import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { BrowserRelayProvider } from '../src/browser-relay.mjs';
import { NotionError, messagesToPrompt } from '../src/notion.mjs';

// Synthetic Node HTTP surfaces: no listening socket, browser, account or credentials.
const origin = `chrome-extension://${'a'.repeat(32)}`;
const otherOrigin = `chrome-extension://${'b'.repeat(32)}`;
const id = 'abcdef12-1234-4567-8abc-123456789abc';
const otherId = 'abcdef12-1234-4567-9abc-123456789abc';
const config = {
  userId: '10000000-0000-4000-8000-000000000001',
  spaceId: '0000abcd-1234-8000-8000-000300000000',
  clientVersion: 'test-version', cellHint: 'test-cell',
};
const input = { messages: [{ role: 'user', content: '你好' }], model: 'notion-auto' };
const epoch = Date.UTC(2026, 9, 13);

class Request extends EventEmitter {
  constructor(path, options) {
    super();
    this.url = path;
    this.method = options.method ?? 'POST';
    this.headers = { origin, ...options.headers };
    this.complete = this.method !== 'POST';
    this.aborted = false;
    this.resumed = 0;
  }
  resume() { this.resumed++; }
  submit(chunks) {
    for (const chunk of chunks) this.emit('data', Buffer.from(chunk));
    this.complete = true;
    this.emit('end');
    this.emit('close');
  }
  abort() { this.aborted = true; this.emit('aborted'); this.emit('close'); }
}

class Response extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.statusCode = 200;
    this.writableEnded = false;
    this.destroyed = false;
    this.text = '';
  }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  end(text = '') {
    assert.equal(this.writableEnded, false, 'response must end once');
    this.text = text;
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit('finish');
    this.emit('close');
  }
  close() { this.destroyed = true; this.emit('close'); }
  get body() { return this.text ? JSON.parse(this.text) : undefined; }
}

function exchange(provider, path, options = {}) {
  const req = new Request(path, options);
  const res = new Response();
  const handled = provider.handle(req, res);
  if (!options.manual && req.method === 'POST') {
    const chunks = options.chunks ?? [options.raw ?? JSON.stringify(options.body ?? {})];
    queueMicrotask(() => req.submit(chunks));
  }
  return { req, res, handled };
}

async function call(provider, path, options = {}) {
  const result = exchange(provider, path, options);
  result.didHandle = await result.handled;
  return result;
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('test operation did not settle')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

function fixture(t, options = {}, suppliedConfig = config) {
  const provider = new BrowserRelayProvider(suppliedConfig, { now: () => epoch, waitMs: 0, ...options });
  const controllers = [];
  const start = (overrides = {}) => {
    const controller = new AbortController();
    controllers.push(controller);
    const iterator = provider.stream({ ...input, signal: controller.signal, ...overrides });
    const first = iterator.next();
    first.catch(() => {});
    return { iterator, first, controller };
  };
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    await call(provider, '/bridge/disconnect', { body: { workerId: id } });
  });
  return { provider, start };
}

const connect = (provider, workerId = id, extensionOrigin = origin) => call(provider, '/bridge/connect', {
  body: { workerId }, headers: { origin: extensionOrigin },
});
const next = (provider, workerId = id, extensionOrigin = origin) => bounded(call(provider, `/bridge/next?workerId=${workerId}`, {
  method: 'GET', headers: { origin: extensionOrigin },
}));
const result = (provider, job, kind, fields = {}, options = {}) => call(provider, '/bridge/result', {
  body: { workerId: id, jobId: job.id, nonce: job.nonce, kind, ...fields }, ...options,
});
async function dispatched(provider, start) {
  const stream = start();
  const response = await next(provider);
  assert.equal(response.res.statusCode, 200);
  return { ...stream, job: response.res.body };
}

test('constructor copies public fields only; ready requires both configuration and a live worker', async t => {
  const credentials = { ...config, get tokenV2() { throw new Error('must not read credentials'); } };
  const { provider } = fixture(t, {}, credentials);
  assert.equal(provider.ready, false);
  assert.deepEqual(provider.models(), ['notion-auto']);
  const connected = await connect(provider);
  assert.equal(connected.res.statusCode, 200);
  assert.deepEqual(connected.res.body, { workerId: id, leaseMs: 45000 });
  assert.equal(provider.ready, true); // No Notion AI verification has taken place.
  for (const suppliedConfig of [{}, { userId: 'u' }, { spaceId: 's' }, { userId: ' ', spaceId: 's' }]) {
    const incomplete = fixture(t, {}, suppliedConfig).provider;
    await connect(incomplete);
    assert.equal(incomplete.ready, false);
    await assert.rejects(incomplete.stream(input).next(), { status: 503 });
  }
  for (const options of [{ leaseMs: 0 }, { waitMs: -1 }, { leaseMs: Infinity }, { waitMs: 2147483648 }, { now: 0 }]) {
    assert.throws(() => new BrowserRelayProvider(config, options), TypeError);
  }
});

test('all bridge operations reject absent, malformed and non-extension Origins', async t => {
  const { provider } = fixture(t);
  for (const invalid of [undefined, 'null', 'https://app.notion.com', 'http://localhost', origin + '/',
    `chrome-extension://${'q'.repeat(32)}`, `chrome-extension://${'a'.repeat(31)}`, origin + ', ' + otherOrigin]) {
    for (const [path, method] of [['/bridge/connect', 'POST'], ['/bridge/next?workerId=' + id, 'GET'],
      ['/bridge/result', 'POST'], ['/bridge/disconnect', 'POST'], ['/bridge/connect', 'OPTIONS']]) {
      const response = await call(provider, path, { method, headers: { origin: invalid }, body: { workerId: id } });
      assert.equal(response.res.statusCode, 403);
      assert.equal(response.res.headers['access-control-allow-origin'], undefined);
    }
  }
  assert.equal(provider.ready, false);
});

test('CORS preflight needs no Bearer, stays within exact bridge routes and checks requested method/headers', async t => {
  const { provider } = fixture(t);
  for (const [path, method] of [['connect', 'POST'], ['result', 'POST'], ['disconnect', 'POST'], ['next', 'GET']]) {
    const response = await call(provider, `/bridge/${path}`, { method: 'OPTIONS', headers: {
      'access-control-request-method': method, 'access-control-request-headers': 'authorization, Content-Type',
    } });
    assert.equal(response.res.statusCode, 204);
    assert.equal(response.res.headers['access-control-allow-origin'], origin);
    assert.equal(response.res.headers.vary, 'Origin');
    assert.equal(response.res.headers['access-control-allow-methods'], path === 'next' ? 'GET, POST, OPTIONS' : `${method}, OPTIONS`);
    assert.equal(response.res.headers['access-control-allow-credentials'], undefined);
  }
  for (const headers of [{ 'access-control-request-method': 'DELETE' }, { 'access-control-request-headers': 'x-cookie' }]) {
    assert.equal((await call(provider, '/bridge/connect', { method: 'OPTIONS', headers })).res.statusCode, 400);
  }
  const outside = await call(provider, '/v1/models', { method: 'OPTIONS' });
  assert.equal(outside.didHandle, false);
  assert.deepEqual(outside.res.headers, {});
  assert.equal(provider.ready, false);
});

test('strict route, prefix, query and method handling returns false outside the namespace', async t => {
  const { provider } = fixture(t);
  for (const path of ['/bridgeX', '/bridges/next', '/v1/models', '/health']) {
    const response = await call(provider, path, { method: 'GET' });
    assert.equal(response.didHandle, false);
    assert.equal(response.res.writableEnded, false);
  }
  for (const path of ['/bridge', '/bridge/unknown', '/bridge/connect/', '/bridge//next', '/bridge/../connect']) {
    assert.equal((await call(provider, path)).res.statusCode, 404);
  }
  for (const [path, method] of [['/bridge/connect', 'GET'], ['/bridge/next', 'POST'], ['/bridge/result', 'PUT'], ['/bridge/disconnect', 'DELETE']]) {
    assert.equal((await call(provider, path, { method })).res.statusCode, 400);
  }
  for (const path of ['/bridge/connect?x=1', '/bridge/result?workerId=' + id,
    `/bridge/next?workerId=${id}&workerId=${id}`, `/bridge/next?workerId=${id}&x=1`, '/bridge/connect#fragment']) {
    assert.equal((await call(provider, path, { method: path.includes('/next') ? 'GET' : 'POST' })).res.statusCode, 400);
  }
});

test('worker UUIDs are canonical; connect binds Origin and never replaces another valid worker', async t => {
  const { provider } = fixture(t);
  for (const workerId of [undefined, null, 1, 'not-a-uuid', id + ' ', '00000000-0000-0000-0000-000000000000']) {
    assert.equal((await call(provider, '/bridge/connect', { body: { workerId } })).res.statusCode, 400);
  }
  const response = await connect(provider, id.toUpperCase());
  assert.equal(response.res.body.workerId, id);
  assert.equal((await connect(provider)).res.statusCode, 200);
  assert.equal((await connect(provider, id, otherOrigin)).res.statusCode, 403);
  assert.equal((await connect(provider, otherId, otherOrigin)).res.statusCode, 409);
  assert.equal((await next(provider, id, otherOrigin)).res.statusCode, 403);
  assert.equal((await next(provider, otherId)).res.statusCode, 403);
  assert.equal((await next(provider, 'bad')).res.statusCode, 400);
  assert.equal(provider.ready, true);
});

test('job includes only public metadata, a new workspace thread, prompt and random 32-byte nonce', async t => {
  const { provider, start } = fixture(t);
  await connect(provider);
  const a = await dispatched(provider, start);
  const b = await dispatched(provider, start);
  assert.deepEqual(Object.keys(a.job).sort(), ['id', 'nonce', 'threadId', 'spaceId', 'userId', 'clientVersion', 'cellHint', 'prompt'].sort());
  assert.match(a.job.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab]/);
  assert.match(a.job.nonce, /^[0-9a-f]{64}$/);
  assert.match(a.job.threadId, /^3f80abcd-1234-80[0-9a-f]{2}-[89ab][0-9a-f]{3}-00a9[0-9a-f]{8}$/);
  for (const key of ['spaceId', 'userId', 'clientVersion', 'cellHint']) assert.equal(a.job[key], config[key]);
  assert.equal(a.job.prompt, messagesToPrompt(input.messages));
  assert.notEqual(a.job.id, b.job.id);
  assert.notEqual(a.job.threadId, b.job.threadId);
  assert.notEqual(a.job.nonce, b.job.nonce);
});

test('authenticated frames stream immediately; acknowledged done terminates and late frames return 410', async t => {
  const { provider, start } = fixture(t);
  await connect(provider);
  const { iterator, first, job } = await dispatched(provider, start);
  assert.equal((await result(provider, job, 'delta', { text: '你' })).res.statusCode, 200);
  assert.deepEqual(await first, { value: '你', done: false });
  const second = iterator.next();
  assert.equal((await result(provider, job, 'delta', { text: '好' })).res.statusCode, 200);
  assert.deepEqual(await second, { value: '好', done: false });
  const last = iterator.next();
  assert.deepEqual((await result(provider, job, 'done')).res.body, { ok: true });
  assert.deepEqual(await last, { value: undefined, done: true });
  assert.equal((await result(provider, job, 'delta', { text: 'late' })).res.statusCode, 410);
  assert.equal((await result(provider, job, 'done')).res.statusCode, 410);
});

test('stolen nonce, jobId, worker and Origin cannot inject frames or claim another worker job', async t => {
  const { provider, start } = fixture(t);
  await connect(provider);
  const { first, job, iterator } = await dispatched(provider, start);
  for (const options of [{ nonce: '0'.repeat(64) }, { nonce: job.nonce.slice(1) }, { nonce: null }, { workerId: otherId }]) {
    assert.equal((await result(provider, job, 'delta', { text: 'injected', ...options })).res.statusCode, 403);
  }
  assert.equal((await result(provider, job, 'delta', { text: 'stolen' }, { headers: { origin: otherOrigin } })).res.statusCode, 403);
  assert.equal((await result(provider, job, 'delta', { text: 'wrong-job', jobId: randomUUID() })).res.statusCode, 410);
  assert.equal((await next(provider, otherId, otherOrigin)).res.statusCode, 403);
  assert.equal((await result(provider, job, 'delta', { text: 'safe' })).res.statusCode, 200);
  assert.equal((await first).value, 'safe');
  await result(provider, job, 'done');
  assert.equal((await iterator.next()).done, true);
  assert.equal((await result(provider, job, 'done', { nonce: '0'.repeat(64) })).res.statusCode, 403);
});

test('invalid result envelopes and non-string deltas are rejected without corrupting the live job', async t => {
  const { provider, start } = fixture(t);
  await connect(provider);
  const { first, job, iterator } = await dispatched(provider, start);
  for (const fields of [{ text: 1 }, { text: null }, { text: {} }, { jobId: 'invalid', text: 'x' },
    { workerId: 'invalid', text: 'x' }, { kind: 'patch', text: 'x' }, { extra: 'x', text: 'x' }]) {
    assert.equal((await result(provider, job, 'delta', fields)).res.statusCode, 400);
  }
  await result(provider, job, 'delta', { text: '' });
  await result(provider, job, 'delta', { text: 'valid' });
  assert.equal((await first).value, 'valid');
  await result(provider, job, 'done');
  assert.equal((await iterator.next()).done, true);
});

test('done requires a non-whitespace delta; terminal text alone never invents a successful answer', async t => {
  for (const text of [undefined, '', ' \n\t']) {
    const { provider, start } = fixture(t);
    await connect(provider);
    const { first, iterator, job } = await dispatched(provider, start);
    let terminal = first;
    if (text !== undefined) {
      await result(provider, job, 'delta', { text });
      if (text) { assert.equal((await first).value, text); terminal = iterator.next(); terminal.catch(() => {}); }
    }
    assert.equal((await result(provider, job, 'done', { text: 'not a delta' })).res.statusCode, 200);
    await assert.rejects(terminal, { status: 502, code: 'notion_empty_answer' });
  }
});

test('browser errors use only fixed explanations, whitelisted codes and integer HTTP 400..599 statuses', async t => {
  const codes = ['notion_access_denied', 'notion_request_rejected', 'notion_quota_exhausted',
    'notion_user_action_required', 'notion_incomplete_stream', 'notion_unknown_patch', 'notion_network_error', 'notion_empty_answer'];
  const { provider, start } = fixture(t);
  await connect(provider);
  for (const code of codes) {
    const { first, job } = await dispatched(provider, start);
    const response = await result(provider, job, 'error', { status: 429, code, text: 'private raw browser error cookie=SECRET' });
    assert.deepEqual(response.res.body, { ok: true });
    await assert.rejects(first, error => error instanceof NotionError && error.status === 429
      && error.code === code && !error.message.includes('SECRET') && !error.message.includes('private'));
  }
  for (const [status, expected] of [[400, 400], [599, 599], [399, 502], [600, 502], ['403', 502], [400.5, 502], [null, 502]]) {
    const { first, job } = await dispatched(provider, start);
    await result(provider, job, 'error', { status, code: 'arbitrary-private-code', text: 'sensitive' });
    await assert.rejects(first, { status: expected, code: 'notion_request_rejected' });
  }
  for (const code of ['__proto__', { toString: null }, null]) {
    const { first, job } = await dispatched(provider, start);
    await result(provider, job, 'error', { code });
    await assert.rejects(first, { status: 502, code: 'notion_request_rejected' });
  }
});

test('each delta is limited to 32 KiB of UTF-8, with a safe terminal error on overflow', async t => {
  const { provider, start } = fixture(t);
  await connect(provider);
  const { first, job } = await dispatched(provider, start);
  const response = await result(provider, job, 'delta', { text: '你'.repeat(10923) });
  assert.equal(response.res.statusCode, 413);
  await assert.rejects(first, { status: 502, code: 'notion_incomplete_stream' });
  assert.equal((await result(provider, job, 'done')).res.statusCode, 410);
});

test('cumulative UTF-8 output accepts exactly 4 MiB and rejects the next byte even after deltas are consumed', async t => {
  const { provider, start } = fixture(t);
  await connect(provider);
  const text = '你'.repeat(10922) + 'aa';
  assert.equal(Buffer.byteLength(text), 32768);
  for (const overflow of [false, true]) {
    const { first, iterator, job } = await dispatched(provider, start);
    let pending = first;
    for (let frame = 0; frame < 128; frame++) {
      assert.equal((await result(provider, job, 'delta', { text })).res.statusCode, 200);
      assert.equal((await pending).value, text);
      pending = iterator.next();
      pending.catch(() => {});
    }
    if (overflow) {
      assert.equal((await result(provider, job, 'delta', { text: 'a' })).res.statusCode, 413);
      await assert.rejects(pending, { status: 502, code: 'notion_incomplete_stream' });
    } else {
      await result(provider, job, 'done');
      assert.equal((await pending).done, true);
    }
  }
});

test('unread tiny deltas are coalesced, remain bounded and preserve answer order', async t => {
  const { provider, start } = fixture(t);
  await connect(provider);
  const { first, iterator, job } = await dispatched(provider, start);
  await result(provider, job, 'delta', { text: 'first' });
  assert.equal((await first).value, 'first');
  for (let frame = 0; frame < 512; frame++) await result(provider, job, 'delta', { text: String(frame % 10) });
  await result(provider, job, 'done');
  assert.equal((await iterator.next()).value, Array.from({ length: 512 }, (_, frame) => frame % 10).join(''));
  assert.equal((await iterator.next()).done, true);
});

test('AbortSignal promptly removes active jobs, preserves the abort reason and returns 410 to late frames', async t => {
  const { provider, start } = fixture(t);
  await connect(provider);
  const { first, job, controller } = await dispatched(provider, start);
  const reason = new Error('client aborted');
  controller.abort(reason);
  await assert.rejects(first, error => error === reason);
  assert.equal((await result(provider, job, 'delta', { text: 'late' })).res.statusCode, 410);
  assert.equal((await next(provider)).res.statusCode, 204);
  const replacement = await dispatched(provider, start);
  await result(provider, replacement.job, 'delta', { text: 'new' });
  assert.equal((await replacement.first).value, 'new');
  await result(provider, replacement.job, 'done');
  await replacement.iterator.next();
});

test('queued cancellation, suspended-consumer abort and iterator.return release the queue and job ownership', async t => {
  const { provider, start } = fixture(t);
  await connect(provider);
  const queued = start();
  queued.controller.abort();
  await assert.rejects(queued.first, { name: 'AbortError' });
  assert.equal((await next(provider)).res.statusCode, 204);
  for (const cancel of ['abort', 'return']) {
    const { first, iterator, job, controller } = await dispatched(provider, start);
    await result(provider, job, 'delta', { text: 'first' });
    assert.equal((await first).value, 'first');
    if (cancel === 'abort') { controller.abort(); await assert.rejects(iterator.next(), { name: 'AbortError' }); }
    else assert.equal((await iterator.return()).done, true);
    assert.equal((await result(provider, job, 'done')).res.statusCode, 410);
  }
});

test('pre-aborted requests and unsupported messages/models never enqueue a job', async t => {
  const { provider } = fixture(t);
  await connect(provider);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.stream({ ...input, signal: controller.signal }).next(), { name: 'AbortError' });
  for (const overrides of [{ model: 'other' }, { messages: [] }, { messages: null }, { messages: [{ role: 'tool', content: 'x' }] },
    { messages: [{ role: 'user', content: 1 }] }]) {
    await assert.rejects(provider.stream({ ...input, ...overrides }).next(), { status: 400 });
  }
  await assert.rejects(provider.stream({ ...input, messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] }).next(), { status: 413 });
  assert.equal((await next(provider)).res.statusCode, 204);
});

test('queue capacity is bounded independently of the main server and abort immediately frees a slot', async t => {
  const { provider, start } = fixture(t);
  await connect(provider);
  const queued = Array.from({ length: 16 }, () => start());
  const excess = start();
  await assert.rejects(excess.first, { status: 429, code: 'bridge_queue_full' });
  queued[0].controller.abort();
  await assert.rejects(queued[0].first, { name: 'AbortError' });
  const replacement = start();
  const nextJob = await next(provider);
  assert.equal(nextJob.res.statusCode, 200);
  await result(provider, nextJob.res.body, 'delta', { text: 'correct queued job' });
  assert.equal((await queued[1].first).value, 'correct queued job');
  replacement.controller.abort();
  await assert.rejects(replacement.first, { name: 'AbortError' });
});

test('connect heartbeat and next renew the lease without clearing in-progress work', async t => {
  let now = epoch;
  const { provider, start } = fixture(t, { now: () => now });
  await connect(provider);
  const { first, job, iterator } = await dispatched(provider, start);
  now += 10000;
  assert.equal((await connect(provider)).res.statusCode, 200);
  now += 40000;
  assert.equal(provider.ready, true);
  assert.equal((await next(provider)).res.statusCode, 204);
  now += 40000;
  assert.equal(provider.ready, true);
  await result(provider, job, 'delta', { text: 'still active' });
  assert.equal((await first).value, 'still active');
  await result(provider, job, 'done');
  assert.equal((await iterator.next()).done, true);
});

test('lease expiry fails active and queued jobs with 503; late verified results are 410 and cannot revive worker', async t => {
  let now = epoch;
  const { provider, start } = fixture(t, { now: () => now });
  await connect(provider);
  const active = await dispatched(provider, start);
  const queued = start();
  now += 45000;
  assert.equal((await result(provider, active.job, 'delta', { text: 'too late' })).res.statusCode, 410);
  for (const stream of [active, queued]) await assert.rejects(stream.first, { status: 503, code: 'notion_network_error' });
  assert.equal(provider.ready, false);
  assert.equal((await result(provider, active.job, 'done', { nonce: '0'.repeat(64) })).res.statusCode, 403);
  assert.equal((await connect(provider, otherId, otherOrigin)).res.statusCode, 200);
  assert.equal((await next(provider, otherId, otherOrigin)).res.statusCode, 204);
  await call(provider, '/bridge/disconnect', { body: { workerId: otherId }, headers: { origin: otherOrigin } });
});

test('idle timer expires leases, waking both stalled generation and pending long poll', async t => {
  const { provider, start } = fixture(t, { now: Date.now, leaseMs: 35, waitMs: 250 });
  await connect(provider);
  const active = await dispatched(provider, start);
  const poll = exchange(provider, '/bridge/next?workerId=' + id, { method: 'GET' });
  await assert.rejects(bounded(active.first), { status: 503 });
  await bounded(poll.handled);
  assert.equal(poll.res.statusCode, 503);
  assert.equal(provider.ready, false);
});

test('one pending GET per worker; normal request close does not cancel; incoming job wakes poll immediately', async t => {
  const { provider, start } = fixture(t, { waitMs: 500 });
  await connect(provider);
  const pending = exchange(provider, '/bridge/next?workerId=' + id, { method: 'GET' });
  pending.req.emit('close');
  assert.equal(pending.res.writableEnded, false);
  assert.equal((await next(provider)).res.statusCode, 409);
  const stream = start();
  await bounded(pending.handled);
  assert.equal(pending.res.statusCode, 200);
  await result(provider, pending.res.body, 'delta', { text: 'woke poll' });
  assert.equal((await stream.first).value, 'woke poll');
  await result(provider, pending.res.body, 'done');
  await stream.iterator.next();
  assert.equal(pending.req.listenerCount('aborted'), 0);
  assert.equal(pending.res.listenerCount('close'), 0);
});

test('request abort/incomplete close and response disconnect cancel only pending poll and release its slot', async t => {
  const { provider, start } = fixture(t, { waitMs: 500 });
  await connect(provider);
  for (const cancel of ['request-abort', 'request-close', 'response-close', 'response-error']) {
    const pending = exchange(provider, '/bridge/next?workerId=' + id, { method: 'GET' });
    if (cancel === 'request-abort') pending.req.abort();
    else if (cancel === 'request-close') { pending.req.complete = false; pending.req.emit('close'); }
    else if (cancel === 'response-error') pending.res.emit('error', new Error('private transport detail'));
    else pending.res.close();
    await bounded(pending.handled);
    assert.equal(pending.res.writableEnded, false);
    assert.equal(pending.req.listenerCount('aborted'), 0);
    assert.equal(pending.res.listenerCount('close'), 0);
    assert.equal(provider.ready, true);
  }
  const stream = await dispatched(provider, start);
  await result(provider, stream.job, 'delta', { text: 'usable after disconnects' });
  await stream.first;
  await result(provider, stream.job, 'done');
  await stream.iterator.next();
});

test('long poll timeout returns empty 204 with CORS and releases the poll slot', async t => {
  const { provider } = fixture(t, { waitMs: 20 });
  await connect(provider);
  for (let attempt = 0; attempt < 2; attempt++) {
    const poll = await next(provider);
    assert.equal(poll.res.statusCode, 204);
    assert.equal(poll.res.text, '');
    assert.equal(poll.res.headers['access-control-allow-origin'], origin);
    assert.equal(poll.req.listenerCount('aborted'), 0);
  }
});

test('disconnect checks bound identity and immediately fails jobs/poll; reconnect cannot reuse old jobs', async t => {
  const { provider, start } = fixture(t, { waitMs: 500 });
  await connect(provider);
  const active = await dispatched(provider, start);
  const queued = start();
  for (const options of [{ body: { workerId: otherId } }, { body: { workerId: id }, headers: { origin: otherOrigin } }]) {
    assert.equal((await call(provider, '/bridge/disconnect', options)).res.statusCode, 403);
    assert.equal(provider.ready, true);
  }
  // First poll consumes queued job; second poll is pending without work.
  const queuedJob = (await next(provider)).res.body;
  const waiting = exchange(provider, '/bridge/next?workerId=' + id, { method: 'GET' });
  const response = await call(provider, '/bridge/disconnect', { body: { workerId: id } });
  assert.deepEqual(response.res.body, { ok: true });
  assert.equal(provider.ready, false);
  await bounded(waiting.handled);
  assert.equal(waiting.res.statusCode, 503);
  for (const stream of [active, queued]) await assert.rejects(stream.first, { status: 503, code: 'notion_network_error' });
  assert.equal((await result(provider, active.job, 'done')).res.statusCode, 410);
  assert.equal((await result(provider, queuedJob, 'delta', { text: 'late' })).res.statusCode, 410);
  await connect(provider);
  const fresh = await dispatched(provider, start);
  assert.notEqual(fresh.job.id, active.job.id);
  await result(provider, fresh.job, 'delta', { text: 'new connection' });
  await fresh.first;
  await result(provider, fresh.job, 'done');
  await fresh.iterator.next();
});

test('disconnect also removes undispatched queued jobs and frees capacity', async t => {
  const { provider, start } = fixture(t);
  await connect(provider);
  const queued = Array.from({ length: 16 }, () => start());
  await call(provider, '/bridge/disconnect', { body: { workerId: id } });
  for (const stream of queued) await assert.rejects(stream.first, { status: 503 });
  await connect(provider);
  assert.equal((await next(provider)).res.statusCode, 204);
  const replacement = await dispatched(provider, start);
  replacement.controller.abort();
  await assert.rejects(replacement.first, { name: 'AbortError' });
});

test('JSON parser rejects bad JSON/non-objects/invalid UTF-8, handles fragmented UTF-8 and enforces 64 KiB', async t => {
  const { provider } = fixture(t);
  for (const raw of ['{bad}', '', '[]', 'null', '1', '"text"']) {
    assert.equal((await call(provider, '/bridge/connect', { raw })).res.statusCode, 400);
  }
  assert.equal((await call(provider, '/bridge/connect', { chunks: [Buffer.from([0xff])] })).res.statusCode, 400);
  const body = JSON.stringify({ workerId: id });
  const exact = body + ' '.repeat(65536 - Buffer.byteLength(body));
  const exactResponse = await call(provider, '/bridge/connect', { chunks: [exact.slice(0, 100), exact.slice(100)] });
  assert.equal(exactResponse.res.statusCode, 200);
  for (const options of [{ raw: exact + ' ' }, { chunks: [exact, ' '] },
    { headers: { 'content-length': '65537' }, raw: body }]) {
    const response = await call(provider, '/bridge/connect', options);
    assert.equal(response.res.statusCode, 413);
    assert.equal(response.res.headers.connection, 'close');
    assert.equal(response.req.listenerCount('data'), 0);
  }
  const stream = provider.stream(input);
  const first = stream.next();
  first.catch(() => {});
  const job = (await next(provider)).res.body;
  const json = Buffer.from(JSON.stringify({ workerId: id, jobId: job.id, nonce: job.nonce, kind: 'delta', text: '你' }));
  const boundary = json.indexOf(Buffer.from('你')) + 1;
  assert.equal((await call(provider, '/bridge/result', { chunks: [json.subarray(0, boundary), json.subarray(boundary)] })).res.statusCode, 200);
  assert.equal((await first).value, '你');
  await result(provider, job, 'done');
  await stream.next();
});

test('POST disconnect and concurrent slow uploads release listeners/slots and recheck worker state after await', async t => {
  let now = epoch;
  const { provider, start } = fixture(t, { now: () => now });
  for (const side of ['request', 'response']) {
    const upload = exchange(provider, '/bridge/connect', { manual: true });
    if (side === 'request') upload.req.abort(); else upload.res.close();
    await upload.handled;
    assert.equal(upload.req.listenerCount('data'), 0);
    assert.equal(upload.res.listenerCount('close'), 0);
    assert.equal(provider.ready, false);
  }
  const a = exchange(provider, '/bridge/connect', { manual: true });
  const b = exchange(provider, '/bridge/connect', { manual: true });
  a.req.submit([JSON.stringify({ workerId: id })]);
  b.req.submit([JSON.stringify({ workerId: otherId })]);
  await Promise.all([a.handled, b.handled]);
  assert.equal(a.res.statusCode, 200);
  assert.equal(b.res.statusCode, 409);
  const active = await dispatched(provider, start);
  const upload = exchange(provider, '/bridge/result', { manual: true });
  now += 45000;
  upload.req.submit([JSON.stringify({ workerId: id, jobId: active.job.id, nonce: active.job.nonce, kind: 'delta', text: 'late upload' })]);
  await upload.handled;
  assert.equal(upload.res.statusCode, 410);
  await assert.rejects(active.first, { status: 503 });
  assert.equal(provider.ready, false);
});

test('concurrent JSON uploads are bounded even when the host does not serialize bridge traffic', async t => {
  const { provider } = fixture(t);
  const uploads = Array.from({ length: 16 }, () => exchange(provider, '/bridge/connect', { manual: true }));
  const excess = await call(provider, '/bridge/connect', { body: { workerId: id } });
  assert.equal(excess.res.statusCode, 429);
  for (const upload of uploads) upload.req.abort();
  await Promise.all(uploads.map(upload => upload.handled));
  assert.equal((await connect(provider)).res.statusCode, 200);
});

test('an in-flight heartbeat cannot revive the worker after user disconnect', async t => {
  const { provider } = fixture(t);
  await connect(provider);
  const heartbeat = exchange(provider, '/bridge/connect', { manual: true });
  assert.equal((await call(provider, '/bridge/disconnect', { body: { workerId: id } })).res.statusCode, 200);
  assert.equal(provider.ready, false);
  heartbeat.req.submit([JSON.stringify({ workerId: id })]);
  await heartbeat.handled;
  assert.equal(heartbeat.res.statusCode, 410);
  assert.equal(provider.ready, false);
  assert.equal((await connect(provider)).res.statusCode, 200);
  assert.equal(provider.ready, true);
});

test('POST next shares the poll slot, survives a normal completed body and stops promptly', async t => {
  const { provider } = fixture(t, { waitMs: 15000 });
  await connect(provider);
  const pending = exchange(provider, '/bridge/next', { body: { workerId: id } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.req.complete, true);
  assert.equal(pending.res.writableEnded, false);
  assert.equal((await call(provider, '/bridge/next', { body: { workerId: id } })).res.statusCode, 409);
  assert.equal((await next(provider)).res.statusCode, 409);
  assert.equal((await call(provider, '/bridge/disconnect', { body: { workerId: id } })).res.statusCode, 200);
  await bounded(pending.handled);
  assert.equal(pending.res.statusCode, 503);
  assert.equal(pending.req.listenerCount('data'), 0);
  assert.equal(pending.req.listenerCount('close'), 0);
  assert.equal(pending.res.listenerCount('close'), 0);
});

test('an old POST next upload cannot poll a reconnected session after Stop', async t => {
  const { provider } = fixture(t);
  await connect(provider);
  const pending = exchange(provider, '/bridge/next', { manual: true });
  await call(provider, '/bridge/disconnect', { body: { workerId: id } });
  await connect(provider);
  pending.req.submit([JSON.stringify({ workerId: id })]);
  await bounded(pending.handled);
  assert.equal(pending.res.statusCode, 410);
  assert.equal(provider.ready, true);
  assert.equal((await call(provider, '/bridge/next', { body: { workerId: id } })).res.statusCode, 204);
});

test('Stop has a reserved upload slot and fails work even when ordinary upload slots are full', async t => {
  const { provider, start } = fixture(t);
  await connect(provider);
  const active = await dispatched(provider, start);
  const uploads = Array.from({ length: 16 }, () => exchange(provider, '/bridge/connect', { manual: true }));
  const stopped = await call(provider, '/bridge/disconnect', { body: { workerId: id } });
  assert.equal(stopped.res.statusCode, 200);
  assert.equal(provider.ready, false);
  await assert.rejects(active.first, { status: 503 });
  for (const upload of uploads) upload.req.submit([JSON.stringify({ workerId: id })]);
  await Promise.all(uploads.map(upload => upload.handled));
  for (const upload of uploads) assert.equal(upload.res.statusCode, 410);
  assert.equal(provider.ready, false);
});

test('close is idempotent and permanently fails active/queued work, including suspended consumers', async t => {
  const { provider, start } = fixture(t);
  await connect(provider);
  const active = await dispatched(provider, start);
  await result(provider, active.job, 'delta', { text: 'already delivered' });
  assert.equal((await active.first).value, 'already delivered');
  await result(provider, active.job, 'delta', { text: 'discard on close' });
  const queued = start();
  assert.equal(provider.close(), undefined);
  assert.equal(provider.close(), undefined);
  assert.equal(provider.ready, false);
  await assert.rejects(active.iterator.next(), { status: 503, code: 'notion_network_error' });
  await assert.rejects(queued.first, { status: 503, code: 'notion_network_error' });
  await assert.rejects(provider.stream(input).next(), { status: 503 });
  assert.equal((await connect(provider)).res.statusCode, 503);
  assert.equal((await result(provider, active.job, 'done')).res.statusCode, 503);
  assert.equal((await next(provider)).res.statusCode, 503);
  assert.equal(provider.ready, false);
});

test('close immediately ends pending next, cleans its listeners and keeps preflight/namespace rules', async t => {
  const { provider } = fixture(t, { waitMs: 15000 });
  await connect(provider);
  const poll = exchange(provider, '/bridge/next?workerId=' + id, { method: 'GET' });
  provider.close();
  await bounded(poll.handled);
  assert.equal(poll.res.statusCode, 503);
  assert.equal(poll.res.body.error.code, 'notion_network_error');
  assert.equal(poll.req.listenerCount('aborted'), 0);
  assert.equal(poll.req.listenerCount('close'), 0);
  assert.equal(poll.res.listenerCount('close'), 0);
  assert.equal(poll.res.listenerCount('error'), 0);
  assert.equal((await call(provider, '/bridge/connect', { method: 'OPTIONS' })).res.statusCode, 204);
  assert.equal((await connect(provider, id, 'https://app.notion.com')).res.statusCode, 403);
  assert.equal((await call(provider, '/health', { method: 'GET' })).didHandle, false);
});

test('close before registration cancels incomplete POST uploads and prevents late connect revival', async t => {
  for (const registered of [false, true]) {
    const { provider } = fixture(t);
    if (registered) await connect(provider);
    const upload = exchange(provider, '/bridge/connect', { manual: true });
    provider.close();
    await bounded(upload.handled);
    assert.equal(upload.res.statusCode, 503);
    assert.equal(upload.req.listenerCount('data'), 0);
    assert.equal(upload.req.listenerCount('end'), 0);
    assert.equal(upload.res.listenerCount('close'), 0);
    upload.req.submit([JSON.stringify({ workerId: id })]);
    assert.equal(provider.ready, false);
    assert.equal((await connect(provider)).res.statusCode, 503);
    provider.close();
  }
});

test('close discards completed-but-unread deltas instead of allowing output after shutdown', async t => {
  const { provider, start } = fixture(t);
  await connect(provider);
  const stream = await dispatched(provider, start);
  await result(provider, stream.job, 'delta', { text: 'first' });
  await stream.first;
  await result(provider, stream.job, 'delta', { text: 'unread' });
  await result(provider, stream.job, 'done');
  provider.close();
  await assert.rejects(stream.iterator.next(), { status: 503, code: 'notion_network_error' });
});
