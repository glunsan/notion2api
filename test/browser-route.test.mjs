import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../src/server.mjs';
import { BrowserRelayProvider } from '../src/browser-relay.mjs';

const origin = 'chrome-extension://' + 'a'.repeat(32);
const apiKey = 'local-test-key-' + '1'.repeat(30);
const workerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function setup(t) {
  const provider = new BrowserRelayProvider({ userId: 'user', spaceId: '0000abcd-1234-8000-8000-000300000000' }, { waitMs: 25 });
  const server = createServer({ provider, apiKey }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { provider.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { origin, authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' };
  const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  return { provider, base, headers, post };
}
test('HTTP wrapper enforces Bearer for bridge traffic but permits scoped OPTIONS before a worker is ready', async t => {
  const { base, post } = await setup(t);
  assert.equal((await post('/bridge/connect', { workerId }, { authorization: 'Bearer wrong' })).status, 401);
  const options = await fetch(base + '/bridge/connect', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization, Content-Type' } });
  assert.equal(options.status, 204); assert.equal(options.headers.get('access-control-allow-origin'), origin);
  assert.equal((await post('/bridge/connect', { workerId }, { origin: 'https://app.notion.com' })).status, 403);
  assert.equal((await post('/bridge/connect', { workerId })).status, 200);
});
test('an authenticated simulated browser job completes through the actual OpenAI HTTP handler', async t => {
  const { base, headers, post } = await setup(t);
  await post('/bridge/connect', { workerId });
  const completion = fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'notion-auto', messages: [{ role: 'user', content: 'challenge' }], stream: true }) });
  completion.catch(() => {}); // A failing dispatch assertion still tears down the pending fetch safely.
  const workerResponse = await post('/bridge/next', { workerId });
  assert.equal(workerResponse.status, 200); const job = await workerResponse.json();
  assert.ok(job.prompt.includes('challenge')); assert.equal(Object.hasOwn(job, 'tokenV2'), false);
  assert.equal((await post('/bridge/result', { workerId, jobId: job.id, nonce: '0'.repeat(64), kind: 'delta', text: 'forged' })).status, 403);
  assert.equal((await post('/bridge/result', { workerId, jobId: job.id, nonce: job.nonce, kind: 'delta', text: 'OK' })).status, 200);
  assert.equal((await post('/bridge/result', { workerId, jobId: job.id, nonce: job.nonce, kind: 'done' })).status, 200);
  const response = await completion, body = await response.text();
  assert.equal(response.status, 200); assert.ok(body.includes('"content":"OK"') && body.includes('data: [DONE]')); assert.equal(body.includes('forged'), false);
});

test('extension polling uses POST without relaxing Bearer, Origin, worker binding or envelope checks', async t => {
  const { base, headers, post } = await setup(t);
  assert.equal((await post('/bridge/connect', { workerId })).status, 200);
  const missingOrigin = { authorization: headers.authorization, 'content-type': 'application/json' };
  const legacyGet = await fetch(base + '/bridge/next?workerId=' + workerId, { headers: missingOrigin });
  assert.equal(legacyGet.status, 403);
  assert.equal((await legacyGet.json()).error.code, 'bridge_origin_forbidden');
  assert.equal((await post('/bridge/next', { workerId })).status, 204);
  assert.equal((await post('/bridge/next', { workerId }, { authorization: 'Bearer wrong' })).status, 401);
  const noOriginPost = await fetch(base + '/bridge/next', { method: 'POST', headers: missingOrigin, body: JSON.stringify({ workerId }) });
  assert.equal(noOriginPost.status, 403);
  assert.equal((await post('/bridge/next', { workerId }, { origin: 'https://app.notion.com' })).status, 403);
  assert.equal((await post('/bridge/next', { workerId }, { origin: 'chrome-extension://' + 'b'.repeat(32) })).status, 403);
  assert.equal((await post('/bridge/next', { workerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).status, 403);
  assert.equal((await post('/bridge/next', { workerId, extra: true })).status, 400);
  assert.equal((await post('/bridge/next?workerId=' + workerId, { workerId })).status, 400);
  const preflight = await fetch(base + '/bridge/next', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } });
  assert.equal(preflight.status, 204);
  assert.ok(preflight.headers.get('access-control-allow-methods').includes('POST'));
});
test('provider shutdown invalidates readiness and forbids a late reconnect', async t => {
  const { provider, base, post } = await setup(t); await post('/bridge/connect', { workerId });
  assert.equal(provider.ready, true); provider.close(); provider.close(); assert.equal(provider.ready, false);
  assert.equal((await post('/bridge/connect', { workerId })).status, 503);
  assert.equal((await (await fetch(base + '/health')).json()).ready, false);
});
