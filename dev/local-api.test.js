import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
