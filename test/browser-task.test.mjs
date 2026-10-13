import test from 'node:test';
import assert from 'node:assert/strict';
import { generateInNotion } from '../extension/notion-task.js';

const job = { id: 'task', nonce: 'nonce', threadId: 'thread', spaceId: 'space', userId: 'user', prompt: 'Only reply OK' };
const answer = text => ({ op: 'put', entity: { id: 'answer', kind: 'assistant_message', sequence: 2, content: [{ type: 'text', text }] } });
const end = [{ op: 'put', entity: { id: 'end', kind: 'turn_completed', sequence: 3 } }, { op: 'session', session: { status: 'idle', pending_input: null } }];

async function browserHarness(events, options = {}) {
  const originals = { window: globalThis.window, location: globalThis.location, document: globalThis.document, fetch: globalThis.fetch };
  const listeners = new Set(), frames = [], requests = [];
  const fakeWindow = {
    addEventListener(name, handler) { assert.equal(name, 'message'); listeners.add(handler); },
    removeEventListener(name, handler) { listeners.delete(handler); },
    postMessage(data, origin) {
      assert.equal(origin, 'https://app.notion.com'); frames.push(data);
      const acknowledge = () => { for (const handler of [...listeners]) handler({ source: fakeWindow, origin, data: { channel: 'notion2api-local-ack', jobId: job.id, nonce: job.nonce, frameId: data.frameId, ok: options.rejectFrame !== true } }); };
      queueMicrotask(acknowledge);
    }
  };
  globalThis.window = fakeWindow;
  globalThis.location = { origin: options.origin || 'https://app.notion.com' };
  globalThis.document = { documentElement: { dataset: { notionVersion: 'test-version' } }, get cookie() { throw new Error('Cookies must never be read by the bridge.'); } };
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (options.httpError) return new Response('private upstream detail', { status: options.httpError });
    if (requests.length === 1) return Response.json({ thread: {} });
    const bytes = Buffer.from(events.map(JSON.stringify).join('\n'));
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7)); controller.close(); } }));
  };
  try { await generateInNotion(job); return { frames, requests, listenerCount: listeners.size }; }
  finally { for (const [key, value] of Object.entries(originals)) value === undefined ? delete globalThis[key] : globalThis[key] = value; }
}

test('browser task sends scoped requests with browser credentials, never reading or exporting cookies', async () => {
  const { frames, requests, listenerCount } = await browserHarness([{ patches: [answer('你')] }, { patches: [answer('你好'), ...end] }]);
  assert.deepEqual(frames.map(f => [f.kind, f.text]), [['delta', '你'], ['delta', '好'], ['done', undefined]]);
  assert.deepEqual(requests.map(r => r.url), ['/api/v3/createAgentThread', '/api/v3/listenToThreadTranscript']);
  assert.equal(requests[0].init.credentials, 'include');
  assert.equal(Object.hasOwn(requests[0].init.headers, 'cookie'), false);
  assert.equal(JSON.parse(requests[0].init.body).policies.approval_mode, 'ask');
  assert.equal(listenerCount, 0);
});
test('wrong-origin pages receive no task, network request, or credential access', async () => {
  const { frames, requests } = await browserHarness([], { origin: 'https://example.org' });
  assert.equal(frames.length, 0); assert.equal(requests.length, 0);
});
test('upstream access rejection is explicit and does not expose raw upstream error', async () => {
  const { frames } = await browserHarness([], { httpError: 403 });
  assert.equal(frames.at(-1).kind, 'error');
  assert.equal(frames.at(-1).code, 'notion_access_denied');
  assert.equal(JSON.stringify(frames).includes('private upstream detail'), false);
});
test('human approval and quota events stop without granting approval or emitting DONE', async () => {
  for (const [event, code] of [
    [{ patches: [{ op: 'session', session: { pending_input: { kind: 'approval' } } }] }, 'notion_user_action_required'],
    [{ patches: [{ op: 'session', session: { last_turn_allowance: { notion_exhausted: true } } }] }, 'notion_quota_exhausted']
  ]) {
    const { frames, requests } = await browserHarness([event]);
    assert.equal(frames.at(-1).kind, 'error'); assert.equal(frames.at(-1).code, code);
    assert.equal(frames.some(f => f.kind === 'done'), false);
    assert.equal(requests.length, 2);
  }
});
test('incomplete stream and unknown patches cannot be passed off as a completed answer', async () => {
  for (const [events, code] of [
    [[{ patches: [answer('partial')] }], 'notion_incomplete_stream'],
    [[{ patches: [{ op: 'unknown' }] }], 'notion_unknown_patch']
  ]) {
    const { frames } = await browserHarness(events);
    assert.equal(frames.at(-1).code, code); assert.equal(frames.some(f => f.kind === 'done'), false);
  }
});
test('long deltas are acknowledged in bounded frames before completion', async () => {
  const text = '中'.repeat(7999) + '🙂'.repeat(5000);
  const { frames } = await browserHarness([{ patches: [answer(text), ...end] }]);
  assert.equal(frames.filter(f => f.kind === 'delta').map(f => f.text).join(''), text);
  assert.ok(frames.filter(f => f.kind === 'delta').every(f => f.text.length <= 8000));
  assert.ok(frames.filter(f => f.kind === 'delta').every(f => !/[\uD800-\uDBFF]$/.test(f.text) && !/^[\uDC00-\uDFFF]/.test(f.text)));
  assert.equal(frames.at(-1).kind, 'done');
});
