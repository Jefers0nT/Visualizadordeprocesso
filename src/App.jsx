import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Search, Network, FileSpreadsheet, FolderOpen, ChevronRight, RefreshCw } from 'lucide-react';
import { toast, Toaster } from 'sonner';
import { estimateLaserHours, groupLaserSchedule, laserJobCounts, laserProgramStatus, MAX_LASER_SCHEDULE_BYTES, parseLaserWorksheet } from './laser-schedule.js';
import { LASER_SEPARATION_PAID, LASER_SEPARATION_PENDING, separationKey } from './laser-separation.js';

const decode = (buf) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
};

function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delimiter = [';', ',', '\t'].reduce((selected, candidate) =>
    firstLine.split(candidate).length > firstLine.split(selected).length ? candidate : selected,
  ';');
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }

  const headers = (rows.shift() || []).map((s) => s.trim());
  const data = rows
    .filter((r) => r.length > 1)
    .map((r) => {
      const obj = {};
      headers.forEach((key, index) => {
        if (!(key in obj)) obj[key] = (r[index] || '').trim();
      });
      return obj;
    });

  return { headers, data };
}

const num = (value) => {
  const n = parseFloat(String(value || '0').replace(/\./g, '').replace(',', '.'));
  return Number.isNaN(n) ? 0 : n;
};

const dt = (value) => (/[\d]/.test(value || '') ? value : '');
const MAX_UPLOAD_CHUNK_BYTES = 1024 * 1024;
const UPLOAD_ROWS_PER_CHUNK = 100;
const UPLOAD_CONCURRENCY = 4;

function createUploadChunks(rows) {
  const chunks = [];
  for (let offset = 0; offset < rows.length; offset += UPLOAD_ROWS_PER_CHUNK) {
    const body = JSON.stringify(rows.slice(offset, offset + UPLOAD_ROWS_PER_CHUNK));
    if (new TextEncoder().encode(body).byteLength > MAX_UPLOAD_CHUNK_BYTES) {
      throw new Error('Um bloco de dados excede 1 MiB. Divida o relatório em arquivos menores.');
    }
    chunks.push(body);
  }
  return chunks;
}
const normalizeHeader = (value) =>
  String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const getField = (row, header) => {
  const normalizedHeader = normalizeHeader(header);
  const key = Object.keys(row).find((candidate) => normalizeHeader(candidate) === normalizedHeader);
  return key ? row[key] : '';
};
const percent = (reported, total) =>
  `${Number((total > 0 ? Math.min((reported / total) * 100, 100) : 0).toFixed(1))}%`;
const uniqueText = (values) => [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].join(', ');
const COMBINED_STAGE_FILTER = '__one-letter-two-digits__';
const isPendingOp = (op) => op.steps.every((step) => step.reported === 0);
const isStepComplete = (step) => step.qtd > 0 && step.reported >= step.qtd;
const isOpComplete = (op) => op.steps.length > 0 && op.steps.every(isStepComplete);

function dateSortValue(value) {
  const date = String(value || '').trim();
  const dmy = date.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  const ymd = date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let year, month, day;

  if (dmy) {
    [, day, month, year] = dmy;
    if (year.length === 2) year = `20${year}`;
  } else if (ymd) {
    [, year, month, day] = ymd;
  } else {
    const parsed = Date.parse(date);
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  }

  return new Date(Number(year), Number(month) - 1, Number(day)).getTime();
}

const compareByEmission = (a, b) =>
  dateSortValue(a.emissao) - dateSortValue(b.emissao) || String(a.num).localeCompare(String(b.num));

function buildTree(ops, ordens, apontamentos = []) {
  const ordMap = new Map(ordens.map((order) => [
    String(getField(order, 'Ord Prod')).trim(),
    order,
  ]));
  const reportsByOrd = new Map();
  apontamentos.forEach((report) => {
    const key = String(getField(report, 'Ord Prod')).trim();
    if (!key) return;
    if (!reportsByOrd.has(key)) reportsByOrd.set(key, []);
    reportsByOrd.get(key).push({
      machine: getField(report, 'Desc Máquina'),
      reporter: getField(report, 'Nome Usuário'),
    });
  });
  const byOp = new Map();

  ops.forEach((row) => {
    const key = row['Numero da OP'];
    if (!byOp.has(key)) byOp.set(key, []);
    byOp.get(key).push(row);
  });

  const jobs = new Map();
  byOp.forEach((rows, key) => {
    rows.sort((a, b) => num(b['Sequencia']) - num(a['Sequencia']));
    const final = rows[rows.length - 1];
    const job = (rows.find((row) => row['Job de Corte']) || {})['Job de Corte'] || '';
    const steps = rows.map((row) => {
      const order = ordMap.get(String(getField(row, 'OP')).trim()) || {};
      const reportRows = reportsByOrd.get(String(getField(row, 'OP')).trim()) || [];
      const qtd = num(order['Quantidade'] !== undefined && order['Quantidade'] !== ''
        ? order['Quantidade']
        : row['Quantidade']);
      const reported = num(getField(order, 'Quant Rep'));
      const reworkQty = num(getField(order, 'Quant Retrab'));
      const scrapQty = num(getField(order, 'Quant Refug'));
      const item = String(getField(row, 'Produto') || '');

      return {
        ord: getField(row, 'OP'),
        item,
        sigla: order['Grup Estoque'] || item.slice(5, 7),
        stageCode: String(getField(order, 'Grup Estoque') || '').trim().toUpperCase(),
        desc: String(getField(order, 'Descrição GE') || '').replace(/\s+/g, ' ').trim(),
        qtd,
        reported,
        hasOrderReport: Object.keys(order).length > 0,
        reworkQty,
        scrapQty,
        machine: uniqueText(reportRows.map((report) => report.machine)),
        reporter: uniqueText(reportRows.map((report) => report.reporter)),
        st: isStepComplete({ qtd, reported })
          ? 'Concluída'
          : reported > 0 ? 'Em andamento' : 'Pendente',
        emissao: dt(getField(order, 'DT Emissão') || getField(row, 'DT Emissão')),
        inicio: dt(order['Inicio Ordem']),
        fim: dt(order['Fim Ordem']),
      };
    });

    const op = {
      num: key,
      job,
      desc: final['Desc Prod'],
      qtd: num(final['Quantidade']),
      entrega: dt(final['Entrega']),
      steps,
      emissao: steps.map((step) => step.emissao).filter(Boolean).sort(
        (a, b) => dateSortValue(a) - dateSortValue(b),
      )[0] || '',
      totalQty: steps.reduce((sum, step) => sum + step.qtd, 0),
      reportedQty: steps.reduce((sum, step) => sum + step.reported, 0),
    };

    if (!jobs.has(job)) jobs.set(job, []);
    jobs.get(job).push(op);
  });

  jobs.forEach((jobOps) => jobOps.sort(compareByEmission));
  return Array.from(jobs.entries()).sort(([jobA, opsA], [jobB, opsB]) => {
    const dateA = Math.min(...opsA.map((op) => dateSortValue(op.emissao)));
    const dateB = Math.min(...opsB.map((op) => dateSortValue(op.emissao)));
    return dateA - dateB || jobA.localeCompare(jobB);
  });
}

const STYLE = {
  Concluída: { border: 'step-concluida', badge: 'badge-concluida', seg: 'segment-concluida' },
  'Em andamento': { border: 'step-andamento', badge: 'badge-andamento', seg: 'segment-andamento' },
  Pendente: { border: 'step-pendente', badge: 'badge-pendente', seg: 'segment-pendente' },
  default: { border: 'step-default', badge: 'badge-default', seg: 'segment-default' },
};

const sty = (status) => STYLE[status] || STYLE.default;

function StepNode({ s }) {
  const c = sty(s.st);

  return (
    <div className={`step-node ${c.border}`} title={`Ordem ${s.ord} · Quant Rep/Quantidade`}>
      <span className="step-sigla">{s.sigla}</span>
      <span className="step-desc">{s.desc || s.item}</span>
      <span className="step-detail">Produto: {s.item}</span>
      <span className="step-detail">Quantidade: {s.qtd}</span>
      {s.machine && <span className="step-detail">Máquina: {s.machine}</span>}
      {s.reporter && <span className="step-detail">Reportado por: {s.reporter}</span>}
      {s.hasOrderReport && (
        <span className="step-detail step-report-qty">
          Reportado: {s.reported} · Retrabalho: {s.reworkQty} · Refugo: {s.scrapQty}
        </span>
      )}
      <span className="step-qty">{percent(s.reported, s.qtd)} reportado</span>
      {s.emissao && <span className="step-date">DT Emissão {s.emissao}</span>}
      {s.inicio && <span className="step-date">Início Ordem {s.inicio}</span>}
      {s.fim && <span className="step-date">Fim {s.fim}</span>}
      <span className={`step-status ${c.badge}`}>{s.st}</span>
    </div>
  );
}

async function fetchApi(path, options) {
  const method = options?.method || 'GET';
  const maxAttempts = method === 'GET' ? 3 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers: {
          ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
          ...options?.headers,
        },
      });
    } catch {
      if (attempt + 1 === maxAttempts) {
        throw new Error('Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.');
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
      continue;
    }

    if (response.ok) return response.json();

    const body = await response.json().catch(() => ({}));
    const isTemporary = [408, 429, 500, 502, 503, 504].includes(response.status);
    if (method === 'GET' && isTemporary && attempt + 1 < maxAttempts) {
      const retryAfter = Number(response.headers.get('Retry-After'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5000)
        : 500 * (2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    const error = new Error(body.error || `Falha na comunicação com o servidor (${response.status})`);
    error.status = response.status;
    throw error;
  }
}

function OpCard({ op }) {
  const [isOpen, setIsOpen] = useState(false);
  const done = op.steps.filter((s) => s.st === 'Concluída').length;

  return (
    <details className="op-card" onToggle={(event) => setIsOpen(event.currentTarget.open)}>
      <summary className="op-summary">
        <span className="op-title">
          <ChevronRight className="chevron" />
          OP {op.num}
        </span>
        <span className="op-desc">{op.desc}</span>
        <span className="op-meta">
          {percent(op.reportedQty, op.totalQty)} · {done}/{op.steps.length} etapas concluídas
        </span>
        <span className="op-emissao">DT Emissão: {op.emissao || '—'}</span>
        <span className="progress-bar">
          {op.steps.map((s, index) => (
            <i key={`${s.ord}-${index}`} className={`progress-seg ${sty(s.st).seg}`} />
          ))}
        </span>
      </summary>

      {isOpen && (
        <div className="step-flow">
          {op.steps.map((s, index) => (
            <div key={`${s.ord}-${index}`} className="flow-item-wrap">
              {index > 0 && <span className="connector" />}
              <StepNode s={s} />
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

function JobGroup({ job, list, jobComplete, jobEmission }) {
  const [isOpen, setIsOpen] = useState(false);
  const totalQty = list.reduce((sum, op) => sum + op.totalQty, 0);
  const reportedQty = list.reduce((sum, op) => sum + op.reportedQty, 0);

  return (
    <details
      className="job-group"
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="job-header">
        <ChevronRight className="job-chevron" />
        {job ? `Job ${job}` : 'Sem job de corte'}
        <span className="job-count">{list.length} OP(s)</span>
        {jobEmission && (
          <span className="job-emissao">Emissão {jobEmission}</span>
        )}
        <span className={`job-status ${jobComplete ? 'job-status-complete' : ''}`}>
          {jobComplete ? 'Finalizado' : 'Em andamento'}
        </span>
        <span className="job-percent">{percent(reportedQty, totalQty)} concluído</span>
      </summary>

      {isOpen && (
        <div className="job-body">
          {list.map((op) => (
            <OpCard key={op.num} op={op} />
          ))}
        </div>
      )}
    </details>
  );
}

function LaserProgramRow({ program, isAdmin, separation, savingSeparation, onSeparationChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const status = program.found ? laserProgramStatus(program) : null;

  return (
    <>
      <tr className={program.found ? undefined : 'laser-program-not-found'}>
        <td>{program.sequence}</td>
        <td>
          {program.found ? (
            <button type="button" className="laser-program-toggle" aria-expanded={isOpen}
              onClick={() => setIsOpen((open) => !open)}>
              <ChevronRight className={`chevron ${isOpen ? 'laser-program-chevron-open' : ''}`} />
              {program.program}
            </button>
          ) : program.program}
        </td>
        <td>{program.hours.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} h</td>
        <td>{program.found ? `${program.reported.toLocaleString('pt-BR')} / ${program.planned.toLocaleString('pt-BR')}` : '—'}</td>
        <td>
          {separation === null ? (
            <span>Indisponível</span>
          ) : isAdmin ? (
            <select
              className={`laser-separation-select ${separation === LASER_SEPARATION_PAID ? 'laser-separation-paid' : 'laser-separation-pending'}`}
              aria-label={`Separação do programa ${program.program} na máquina ${program.machine}`}
              value={separation}
              disabled={savingSeparation}
              onChange={(event) => onSeparationChange(program, event.target.value)}
            >
              <option value={LASER_SEPARATION_PENDING}>Pendente de separação</option>
              <option value={LASER_SEPARATION_PAID}>Pago</option>
            </select>
          ) : (
            <span className={`integration-status ${separation === LASER_SEPARATION_PAID ? 'laser-separation-paid' : 'laser-separation-pending'}`}>
              {separation === LASER_SEPARATION_PAID ? 'Pago' : 'Pendente de separação'}
            </span>
          )}
        </td>
        <td>{program.found ? percent(program.reported, program.planned) : '—'}</td>
        <td>
          {program.found ? (
            <span className={`integration-status ${status.className}`}>
              {status.label}
            </span>
          ) : program.ambiguous ? 'Vários Jobs encontrados' : 'Não encontrado'}
        </td>
      </tr>
      {program.found && isOpen && (
        <tr className="laser-program-details">
          <td colSpan={7}>
            <section aria-label={`OPs do programa ${program.program}`}>
              <p>OPs do Job {program.job} · etapa CL</p>
              <div className="job-list">
                {program.clOps.map((op) => <OpCard key={op.num} op={op} />)}
              </div>
            </section>
          </td>
        </tr>
      )}
    </>
  );
}

export default function App() {
  const [ops, setOps] = useState([]);
  const [ordens, setOrdens] = useState([]);
  const [apontamentos, setApontamentos] = useState([]);
  const [search, setSearch] = useState('');
  const [filtro, setFiltro] = useState('');
  const [etapaFiltro, setEtapaFiltro] = useState('');
  const [activeView, setActiveView] = useState('production');
  const [selectedMachine, setSelectedMachine] = useState('');
  const [over, setOver] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [password, setPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState('');
  const [laserSchedule, setLaserSchedule] = useState({ rows: [], updatedAt: null });
  const [scheduleError, setScheduleError] = useState('');
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [separationStatuses, setSeparationStatuses] = useState(null);
  const [separationError, setSeparationError] = useState('');
  const [savingSeparation, setSavingSeparation] = useState(false);
  const fileRef = useRef(null);
  const scheduleFileRef = useRef(null);
  const dirRef = useRef(null);
  const loadSharedData = useCallback(async ({ showToast = false } = {}) => {
    setLoading(true);
    setLoadError('');

    try {
      const session = await fetchApi('/api/session');
      setAuthenticated(true);
      setAuthChecked(true);
      setIsAdmin(session.isAdmin);
      const dataset = await fetchApi('/api/data');
      setOps(dataset.ops);
      setOrdens(dataset.ordens);
      setApontamentos(dataset.apontamentos || []);
      setUpdatedAt(dataset.updatedAt || '');
      try {
        const schedule = await fetchApi('/api/laser-schedule');
        setLaserSchedule(schedule);
        setScheduleError('');
      } catch (error) {
        if (error.status === 401) throw error;
        setLaserSchedule({ rows: [], updatedAt: null });
        setScheduleError(error.message);
      }
      try {
        const result = await fetchApi('/api/laser-separation');
        setSeparationStatuses(Object.fromEntries(result.rows.map((row) => [
          separationKey(row.machine, row.program), row.status,
        ])));
        setSeparationError('');
      } catch (error) {
        if (error.status === 401) throw error;
        setSeparationStatuses(null);
        setSeparationError(error.message);
      }
      if (showToast) toast.success('Dados de produção atualizados.');
    } catch (error) {
      setAuthChecked(true);
      if (error.status === 401) {
        setAuthenticated(false);
        setIsAdmin(false);
        setOps([]);
        setOrdens([]);
        setApontamentos([]);
        setUpdatedAt('');
        setLaserSchedule({ rows: [], updatedAt: null });
        setScheduleError('');
        setSeparationStatuses(null);
        setSeparationError('');
      } else {
        setLoadError(error.message);
      }
      if (showToast) toast.error(error.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) loadSharedData();
    });
    return () => {
      active = false;
    };
  }, [loadSharedData]);

  const handleLogin = async (event) => {
    event.preventDefault();
    setLoggingIn(true);
    try {
      await fetchApi('/api/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      setPassword('');
      await loadSharedData();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetchApi('/api/logout', { method: 'POST' });
      setAuthenticated(false);
      setIsAdmin(false);
      setOps([]);
      setOrdens([]);
      setApontamentos([]);
      setUpdatedAt('');
      setLaserSchedule({ rows: [], updatedAt: null });
      setScheduleError('');
      setSeparationStatuses(null);
      setSeparationError('');
      setAuthChecked(true);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleFiles = async (fileList) => {
    if (!isAdmin || saving) return;
    const files = Array.from(fileList).filter((f) => /\.csv$/i.test(f.name));
    let allOps = [];
    let allOrdens = [];
    let allApontamentos = [];
    let ignorados = 0;

    if (!files.length) {
      toast.error('Selecione pelo menos um arquivo CSV');
      return;
    }

    setSaving(true);
    let uploadId = '';
    let finalized = false;
    try {
      for (const file of files) {
        const parsed = parseCSV(decode(await file.arrayBuffer()));
        const headers = new Set(parsed.headers.map(normalizeHeader));
        const isProductionReport = headers.has('ord prod')
          && headers.has('desc maquina')
          && headers.has('nome usuario');
        if (isProductionReport) {
          allApontamentos = allApontamentos.concat(parsed.data);
        } else if (headers.has('ord prod')) {
          allOrdens = allOrdens.concat(parsed.data);
        } else if (headers.has('numero da op')) {
          allOps = allOps.concat(parsed.data);
        } else {
          ignorados += 1;
        }
      }

      const missingReports = [
        ['OPs', allOps],
        ['Ordens de Produção', allOrdens],
        ['Apontamentos', allApontamentos],
      ].filter(([, rows]) => rows.length === 0).map(([name]) => name);
      if (missingReports.length) {
        toast.error(`Envie os três relatórios. Faltando: ${missingReports.join(', ')}.`);
        return;
      }

      const nextOps = allOps;
      const nextOrdens = allOrdens;
      const nextApontamentos = allApontamentos;
      const chunks = {
        ops: createUploadChunks(nextOps),
        ordens: createUploadChunks(nextOrdens),
        apontamentos: createUploadChunks(nextApontamentos),
      };
      const expectedBytes = Object.values(chunks)
        .flat()
        .reduce((total, body) => total + new TextEncoder().encode(body).byteLength, 0);
      const started = await fetchApi('/api/data', {
        method: 'POST',
        body: JSON.stringify({ action: 'start', expectedBytes }),
      });
      uploadId = started.uploadId;

      for (const [kind, kindChunks] of Object.entries(chunks)) {
        for (let offset = 0; offset < kindChunks.length; offset += UPLOAD_CONCURRENCY) {
          const batch = kindChunks.slice(offset, offset + UPLOAD_CONCURRENCY);
          await Promise.all(batch.map((body, batchIndex) => {
            const index = offset + batchIndex;
            const query = new URLSearchParams({ uploadId, kind, index: String(index) });
            return fetchApi(`/api/data?${query}`, { method: 'PUT', body });
          }));
        }
      }

      const result = await fetchApi('/api/data', {
        method: 'POST',
        body: JSON.stringify({
          action: 'complete',
          uploadId,
          chunkCounts: Object.fromEntries(Object.entries(chunks).map(([kind, items]) => [kind, items.length])),
          rowCounts: {
            ops: nextOps.length,
            ordens: nextOrdens.length,
            apontamentos: nextApontamentos.length,
          },
        }),
      });
      finalized = true;

      setOps(nextOps);
      setOrdens(nextOrdens);
      setApontamentos(nextApontamentos);
      setUpdatedAt(result.updatedAt);
      toast.success(`${files.length - ignorados} arquivo(s) publicado(s) para consulta`);
      if (ignorados) {
        toast.warning(`${ignorados} arquivo(s) ignorado(s): cabeçalho não reconhecido`);
      }
    } catch (error) {
      if (uploadId && !finalized) {
        await fetchApi(`/api/data?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => {});
      }
      toast.error(`Não foi possível publicar os arquivos: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleLaserSchedule = async (file) => {
    if (!file || !isAdmin || savingSchedule) return;
    setSavingSchedule(true);
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error('Selecione uma planilha XLSX.');
      if (file.size > 10 * 1024 * 1024) throw new Error('A planilha excede 10 MiB.');
      const { default: ExcelJS } = await import('exceljs/dist/exceljs.min.js');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await file.arrayBuffer());
      const worksheet = workbook.getWorksheet('Sequenciamento laser') || workbook.worksheets[0];
      if (!worksheet) throw new Error('A planilha não contém nenhuma aba.');
      const rows = parseLaserWorksheet(worksheet);
      const body = JSON.stringify(rows);
      if (new TextEncoder().encode(body).byteLength > MAX_LASER_SCHEDULE_BYTES) {
        throw new Error('O sequenciamento processado excede 1 MiB.');
      }
      const result = await fetchApi('/api/laser-schedule', { method: 'PUT', body });
      setLaserSchedule({ rows, updatedAt: result.updatedAt });
      setScheduleError('');
      toast.success(`${rows.length} programa(s) de laser importado(s) para todos os usuários.`);
    } catch (error) {
      toast.error(`Não foi possível importar o sequenciamento: ${error.message}`);
    } finally {
      setSavingSchedule(false);
    }
  };

  const handleSeparationChange = async (program, status) => {
    if (!isAdmin || savingSeparation) return;
    setSavingSeparation(true);
    try {
      await fetchApi('/api/laser-separation', {
        method: 'PUT',
        body: JSON.stringify({ machine: program.machine, program: program.program, status }),
      });
      setSeparationStatuses((current) => ({
        ...current,
        [separationKey(program.machine, program.program)]: status,
      }));
      toast.success('Status de separação atualizado.');
    } catch (error) {
      toast.error(`Não foi possível atualizar a separação: ${error.message}`);
    } finally {
      setSavingSeparation(false);
    }
  };

  const tree = useMemo(() => buildTree(ops, ordens, apontamentos), [ops, ordens, apontamentos]);
  const allOps = useMemo(() => tree.flatMap(([, list]) => list), [tree]);
  const allSteps = useMemo(() => allOps.flatMap((op) => op.steps), [allOps]);
  const stageOptions = useMemo(
    () => {
      const stages = new Map();
      allSteps.forEach((step) => {
        if (step.stageCode && !stages.has(step.stageCode)) {
          stages.set(step.stageCode, step.desc);
        }
      });
      const groupedCodes = [...stages.keys()]
        .filter((code) => /^[A-Z]\d{2}$/.test(code))
        .sort((codeA, codeB) => codeA.localeCompare(codeB));
      const groupedLabel = groupedCodes.length > 3
        ? `PRODUTOS ACABADOS (${groupedCodes.slice(0, 3).join(', ')}, +${groupedCodes.length - 3})`
        : `PRODUTOS ACABADOS (${groupedCodes.join(', ')})`;
      const groupedOption = groupedCodes.length
        ? [{ code: COMBINED_STAGE_FILTER, label: groupedLabel }]
        : [];

      return [
        ...groupedOption,
        ...[...stages.entries()]
          .filter(([code]) => !/^[A-Z]\d{2}$/.test(code))
          .sort(([codeA], [codeB]) => codeA.localeCompare(codeB))
          .map(([code, description]) => ({
            code,
            label: description ? `${code} · ${description}` : code,
          })),
      ];
    },
    [allSteps],
  );
  const laserLoad = useMemo(
    () => groupLaserSchedule(laserSchedule.rows, tree),
    [laserSchedule.rows, tree],
  );
  const activeMachine = laserLoad.machines.find((machine) => machine.machine === selectedMachine)
    || laserLoad.machines[0];
  const jobEmissions = useMemo(() => new Map(tree.map(([job, list]) => {
    const dates = list.map((op) => op.emissao).filter(Boolean);
    dates.sort((a, b) => dateSortValue(a) - dateSortValue(b));
    return [job, dates[0] || ''];
  })), [tree]);
  const jobCompletion = useMemo(
    () => new Map(tree.map(([job, list]) => [job, list.length > 0 && list.every(isOpComplete)])),
    [tree],
  );

  const stats = {
    jobs: tree.filter(([job]) => job).length,
    ops: allOps.length,
    etapas: allSteps.length,
    pendentes: tree.filter(
      ([job, list]) => job && list.every(isPendingOp),
    ).length,
    parciais: tree.filter(([job, list]) =>
      job
      && list.some((op) => op.steps.some((step) => step.reported > 0))
      && !jobCompletion.get(job),
    ).length,
    concluidas: [...jobCompletion].filter(([job, complete]) => job && complete).length,
  };

  const q = search.trim().toLowerCase();
  const visible = useMemo(() => {
    const matchesSearch = (op) =>
      !q ||
      [op.num, op.job, op.desc, ...op.steps.map((s) => `${s.ord} ${s.item} ${s.sigla} ${s.desc}`)]
        .join(' ')
        .toLowerCase()
        .includes(q);

    return tree
      .map(([job, list]) => {
        const jobComplete = list.length > 0 && list.every(isOpComplete);
        return [
          job,
          list.flatMap((op) => {
            const stageSteps = op.steps.filter((step) => {
              if (!etapaFiltro) return true;
              if (etapaFiltro === COMBINED_STAGE_FILTER) return /^[A-Z]\d{2}$/.test(step.stageCode);
              return step.stageCode === etapaFiltro;
            });
            if (!stageSteps.length) return [];
            if (filtro === 'job-concluido' && !jobComplete) return [];
            if (filtro === 'Pendente' && !stageSteps.every((step) => step.st === 'Pendente')) return [];

            const visibleSteps = filtro === 'Concluída'
              ? stageSteps.filter((step) => step.st === 'Concluída')
              : stageSteps;
            if (!visibleSteps.length) return [];

            const visibleOp = {
              ...op,
              steps: visibleSteps,
              totalQty: visibleSteps.reduce((sum, step) => sum + step.qtd, 0),
              reportedQty: visibleSteps.reduce((sum, step) => sum + step.reported, 0),
            };
            return matchesSearch(visibleOp) ? [visibleOp] : [];
          }),
        ];
      })
      .filter(([, list]) => list.length > 0);
  }, [tree, q, filtro, etapaFiltro]);

  const hasData = ops.length > 0;

  return (
    <div
      className="app-shell"
      onDragOver={(event) => {
        if (!authenticated || !isAdmin || saving) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        if (!authenticated || !isAdmin || saving) return;
        event.preventDefault();
        setOver(false);
        handleFiles(event.dataTransfer.files);
      }}
    >
      <header className="topbar">
        <div className={`topbar-inner ${activeView === 'integration' ? 'topbar-inner-wide' : ''}`}>
          <div>
            <h1 className="title">
              <Network className="title-icon" />
              Painel de OPs
            </h1>
            <p className="subtitle">Programa → OP → Etapas. Na ordem em que o processo acontece</p>
          </div>

          <div className="stats-grid">
            {[
              ['Jobs', stats.jobs],
              ['OPs', stats.ops],
              ['Etapas', stats.etapas],
              ['Jobs pendentes', stats.pendentes, 'accent-amber'],
              ['Jobs parciais', stats.parciais, 'accent-blue'],
              ['Jobs concluídos', stats.concluidas, 'accent-emerald'],
            ].map(([label, value, className]) => (
              <div key={label} className="stat-box">
                <div className={`stat-value ${className || ''}`}>{value}</div>
                <div className="stat-label">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </header>

      <main className={`main-panel ${activeView === 'integration' ? 'main-panel-wide' : ''}`}>
        {authenticated && isAdmin && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              multiple
              hidden
              disabled={saving}
              onChange={(event) => {
                handleFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <input
              ref={dirRef}
              type="file"
              multiple
              hidden
              webkitdirectory=""
              disabled={saving}
              onChange={(event) => {
                handleFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <input
              ref={scheduleFileRef}
              type="file"
              accept=".xlsx"
              hidden
              disabled={savingSchedule}
              onChange={(event) => {
                handleLaserSchedule(event.target.files[0]);
                event.target.value = '';
              }}
            />
          </>
        )}

        {authenticated && (
          <nav className="view-tabs" role="tablist" aria-label="Visões do processo">
            <button
              type="button"
              role="tab"
              aria-selected={activeView === 'production'}
              className={`view-tab ${activeView === 'production' ? 'view-tab-active' : ''}`}
              onClick={() => setActiveView('production')}
            >
              Visão de produção
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeView === 'integration'}
              className={`view-tab ${activeView === 'integration' ? 'view-tab-active' : ''}`}
              onClick={() => setActiveView('integration')}
            >
              Corte Laser
            </button>
          </nav>
        )}

        {authenticated && hasData && activeView === 'production' && (
          <div className="toolbar">
            <div className="search-wrap">
              <Search className="search-icon" />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar por job, OP, produto, ordem, etapa..."
                className="search-input"
              />
            </div>

            <label className="stage-filter">
              <span>Etapa</span>
              <select value={etapaFiltro} onChange={(event) => setEtapaFiltro(event.target.value)}>
                <option value="">Todas</option>
                {stageOptions.map(({ code, label }) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <div className="filter-group">
              {[
                ['', 'Todas'],
                ['Pendente', 'Pendentes'],
                ['Concluída', 'Etapas concluídas'],
                ['job-concluido', 'Jobs finalizados'],
              ].map(([value, label]) => (
                <button
                  key={label}
                  type="button"
                  className={`filter-button ${filtro === value ? 'filter-button-active' : ''}`}
                  onClick={() => setFiltro(value)}
                >
                  {label}
                </button>
              ))}
            </div>

            {updatedAt && (
              <span className="dataset-updated">
                Dados atualizados em {new Date(updatedAt).toLocaleString('pt-BR')}
              </span>
            )}
            <button
              type="button"
              className="secondary-button refresh-button"
              onClick={() => loadSharedData({ showToast: true })}
              disabled={loading || savingSchedule || savingSeparation}
            >
              <RefreshCw className={`button-icon ${loading ? 'refreshing' : ''}`} />
              Atualizar
            </button>
            <button type="button" className="secondary-button logout-button" onClick={handleLogout}>
              Sair
            </button>
            {isAdmin && (
              <button
                type="button"
                className="primary-button upload-button"
                onClick={() => fileRef.current?.click()}
                disabled={saving}
              >
                <FileSpreadsheet className="button-icon" />
                {saving ? 'Publicando...' : 'Atualizar arquivos'}
              </button>
            )}
          </div>
        )}

        {authenticated && activeView === 'integration' && (
          <section className="integration-panel" role="tabpanel" aria-labelledby="integration-tab">
            <header className="integration-heading">
              <div className="integration-actions">
                {updatedAt && (
                  <span className="dataset-updated">
                    Dados atualizados em {new Date(updatedAt).toLocaleString('pt-BR')}
                  </span>
                )}
                <button
                  type="button"
                  className="secondary-button refresh-button"
                  onClick={() => loadSharedData({ showToast: true })}
                  disabled={loading || savingSchedule || savingSeparation}
                >
                  <RefreshCw className={`button-icon ${loading ? 'refreshing' : ''}`} />
                  Atualizar
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => fileRef.current?.click()}
                    disabled={saving}
                  >
                    <FileSpreadsheet className="button-icon" />
                    {saving ? 'Publicando...' : 'Atualizar arquivos'}
                  </button>
                )}
                <button type="button" className="secondary-button" onClick={handleLogout}>Sair</button>
              </div>
            </header>

            <div className="integration-production" role="tabpanel" aria-label="Produção CL">
                <section className="laser-load" aria-labelledby="laser-load-heading">
                  <div className="integration-section-heading">
                    <div>
                      <p className="integration-eyebrow">SEQUENCIAMENTO · CL</p>
                      <h3 id="laser-load-heading">Carga por máquina</h3>
                      <p className="laser-load-description">
                        O progresso considera todas as etapas CL do Job na Visão de produção.
                      </p>
                      <p className="laser-load-description">
                        Horas estimadas dividem a carga de cada programa igualmente entre as OPs CL do Job.
                        Programas não encontrados e OPs sem quantidade planejada são considerados pendentes.
                      </p>
                      {laserSchedule.updatedAt && (
                        <span className="dataset-updated">
                          Sequenciamento importado em {new Date(laserSchedule.updatedAt).toLocaleString('pt-BR')}
                        </span>
                      )}
                    </div>
                    {isAdmin && (
                      <button type="button" className="primary-button" disabled={savingSchedule || loading}
                        onClick={() => scheduleFileRef.current?.click()}>
                        <FileSpreadsheet className="button-icon" />
                        {savingSchedule ? 'Importando...' : 'Importar sequenciamento XLSX'}
                      </button>
                    )}
                  </div>
                  {scheduleError ? (
                    <p className="laser-load-description" role="alert">{scheduleError}</p>
                  ) : !laserSchedule.rows.length ? (
                    <p className="laser-load-description">Nenhum sequenciamento importado.</p>
                  ) : !laserLoad.machines.length ? (
                    <p className="laser-load-description">Nenhum programa da planilha corresponde às OPs da etapa CL.</p>
                  ) : (
                    <>
                      {separationError && <p className="laser-load-description" role="alert">{separationError} Use Atualizar para tentar novamente.</p>}
                      <div className="laser-dashboard" aria-label="Resumo das máquinas">
                        {laserLoad.machines.map((machine) => {
                          const counts = laserJobCounts(machine.jobs);
                          const estimate = estimateLaserHours(machine.programs);
                          return (
                          <article className="laser-dashboard-card" key={machine.machine}>
                            <h4>{machine.machine}</h4>
                            <div className="laser-dashboard-hours">
                              <strong>{machine.hours.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} h</strong>
                              <span>de programas encontrados</span>
                            </div>
                            <div className="laser-dashboard-estimate">
                              <div className="laser-dashboard-estimate-heading">
                                <strong>{estimate.remaining.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} h</strong>
                                <span>estimadas para cortar</span>
                              </div>
                              <strong className="laser-dashboard-cut">
                                {estimate.cut.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} h cortadas
                              </strong>
                            </div>
                            <div className="laser-dashboard-counts">
                              <span><strong>{machine.programs.length}</strong> programa(s)</span>
                            </div>
                            <div className="laser-dashboard-statuses" aria-label={`Status dos Jobs de ${machine.machine}`}>
                              <span className="laser-status-complete"><strong>{counts.complete}</strong> Concluídos</span>
                              <span className="laser-status-partial"><strong>{counts.partial}</strong> Corte parcial</span>
                              <span className="laser-status-progress"><strong>{counts.progress}</strong> Em andamento</span>
                            </div>
                          </article>
                          );
                        })}
                      </div>
                      <div className="laser-load-machines" role="group" aria-label="Filtrar por máquina">
                        {laserLoad.machines.map((machine) => (
                          <button
                            type="button"
                            className={`laser-machine-button ${activeMachine.machine === machine.machine ? 'laser-machine-button-active' : ''}`}
                            key={machine.machine}
                            aria-pressed={activeMachine.machine === machine.machine}
                            onClick={() => setSelectedMachine(machine.machine)}
                          >
                            {machine.machine}
                          </button>
                        ))}
                      </div>
                      <section className="laser-load-machine" aria-label={`Carga da máquina ${activeMachine.machine}`}>
                        <h4 className="laser-machine-heading">{activeMachine.machine}</h4>
                        {activeMachine.programs.length === 0 ? (
                          <p className="laser-load-description laser-machine-empty">Nenhum programa desta máquina corresponde às OPs da etapa CL.</p>
                        ) : (
                          <div className="integration-table-wrap">
                            <table className="integration-table">
                              <thead><tr><th>Seq</th><th>Programa</th><th>Carga</th><th>Reportado / planejado</th><th>Separação</th><th>Progresso CL</th><th>Status</th></tr></thead>
                              <tbody>
                                {activeMachine.programs.map((program, index) => (
                                  <LaserProgramRow
                                    key={`${activeMachine.machine}-${program.sequence}-${index}`}
                                    program={program}
                                    isAdmin={isAdmin}
                                    separation={separationStatuses === null
                                      ? null
                                      : separationStatuses[separationKey(program.machine, program.program)] || LASER_SEPARATION_PENDING}
                                    savingSeparation={savingSeparation || loading}
                                    onSeparationChange={handleSeparationChange}
                                  />
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </section>
                    </>
                  )}
                </section>
            </div>
          </section>
        )}

        {loading && !authChecked && (
          <div className="empty-state"><p>Carregando Jobs publicados...</p></div>
        )}

        {!loading && loadError && !hasData && (
          <div className="empty-state">
            <p>{loadError}</p>
            <button type="button" className="secondary-button" onClick={() => loadSharedData()}>
              Tentar novamente
            </button>
          </div>
        )}

        {!loading && authChecked && !authenticated && !loadError && (
          <form className="login-panel" onSubmit={handleLogin}>
            <h2>Consultar Jobs</h2>
            <p>Digite a senha compartilhada para acessar os dados publicados.</p>
            <label className="login-field">
              <span>Senha de acesso</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <button type="submit" className="primary-button" disabled={loggingIn || !password}>
              {loggingIn ? 'Validando...' : 'Entrar'}
            </button>
          </form>
        )}

        {!loading && !loadError && authenticated && !hasData && isAdmin && (
          <div className={`dropzone ${over ? 'dropzone-over' : ''}`}>
            <h2>Publique os CSVs para consulta dos usuários</h2>
            <p>Os arquivos publicados ficam disponíveis aos usuários autenticados neste site.</p>
            <div className="dropzone-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => fileRef.current?.click()}
                disabled={saving}
              >
                <FileSpreadsheet className="button-icon" />
                {saving ? 'Publicando...' : 'Escolher arquivos CSV'}
              </button>

              <button
                type="button"
                className="secondary-button"
                onClick={() => dirRef.current?.click()}
                disabled={saving}
              >
                <FolderOpen className="button-icon" />
                Escolher pasta "Ordens de produção"
              </button>
            </div>
          </div>
        )}

        {!loading && !loadError && authenticated && !hasData && !isAdmin && (
          <div className="empty-state">
            <p>Ainda não há Jobs publicados para consulta.</p>
          </div>
        )}

        {authenticated && !hasData && (
          <div className="empty-session-actions">
            <button type="button" className="secondary-button" onClick={handleLogout}>Sair</button>
          </div>
        )}

        {activeView === 'production' && hasData && !ordens.length && (
          <p className="helper-text">Falta o relatório de Ordens de Produção: as etapas aparecem sem status.</p>
        )}

        {activeView === 'production' && hasData && visible.length === 0 && (
          <div className="empty-state">
            <p>Nenhuma OP encontrada</p>
          </div>
        )}

        {activeView === 'production' && (
        <div className="job-list">
          {visible.map(([job, list]) => (
            <JobGroup
              key={job || 'sem-job'}
              job={job}
              list={list}
              jobComplete={jobCompletion.get(job)}
              jobEmission={jobEmissions.get(job)}
            />
          ))}
        </div>
        )}
      </main>

      <Toaster richColors position="top-right" />
    </div>
  );
}
