import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.js';

class FakeStatement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  run() {
    return this.db.run(this.query, this.values);
  }

  first() {
    return this.db.first(this.query, this.values);
  }

  all() {
    return this.db.all(this.query, this.values);
  }
}

class FakeD1 {
  attempts = [];
  snapshots = new Map();
  chunks = [];
  activeSnapshotId = null;

  prepare(query) {
    return new FakeStatement(this, query);
  }

  async batch(statements) {
    for (const statement of statements) await statement.run();
  }

  async run(query, values) {
    if (query.startsWith('DELETE FROM login_attempts WHERE attempted_at <')) {
      this.attempts = this.attempts.filter((attempt) => attempt.attemptedAt >= values[0]);
    } else if (query.startsWith('INSERT INTO login_attempts')) {
      this.attempts.push({ ipHash: values[0], attemptedAt: values[1] });
    } else if (query.startsWith('DELETE FROM login_attempts WHERE ip_hash')) {
      this.attempts = this.attempts.filter((attempt) => attempt.ipHash !== values[0]);
    } else if (query.startsWith('INSERT INTO dataset_snapshots')) {
      this.snapshots.set(values[0], values[1]);
    } else if (query.startsWith('INSERT INTO dataset_chunks')) {
      this.chunks.push({
        snapshotId: values[0],
        kind: values[1],
        chunkIndex: values[2],
        payload: values[3],
      });
    } else if (query.startsWith('INSERT INTO active_dataset')) {
      this.activeSnapshotId = values[0];
    } else if (query.startsWith('DELETE FROM dataset_chunks WHERE snapshot_id <>')) {
      this.chunks = this.chunks.filter((chunk) => chunk.snapshotId === values[0]);
    } else if (query.startsWith('DELETE FROM dataset_snapshots WHERE snapshot_id <>')) {
      this.snapshots = new Map([...this.snapshots].filter(([id]) => id === values[0]));
    } else if (query.startsWith('DELETE FROM dataset_chunks WHERE snapshot_id =')) {
      this.chunks = this.chunks.filter((chunk) => chunk.snapshotId !== values[0]);
    } else if (query.startsWith('DELETE FROM dataset_snapshots WHERE snapshot_id =')) {
      this.snapshots.delete(values[0]);
    } else {
      throw new Error(`Unsupported fake D1 statement: ${query}`);
    }
    return { success: true };
  }

  async first(query, values) {
    if (query.startsWith('SELECT COUNT(*) AS attempt_count')) {
      return {
        attempt_count: this.attempts.filter(
          (attempt) => attempt.ipHash === values[0] && attempt.attemptedAt >= values[1],
        ).length,
      };
    }
    if (query.startsWith('SELECT snapshot_id FROM active_dataset')) {
      return this.activeSnapshotId ? { snapshot_id: this.activeSnapshotId } : null;
    }
    if (query.startsWith('SELECT created_at FROM dataset_snapshots')) {
      const createdAt = this.snapshots.get(values[0]);
      return createdAt ? { created_at: createdAt } : null;
    }
    throw new Error(`Unsupported fake D1 query: ${query}`);
  }

  async all(query, values) {
    if (query.startsWith('SELECT kind, payload FROM dataset_chunks')) {
      const results = this.chunks
        .filter((chunk) => chunk.snapshotId === values[0])
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.chunkIndex - b.chunkIndex)
        .map(({ kind, payload }) => ({ kind, payload }));
      return { results };
    }
    throw new Error(`Unsupported fake D1 query: ${query}`);
  }
}

const env = () => ({
  DB: new FakeD1(),
  VIEWER_PASSWORD: 'viewer-password-123',
  ADMIN_PASSWORD: 'admin-password-123',
  SESSION_SECRET: 'test-session-secret-with-more-than-32-bytes',
});

async function request(path, { db, body, method = 'GET', cookie = '', ip = '192.0.2.1' } = {}) {
  const headers = new Headers({ 'CF-Connecting-IP': ip });
  if (method !== 'GET') headers.set('Origin', 'https://visualizador.test');
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (cookie) headers.set('Cookie', cookie);
  const response = await worker.fetch(new Request(`https://visualizador.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), db);
  return response;
}

async function login(db, password, ip) {
  const response = await request('/api/login', { db, method: 'POST', body: { password }, ip });
  const cookie = (response.headers.get('Set-Cookie') || '').split(';')[0];
  return { response, cookie };
}

test('viewer login can read shared data but cannot publish', async () => {
  const bindings = env();
  const { response, cookie } = await login(bindings, bindings.VIEWER_PASSWORD);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Set-Cookie'), /HttpOnly/);

  const session = await request('/api/session', { db: bindings, cookie });
  assert.deepEqual(await session.json(), { isAdmin: false });

  const publish = await request('/api/data', {
    db: bindings,
    method: 'PUT',
    cookie,
    body: { ops: [{ 'Numero da OP': '123' }], ordens: [] },
  });
  assert.equal(publish.status, 403);
});

test('admin can publish a dataset that persists for later reads', async () => {
  const bindings = env();
  const { response, cookie } = await login(bindings, bindings.ADMIN_PASSWORD);
  assert.equal(response.status, 200);

  const ops = [{ 'Numero da OP': '123', Produto: 'ITEM-01' }];
  const publish = await request('/api/data', {
    db: bindings,
    method: 'PUT',
    cookie,
    body: { ops, ordens: [] },
  });
  assert.equal(publish.status, 201);

  const read = await request('/api/data', { db: bindings, cookie });
  const dataset = await read.json();
  assert.deepEqual(dataset.ops, ops);
  assert.deepEqual(dataset.ordens, []);
  assert.ok(dataset.updatedAt);
});

test('login limits repeated failed attempts from the same address', async () => {
  const bindings = env();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { response } = await login(bindings, 'incorrect-password', '192.0.2.2');
    assert.equal(response.status, 401);
  }
  const blocked = await login(bindings, 'incorrect-password', '192.0.2.2');
  assert.equal(blocked.response.status, 429);
});

test('logout expires the session cookie', async () => {
  const bindings = env();
  const { cookie } = await login(bindings, bindings.VIEWER_PASSWORD);
  const logout = await request('/api/logout', { db: bindings, method: 'POST', cookie });
  assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);

  const session = await request('/api/session', { db: bindings, cookie: 'visualizador_session=invalid' });
  assert.equal(session.status, 401);
});
