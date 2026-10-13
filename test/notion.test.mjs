import test from 'node:test';
import assert from 'node:assert/strict';
import { NotionProvider, TranscriptState, ndjson, newThreadId, messagesToPrompt } from '../src/notion.mjs';

const session = { tokenV2: 'local-test-token', userId: 'test-user', spaceId: '0000abcd-1234-8000-8000-000300000000' };
const messages = [{ role: 'user', content: 'hello' }];
const answer = text => ({ op: 'put', entity: { id: 'answer', kind: 'assistant_message', sequence: 2, content: [{ type: 'text', text }] } });
const end = [{ op: 'put', entity: { id: 'end', kind: 'turn_completed', sequence: 3 } }, { op: 'session', session: { status: 'idle', pending_input: null } }];

test('workspace thread ids preserve shard and table with random uniqueness', () => {
  const a = newThreadId(session.spaceId, Date.UTC(2026, 9, 13)), b = newThreadId(session.spaceId, Date.UTC(2026, 9, 13));
  assert.notEqual(a, b);
  assert.match(a, /^3f80abcd-1234-80[0-9a-f]{2}-[89ab][0-9a-f]{3}-00a9[0-9a-f]{8}$/);
});
test('older UUID workspaces use random v4 IDs', () => assert.match(newThreadId('00000000-0000-4000-8000-000000000000'), /^[\da-f]{8}-[\da-f]{4}-4/));
test('prompt quotes all supplied roles and asks for conversation-only response', () => {
  const text = messagesToPrompt([{ role: 'system', content: 'rules' }, ...messages, { role: 'assistant', content: 'answer' }]);
  assert.ok(text.includes('"system"') && text.includes('"assistant"') && text.includes('rules'));
});
test('NDJSON preserves fragmented UTF-8 and final line without newline', async () => {
  const bytes = Buffer.from('{"text":"你好"}\n{"text":"end"}');
  async function* chunks() { for (const byte of bytes) yield Uint8Array.of(byte); }
  assert.deepEqual(await Array.fromAsync(ndjson(chunks())), [{ text: '你好' }, { text: 'end' }]);
});
test('malformed and oversized upstream events fail explicitly', async () => {
  await assert.rejects(Array.fromAsync(ndjson([Buffer.from('{bad}\n')])), { code: 'notion_invalid_json' });
  await assert.rejects(Array.fromAsync(ndjson([Buffer.from('123456')], 4)), { code: 'notion_response_too_large' });
});
test('only assistant text is returned; a turn without idle is incomplete', () => {
  const state = new TranscriptState();
  const result = state.apply([
    { op: 'put', entity: { id: 'user', kind: 'user_message', text: [['private']] } },
    { op: 'put', entity: { id: 'think', kind: 'thinking', content_text: 'internal' } }, answer('OK'), end[0]
  ]);
  assert.deepEqual(result, { text: 'OK', completed: false });
  assert.equal(state.apply([end[1]]).completed, true);
});
test('live provisional append patches produce cumulative answer', () => {
  const state = new TranscriptState();
  state.apply([{ op: 'put', entity: { id: 'answer', source: 'provisional', kind: 'assistant_message', content: [{ type: 'text', text: 'O' }] } }]);
  assert.equal(state.apply([{ op: 'patch', id: 'answer', ops: [{ op: 'append', path: '/content/0/text', value: 'K' }] }]).text, 'OK');
});
test('patch prototype traversal and unknown operations are rejected', () => {
  const state = new TranscriptState(); state.apply([answer('OK')]);
  assert.throws(() => state.apply([{ op: 'patch', id: 'answer', ops: [{ op: 'replace', path: '/__proto__/polluted', value: true }] }]), { code: 'notion_unknown_patch' });
  assert.equal({}.polluted, undefined);
  assert.throws(() => state.apply([{ op: 'new-format' }]), { code: 'notion_unknown_patch' });
});
test('quota, upstream error and human action requirements cannot become success', () => {
  assert.throws(() => new TranscriptState().apply([{ op: 'put', entity: { id: 'limit', kind: 'status', status: 'rate_limited' } }]), { status: 429 });
  assert.throws(() => new TranscriptState().apply([], { status: 'idle', last_turn_allowance: { notion_exhausted: true } }), { status: 429 });
  assert.throws(() => new TranscriptState().apply([{ op: 'put', entity: { id: 'error', kind: 'error', message: 'sensitive upstream detail' } }]), { code: 'notion_upstream_error' });
  assert.throws(() => new TranscriptState().apply([], { pending_input: { type: 'approval' } }), { status: 409 });
});
test('provider uses authenticated fixed-origin requests, then streams real deltas', async () => {
  const seen = [];
  const provider = new NotionProvider(session, { fetchImpl: async (url, options) => {
    seen.push({ url, options });
    return seen.length === 1 ? Response.json({ thread: {} }) : new Response([
      JSON.stringify({ patches: [answer('O')] }), JSON.stringify({ patches: [answer('OK'), ...end] })
    ].join('\n'), { headers: { 'content-type': 'application/x-ndjson' } });
  } });
  assert.deepEqual(await Array.fromAsync(provider.stream({ messages, model: 'notion-auto' })), ['O', 'K']);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, 'https://app.notion.com/api/v3/createAgentThread');
  assert.ok(seen[0].options.headers.cookie.includes(session.tokenV2));
  const body = JSON.parse(seen[0].options.body);
  assert.deepEqual(body.policies, { approval_mode: 'ask' });
  assert.equal(body.browserEnabled, false);
  assert.equal(Object.hasOwn(body, 'model'), false);
  assert.ok(Array.isArray(body.content[0].text[0]));
});
test('HTTP errors are returned without logging upstream bodies or credentials', async () => {
  const provider = new NotionProvider(session, { fetchImpl: async () => new Response('private detail ' + session.tokenV2, { status: 403 }) });
  await assert.rejects(Array.fromAsync(provider.stream({ messages, model: 'notion-auto' })), error => error.status === 403 && !error.message.includes(session.tokenV2) && !error.message.includes('private detail'));
});
test('EOF without completion and answer revisions fail', async () => {
  for (const [events, code] of [
    [[{ patches: [answer('O')] }], 'notion_incomplete_stream'],
    [[{ patches: [answer('O')] }, { patches: [answer('Changed')] }], 'notion_stream_revised']
  ]) {
    let calls = 0;
    const provider = new NotionProvider(session, { fetchImpl: async () => ++calls === 1 ? Response.json({}) : new Response(events.map(JSON.stringify).join('\n')) });
    await assert.rejects(Array.fromAsync(provider.stream({ messages, model: 'notion-auto' })), { code });
  }
});
