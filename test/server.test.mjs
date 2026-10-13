import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../src/server.mjs';

const apiKey = 'local-test-secret';
const model = 'test-model';
const messages = [
  { role: 'system', content: 'Reply with text.' },
  { role: 'user', content: '你好' },
  { role: 'assistant', content: 'Hello' },
];
const validBody = { model, messages };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function provider(overrides = {}) {
  return {
    ready: true,
    models: () => [model, 'other-model'],
    async *stream() { yield '你'; yield '好'; },
    ...overrides,
  };
}

async function serve(t, options = {}) {
  const server = createServer({ provider: provider(), apiKey, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body = validBody, options = {}) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...options,
  });
  return { server, base, post };
}

function rawPost(base, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    // Multiple writes without Content-Length exercise the chunked request path.
    if (Array.isArray(body)) { for (const chunk of body) req.write(chunk); req.end(); }
    else req.end(body);
  });
}

function parseEvents(text) {
  return text.split('\n\n').filter(Boolean).map(block => {
    const data = block.split('\n').find(line => line.startsWith('data: '))?.slice(6);
    return { event: block.startsWith('event: error\n') ? 'error' : 'message', data: data === '[DONE]' ? data : JSON.parse(data) };
  });
}

test('health needs no credentials and reports changing readiness; protected routes return 503', { timeout: 5000 }, async t => {
  let calls = 0;
  const p = provider({ ready: false, async *stream() { calls++; yield 'unused'; } });
  const { base, post } = await serve(t, { provider: p });
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const healthText = await health.text();
  assert.equal(JSON.parse(healthText).ready, false);
  assert.equal(healthText.includes(apiKey), false);
  const models = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  assert.equal(models.status, 503);
  await models.arrayBuffer();
  const unavailable = await post();
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, 'provider_not_ready');
  assert.equal(calls, 0);
  p.ready = true;
  assert.equal((await (await fetch(`${base}/health`)).json()).ready, true);
});

test('models and chat require one exact Bearer key, including rejection of duplicate headers', { timeout: 5000 }, async t => {
  const { base, post } = await serve(t);
  for (const authorization of [undefined, 'Bearer wrong', 'Basic local-test-secret', `Bearer ${apiKey} extra`]) {
    const headers = authorization === undefined ? {} : { authorization };
    const result = await fetch(`${base}/v1/models`, { headers });
    assert.equal(result.status, 401);
    assert.equal(result.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await result.text()).includes(apiKey), false);
  }
  const unauthorized = await post(validBody, { headers: {} });
  assert.equal(unauthorized.status, 401);
  await unauthorized.arrayBuffer();
  const duplicate = await rawPost(base, JSON.stringify(validBody), { authorization: [`Bearer ${apiKey}`, 'Bearer wrong'] });
  assert.equal(duplicate.status, 401);
  const models = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  assert.equal(models.status, 200);
  const list = await models.json();
  assert.equal(list.object, 'list');
  assert.deepEqual(list.data.map(item => item.id), [model, 'other-model']);
});

test('non-stream completion combines text and forwards messages/model without inventing usage', { timeout: 5000 }, async t => {
  let received;
  const { post } = await serve(t, { provider: provider({
    async *stream(input) { received = input; yield '你'; yield ''; yield '好\nworld'; },
  }) });
  const result = await post();
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.model, model);
  assert.match(body.id, /^chatcmpl-/);
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.equal(body.choices[0].message.content, '你好\nworld');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(Object.hasOwn(body, 'usage'), false);
  assert.deepEqual(received.messages, messages);
  assert.equal(received.model, model);
  assert.ok(received.signal instanceof AbortSignal);
  assert.equal(received.signal.aborted, false);
});

test('SSE delivers the first delta before the upstream finishes, then emits stop and DONE', { timeout: 5000 }, async t => {
  const continueStream = deferred();
  t.after(() => continueStream.resolve());
  const { post } = await serve(t, { provider: provider({
    async *stream() { yield '你'; await continueStream.promise; yield '好\n世界'; },
  }) });
  const result = await post({ ...validBody, stream: true });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-type'), /^text\/event-stream/);
  const reader = result.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
    const part = await reader.read();
    assert.equal(part.done, false);
    text += decoder.decode(part.value, { stream: true });
  }
  const first = parseEvents(text)[0].data;
  assert.equal(first.choices[0].delta.role, 'assistant');
  assert.equal(first.choices[0].delta.content, '你');
  continueStream.resolve();
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    text += decoder.decode(part.value, { stream: true });
  }
  text += decoder.decode();
  const events = parseEvents(text);
  assert.equal(events.at(-1).data, '[DONE]');
  const chunks = events.slice(0, -1).map(event => event.data);
  assert.equal(chunks.map(chunk => chunk.choices[0].delta.content ?? '').join(''), '你好\n世界');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.ok(chunks.every(chunk => chunk.id === first.id && chunk.model === model && !Object.hasOwn(chunk, 'usage')));
});

test('empty upstream is a valid empty JSON or SSE completion', { timeout: 5000 }, async t => {
  const { post } = await serve(t, { provider: provider({ async *stream() {} }) });
  const json = await post({ ...validBody, stream: false });
  assert.equal((await json.json()).choices[0].message.content, '');
  const sse = await post({ ...validBody, stream: true });
  const events = parseEvents(await sse.text());
  assert.equal(events[0].data.choices[0].delta.role, 'assistant');
  assert.equal(events.at(-1).data, '[DONE]');
});

test('unsupported tools, fields, non-text messages, roles, models and stream types are rejected before upstream', { timeout: 5000 }, async t => {
  let calls = 0;
  const { post } = await serve(t, { provider: provider({ async *stream() { calls++; yield 'unused'; } }) });
  const cases = [
    [null, 'JSON object'],
    [[], 'JSON object'],
    [{ ...validBody, tools: [] }, 'tools'],
    [{ ...validBody, tool_choice: null }, 'tool_choice'],
    [{ ...validBody, temperature: 0.5 }, 'temperature'],
    [{ ...validBody, n: 2 }, 'n'],
    [{ ...validBody, stream: 'true' }, 'stream'],
    [{ ...validBody, stream: null }, 'stream'],
    [{ messages }, 'model'],
    [{ ...validBody, model: '' }, 'model'],
    [{ ...validBody, model: 'missing-model' }, 'model'],
    [{ ...validBody, messages: [] }, 'messages'],
    [{ ...validBody, messages: [null] }, 'message'],
    [{ ...validBody, messages: [{ role: 'tool', content: 'result' }] }, 'role'],
    [{ ...validBody, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] }] }, 'text'],
    [{ ...validBody, messages: [{ role: 'user', content: 7 }] }, 'text'],
    [{ ...validBody, messages: [{ role: 'assistant', content: 'ok', tool_calls: [] }] }, 'tool_calls'],
  ];
  for (const [input, message] of cases) {
    const result = await post(input);
    assert.equal(result.status, 400, JSON.stringify(input));
    assert.match((await result.json()).error.message, new RegExp(message, 'i'));
  }
  assert.equal(calls, 0);
});

test('bad and empty JSON return 400; unknown paths and unsupported route methods return 404', { timeout: 5000 }, async t => {
  const { base } = await serve(t);
  for (const body of ['{broken', '']) {
    const result = await rawPost(base, body);
    assert.equal(result.status, 400);
    assert.equal(JSON.parse(result.text).error.code, 'invalid_json');
  }
  for (const [path, method] of [['/missing', 'GET'], ['/v1/chat/completions', 'GET'], ['/v1/models', 'POST']]) {
    const result = await fetch(`${base}${path}`, { method });
    assert.equal(result.status, 404);
    await result.arrayBuffer();
  }
});

test('body byte limit accepts the exact boundary and rejects Content-Length or chunked excess with 413', { timeout: 5000 }, async t => {
  const body = JSON.stringify({ model, messages: [{ role: 'user', content: '你好' }] });
  const maxBodyBytes = Buffer.byteLength(body);
  let calls = 0;
  const { base } = await serve(t, { maxBodyBytes, provider: provider({ async *stream() { calls++; yield 'ok'; } }) });
  const exact = await rawPost(base, body, { 'content-length': maxBodyBytes });
  assert.equal(exact.status, 200);
  assert.equal(JSON.parse(exact.text).choices[0].message.content, 'ok');
  const oversized = `${body} `;
  const declared = await rawPost(base, oversized, { 'content-length': Buffer.byteLength(oversized) });
  assert.equal(declared.status, 413);
  const chunked = await rawPost(base, [Buffer.from(body), Buffer.from(' ')]);
  assert.equal(chunked.status, 413);
  assert.equal(JSON.parse(chunked.text).error.code, 'body_too_large');
  assert.equal(calls, 1);
});

test('default concurrency is one: busy request returns 429 and the slot is reusable', { timeout: 5000 }, async t => {
  const started = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let calls = 0;
  const { post } = await serve(t, { provider: provider({ async *stream() {
    calls++;
    if (calls === 1) { started.resolve(); await release.promise; }
    yield 'ok';
  } }) });
  const pending = post();
  await started.promise;
  const busy = await post();
  assert.equal(busy.status, 429);
  assert.equal((await busy.json()).error.code, 'server_busy');
  assert.equal(calls, 1);
  release.resolve();
  assert.equal((await (await pending).json()).choices[0].message.content, 'ok');
  const again = await post();
  assert.equal(again.status, 200);
  await again.arrayBuffer();
});

test('configured concurrency permits two active upstreams and rejects the third', { timeout: 5000 }, async t => {
  const bothStarted = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let calls = 0;
  const { post } = await serve(t, { maxConcurrency: 2, provider: provider({ async *stream() {
    if (++calls === 2) bothStarted.resolve();
    await release.promise;
    yield 'ok';
  } }) });
  const first = post();
  const second = post();
  await bothStarted.promise;
  const third = await post();
  assert.equal(third.status, 429);
  await third.arrayBuffer();
  assert.equal(calls, 2);
  release.resolve();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.status, 200);
    await result.arrayBuffer();
  }
});

test('disconnect before the first delta aborts upstream and releases a stuck generator slot', { timeout: 5000 }, async t => {
  const started = deferred();
  const aborted = deferred();
  let calls = 0;
  const { post } = await serve(t, { provider: provider({ async *stream({ signal }) {
    if (++calls === 1) {
      signal.addEventListener('abort', () => aborted.resolve(signal.aborted), { once: true });
      started.resolve();
      await new Promise(() => {});
    }
    yield 'recovered';
  } }) });
  const cancellation = new AbortController();
  const pending = post({ ...validBody, stream: true }, { signal: cancellation.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started.promise;
  cancellation.abort();
  await rejected;
  assert.equal(await aborted.promise, true);
  const next = await post();
  assert.equal(next.status, 200);
  assert.equal((await next.json()).choices[0].message.content, 'recovered');
});

test('disconnect during an incomplete request body leaves the server usable without starting upstream', { timeout: 5000 }, async t => {
  let calls = 0;
  const { server, base, post } = await serve(t, { provider: provider({ async *stream() { calls++; yield 'ok'; } }) });
  const accepted = once(server, 'request');
  const upload = http.request(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}` },
  });
  upload.on('error', () => {});
  upload.write('{"model":');
  const [incoming] = await accepted;
  const disconnected = once(incoming, 'aborted');
  upload.destroy();
  await disconnected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  const next = await post();
  assert.equal(next.status, 200);
  await next.arrayBuffer();
  assert.equal(calls, 1);
});

test('disconnect after an SSE delta aborts upstream and releases the slot immediately', { timeout: 5000 }, async t => {
  const aborted = deferred();
  let calls = 0;
  const { base, post } = await serve(t, { provider: provider({ async *stream({ signal }) {
    if (++calls === 1) {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      yield 'first';
      await new Promise(() => {});
    }
    yield 'recovered';
  } }) });
  const response = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` } }, resolve);
    req.on('error', reject);
    req.end(JSON.stringify({ ...validBody, stream: true }));
  });
  await once(response, 'data');
  response.destroy();
  await aborted.promise;
  const next = await post();
  assert.equal(next.status, 200);
  await next.arrayBuffer();
});

test('first upstream failure retains its real HTTP status/code/message even for SSE and frees the slot', { timeout: 5000 }, async t => {
  let calls = 0;
  const { post } = await serve(t, { provider: provider({ async *stream() {
    if (++calls <= 2) throw Object.assign(new Error('Sanitized upstream rate limit.'), { status: 429, code: 'rate_limit' });
    yield 'ok';
  } }) });
  for (const stream of [false, true]) {
    const result = await post({ ...validBody, stream });
    assert.equal(result.status, 429);
    assert.match(result.headers.get('content-type'), /^application\/json/);
    const { error } = await result.json();
    assert.equal(error.code, 'rate_limit');
    assert.equal(error.message, 'Sanitized upstream rate limit.');
  }
  const next = await post();
  assert.equal(next.status, 200);
  await next.arrayBuffer();
});

test('mid-stream error emits terminal SSE error without stop or DONE; JSON returns the upstream status', { timeout: 5000 }, async t => {
  const { post } = await serve(t, { provider: provider({ async *stream() {
    yield 'partial';
    throw Object.assign(new Error('Sanitized permission failure.'), { status: 403, code: 'upstream_denied' });
  } }) });
  const streamed = await post({ ...validBody, stream: true });
  assert.equal(streamed.status, 200);
  const events = parseEvents(await streamed.text());
  assert.equal(events[0].data.choices[0].delta.content, 'partial');
  assert.equal(events.at(-1).event, 'error');
  assert.equal(events.at(-1).data.error.code, 'upstream_denied');
  assert.equal(events.at(-1).data.error.message, 'Sanitized permission failure.');
  assert.equal(events.some(event => event.data === '[DONE]' || event.data.choices?.[0].finish_reason === 'stop'), false);
  const json = await post();
  assert.equal(json.status, 403);
  assert.equal((await json.json()).error.code, 'upstream_denied');
});

test('upstream failures without a valid HTTP status map to 502', { timeout: 5000 }, async t => {
  const { post } = await serve(t, { provider: provider({ async *stream() {
    throw Object.assign(new Error('Sanitized failure.'), { status: 200, code: 'bad_upstream' });
  } }) });
  const result = await post();
  assert.equal(result.status, 502);
  assert.equal((await result.json()).error.message, 'Sanitized failure.');
});

test('timeout before headers returns 504, aborts an uncooperative upstream and releases its slot', { timeout: 5000 }, async t => {
  let calls = 0;
  let firstSignal;
  const { post } = await serve(t, { timeoutMs: 60, provider: provider({ async *stream({ signal }) {
    if (++calls === 1) { firstSignal = signal; await new Promise(() => {}); }
    yield 'recovered';
  } }) });
  const timedOut = await post({ ...validBody, stream: true });
  assert.equal(timedOut.status, 504);
  assert.equal((await timedOut.json()).error.code, 'upstream_timeout');
  assert.equal(firstSignal.aborted, true);
  const next = await post();
  assert.equal(next.status, 200);
  await next.arrayBuffer();
});

test('timeout after headers closes SSE with an error and releases the slot', { timeout: 5000 }, async t => {
  let calls = 0;
  let firstSignal;
  const { post } = await serve(t, { timeoutMs: 60, provider: provider({ async *stream({ signal }) {
    if (++calls === 1) { firstSignal = signal; yield 'first'; await new Promise(() => {}); }
    yield 'recovered';
  } }) });
  const result = await post({ ...validBody, stream: true });
  assert.equal(result.status, 200);
  const events = parseEvents(await result.text());
  assert.equal(events.at(-1).event, 'error');
  assert.equal(events.at(-1).data.error.code, 'upstream_timeout');
  assert.equal(events.some(event => event.data === '[DONE]'), false);
  assert.equal(firstSignal.aborted, true);
  const next = await post();
  assert.equal(next.status, 200);
  await next.arrayBuffer();
});

test('invalid upstream delta is rejected instead of converted into text', { timeout: 5000 }, async t => {
  const { post } = await serve(t, { provider: provider({ async *stream() { yield { content: 'wrong shape' }; } }) });
  const result = await post({ ...validBody, stream: true });
  assert.equal(result.status, 502);
  assert.equal((await result.json()).error.code, 'invalid_upstream_response');
});
