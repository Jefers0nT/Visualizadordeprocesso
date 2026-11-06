const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_ROWS_PER_KIND = 100_000;
const ROWS_PER_CHUNK = 100;
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

async function readDataset(db) {
  const active = await db
    .prepare('SELECT snapshot_id FROM active_dataset WHERE singleton = 1')
    .first();
  if (!active) return { ops: [], ordens: [], updatedAt: null };

  const snapshot = await db
    .prepare('SELECT created_at FROM dataset_snapshots WHERE snapshot_id = ?')
    .bind(active.snapshot_id)
    .first();
  if (!snapshot) throw new Error('Active dataset snapshot is missing');

  const result = await db
    .prepare('SELECT kind, payload FROM dataset_chunks WHERE snapshot_id = ? ORDER BY kind, chunk_index')
    .bind(active.snapshot_id)
    .all();

  const dataset = { ops: [], ordens: [], updatedAt: snapshot.created_at };
  for (const chunk of result.results) {
    const rows = JSON.parse(chunk.payload);
    if (chunk.kind === 'ops') dataset.ops.push(...rows);
    if (chunk.kind === 'ordens') dataset.ordens.push(...rows);
  }
  return dataset;
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
    ];

    for (let offset = 0; offset < chunks.length; offset += STATEMENTS_PER_BATCH) {
      const batch = chunks.slice(offset, offset + STATEMENTS_PER_BATCH).map((chunk) =>
        db.prepare(
          'INSERT INTO dataset_chunks (snapshot_id, kind, chunk_index, payload) VALUES (?, ?, ?, ?)',
        ).bind(chunk.snapshotId, chunk.kind, chunk.chunkIndex, chunk.payload),
      );
      await db.batch(batch);
    }

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

  if (url.pathname === '/api/data' && request.method === 'GET') {
    try {
      return json(await readDataset(env.DB));
    } catch (error) {
      console.error('Could not read the shared dataset', error);
      return json({ error: 'Não foi possível carregar os Jobs publicados.' }, 500);
    }
  }

  if (url.pathname === '/api/data' && request.method === 'PUT') {
    if (!isSameOrigin(request)) return json({ error: 'Origem da solicitação não permitida.' }, 403);
    if (session.role !== 'admin') {
      return json({ error: 'Somente administradores podem publicar arquivos.' }, 403);
    }
    if (Number(request.headers.get('Content-Length') || 0) > MAX_UPLOAD_BYTES) {
      return json({ error: 'Os arquivos excedem o limite de envio de 25 MB.' }, 413);
    }

    let payload;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_UPLOAD_BYTES) {
        return json({ error: 'Os arquivos excedem o limite de envio de 25 MB.' }, 413);
      }
      payload = JSON.parse(body);
    } catch {
      return json({ error: 'O conteúdo enviado não é um JSON válido.' }, 400);
    }

    if (
      !payload
      || !validateRows(payload.ops, 'Numero da OP')
      || !validateRows(payload.ordens, 'Ord Prod')
      || payload.ops.length === 0 && payload.ordens.length === 0
    ) {
      return json({ error: 'Os arquivos não contêm os cabeçalhos esperados de OPs ou Ordens de Produção.' }, 400);
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
