export const DATASET_COLUMNS = {
  ops: ['Numero da OP', 'Sequencia', 'Job de Corte', 'Quantidade', 'OP', 'Produto', 'DT Emissão', 'Desc Prod', 'Entrega'],
  ordens: ['Ord Prod', 'Quantidade', 'Grup Estoque', 'Descrição GE', 'Quant Rep', 'Quant Retrab', 'Quant Refug', 'DT Emissão', 'Inicio Ordem', 'Fim Ordem'],
};

export const normalizeHeader = (value) =>
  String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

const normalizedHeaders = new Map();
const MAX_CACHED_HEADERS = 4096;

function cachedHeader(value) {
  if (normalizedHeaders.has(value)) return normalizedHeaders.get(value);
  const normalized = normalizeHeader(value);
  if (normalizedHeaders.size < MAX_CACHED_HEADERS) normalizedHeaders.set(value, normalized);
  return normalized;
}

export const getField = (row, header) => {
  const normalizedHeader = cachedHeader(header);
  const key = Object.keys(row).find((candidate) => cachedHeader(candidate) === normalizedHeader);
  return key ? row[key] : '';
};

export function projectRows(rows, kind) {
  const wanted = new Set(DATASET_COLUMNS[kind].map(normalizeHeader));
  const keys = new Map();
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => {
    if (!keys.has(key)) keys.set(key, wanted.has(normalizeHeader(key)));
    return keys.get(key);
  })));
}

export function projectDataset(rowsByKind) {
  return {
    ops: projectRows(rowsByKind.ops, 'ops'),
    ordens: projectRows(rowsByKind.ordens, 'ordens'),
    apontamentos: rowsByKind.apontamentos,
  };
}
