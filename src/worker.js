import { MAX_LASER_SCHEDULE_BYTES, validLaserSchedule } from './laser-schedule.js';
import { validSeparationUpdate } from './laser-separation.js';
import { projectViewRows } from './dataset-projection.js';

const MAX_UPLOAD_CHUNK_BYTES = 1024 * 1024;
const MAX_ROWS_PER_KIND = 100_000;
const ROWS_PER_CHUNK = 100;
const READ_CHUNKS_PER_QUERY = 10;
const READ_QUERY_CONCURRENCY = 3;
const MAX_SINGLE_READ_BYTES = 40 * 1024 * 1024;
const MAX_CHUNKS_PER_KIND = MAX_ROWS_PER_KIND / ROWS_PER_CHUNK;
const STATEMENTS_PER_BATCH = 50;
const SESSION_DURATION_SECONDS = 8 * 60 * 60;
const SESSION_COOKIE = 'visualizador_session';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });

const normalizeHeader = (value) =>
  String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function getSessionSecret(env) {
  const secret = env.SESSION_SECRET || '';
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 bytes');
  }
  return secret;
}

async function signSession(payload, env) {
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getSessionSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(encodedPayload),
  );
  return `${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function verifySession(token, env) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  let payload;
  let signature;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    signature = decodeBase64Url(parts[1]);
  } catch {
    return null;
  }
  if (!payload || !['viewer', 'admin'].includes(payload.role)) return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) return null;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getSessionSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    new TextEncoder().encode(parts[0]),
  );
  return valid ? { role: payload.role } : null;
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const prefix = `${name}=`;
  const entry = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : '';
}

function cookieOptions(request, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function isSameOrigin(request) {
  return request.headers.get('Origin') === new URL(request.url).origin;
}

function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

function getRole(password, env) {
  const viewerPassword = env.VIEWER_PASSWORD || '';
  const adminPassword = env.ADMIN_PASSWORD || '';
  if (viewerPassword.length < 12 || adminPassword.length < 12) {
    throw new Error('VIEWER_PASSWORD and ADMIN_PASSWORD must each contain at least 12 characters');
  }
  if (constantTimeEqual(viewerPassword, adminPassword)) {
    throw new Error('VIEWER_PASSWORD and ADMIN_PASSWORD must be different');
  }
  const isAdmin = constantTimeEqual(password, adminPassword);
  const isViewer = constantTimeEqual(password, viewerPassword);
  if (isAdmin) return 'admin';
  if (isViewer) return 'viewer';
  return null;
}

async function getLoginAttemptKey(request) {
  const address = request.headers.get('CF-Connecting-IP') || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function registerFailedLoginAttempt(db, ipHash) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const expired = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  await db.prepare('DELETE FROM login_attempts WHERE attempted_at < ?').bind(expired).run();
  const result = await db
    .prepare('SELECT COUNT(*) AS attempt_count FROM login_attempts WHERE ip_hash = ? AND attempted_at >= ?')
    .bind(ipHash, cutoff)
    .first();
  if (result.attempt_count >= 5) return true;
  await db
    .prepare('INSERT INTO login_attempts (ip_hash, attempted_at) VALUES (?, ?)')
    .bind(ipHash, now.toISOString())
    .run();
  return false;
}

function validateRows(rows, header) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_KIND) return false;
  if (rows.some((row) => row === null || typeof row !== 'object' || Array.isArray(row))) return false;
  if (rows.length === 0) return true;

  const requiredHeader = normalizeHeader(header);
  return rows.some((row) =>
    Object.keys(row).some((key) => normalizeHeader(key) === requiredHeader),
  );
}

function validateProductionReportRows(rows) {
  return validateRows(rows, 'Ord Prod')
    && ['Desc Máquina', 'Nome Usuário'].every((header) =>
      rows.some((row) =>
        Object.keys(row).some((key) => normalizeHeader(key) === normalizeHeader(header)),
      ),
    );
}

function validateUploadChunk(rows, kind, chunkIndex) {
  if (
    !Array.isArray(rows)
    || rows.length === 0
    || rows.length > ROWS_PER_CHUNK
    || rows.some((row) => row === null || typeof row !== 'object' || Array.isArray(row))
  ) return false;
  if (chunkIndex !== 0) return true;
  if (kind === 'ops') return validateRows(rows, 'Numero da OP');
  if (kind === 'ordens') return validateRows(rows, 'Ord Prod');
  return validateProductionReportRows(rows);
}

async function* readDatasetChunks(db, snapshotId, updatedAt, expectedBytes, compact = false) {
  const encoder = new TextEncoder();
  yield encoder.encode('{"ops":[');

  const kinds = ['ops', 'ordens', 'apontamentos'];
  let table = 'dataset_chunks';
  let projectOnRead = false;
  if (compact) {
    const count = await db.prepare('SELECT COUNT(*) AS chunk_count FROM dataset_view_chunks WHERE snapshot_id = ?')
      .bind(snapshotId).first();
    if (count.chunk_count) {
      table = 'dataset_view_chunks';
      expectedBytes = 0;
    } else {
      projectOnRead = true;
    }
  }
  const contents = (chunk, kind) => projectOnRead
    ? JSON.stringify(projectViewRows(JSON.parse(chunk.payload), kind)).slice(1, -1)
    : chunk.payload.slice(1, -1);
  let canReadAllChunks = expectedBytes > 0 && expectedBytes <= MAX_SINGLE_READ_BYTES;
  let chunkCounts = new Map();
  if (!canReadAllChunks) {
    const summary = await db
      .prepare(`
        SELECT kind, COUNT(*) AS chunk_count, SUM(length(CAST(payload AS BLOB))) AS payload_bytes
        FROM ${table} WHERE snapshot_id = ? GROUP BY kind
      `)
      .bind(snapshotId)
      .all();
    const payloadSizes = new Map(summary.results.map((row) => [row.kind, row.payload_bytes]));
    chunkCounts = new Map(summary.results.map((row) => [row.kind, row.chunk_count]));
    canReadAllChunks = kinds.reduce(
      (total, kind) => total + (payloadSizes.get(kind) || 0), 0,
    ) <= MAX_SINGLE_READ_BYTES;
  }

  if (canReadAllChunks) {
    const chunksByKind = await Promise.all(kinds.map(async (kind) => {
      const result = await db
        .prepare(`
          SELECT chunk_index, payload FROM ${table}
          WHERE snapshot_id = ? AND kind = ?
          ORDER BY chunk_index LIMIT ?
        `)
        .bind(snapshotId, kind, MAX_CHUNKS_PER_KIND)
        .all();
      return [kind, result.results];
    }));

    for (const [index, [kind, chunks]] of chunksByKind.entries()) {
      let hasRows = false;
      for (const chunk of chunks) {
        const rows = contents(chunk, kind);
        if (rows) {
          yield encoder.encode(`${hasRows ? ',' : ''}${rows}`);
          hasRows = true;
        }
      }
      yield encoder.encode(index === kinds.length - 1
        ? `],"updatedAt":${JSON.stringify(updatedAt)}}`
        : `],"${kinds[index + 1]}":[`);
    }
    return;
  }

  for (const kind of kinds) {
    let nextChunkIndex = 0;
    let hasRows = false;
    const chunkCount = chunkCounts.get(kind) || 0;
    while (nextChunkIndex < chunkCount) {
      const pagesToRead = Math.min(
        READ_QUERY_CONCURRENCY,
        Math.ceil((chunkCount - nextChunkIndex) / READ_CHUNKS_PER_QUERY),
      );
      const pages = await Promise.all(
        Array.from({ length: pagesToRead }, (_, pageIndex) => {
          const pageStart = nextChunkIndex + pageIndex * READ_CHUNKS_PER_QUERY;
          return db
            .prepare(`
              SELECT chunk_index, payload FROM ${table}
              WHERE snapshot_id = ? AND kind = ? AND chunk_index >= ? AND chunk_index < ?
              ORDER BY chunk_index LIMIT ?
            `)
            .bind(
              snapshotId,
              kind,
              pageStart,
              pageStart + READ_CHUNKS_PER_QUERY,
              READ_CHUNKS_PER_QUERY,
            )
            .all();
        }),
      );

      for (const page of pages) {
        if (!page.results.length) {
          nextChunkIndex = chunkCount;
          break;
        }

        for (const chunk of page.results) {
          const rows = contents(chunk, kind);
          if (rows) {
            yield encoder.encode(`${hasRows ? ',' : ''}${rows}`);
            hasRows = true;
          }
        }

        if (page.results.length < READ_CHUNKS_PER_QUERY) {
          nextChunkIndex = chunkCount;
          break;
        }
      }

      nextChunkIndex += READ_CHUNKS_PER_QUERY * pagesToRead;
    }

    yield encoder.encode(kind === 'apontamentos'
      ? `],"updatedAt":${JSON.stringify(updatedAt)}}`
      : `],"${kinds[kinds.indexOf(kind) + 1]}":[`);
  }
}

async function readDataset(db, compact = false) {
  const active = await db
    .prepare('SELECT snapshot_id FROM active_dataset WHERE singleton = 1')
    .first();
  if (!active) return { ops: [], ordens: [], apontamentos: [], updatedAt: null };

  const snapshot = await db
    .prepare('SELECT created_at, upload_expected_bytes FROM dataset_snapshots WHERE snapshot_id = ?')
    .bind(active.snapshot_id)
    .first();
  if (!snapshot) throw new Error('Active dataset snapshot is missing');

  const iterator = readDatasetChunks(
    db,
    active.snapshot_id,
    snapshot.created_at,
    snapshot.upload_expected_bytes,
    compact,
  );
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      return iterator.return();
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function createChunks(snapshotId, kind, rows) {
  const chunks = [];
  for (let offset = 0; offset < rows.length; offset += ROWS_PER_CHUNK) {
    chunks.push({
      snapshotId,
      kind,
      chunkIndex: offset / ROWS_PER_CHUNK,
      payload: JSON.stringify(rows.slice(offset, offset + ROWS_PER_CHUNK)),
    });
  }
  return chunks;
}

async function cleanupExpiredUploads(db) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const active = await db
    .prepare('SELECT snapshot_id FROM active_dataset WHERE singleton = 1')
    .first();
  const activeSnapshotId = active?.snapshot_id || '';
  await db.batch([
    db.prepare(`
      DELETE FROM dataset_chunks WHERE snapshot_id IN (
        SELECT snapshot_id FROM dataset_snapshots
        WHERE created_at < ? AND snapshot_id <> ?
      )
    `).bind(cutoff, activeSnapshotId),
    db.prepare(`
      DELETE FROM dataset_snapshots WHERE created_at < ? AND snapshot_id <> ?
    `).bind(cutoff, activeSnapshotId),
  ]);
}

async function startDatasetUpload(db, expectedBytes) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) {
    return { error: 'O tamanho informado para o envio é inválido.', status: 400 };
  }

  await cleanupExpiredUploads(db);
  const snapshotId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db
    .prepare(`
      INSERT INTO dataset_snapshots (
        snapshot_id, created_at, upload_expected_bytes, upload_received_bytes
      ) VALUES (?, ?, ?, 0)
    `)
    .bind(snapshotId, createdAt, expectedBytes)
    .run();
  return { uploadId: snapshotId, createdAt };
}

async function uploadDatasetChunk(db, uploadId, kind, chunkIndex, body, rows) {
  if (
    !uploadId
    || !['ops', 'ordens', 'apontamentos'].includes(kind)
    || !Number.isInteger(chunkIndex)
    || chunkIndex < 0
    || chunkIndex >= Math.ceil(MAX_ROWS_PER_KIND / ROWS_PER_CHUNK)
    || !validateUploadChunk(rows, kind, chunkIndex)
  ) {
    return { error: 'Bloco de dados inválido.', status: 400 };
  }

  const snapshot = await db
    .prepare(`
      SELECT upload_expected_bytes, upload_received_bytes
      FROM dataset_snapshots WHERE snapshot_id = ?
    `)
    .bind(uploadId)
    .first();
  if (!snapshot) return { error: 'A publicação temporária não existe mais.', status: 404 };

  const active = await db
    .prepare('SELECT snapshot_id FROM active_dataset WHERE singleton = 1')
    .first();
  if (active?.snapshot_id === uploadId) {
    return { error: 'Este conjunto já foi publicado.', status: 409 };
  }

  const bodyBytes = new TextEncoder().encode(body).byteLength;
  if (bodyBytes > MAX_UPLOAD_CHUNK_BYTES) {
    return { error: 'Um bloco do envio excede 1 MiB.', status: 413 };
  }
  if (snapshot.upload_received_bytes + bodyBytes > snapshot.upload_expected_bytes) {
    return { error: 'O envio excede o tamanho informado.', status: 400 };
  }

  try {
    await db.batch([
      db.prepare(`
        INSERT INTO dataset_chunks (snapshot_id, kind, chunk_index, payload)
        VALUES (?, ?, ?, ?)
      `).bind(uploadId, kind, chunkIndex, body),
      db.prepare(`
        INSERT INTO dataset_view_chunks (snapshot_id, kind, chunk_index, payload)
        VALUES (?, ?, ?, ?)
      `).bind(uploadId, kind, chunkIndex, JSON.stringify(projectViewRows(rows, kind))),
      db.prepare(`
        UPDATE dataset_snapshots
        SET upload_received_bytes = upload_received_bytes + ?
        WHERE snapshot_id = ?
      `).bind(bodyBytes, uploadId),
    ]);
  } catch (error) {
    console.error('Could not register dataset upload chunk', error);
    return { error: 'Não foi possível registrar um bloco do envio.', status: 409 };
  }
  return { ok: true };
}

async function getUploadChunkSummary(db, uploadId, kind) {
  return db
    .prepare(`
      SELECT COUNT(*) AS chunk_count, MAX(chunk_index) AS max_chunk_index,
        SUM(json_array_length(payload)) AS row_count,
        SUM(length(CAST(payload AS BLOB))) AS byte_count
      FROM dataset_chunks WHERE snapshot_id = ? AND kind = ?
    `)
    .bind(uploadId, kind)
    .first();
}

async function activateDataset(db, snapshotId) {
  await db
    .prepare(`
      INSERT INTO active_dataset (singleton, snapshot_id) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET snapshot_id = excluded.snapshot_id
    `)
    .bind(snapshotId)
    .run();

  try {
    await db.batch([
      db.prepare('DELETE FROM dataset_chunks WHERE snapshot_id <> ?').bind(snapshotId),
      db.prepare('DELETE FROM dataset_snapshots WHERE snapshot_id <> ?').bind(snapshotId),
    ]);
  } catch (error) {
    console.error('Published dataset, but could not remove old snapshots', error);
  }
}

async function completeDatasetUpload(db, payload) {
  const { uploadId, chunkCounts, rowCounts } = payload || {};
  const snapshot = await db
    .prepare(`
      SELECT created_at, upload_expected_bytes, upload_received_bytes
      FROM dataset_snapshots WHERE snapshot_id = ?
    `)
    .bind(uploadId || '')
    .first();
  if (!snapshot) return { error: 'A publicação temporária não existe mais.', status: 404 };
  if (snapshot.upload_received_bytes !== snapshot.upload_expected_bytes) {
    return { error: 'O envio está incompleto.', status: 400 };
  }

  let totalRows = 0;
  let totalBytes = 0;
  for (const kind of ['ops', 'ordens', 'apontamentos']) {
    const expectedChunks = chunkCounts?.[kind];
    const expectedRows = rowCounts?.[kind];
    if (
      !Number.isInteger(expectedChunks)
      || expectedChunks < 0
      || expectedChunks > Math.ceil(MAX_ROWS_PER_KIND / ROWS_PER_CHUNK)
      || !Number.isInteger(expectedRows)
      || expectedRows < 1
      || expectedRows > MAX_ROWS_PER_KIND
      || expectedChunks !== Math.ceil(expectedRows / ROWS_PER_CHUNK)
    ) {
      return { error: 'O manifesto do envio é inválido.', status: 400 };
    }

    const actual = await getUploadChunkSummary(db, uploadId, kind);
    if (
      actual.chunk_count !== expectedChunks
      || (expectedChunks > 0 && actual.max_chunk_index !== expectedChunks - 1)
      || (actual.row_count || 0) !== expectedRows
    ) {
      return { error: 'Faltam blocos ou linhas no envio.', status: 400 };
    }
    const view = await db.prepare(`
      SELECT COUNT(*) AS chunk_count, MAX(chunk_index) AS max_chunk_index,
        SUM(json_array_length(payload)) AS row_count
      FROM dataset_view_chunks WHERE snapshot_id = ? AND kind = ?
    `).bind(uploadId, kind).first();
    if (view.chunk_count !== expectedChunks || view.max_chunk_index !== expectedChunks - 1
      || (view.row_count || 0) !== expectedRows) {
      return { error: 'Faltam blocos na versão de consulta.', status: 400 };
    }
    totalRows += expectedRows;
    totalBytes += actual.byte_count || 0;
  }

  if (totalRows === 0 || totalBytes !== snapshot.upload_expected_bytes) {
    return { error: 'O envio não corresponde aos dados recebidos.', status: 400 };
  }

  await activateDataset(db, uploadId);
  return { updatedAt: snapshot.created_at };
}

async function abortDatasetUpload(db, uploadId) {
  if (!uploadId) return { error: 'Identificador de publicação inválido.', status: 400 };
  const active = await db
    .prepare('SELECT snapshot_id FROM active_dataset WHERE singleton = 1')
    .first();
  if (active?.snapshot_id === uploadId) {
    return { error: 'O conjunto já foi publicado e não pode ser cancelado.', status: 409 };
  }
  await db.batch([
    db.prepare('DELETE FROM dataset_chunks WHERE snapshot_id = ?').bind(uploadId),
    db.prepare('DELETE FROM dataset_snapshots WHERE snapshot_id = ?').bind(uploadId),
  ]);
  return { ok: true };
}

async function publishDataset(db, rowsByKind) {
  const snapshotId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db
    .prepare('INSERT INTO dataset_snapshots (snapshot_id, created_at) VALUES (?, ?)')
    .bind(snapshotId, createdAt)
    .run();

  try {
    const chunks = [
      ...createChunks(snapshotId, 'ops', rowsByKind.ops),
      ...createChunks(snapshotId, 'ordens', rowsByKind.ordens),
      ...createChunks(snapshotId, 'apontamentos', rowsByKind.apontamentos || []),
    ];

    const chunksPerBatch = Math.floor(STATEMENTS_PER_BATCH / 2);
    for (let offset = 0; offset < chunks.length; offset += chunksPerBatch) {
      const batch = chunks.slice(offset, offset + chunksPerBatch).flatMap((chunk) => [
        db.prepare('INSERT INTO dataset_chunks (snapshot_id, kind, chunk_index, payload) VALUES (?, ?, ?, ?)')
          .bind(chunk.snapshotId, chunk.kind, chunk.chunkIndex, chunk.payload),
        db.prepare('INSERT INTO dataset_view_chunks (snapshot_id, kind, chunk_index, payload) VALUES (?, ?, ?, ?)')
          .bind(chunk.snapshotId, chunk.kind, chunk.chunkIndex,
            JSON.stringify(projectViewRows(JSON.parse(chunk.payload), chunk.kind))),
      ]);
      await db.batch(batch);
    }

    await activateDataset(db, snapshotId);

    return createdAt;
  } catch (error) {
    try {
      await db.batch([
        db.prepare('DELETE FROM dataset_chunks WHERE snapshot_id = ?').bind(snapshotId),
        db.prepare('DELETE FROM dataset_snapshots WHERE snapshot_id = ?').bind(snapshotId),
      ]);
    } catch (cleanupError) {
      console.error('Could not clean up incomplete dataset snapshot', cleanupError);
    }
    throw error;
  }
}

async function handleApi(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/api/login' && request.method === 'POST') {
    if (!isSameOrigin(request)) return json({ error: 'Origem da solicitação não permitida.' }, 403);
    if (Number(request.headers.get('Content-Length') || 0) > 1024) {
      return json({ error: 'Solicitação de login inválida.' }, 413);
    }

    let payload;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > 1024) {
        return json({ error: 'Solicitação de login inválida.' }, 413);
      }
      payload = JSON.parse(body);
    } catch {
      return json({ error: 'Informe a senha de acesso.' }, 400);
    }
    if (typeof payload?.password !== 'string' || payload.password.length > 256) {
      return json({ error: 'Informe uma senha válida.' }, 400);
    }

    let role;
    try {
      role = getRole(payload.password, env);
    } catch (error) {
      console.error('Authentication secrets are not configured', error);
      return json({ error: 'O acesso ainda não está configurado pelo administrador.' }, 503);
    }
    if (!role) {
      try {
        const ipHash = await getLoginAttemptKey(request);
        if (await registerFailedLoginAttempt(env.DB, ipHash)) {
          return json({ error: 'Muitas tentativas de login. Aguarde 15 minutos e tente novamente.' }, 429);
        }
      } catch (error) {
        console.error('Could not apply login rate limit', error);
        return json({ error: 'Não foi possível validar o acesso. Tente novamente mais tarde.' }, 503);
      }
      return json({ error: 'Senha incorreta.' }, 401);
    }

    try {
      const token = await signSession({
        role,
        exp: Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS,
      }, env);
      const cookie = `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DURATION_SECONDS}${url.protocol === 'https:' ? '; Secure' : ''}`;
      return json({ isAdmin: role === 'admin' }, 200, { 'Set-Cookie': cookie });
    } catch (error) {
      console.error('Could not create an authenticated session', error);
      return json({ error: 'Não foi possível iniciar a sessão.' }, 503);
    }
  }

  if (url.pathname === '/api/logout' && request.method === 'POST') {
    if (!isSameOrigin(request)) return json({ error: 'Origem da solicitação não permitida.' }, 403);
    return json({ ok: true }, 200, { 'Set-Cookie': cookieOptions(request, 0) });
  }

  let session;
  try {
    session = await verifySession(getCookie(request, SESSION_COOKIE), env);
  } catch (error) {
    console.error('Could not validate the session', error);
    return json({ error: 'Não foi possível validar a sessão.' }, 503);
  }
  if (!session) return json({ error: 'A sessão expirou. Entre novamente para continuar.' }, 401);

  if (url.pathname === '/api/session' && request.method === 'GET') {
    return json({ isAdmin: session.role === 'admin' });
  }

  if (url.pathname === '/api/laser-separation' && request.method === 'GET') {
    try {
      const result = await env.DB.prepare('SELECT machine, program, status FROM laser_separation').all();
      return json({ rows: result.results });
    } catch (error) {
      console.error('Could not read laser separation statuses', error);
      return json({ error: 'Não foi possível carregar os status de separação.' }, 500);
    }
  }

  if (url.pathname === '/api/laser-separation' && request.method === 'PUT') {
    if (!isSameOrigin(request)) return json({ error: 'Origem da solicitação não permitida.' }, 403);
    if (session.role !== 'admin') return json({ error: 'Somente administradores podem alterar a separação.' }, 403);
    if (Number(request.headers.get('Content-Length') || 0) > 4096) {
      return json({ error: 'Solicitação de separação excede o limite.' }, 413);
    }
    let update;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > 4096) {
        return json({ error: 'Solicitação de separação excede o limite.' }, 413);
      }
      update = JSON.parse(body);
    } catch {
      return json({ error: 'Solicitação de separação inválida.' }, 400);
    }
    if (!validSeparationUpdate(update)) return json({ error: 'Status de separação inválido.' }, 400);
    try {
      await env.DB.prepare(`
        INSERT INTO laser_separation (machine, program, status) VALUES (?, ?, ?)
        ON CONFLICT(machine, program) DO UPDATE SET status = excluded.status
      `).bind(update.machine, update.program, update.status).run();
      return json({ ok: true });
    } catch (error) {
      console.error('Could not save laser separation status', error);
      return json({ error: 'Não foi possível salvar o status de separação.' }, 500);
    }
  }

  if (url.pathname === '/api/laser-schedule' && request.method === 'GET') {
    try {
      const saved = await env.DB.prepare('SELECT payload, updated_at FROM laser_schedule WHERE singleton = 1').first();
      return json(saved ? { rows: JSON.parse(saved.payload), updatedAt: saved.updated_at } : { rows: [], updatedAt: null });
    } catch (error) {
      console.error('Could not read laser schedule', error);
      return json({ error: 'Não foi possível carregar o sequenciamento laser.' }, 500);
    }
  }

  if (url.pathname === '/api/laser-schedule' && request.method === 'PUT') {
    if (!isSameOrigin(request)) return json({ error: 'Origem da solicitação não permitida.' }, 403);
    if (session.role !== 'admin') return json({ error: 'Somente administradores podem importar o sequenciamento.' }, 403);
    if (Number(request.headers.get('Content-Length') || 0) > MAX_LASER_SCHEDULE_BYTES) {
      return json({ error: 'O sequenciamento excede 1 MiB.' }, 413);
    }
    let rows;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_LASER_SCHEDULE_BYTES) {
        return json({ error: 'O sequenciamento excede 1 MiB.' }, 413);
      }
      rows = JSON.parse(body);
    } catch {
      return json({ error: 'O sequenciamento enviado não é um JSON válido.' }, 400);
    }
    if (!validLaserSchedule(rows)) return json({ error: 'O sequenciamento contém dados inválidos.' }, 400);
    const updatedAt = new Date().toISOString();
    try {
      await env.DB.prepare(`
        INSERT INTO laser_schedule (singleton, payload, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `).bind(JSON.stringify(rows), updatedAt).run();
      return json({ updatedAt }, 201);
    } catch (error) {
      console.error('Could not save laser schedule', error);
      return json({ error: 'Não foi possível salvar o sequenciamento laser.' }, 500);
    }
  }

  if (url.pathname === '/api/data' && request.method === 'GET') {
    try {
      return await readDataset(env.DB, url.searchParams.get('view') === 'compact');
    } catch (error) {
      console.error('Could not read the shared dataset', error);
      return json({ error: 'Não foi possível carregar os Jobs publicados.' }, 500);
    }
  }

  if (url.pathname === '/api/data' && request.method === 'POST') {
    if (!isSameOrigin(request)) return json({ error: 'Origem da solicitação não permitida.' }, 403);
    if (session.role !== 'admin') {
      return json({ error: 'Somente administradores podem publicar arquivos.' }, 403);
    }
    if (Number(request.headers.get('Content-Length') || 0) > 1024) {
      return json({ error: 'Solicitação de publicação inválida.' }, 413);
    }

    let payload;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > 1024) {
        return json({ error: 'Solicitação de publicação inválida.' }, 413);
      }
      payload = JSON.parse(body);
    } catch {
      return json({ error: 'Solicitação de publicação inválida.' }, 400);
    }

    try {
      if (payload?.action === 'start') {
        const result = await startDatasetUpload(env.DB, payload.expectedBytes);
        if (result.error) return json({ error: result.error }, result.status);
        return json(result, 201);
      }
      if (payload?.action === 'complete') {
        const result = await completeDatasetUpload(env.DB, payload);
        if (result.error) return json({ error: result.error }, result.status);
        return json({ updatedAt: result.updatedAt }, 201);
      }
      return json({ error: 'Ação de publicação desconhecida.' }, 400);
    } catch (error) {
      console.error('Could not process dataset upload', error);
      return json({ error: 'Não foi possível processar a publicação.' }, 500);
    }
  }

  if (url.pathname === '/api/data' && request.method === 'DELETE') {
    if (!isSameOrigin(request)) return json({ error: 'Origem da solicitação não permitida.' }, 403);
    if (session.role !== 'admin') {
      return json({ error: 'Somente administradores podem cancelar publicações.' }, 403);
    }
    try {
      const result = await abortDatasetUpload(env.DB, url.searchParams.get('uploadId'));
      if (result.error) return json({ error: result.error }, result.status);
      return json(result);
    } catch (error) {
      console.error('Could not cancel dataset upload', error);
      return json({ error: 'Não foi possível cancelar a publicação.' }, 500);
    }
  }

  if (url.pathname === '/api/data' && request.method === 'PUT' && url.searchParams.has('uploadId')) {
    if (!isSameOrigin(request)) return json({ error: 'Origem da solicitação não permitida.' }, 403);
    if (session.role !== 'admin') {
      return json({ error: 'Somente administradores podem publicar arquivos.' }, 403);
    }
    if (Number(request.headers.get('Content-Length') || 0) > MAX_UPLOAD_CHUNK_BYTES) {
      return json({ error: 'Um bloco do envio excede 1 MiB.' }, 413);
    }

    let body;
    let rows;
    try {
      body = await request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_UPLOAD_CHUNK_BYTES) {
        return json({ error: 'Um bloco do envio excede 1 MiB.' }, 413);
      }
      rows = JSON.parse(body);
    } catch {
      return json({ error: 'O bloco enviado não é um JSON válido.' }, 400);
    }

    try {
      const result = await uploadDatasetChunk(
        env.DB,
        url.searchParams.get('uploadId'),
        url.searchParams.get('kind'),
        Number(url.searchParams.get('index')),
        body,
        rows,
      );
      if (result.error) return json({ error: result.error }, result.status);
      return json(result);
    } catch (error) {
      console.error('Could not store dataset upload chunk', error);
      return json({ error: 'Não foi possível salvar um bloco do envio.' }, 500);
    }
  }

  if (url.pathname === '/api/data' && request.method === 'PUT') {
    if (!isSameOrigin(request)) return json({ error: 'Origem da solicitação não permitida.' }, 403);
    if (session.role !== 'admin') {
      return json({ error: 'Somente administradores podem publicar arquivos.' }, 403);
    }
    if (Number(request.headers.get('Content-Length') || 0) > MAX_UPLOAD_CHUNK_BYTES) {
      return json({ error: 'Envie os dados em blocos usando a versão atualizada do aplicativo.' }, 413);
    }

    let payload;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_UPLOAD_CHUNK_BYTES) {
        return json({ error: 'Envie os dados em blocos usando a versão atualizada do aplicativo.' }, 413);
      }
      payload = JSON.parse(body);
    } catch {
      return json({ error: 'O conteúdo enviado não é um JSON válido.' }, 400);
    }

    if (
      !payload
      || !validateRows(payload.ops, 'Numero da OP')
      || !validateRows(payload.ordens, 'Ord Prod')
      || !validateProductionReportRows(payload.apontamentos)
      || (
        payload.ops.length === 0
        || payload.ordens.length === 0
        || payload.apontamentos.length === 0
      )
    ) {
      return json({ error: 'Os arquivos não contêm os cabeçalhos esperados de OPs, Ordens de Produção ou Apontamentos.' }, 400);
    }

    try {
      const updatedAt = await publishDataset(env.DB, payload);
      return json({ updatedAt }, 201);
    } catch (error) {
      console.error('Could not publish the shared dataset', error);
      return json({ error: 'Não foi possível salvar os dados compartilhados.' }, 500);
    }
  }

  return json({ error: 'Rota da API não encontrada.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};
