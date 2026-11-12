import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import localApi from './local-api.js';

test('local upload accepts more than 90 MiB and rejects invalid sizes', async (t) => {
  let middleware;
  localApi().configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  const server = createServer((request, response) => middleware(request, response, () => {
    response.writeHead(404).end();
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}/api/data`;
  const start = (expectedBytes) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'start', expectedBytes }),
  });

  const response = await start(91 * 1024 * 1024);
  assert.equal(response.status, 201);
  const { uploadId } = await response.json();
  assert.ok(uploadId);
  const abort = await fetch(`${url}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE' });
  assert.equal(abort.status, 200);

  for (const expectedBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100']) {
    const invalid = await start(expectedBytes);
    assert.equal(invalid.status, 400);
  }
});

test('local laser schedule survives a server restart and rejects invalid replacements', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'laser-schedule-test-'));
  const dataFile = path.join(directory, 'dataset.json');
  const scheduleFile = path.join(directory, 'laser-schedule.json');
  t.after(async () => {
    await rm(scheduleFile, { force: true });
    await rmdir(directory);
  });

  const serve = async () => {
    let middleware;
    localApi({ dataFile, scheduleFile }).configureServer({ middlewares: { use(handler) { middleware = handler; } } });
    const server = createServer((request, response) => middleware(request, response, () => response.writeHead(404).end()));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}/api/laser-schedule` };
  };
  const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const first = await serve();
  const rows = [{ machine: 'Fiber 4', sequence: 1, program: 'A', hours: 2, ops: ['123'] }];
  const save = await fetch(first.url, { method: 'PUT', body: JSON.stringify(rows) });
  assert.equal(save.status, 201);
  const invalid = await fetch(first.url, { method: 'PUT', body: '[]' });
  assert.equal(invalid.status, 400);
  await close(first.server);

  const second = await serve();
  t.after(() => close(second.server));
  const response = await fetch(second.url);
  const schedule = await response.json();
  assert.deepEqual(schedule.rows, rows);
  assert.ok(schedule.updatedAt);
});

test('local separation statuses persist across restarts and concurrent updates', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'laser-separation-test-'));
  const separationFile = path.join(directory, 'separation.json');
  t.after(async () => {
    await rm(separationFile, { force: true });
    await rmdir(directory);
  });
  const serve = async () => {
    let middleware;
    localApi({
      dataFile: path.join(directory, 'dataset.json'),
      scheduleFile: path.join(directory, 'schedule.json'),
      separationFile,
    }).configureServer({ middlewares: { use(handler) { middleware = handler; } } });
    const server = createServer((request, response) => middleware(request, response, () => response.writeHead(404).end()));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.listening ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) : undefined);
    return { server, url: `http://127.0.0.1:${server.address().port}/api/laser-separation` };
  };
  const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const first = await serve();
  assert.deepEqual(await (await fetch(first.url)).json(), { rows: [] });
  const rows = [
    { machine: 'Fiber 4', program: 'A', status: 'paid' },
    { machine: 'Fiber 6', program: 'A', status: 'pending' },
  ];
  const responses = await Promise.all(rows.map((row) => fetch(first.url, { method: 'PUT', body: JSON.stringify(row) })));
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal((await fetch(first.url, { method: 'PUT', body: '{"machine":"Fiber 4","program":"A","status":"unknown"}' })).status, 400);
  await close(first.server);
  const second = await serve();
  const result = await (await fetch(second.url)).json();
  assert.deepEqual(result.rows.sort((a, b) => a.machine.localeCompare(b.machine)), rows);
});
