import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MAX_LASER_SCHEDULE_BYTES, validLaserSchedule } from '../src/laser-schedule.js';
import { separationKey, validSeparationUpdate } from '../src/laser-separation.js';

const MAX_CHUNK_BYTES = 1024 * 1024;
const ROWS_PER_CHUNK = 100;
const DATA_FILE = path.resolve('.local', 'dataset.json');
const SCHEDULE_FILE = path.resolve('.local', 'laser-schedule.json');
const SEPARATION_FILE = path.resolve('.local', 'laser-separation.json');

const emptyDataset = () => ({ ops: [], ordens: [], apontamentos: [], updatedAt: null });
const normalizeHeader = (value) =>
  String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

function sendJson(response, body, status = 200) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > maxBytes) {
      const error = new Error('O envio excede o limite permitido.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function validRows(rows, header) {
  return Array.isArray(rows)
    && rows.length <= 100_000
    && rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))
    && (rows.length === 0 || rows.some((row) =>
      Object.keys(row).some((key) => normalizeHeader(key) === header),
    ));
}

function validProductionReports(rows) {
  if (!validRows(rows, 'ord prod')) return false;
  if (rows.length === 0) return true;
  const headers = new Set(Object.keys(rows[0]).map(normalizeHeader));
  return ['desc maquina', 'nome usuario'].every((header) => headers.has(header));
}

function localApi({ dataFile = DATA_FILE, scheduleFile = SCHEDULE_FILE, separationFile = SEPARATION_FILE } = {}) {
  let dataset = emptyDataset();
  let schedule = { rows: [], updatedAt: null };
  let separation = new Map();
  let separationWrites = Promise.resolve();
  const uploads = new Map();
  const datasetReady = readFile(dataFile, 'utf8')
    .then((contents) => {
      dataset = { ...emptyDataset(), ...JSON.parse(contents) };
    })
    .catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  const scheduleReady = readFile(scheduleFile, 'utf8')
    .then((contents) => {
      schedule = JSON.parse(contents);
      if (!validLaserSchedule(schedule.rows) || typeof schedule.updatedAt !== 'string') {
        throw new Error('O sequenciamento local salvo é inválido.');
      }
    })
    .catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  const separationReady = readFile(separationFile, 'utf8')
    .then((contents) => {
      const rows = JSON.parse(contents);
      if (!Array.isArray(rows) || !rows.every(validSeparationUpdate)) {
        throw new Error('Os status de separação locais são inválidos.');
      }
      separation = new Map(rows.map((row) => [separationKey(row.machine, row.program), row]));
    })
    .catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });

  const persist = async () => {
    await mkdir(path.dirname(dataFile), { recursive: true });
    await writeFile(dataFile, JSON.stringify(dataset));
  };

  return {
    name: 'local-api',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url || '/', 'http://localhost');
        if (!url.pathname.startsWith('/api/')) return next();

        try {
          await datasetReady;
          if (url.pathname === '/api/session' && request.method === 'GET') {
            return sendJson(response, { isAdmin: true });
          }
          if (url.pathname === '/api/login' && request.method === 'POST') {
            return sendJson(response, { isAdmin: true });
          }
          if (url.pathname === '/api/logout' && request.method === 'POST') {
            return sendJson(response, { ok: true });
          }
          if (url.pathname === '/api/laser-separation' && request.method === 'GET') {
            await separationReady;
            await separationWrites;
            return sendJson(response, { rows: [...separation.values()] });
          }
          if (url.pathname === '/api/laser-separation' && request.method === 'PUT') {
            await separationReady;
            const update = JSON.parse(await readBody(request, 4096));
            if (!validSeparationUpdate(update)) {
              return sendJson(response, { error: 'Status de separação inválido.' }, 400);
            }
            const save = separationWrites.then(async () => {
              const next = new Map(separation);
              next.set(separationKey(update.machine, update.program), {
                machine: update.machine, program: update.program, status: update.status,
              });
              await mkdir(path.dirname(separationFile), { recursive: true });
              await writeFile(separationFile, JSON.stringify([...next.values()]));
              separation = next;
            });
            separationWrites = save.catch((error) => {
              console.error('Could not save local separation status', error);
            });
            await save;
            return sendJson(response, { ok: true });
          }
          if (url.pathname === '/api/laser-schedule' && request.method === 'GET') {
            await scheduleReady;
            return sendJson(response, schedule);
          }
          if (url.pathname === '/api/laser-schedule' && request.method === 'PUT') {
            await scheduleReady;
            const rows = JSON.parse(await readBody(request, MAX_LASER_SCHEDULE_BYTES));
            if (!validLaserSchedule(rows)) {
              return sendJson(response, { error: 'O sequenciamento contém dados inválidos.' }, 400);
            }
            const nextSchedule = { rows, updatedAt: new Date().toISOString() };
            await mkdir(path.dirname(scheduleFile), { recursive: true });
            await writeFile(scheduleFile, JSON.stringify(nextSchedule));
            schedule = nextSchedule;
            return sendJson(response, { updatedAt: schedule.updatedAt }, 201);
          }
          if (url.pathname === '/api/data' && request.method === 'GET') {
            return sendJson(response, dataset);
          }

          if (url.pathname === '/api/data' && request.method === 'POST') {
            const payload = JSON.parse(await readBody(request, 1024));
            if (payload.action === 'start') {
              if (!Number.isSafeInteger(payload.expectedBytes) || payload.expectedBytes < 1) {
                return sendJson(response, { error: 'O tamanho informado para o envio é inválido.' }, 400);
              }
              const uploadId = randomUUID();
              uploads.set(uploadId, {
                expectedBytes: payload.expectedBytes,
                receivedBytes: 0,
                chunks: {
                  ops: new Map(),
                  ordens: new Map(),
                  apontamentos: new Map(),
                },
              });
              return sendJson(response, { uploadId }, 201);
            }
            if (payload.action === 'complete') {
              const upload = uploads.get(payload.uploadId);
              if (!upload) return sendJson(response, { error: 'Publicação local não encontrada.' }, 404);
              if (upload.receivedBytes !== upload.expectedBytes) {
                return sendJson(response, { error: 'O envio está incompleto.' }, 400);
              }

              const rowsByKind = {};
              for (const kind of ['ops', 'ordens', 'apontamentos']) {
                const chunkCount = payload.chunkCounts?.[kind];
                const rowCount = payload.rowCounts?.[kind];
                const chunks = upload.chunks[kind];
                if (!Number.isInteger(chunkCount) || !Number.isInteger(rowCount)
                  || chunkCount !== Math.ceil(rowCount / ROWS_PER_CHUNK)
                  || chunks.size !== chunkCount) {
                  return sendJson(response, { error: 'Faltam blocos ou linhas no envio.' }, 400);
                }
                rowsByKind[kind] = [];
                for (let index = 0; index < chunkCount; index += 1) {
                  const rows = chunks.get(index);
                  if (!rows) return sendJson(response, { error: 'Faltam blocos no envio.' }, 400);
                  rowsByKind[kind].push(...rows);
                }
                if (rowsByKind[kind].length !== rowCount) {
                  return sendJson(response, { error: 'A quantidade de linhas não confere.' }, 400);
                }
              }

              if (!validRows(rowsByKind.ops, 'numero da op')
                || !validRows(rowsByKind.ordens, 'ord prod')
                || !validProductionReports(rowsByKind.apontamentos)
                || !rowsByKind.ops.length
                || !rowsByKind.ordens.length
                || !rowsByKind.apontamentos.length) {
                return sendJson(response, { error: 'Envie os três relatórios: OPs, Ordens de Produção e Apontamentos.' }, 400);
              }
              dataset = { ...rowsByKind, updatedAt: new Date().toISOString() };
              await persist();
              uploads.delete(payload.uploadId);
              return sendJson(response, { updatedAt: dataset.updatedAt }, 201);
            }
            return sendJson(response, { error: 'Ação local desconhecida.' }, 400);
          }

          if (url.pathname === '/api/data' && request.method === 'PUT') {
            const uploadId = url.searchParams.get('uploadId');
            const upload = uploads.get(uploadId);
            const kind = url.searchParams.get('kind');
            const index = Number(url.searchParams.get('index'));
            if (!upload || !['ops', 'ordens', 'apontamentos'].includes(kind)
              || !Number.isInteger(index) || index < 0) {
              return sendJson(response, { error: 'Bloco de publicação inválido.' }, 400);
            }
            const body = await readBody(request, MAX_CHUNK_BYTES);
            const rows = JSON.parse(body);
            if (!Array.isArray(rows) || rows.length < 1 || rows.length > ROWS_PER_CHUNK
              || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
              return sendJson(response, { error: 'Bloco de dados inválido.' }, 400);
            }
            if (upload.chunks[kind].has(index)) {
              return sendJson(response, { error: 'Bloco já recebido.' }, 409);
            }
            const bytes = Buffer.byteLength(body, 'utf8');
            if (upload.receivedBytes + bytes > upload.expectedBytes) {
              return sendJson(response, { error: 'O envio excede o tamanho informado.' }, 400);
            }
            upload.chunks[kind].set(index, rows);
            upload.receivedBytes += bytes;
            return sendJson(response, { ok: true });
          }

          if (url.pathname === '/api/data' && request.method === 'DELETE') {
            uploads.delete(url.searchParams.get('uploadId'));
            return sendJson(response, { ok: true });
          }
          return sendJson(response, { error: 'Rota local não encontrada.' }, 404);
        } catch (error) {
          if (response.headersSent) return response.destroy(error);
          return sendJson(response, { error: error.message || 'Falha na API local.' }, error.status || 400);
        }
      });
    },
  };
}

export default localApi;
