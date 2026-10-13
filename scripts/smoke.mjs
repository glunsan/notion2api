import { loadConfig } from '../src/config.mjs';
const config = await loadConfig();
const base = `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`;
const headers = { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' };
const messages = [{ role: 'user', content: '这是一次最小连接测试。请只回复 NOTION2API_OK。不要访问工作区页面或执行任何操作。' }];
const results = [];
for (const stream of [false, true]) {
  const response = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers, body: JSON.stringify({ model: 'notion-auto', messages, stream }), signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    console.error(JSON.stringify({ pass: false, stream, status: response.status, error: error.error?.code, message: error.error?.message }));
    process.exit(1);
  }
  let text = '', done = false, count = 0;
  if (stream) {
    const body = await response.text();
    for (const frame of body.split(/\r?\n\r?\n/)) {
      const line = frame.split(/\r?\n/).find(line => line.startsWith('data: '));
      if (!line) continue;
      if (line === 'data: [DONE]') { done = true; continue; }
      const chunk = JSON.parse(line.slice(6));
      if (chunk.error) throw new Error(chunk.error.code || 'stream_error');
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) { text += delta; count++; }
    }
  } else {
    const body = await response.json();
    text = body.choices?.[0]?.message?.content || '';
    done = body.choices?.[0]?.finish_reason === 'stop';
  }
  const pass = text.trim().replace(/[。.]+$/, '') === 'NOTION2API_OK' && done;
  results.push({ pass, stream, status: response.status, returned: text.trim(), ...(stream ? { contentChunks: count, done } : {}) });
  if (!pass) { console.error(JSON.stringify({ results })); process.exit(1); }
}
console.log(JSON.stringify({ realNotionCalls: 2, results }, null, 2));
