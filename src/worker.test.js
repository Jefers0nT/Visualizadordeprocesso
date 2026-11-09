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
  snapshotSizes = new Map();
  uploadState = new Map();
  chunks = [];
  activeSnapshotId = null;
  datasetReadPages = 0;
  activeDatasetReadPages = 0;
  maxConcurrentDatasetReadPages = 0;

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
    } else if (query.startsWith('DELETE FROM dataset_chunks WHERE snapshot_id IN')) {
      const expiredIds = [...this.snapshots]
        .filter(([id, createdAt]) => id !== values[1] && createdAt < values[0])
        .map(([id]) => id);
      this.chunks = this.chunks.filter((chunk) => !expiredIds.includes(chunk.snapshotId));
    } else if (query.startsWith('DELETE FROM dataset_snapshots WHERE created_at <')) {
      for (const [id, createdAt] of this.snapshots) {
        if (id !== values[1] && createdAt < values[0]) {
          this.snapshots.delete(id);
          this.snapshotSizes.delete(id);
          this.uploadState.delete(id);
        }
      }
    } else if (query.startsWith('INSERT INTO dataset_snapshots')) {
      this.snapshots.set(values[0], values[1]);
      this.snapshotSizes.set(values[0], values[2] || 0);
      if (values.length > 2) {
        this.uploadState.set(values[0], { expectedBytes: values[2], receivedBytes: values[3] ?? 0 });
      }
    } else if (query.startsWith('INSERT INTO dataset_chunks')) {
      if (this.chunks.some((chunk) =>
        chunk.snapshotId === values[0] && chunk.kind === values[1] && chunk.chunkIndex === values[2],
      )) throw new Error('Duplicate dataset chunk');
      this.chunks.push({
        snapshotId: values[0],
        kind: values[1],
        chunkIndex: values[2],
        payload: values[3],
      });
    } else if (query.startsWith('UPDATE dataset_snapshots SET upload_received_bytes')) {
      const upload = this.uploadState.get(values[1]);
      upload.receivedBytes += values[0];
    } else if (query.startsWith('INSERT INTO active_dataset')) {
      this.activeSnapshotId = values[0];
    } else if (query.startsWith('DELETE FROM dataset_chunks WHERE snapshot_id <>')) {
      this.chunks = this.chunks.filter((chunk) => chunk.snapshotId === values[0]);
    } else if (query.startsWith('DELETE FROM dataset_snapshots WHERE snapshot_id <>')) {
      this.snapshots = new Map([...this.snapshots].filter(([id]) => id === values[0]));
      this.snapshotSizes = new Map([...this.snapshotSizes].filter(([id]) => id === values[0]));
    } else if (query.startsWith('DELETE FROM dataset_chunks WHERE snapshot_id =')) {
      this.chunks = this.chunks.filter((chunk) => chunk.snapshotId !== values[0]);
    } else if (query.startsWith('DELETE FROM dataset_snapshots WHERE snapshot_id =')) {
      this.snapshots.delete(values[0]);
      this.snapshotSizes.delete(values[0]);
      this.uploadState.delete(values[0]);
    } else {
      throw new Error(`Unsupported fake D1 statement: ${query}`);
    }
    return { success: true };
  }

  async first(query, values) {
    if (query.startsWith('SELECT upload_expected_bytes, upload_received_bytes')) {
      const upload = this.uploadState.get(values[0]);
      return upload ? {
        upload_expected_bytes: upload.expectedBytes,
        upload_received_bytes: upload.receivedBytes,
      } : null;
    }
    if (query.startsWith('SELECT created_at, upload_expected_bytes, upload_received_bytes')) {
      const createdAt = this.snapshots.get(values[0]);
      const upload = this.uploadState.get(values[0]);
      return createdAt && upload ? {
        created_at: createdAt,
        upload_expected_bytes: upload.expectedBytes,
        upload_received_bytes: upload.receivedBytes,
      } : null;
    }
    if (query.startsWith('SELECT COUNT(*) AS chunk_count')) {
      const chunks = this.chunks.filter((chunk) =>
        chunk.snapshotId === values[0] && chunk.kind === values[1],
      );
      return {
        chunk_count: chunks.length,
        max_chunk_index: chunks.length ? Math.max(...chunks.map((chunk) => chunk.chunkIndex)) : null,
        row_count: chunks.reduce((count, chunk) => count + JSON.parse(chunk.payload).length, 0) || null,
        byte_count: chunks.reduce((count, chunk) => count + new TextEncoder().encode(chunk.payload).byteLength, 0) || null,
      };
    }
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
    if (query.startsWith('SELECT created_at, upload_expected_bytes FROM dataset_snapshots')) {
      const createdAt = this.snapshots.get(values[0]);
      return createdAt ? {
        created_at: createdAt,
        upload_expected_bytes: this.snapshotSizes.get(values[0]) || 0,
      } : null;
    }
    throw new Error(`Unsupported fake D1 query: ${query}`);
  }

  async all(query, values) {
    if (query.startsWith('SELECT kind, COUNT(*) AS chunk_count')) {
      const chunksByKind = ['ops', 'ordens'].map((kind) => {
        const chunks = this.chunks.filter((chunk) =>
          chunk.snapshotId === values[0] && chunk.kind === kind,
        );
        const expectedBytes = this.snapshotSizes.get(values[0]) || 0;
        const actualBytes = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.payload), 0);
        return {
          kind,
          chunk_count: chunks.length,
          payload_bytes: expectedBytes ? Math.ceil(expectedBytes / 2) : actualBytes,
        };
      });
      return { results: chunksByKind.filter((row) => row.chunk_count > 0) };
    }

    if (query.startsWith('SELECT chunk_index, payload FROM dataset_chunks')) {
      assert.match(query, /LIMIT \?/);
      this.datasetReadPages += 1;
      this.activeDatasetReadPages += 1;
      this.maxConcurrentDatasetReadPages = Math.max(
        this.maxConcurrentDatasetReadPages,
        this.activeDatasetReadPages,
      );
      try {
        await Promise.resolve();
        const results = this.chunks
          .filter((chunk) =>
            chunk.snapshotId === values[0]
            && chunk.kind === values[1]
            && (values.length === 3
              || (chunk.chunkIndex >= values[2] && chunk.chunkIndex < values[3])),
          )
          .sort((a, b) => a.chunkIndex - b.chunkIndex)
          .slice(0, values.length === 3 ? values[2] : values[4])
          .map(({ chunkIndex, payload }) => ({ chunk_index: chunkIndex, payload }));
        return { results };
      } finally {
        this.activeDatasetReadPages -= 1;
      }
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

async function stagedUpload(db, cookie, ops, ordens, { omitChunk } = {}) {
  const rowsByKind = { ops, ordens };
  const chunksByKind = Object.fromEntries(Object.entries(rowsByKind).map(([kind, rows]) => [
    kind,
    Array.from({ length: Math.ceil(rows.length / 100) }, (_, index) => rows.slice(index * 100, (index + 1) * 100)),
  ]));
  const expectedBytes = Object.values(chunksByKind)
    .flat()
    .reduce((bytes, rows) => bytes + new TextEncoder().encode(JSON.stringify(rows)).byteLength, 0);
  const start = await request('/api/data', {
    db,
    method: 'POST',
    cookie,
    body: { action: 'start', expectedBytes },
  });
  const { uploadId } = await start.json();

  for (const [kind, chunks] of Object.entries(chunksByKind)) {
    for (const [index, rows] of chunks.entries()) {
      if (omitChunk?.kind === kind && omitChunk.index === index) continue;
      const upload = await request(`/api/data?uploadId=${uploadId}&kind=${kind}&index=${index}`, {
        db,
        method: 'PUT',
        cookie,
        body: rows,
      });
      assert.equal(upload.status, 200);
    }
  }

  const complete = await request('/api/data', {
    db,
    method: 'POST',
    cookie,
    body: {
      action: 'complete',
      uploadId,
      chunkCounts: Object.fromEntries(Object.entries(chunksByKind).map(([kind, chunks]) => [kind, chunks.length])),
      rowCounts: Object.fromEntries(Object.entries(rowsByKind).map(([kind, rows]) => [kind, rows.length])),
    },
  });
  return { complete, uploadId };
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

test('admin publishes staged chunks only after every row is received', async () => {
  const bindings = env();
  const { cookie } = await login(bindings, bindings.ADMIN_PASSWORD);
  const ops = Array.from({ length: 250 }, (_, index) => ({
    'Numero da OP': String(index + 1),
    Produto: `ITEM-${index + 1}`,
  }));
  const ordens = Array.from({ length: 150 }, (_, index) => ({
    'Ord Prod': String(index + 1),
    Produto: `ORDEM-${index + 1}`,
  }));

  const { complete, uploadId } = await stagedUpload(bindings, cookie, ops, ordens);
  const uploadState = bindings.DB.uploadState.get(uploadId);
  assert.equal(uploadState.receivedBytes, uploadState.expectedBytes, JSON.stringify(uploadState));
  assert.equal(complete.status, 201, await complete.clone().text());

  bindings.DB.snapshotSizes.set(uploadId, 80_008_540);
  const read = await request('/api/data', { db: bindings, cookie });
  const dataset = await read.json();
  assert.equal(dataset.ops.length, 250);
  assert.equal(dataset.ordens.length, 150);
  assert.equal(dataset.ops[249].Produto, 'ITEM-250');
  assert.equal(bindings.DB.datasetReadPages, 2);
  assert.equal(bindings.DB.maxConcurrentDatasetReadPages, 2);
});

test('incomplete staged upload leaves the active dataset unchanged', async () => {
  const bindings = env();
  const { cookie } = await login(bindings, bindings.ADMIN_PASSWORD);
  const initial = await request('/api/data', {
    db: bindings,
    method: 'PUT',
    cookie,
    body: { ops: [{ 'Numero da OP': 'original' }], ordens: [] },
  });
  assert.equal(initial.status, 201);
  const activeSnapshotId = bindings.DB.activeSnapshotId;
  const ops = Array.from({ length: 101 }, (_, index) => ({ 'Numero da OP': String(index) }));

  const { complete, uploadId } = await stagedUpload(bindings, cookie, ops, [], {
    omitChunk: { kind: 'ops', index: 1 },
  });
  assert.equal(complete.status, 400);
  assert.equal(bindings.DB.activeSnapshotId, activeSnapshotId);

  await request(`/api/data?uploadId=${uploadId}`, { db: bindings, method: 'DELETE', cookie });
});

test('large shared datasets stream from D1 in bounded pages', async () => {
  const bindings = env();
  const db = bindings.DB;
  const snapshotId = 'large-snapshot';
  db.activeSnapshotId = snapshotId;
  db.snapshots.set(snapshotId, new Date().toISOString());
  db.snapshotSizes.set(snapshotId, 90 * 1024 * 1024);
  for (const kind of ['ops', 'ordens']) {
    for (let chunkIndex = 0; chunkIndex < 201; chunkIndex += 1) {
      db.chunks.push({
        snapshotId,
        kind,
        chunkIndex,
        payload: JSON.stringify([{ id: `${kind}-${chunkIndex}` }]),
      });
    }
  }

  const { cookie } = await login(bindings, bindings.VIEWER_PASSWORD);
  const read = await request('/api/data', { db: bindings, cookie });
  const dataset = await read.json();

  assert.equal(read.status, 200);
  assert.equal(dataset.ops.length, 201);
  assert.equal(dataset.ordens.length, 201);
  assert.equal(dataset.ops[200].id, 'ops-200');
  assert.equal(dataset.ordens[200].id, 'ordens-200');
  assert.equal(db.datasetReadPages, 10);
  assert.equal(db.maxConcurrentDatasetReadPages, 3);
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
