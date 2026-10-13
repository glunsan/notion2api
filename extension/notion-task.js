// Runs in the selected real Notion page. No Cookie, browser storage, or login token is read.
export async function generateInNotion(job) {
  const send = payload => new Promise((resolve, reject) => {
    const frameId = crypto.randomUUID();
    const timeout = setTimeout(() => finish(false), 20000);
    function receive(event) {
      const data = event.data;
      if (event.source === window && event.origin === 'https://app.notion.com' && data?.channel === 'notion2api-local-ack' && data.jobId === job.id && data.nonce === job.nonce && data.frameId === frameId) finish(data.ok === true);
    }
    function finish(ok) { clearTimeout(timeout); window.removeEventListener('message', receive); ok ? resolve() : reject(Object.assign(new Error('Bridge rejected frame'), { status: 502, code: 'notion_network_error' })); }
    window.addEventListener('message', receive);
    window.postMessage({ channel: 'notion2api-local-bridge', jobId: job.id, nonce: job.nonce, frameId, ...payload }, 'https://app.notion.com');
  });
  const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
  if (location.origin !== 'https://app.notion.com') return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 115000);
  const entities = new Map();
  let session, emitted = '';
  async function request(endpoint, body) {
    const response = await fetch('/api/v3/' + endpoint, {
      method: 'POST', credentials: 'include', redirect: 'error', signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-notion-active-user-header': job.userId, 'x-notion-space-id': job.spaceId,
        ...(document.documentElement.dataset.notionVersion ? { 'notion-client-version': document.documentElement.dataset.notionVersion } : {}),
        ...(job.cellHint ? { 'x-notion-cell-hint': job.cellHint, 'x-notion-cell-hint-source': 'space-id-mapping' } : {})
      }, body: JSON.stringify(body)
    });
    if (!response.ok) fail(response.status, response.status === 429 ? 'notion_quota_exhausted' : [401, 403].includes(response.status) ? 'notion_access_denied' : 'notion_request_rejected');
    return response;
  }
  function applyOperation(entity, operation) {
    const parts = typeof operation.path === 'string' && operation.path.startsWith('/') ? operation.path.slice(1).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~')) : [];
    if (!parts.length || parts.some(p => ['__proto__', 'constructor', 'prototype'].includes(p))) fail(502, 'notion_unknown_patch');
    let target = entity;
    for (const part of parts.slice(0, -1)) { if (!target || !Object.hasOwn(target, part)) fail(502, 'notion_unknown_patch'); target = target[part]; }
    const key = parts.at(-1);
    if (!target || typeof target !== 'object') fail(502, 'notion_unknown_patch');
    if (operation.op === 'append') {
      if (entity.source !== 'provisional' || !['/content/0/text', '/content_text'].includes(operation.path) || typeof target[key] !== 'string' || typeof operation.value !== 'string') fail(502, 'notion_unknown_patch');
      target[key] += operation.value;
    } else if (['replace', 'add'].includes(operation.op) && !Array.isArray(target)) target[key] = structuredClone(operation.value);
    else fail(502, 'notion_unknown_patch');
  }
  async function applyEvent(event) {
    if (event.session) session = event.session;
    for (const patch of event.patches || []) {
      if (patch.op === 'put') entities.set(patch.entity.id, structuredClone(patch.entity));
      else if (patch.op === 'remove') entities.delete(patch.id);
      else if (['session', 'session_status'].includes(patch.op)) session = patch.session;
      else if (patch.op === 'patch') {
        const entity = entities.get(patch.id); if (!entity) fail(502, 'notion_unknown_patch');
        for (const operation of patch.ops || []) applyOperation(entity, operation);
      } else if (patch.op !== 'committed') fail(502, 'notion_unknown_patch');
    }
    const values = [...entities.values()].sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
    if (session?.pending_input) fail(409, 'notion_user_action_required');
    if (session?.last_turn_allowance?.notion_exhausted || values.some(e => e.kind === 'status' && ['rate_limited', 'notion_credits_exhausted'].includes(e.status))) fail(429, 'notion_quota_exhausted');
    if (values.some(e => ['error', 'client_update_required'].includes(e.kind))) fail(502, 'notion_request_rejected');
    const text = values.filter(e => e.kind === 'assistant_message').map(e => (e.content || []).filter(p => p.type === 'text').map(p => p.text || '').join('')).join('\n\n');
    if (!text.startsWith(emitted)) fail(502, 'notion_unknown_patch');
    if (text.length > emitted.length) {
      const delta = text.slice(emitted.length);
      for (let offset = 0; offset < delta.length;) {
        let end = Math.min(offset + 8000, delta.length);
        if (end < delta.length && /[\uD800-\uDBFF]/.test(delta[end - 1]) && /[\uDC00-\uDFFF]/.test(delta[end])) end--;
        await send({ kind: 'delta', text: delta.slice(offset, end) });
        offset = end;
      }
      emitted = text;
    }
    if (values.some(e => e.kind === 'turn_completed') && session?.status === 'idle') {
      if (!emitted) fail(502, 'notion_empty_answer');
      return true;
    }
    return false;
  }
  try {
    const created = await request('createAgentThread', {
      type: 'personal_agent', spaceId: job.spaceId, threadId: job.threadId, clientMessageId: crypto.randomUUID(),
      content: [{ type: 'text', text: [[job.prompt]] }], createdSource: 'full_page_chat',
      enableSuggestedEditsTools: true, policies: { approval_mode: 'ask' },
      agentMemorySettings: { useMemories: false, excludeChatFromMemories: true }, browserEnabled: false
    });
    await created.json();
    const response = await request('listenToThreadTranscript', { spaceId: job.spaceId, threadId: job.threadId, includeProvisionalUserMessages: true, includeQueueChanges: false });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '', completed = false;
    try {
      while (!completed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
          if (new TextEncoder().encode(line).byteLength > 1048576) fail(502, 'notion_unknown_patch');
          if (line) completed = await applyEvent(JSON.parse(line));
          if (completed) break;
        }
        if (pending.length > 1048576) fail(502, 'notion_unknown_patch');
      }
      if (!completed && pending.trim()) completed = await applyEvent(JSON.parse(pending));
      if (!completed) fail(502, 'notion_incomplete_stream');
      await send({ kind: 'done' });
    } finally { await reader.cancel().catch(() => {}); }
  } catch (error) { await send({ kind: 'error', status: error.status || 502, code: error.code || 'notion_network_error' }).catch(() => {}); }
  finally { clearTimeout(timer); controller.abort(); }
}
