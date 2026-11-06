import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Search, Network, FileSpreadsheet, FolderOpen, ChevronRight, RefreshCw } from 'lucide-react';
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

function buildTree(ops, ordens) {
  const ordMap = new Map(ordens.map((order) => [
    String(getField(order, 'Ord Prod')).trim(),
    order,
  ]));
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
    const job = (rows.find((r) => r['Job de Corte']) || {})['Job de Corte'] || '';

    const steps = rows.map((row) => {
      const order = ordMap.get(String(getField(row, 'OP')).trim()) || {};
      const qtd = num(order['Quantidade'] !== undefined && order['Quantidade'] !== '' ? order['Quantidade'] : row['Quantidade']);
      const reported = num(order['Quant Rep']);
      const item = String(getField(row, 'Produto') || '');

      return {
        ord: getField(row, 'OP'),
        item,
        sigla: order['Grup Estoque'] || item.slice(5, 7),
        desc: (order['Descrição GE'] || '').replace(/\s+/g, ' '),
        qtd,
        reported,
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
    <details open className="op-card">
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
  const [search, setSearch] = useState('');
  const [filtro, setFiltro] = useState('');
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
      setUpdatedAt(dataset.updatedAt || '');
      if (showToast) toast.success('Dados atualizados');
    } catch (error) {
      setAuthChecked(true);
      if (error.status === 401) {
        setAuthenticated(false);
        setIsAdmin(false);
        setOps([]);
        setOrdens([]);
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
        if (parsed.headers.some((header) => normalizeHeader(header) === 'ord prod')) {
          allOrdens = allOrdens.concat(parsed.data);
        } else if (parsed.headers.some((header) => normalizeHeader(header) === 'numero da op')) {
          allOps = allOps.concat(parsed.data);
        } else {
          ignorados += 1;
        }
      }

      if (!allOps.length && !allOrdens.length) {
        toast.error('Nenhum CSV reconhecido');
        return;
      }

      const nextOps = allOps.length ? allOps : ops;
      const nextOrdens = allOrdens.length ? allOrdens : ordens;
      const chunks = {
        ops: createUploadChunks(nextOps),
        ordens: createUploadChunks(nextOrdens),
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
          rowCounts: { ops: nextOps.length, ordens: nextOrdens.length },
        }),
      });
      finalized = true;

      setOps(nextOps);
      setOrdens(nextOrdens);
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

  const tree = useMemo(() => buildTree(ops, ordens), [ops, ordens]);
  const allOps = useMemo(() => tree.flatMap(([, list]) => list), [tree]);
  const allSteps = useMemo(() => allOps.flatMap((op) => op.steps), [allOps]);
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
    concluidas: allSteps.filter((s) => s.st === 'Concluída').length,
  };

  const q = search.trim().toLowerCase();
  const visible = useMemo(() => {
    const match = (op) =>
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
          list.filter((op) => {
            if (!match(op)) return false;
            if (filtro === 'job-concluido') return jobComplete;
            if (filtro === 'Pendente') return isPendingOp(op);
            return !filtro || op.steps.some((step) => step.st === filtro);
          }),
        ];
      })
      .filter(([, list]) => list.length > 0);
  }, [tree, q, filtro]);

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
        <div className="topbar-inner">
          <div>
            <h1 className="title">
              <Network className="title-icon" />
              Visualizador de Processo
            </h1>
            <p className="subtitle">Job de Corte → OP → Etapas, na ordem em que o processo acontece</p>
          </div>

          <div className="stats-grid">
            {[
              ['Jobs', stats.jobs],
              ['OPs', stats.ops],
              ['Etapas', stats.etapas],
              ['Pendentes', stats.pendentes, 'accent-amber'],
              ['Concluídas', stats.concluidas, 'accent-emerald'],
            ].map(([label, value, className]) => (
              <div key={label} className="stat-box">
                <div className={`stat-value ${className || ''}`}>{value}</div>
                <div className="stat-label">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </header>

      <main className="main-panel">
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

        {authenticated && hasData && (
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

        {hasData && !ordens.length && (
          <p className="helper-text">Falta o relatório de Ordens de Produção: as etapas aparecem sem status.</p>
        )}

        {hasData && visible.length === 0 && (
          <div className="empty-state">
            <p>Nenhuma OP encontrada</p>
          </div>
        )}

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
      </main>

      <Toaster richColors position="top-right" />
    </div>
  );
}
