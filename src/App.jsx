import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Search, Network, FileSpreadsheet, FolderOpen, ChevronRight, RefreshCw, X } from 'lucide-react';
import { toast, Toaster } from 'sonner';

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
const MAX_UPLOAD_BYTES = 90 * 1024 * 1024;
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

const WAREHOUSE_STATUS_STORAGE_KEY = 'visualizador-pcp-almoxarifado-status';
const WAREHOUSE_OPERATOR_STORAGE_KEY = 'visualizador-pcp-almoxarifado-operadores';
const WAREHOUSE_SEPARATION_STORAGE_KEY = 'visualizador-pcp-separacao';
const WAREHOUSE_STATUS_OPTIONS = [
  { value: 'awaiting', label: 'Aguardando PCP', tone: 'pending' },
  { value: 'shortage', label: 'Falta MP', tone: 'critical' },
  { value: 'separating', label: 'Em separação', tone: 'waiting' },
  { value: 'delivered', label: 'Entregue na Laser', tone: 'delivered' },
];
const FINALIZED_WAREHOUSE_STATUS = { value: 'finalized', label: 'Finalizado', tone: 'available' };

function readWarehouseStatuses() {
  try {
    const stored = JSON.parse(localStorage.getItem(WAREHOUSE_STATUS_STORAGE_KEY) || '{}');
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
}

function readWarehouseOperators() {
  try {
    const stored = JSON.parse(localStorage.getItem(WAREHOUSE_OPERATOR_STORAGE_KEY) || '{}');
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
}

function readWarehouseSeparations() {
  try {
    const stored = JSON.parse(localStorage.getItem(WAREHOUSE_SEPARATION_STORAGE_KEY) || '{}');
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
}

function localDateValue() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function warehouseStatusForOrder(row, statuses) {
  if (row.finished) return FINALIZED_WAREHOUSE_STATUS.value;
  const savedStatus = statuses[row.orderKey];
  return WAREHOUSE_STATUS_OPTIONS.some((option) => option.value === savedStatus)
    ? savedStatus
    : 'awaiting';
}

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
  const done = op.steps.filter((s) => s.st === 'Concluída').length;

  return (
    <details className="op-card">
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

      <div className="step-flow">
        {op.steps.map((s, index) => (
          <div key={`${s.ord}-${index}`} className="flow-item-wrap">
            {index > 0 && <span className="connector" />}
            <StepNode s={s} />
          </div>
        ))}
      </div>
    </details>
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
  const [laserFilter, setLaserFilter] = useState('pending');
  const [warehouseStatusByOrder, setWarehouseStatusByOrder] = useState(readWarehouseStatuses);
  const [warehouseOperatorByJob, setWarehouseOperatorByJob] = useState(readWarehouseOperators);
  const [warehouseSeparationByJob, setWarehouseSeparationByJob] = useState(readWarehouseSeparations);
  const [separationDialogOpen, setSeparationDialogOpen] = useState(false);
  const [separationJobQuery, setSeparationJobQuery] = useState('');
  const [separationJob, setSeparationJob] = useState('');
  const [separationOperator, setSeparationOperator] = useState('');
  const [separationDate, setSeparationDate] = useState(localDateValue);
  const [separationMachine, setSeparationMachine] = useState('');
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
  const fileRef = useRef(null);
  const dirRef = useRef(null);
  const separationDialogRef = useRef(null);

  useEffect(() => {
    try {
      localStorage.setItem(WAREHOUSE_STATUS_STORAGE_KEY, JSON.stringify(warehouseStatusByOrder));
    } catch {
      toast.error('Não foi possível salvar os status do almoxarifado neste navegador.');
    }
  }, [warehouseStatusByOrder]);

  useEffect(() => {
    try {
      localStorage.setItem(WAREHOUSE_OPERATOR_STORAGE_KEY, JSON.stringify(warehouseOperatorByJob));
    } catch {
      toast.error('Não foi possível salvar os operadores neste navegador.');
    }
  }, [warehouseOperatorByJob]);

  useEffect(() => {
    try {
      localStorage.setItem(WAREHOUSE_SEPARATION_STORAGE_KEY, JSON.stringify(warehouseSeparationByJob));
    } catch {
      toast.error('Não foi possível salvar os dados de separação neste navegador.');
    }
  }, [warehouseSeparationByJob]);

  useEffect(() => {
    const dialog = separationDialogRef.current;
    if (!dialog) return;
    if (separationDialogOpen && !dialog.open) dialog.showModal();
    if (!separationDialogOpen && dialog.open) dialog.close();
  }, [separationDialogOpen]);

  useEffect(() => {
    const dialog = separationDialogRef.current;
    if (!dialog) return;
    if (separationDialogOpen && !dialog.open) dialog.showModal();
    if (!separationDialogOpen && dialog.open) dialog.close();
  }, [separationDialogOpen]);

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
      if (showToast) toast.success('Dados atualizados');
    } catch (error) {
      setAuthChecked(true);
      if (error.status === 401) {
        setAuthenticated(false);
        setIsAdmin(false);
        setOps([]);
        setOrdens([]);
        setApontamentos([]);
        setUpdatedAt('');
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

      if (!allOps.length && !allOrdens.length && !allApontamentos.length) {
        toast.error('Nenhum CSV reconhecido');
        return;
      }

      const nextOps = allOps.length ? allOps : ops;
      const nextOrdens = allOrdens.length ? allOrdens : ordens;
      const nextApontamentos = allApontamentos.length ? allApontamentos : apontamentos;
      const chunks = {
        ops: createUploadChunks(nextOps),
        ordens: createUploadChunks(nextOrdens),
        apontamentos: createUploadChunks(nextApontamentos),
      };
      const expectedBytes = Object.values(chunks)
        .flat()
        .reduce((total, body) => total + new TextEncoder().encode(body).byteLength, 0);
      if (expectedBytes > MAX_UPLOAD_BYTES) {
        toast.error('O envio excede o limite de 90 MiB. Divida os relatórios em arquivos menores.');
        return;
      }
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
  const laserRows = useMemo(
    () => tree.flatMap(([job, jobOps]) => jobOps.flatMap((op) => op.steps
      .filter((step) => step.stageCode === 'CL' && normalizeHeader(step.desc) === 'pi de corte laser')
      .map((step) => ({
        orderKey: String(step.ord || '').trim(),
        job: job || '—',
        op: op.num,
        item: step.item || '—',
        machine: step.machine || '—',
        reporter: step.reporter || '—',
        reported: step.reported,
        planned: step.qtd,
        finished: step.qtd > 0 && step.reported >= step.qtd,
        rework: step.reworkQty,
        scrap: step.scrapQty,
      })))),
    [tree],
  );
  const pendingLaserRows = useMemo(() => laserRows.filter((row) => !row.finished), [laserRows]);
  const finishedLaserRows = useMemo(() => laserRows.filter((row) => row.finished), [laserRows]);
  const getWarehouseStatus = (row) => warehouseStatusForOrder(row, warehouseStatusByOrder);
  const getWarehouseStatusOption = (row) => row.finished
    ? FINALIZED_WAREHOUSE_STATUS
    : WAREHOUSE_STATUS_OPTIONS.find((option) => option.value === getWarehouseStatus(row))
      || WAREHOUSE_STATUS_OPTIONS[0];
  const awaitingLaserRows = pendingLaserRows.filter((row) => getWarehouseStatus(row) === 'awaiting');
  const laserStatusMetrics = WAREHOUSE_STATUS_OPTIONS.map((option) => ({
    ...option,
    count: pendingLaserRows.filter((row) => getWarehouseStatus(row) === option.value).length,
  }));
  const separationJobs = useMemo(() => {
    const jobs = new Map();
    pendingLaserRows.forEach((row) => {
      if (!jobs.has(row.job)) jobs.set(row.job, []);
      jobs.get(row.job).push(row);
    });
    return [...jobs.entries()]
      .map(([job, rows]) => {
        const statusValues = [...new Set(
          rows.map((row) => warehouseStatusForOrder(row, warehouseStatusByOrder)),
        )];
        const status = statusValues.length === 1
          ? WAREHOUSE_STATUS_OPTIONS.find((option) => option.value === statusValues[0]) || WAREHOUSE_STATUS_OPTIONS[0]
          : { label: 'Status misto', tone: 'waiting' };
        return { job, rows, status };
      })
      .sort((a, b) => a.job.localeCompare(b.job));
  }, [pendingLaserRows, warehouseStatusByOrder]);
  const visibleSeparationJobs = useMemo(() => {
    const query = separationJobQuery.trim().toLowerCase();
    return separationJobs.filter((entry) => !query || entry.job.toLowerCase().includes(query));
  }, [separationJobs, separationJobQuery]);
  const activeSeparationJob = separationJobs.find((entry) => entry.job === separationJob);
  const separationMachineOptions = useMemo(() => [...new Set(
    laserRows
      .filter((row) => row.job === separationJob)
      .flatMap((row) => row.machine.split(', '))
      .filter((machine) => machine && machine !== '—'),
  )].sort((a, b) => a.localeCompare(b)), [laserRows, separationJob]);

  const openSeparationDialog = () => {
    setSeparationJobQuery('');
    setSeparationJob('');
    setSeparationOperator('');
    setSeparationDate(localDateValue());
    setSeparationMachine('');
    setSeparationDialogOpen(true);
  };

  const handleSeparationJobChange = (job) => {
    setSeparationJob(job);
    const saved = warehouseSeparationByJob[job];
    setSeparationOperator(saved?.operator || warehouseOperatorByJob[job] || '');
    setSeparationDate(saved?.date || localDateValue());
    const machines = [...new Set(laserRows
      .filter((row) => row.job === job)
      .flatMap((row) => row.machine.split(', '))
      .filter((machine) => machine && machine !== '—'))];
    setSeparationMachine(saved?.machine || machines[0] || '');
  };

  const updateSelectedJobStatus = (status) => {
    if (!activeSeparationJob) {
      toast.error('Selecione um Job para continuar.');
      return;
    }
    const operator = separationOperator.trim();
    if (!operator || !separationDate) {
      toast.error('Informe o responsável e a data da separação.');
      return;
    }

    setWarehouseStatusByOrder((current) => ({
      ...current,
      ...Object.fromEntries(activeSeparationJob.rows.map((row) => [row.orderKey, status])),
    }));
    setWarehouseOperatorByJob((current) => ({ ...current, [activeSeparationJob.job]: operator }));
    setWarehouseSeparationByJob((current) => ({
      ...current,
      [activeSeparationJob.job]: {
        operator,
        date: separationDate,
        machine: separationMachine.trim(),
        status,
      },
    }));
    setSeparationDialogOpen(false);
    toast.success(`Status atualizado para o Job ${activeSeparationJob.job}`);
  };
  const laserVisibleRows = laserRows.filter((row) => {
    if (laserFilter === 'finished') return row.finished;
    if (laserFilter === 'all') return true;
    if (row.finished) return false;
    const status = getWarehouseStatus(row);
    return laserFilter === 'pending' ? status === 'awaiting' : status === laserFilter;
  });
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
              disabled={loading}
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
              <div>
                <p className="integration-eyebrow">Escopo da visão · CL</p>
                <h2>Corte Laser</h2>
                <p>Acompanhamento de Jobs para Corte Laser</p>
              </div>
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
                  disabled={loading}
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
                <div className="integration-metrics integration-metrics-primary" aria-label="Resumo da produção CL">
                  {[
                    { label: 'Finalizados', value: finishedLaserRows.length, tone: 'available' },
                    { label: 'Pendentes', value: awaitingLaserRows.length, tone: 'waiting' },
                  ].map((metric) => (
                    <div key={metric.label} className={`integration-metric metric-${metric.tone}`}>
                      <span className="integration-metric-value">{metric.value}</span>
                      <span className="integration-metric-label">{metric.label}</span>
                    </div>
                  ))}
                </div>

                <div className="laser-status-breakdown" aria-label="Situação das OPs pendentes">
                  <span className="laser-status-breakdown-title">Situação das pendentes</span>
                  <div className="laser-status-items">
                    {laserStatusMetrics.map((metric) => (
                      <div key={metric.value} className={`laser-status-count status-${metric.tone}`}>
                        <strong>{metric.count}</strong>
                        <span>{metric.label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="integration-section-heading">
                  <div>
                    <p className="integration-eyebrow">CL · PI DE CORTE LASER</p>
                    <div className="laser-title-row">
                      <h3>OPs da etapa de corte</h3>
                      <button
                        type="button"
                        className="primary-button separation-open-button"
                        onClick={openSeparationDialog}
                      >
                        SEPARAÇÃO
                      </button>
                    </div>
                  </div>
                  <div className="laser-list-controls">
                    <div className="filter-group" role="group" aria-label="Filtrar OPs da etapa CL">
                      {[
                        ['pending', 'Pendentes'],
                        ['separating', 'Em separação'],
                        ['shortage', 'Falta MP'],
                        ['delivered', 'Entregue na Laser'],
                        ['finished', 'Finalizados'],
                        ['all', 'Todos'],
                      ].map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className={`filter-button ${laserFilter === value ? 'filter-button-active' : ''}`}
                          onClick={() => setLaserFilter(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <span className="integration-sample-count">{laserVisibleRows.length} OPs</span>
                  </div>
                </div>
                {laserVisibleRows.length === 0 ? (
                  <div className="empty-state"><p>Nenhuma OP encontrada para CL · PI DE CORTE LASER</p></div>
                ) : (
                  <div className="integration-table-wrap">
                    <table className={`integration-table integration-production-table ${laserFilter === 'finished' ? 'integration-production-finished' : ''}`}>
                      <thead>
                        <tr>
                          <th scope="col">Job</th>
                          <th scope="col">OP</th>
                          <th scope="col">Ord Prod</th>
                          <th scope="col">Item</th>
                          <th scope="col">Máquina</th>
                          <th scope="col">Reportado / planejado</th>
                          <th scope="col">Retrabalho</th>
                          <th scope="col">Refugo</th>
                          <th scope="col">Responsável</th>
                          <th scope="col">STATUS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {laserVisibleRows.map((row) => {
                          const status = getWarehouseStatusOption(row);
                          return (
                            <tr key={row.orderKey}>
                              <td>{row.job}</td>
                              <th scope="row">{row.op}</th>
                              <td>{row.orderKey}</td>
                              <td title={row.item}>{row.item}</td>
                              <td title={row.machine}>{row.machine}</td>
                              <td>{row.reported} / {row.planned}</td>
                              <td>{row.rework}</td>
                              <td>{row.scrap}</td>
                              <td title={row.reporter}>{row.reporter}</td>
                              <td>
                                {row.finished ? (
                                  <span className={`integration-status status-${status.tone}`}>Finalizado</span>
                                ) : (
                                  <select
                                    className={`warehouse-status-select status-${status.tone}`}
                                    aria-label={`Status da Ord Prod ${row.orderKey}`}
                                    value={status.value}
                                    onChange={(event) => setWarehouseStatusByOrder((current) => ({
                                      ...current,
                                      [row.orderKey]: event.target.value,
                                    }))}
                                  >
                                    {WAREHOUSE_STATUS_OPTIONS.map((option) => (
                                      <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                  </select>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <dialog
                ref={separationDialogRef}
                className="separation-dialog"
                onCancel={() => setSeparationDialogOpen(false)}
                onClose={() => setSeparationDialogOpen(false)}
              >
                <header className="separation-dialog-header">
                  <div>
                    <p className="integration-eyebrow">MOVIMENTAÇÃO DE SAÍDA · CL</p>
                    <h3>Separação de material</h3>
                    <p>Selecione o Job, identifique o responsável e registre a movimentação.</p>
                  </div>
                  <button
                    type="button"
                    className="icon-button separation-dialog-close"
                    aria-label="Fechar separação"
                    onClick={() => setSeparationDialogOpen(false)}
                  >
                    <X className="button-icon" />
                  </button>
                </header>

                <div className="separation-form-grid">
                  <label className="operator-field">
                    <span>Buscar nº do Job</span>
                    <input
                      type="search"
                      value={separationJobQuery}
                      onChange={(event) => setSeparationJobQuery(event.target.value)}
                      placeholder="Ex.: 0311I"
                    />
                  </label>
                  <label className="operator-field">
                    <span>Nº Job</span>
                    <select value={separationJob} onChange={(event) => handleSeparationJobChange(event.target.value)}>
                      <option value="">Selecione um Job</option>
                      {visibleSeparationJobs.map((entry) => (
                        <option key={entry.job} value={entry.job}>
                          {entry.job} · {entry.rows.length} OPs pendentes
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="operator-field">
                    <span>Responsável pela separação</span>
                    <input
                      type="text"
                      value={separationOperator}
                      onChange={(event) => setSeparationOperator(event.target.value)}
                      placeholder="Nome do operador"
                      autoComplete="name"
                    />
                  </label>
                  <label className="operator-field">
                    <span>Data da separação</span>
                    <input type="date" value={separationDate} onChange={(event) => setSeparationDate(event.target.value)} />
                  </label>
                  <label className="operator-field">
                    <span>Máquina</span>
                    <input
                      type="text"
                      list="cl-separation-machines"
                      value={separationMachine}
                      onChange={(event) => setSeparationMachine(event.target.value)}
                      placeholder="Selecione ou informe a máquina"
                    />
                    <datalist id="cl-separation-machines">
                      {separationMachineOptions.map((machine) => <option key={machine} value={machine} />)}
                    </datalist>
                  </label>
                </div>

                {activeSeparationJob && (
                  <p className="separation-job-summary">
                    {activeSeparationJob.rows.length} OPs pendentes serão atualizadas para o Job {activeSeparationJob.job}.
                  </p>
                )}

                <footer className="separation-dialog-actions">
                  <button type="button" className="secondary-button" onClick={() => updateSelectedJobStatus('separating')}>
                    Iniciar separação
                  </button>
                  <button type="button" className="secondary-button" onClick={() => updateSelectedJobStatus('shortage')}>
                    Registrar falta MP
                  </button>
                  <button type="button" className="primary-button" onClick={() => updateSelectedJobStatus('delivered')}>
                    Entregue na Laser
                  </button>
                </footer>
              </dialog>
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
          {visible.map(([job, list]) => {
            const totalQty = list.reduce((sum, op) => sum + op.totalQty, 0);
            const reportedQty = list.reduce((sum, op) => sum + op.reportedQty, 0);
            const jobComplete = jobCompletion.get(job);

            return (
              <details key={job || 'sem-job'} className="job-group">
                <summary className="job-header">
                  <ChevronRight className="job-chevron" />
                  {job ? `Job ${job}` : 'Sem job de corte'}
                  <span className="job-count">{list.length} OP(s)</span>
                  {jobEmissions.get(job) && (
                    <span className="job-emissao">Emissão {jobEmissions.get(job)}</span>
                  )}
                  <span className={`job-status ${jobComplete ? 'job-status-complete' : ''}`}>
                    {jobComplete ? 'Finalizado' : 'Em andamento'}
                  </span>
                  <span className="job-percent">{percent(reportedQty, totalQty)} concluído</span>
                </summary>

                <div className="job-body">
                  {list.map((op) => (
                    <OpCard key={op.num} op={op} />
                  ))}
                </div>
              </details>
            );
          })}
        </div>
        )}
      </main>

      <Toaster richColors position="top-right" />
    </div>
  );
}
