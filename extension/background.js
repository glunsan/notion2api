import { generateInNotion } from './notion-task.js';

let loopActive = false;
let currentJob = null;
let resultChain = Promise.resolve();
const safeError = message => new Error(message);
async function settings() { return chrome.storage.local.get(['enabled', 'apiKey', 'tabId', 'workerId']); }
async function status(text) { await chrome.storage.local.set({ status: text }); }
async function request(path, options = {}) {
  const { apiKey } = await settings();
  if (!apiKey) throw safeError('请填写本地 API 密钥');
  return fetch('http://127.0.0.1:8787' + path, {
    ...options, mode: 'cors', cache: 'no-store', redirect: 'error',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(options.timeoutMs || 20000)
  });
}
async function connect(config) {
  const response = await request('/bridge/connect', { method: 'POST', body: JSON.stringify({ workerId: config.workerId }) });
  if (!response.ok) throw safeError('本地桥接拒绝连接（HTTP ' + response.status + '）');
  await status('浏览器已连接；AI 可用性仍需真实测试');
}
async function runJob(job, config) {
  const tab = await chrome.tabs.get(config.tabId);
  if (!tab.url?.startsWith('https://app.notion.com/')) throw safeError('选择的 Notion 标签页已关闭或跳转');
  currentJob = { ...job, workerId: config.workerId, tabId: tab.id };
  resultChain = Promise.resolve();
  const heartbeat = setInterval(() => { void request('/bridge/connect', { method: 'POST', body: JSON.stringify({ workerId: config.workerId }) }).catch(() => {}); }, 10000);
  try {
    // A tab opened before extension installation needs its isolated listener injected once.
    try { await chrome.tabs.sendMessage(tab.id, { kind: 'prepare', job: { id: job.id, nonce: job.nonce } }); }
    catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { kind: 'prepare', job: { id: job.id, nonce: job.nonce } });
    }
    await status('正在进行一次 Notion 文本请求');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: generateInNotion, args: [job] });
    await resultChain;
    await status('浏览器已连接；等待下一条请求');
  } finally {
    clearInterval(heartbeat);
    await chrome.tabs.sendMessage(tab.id, { kind: 'clear', jobId: job.id }).catch(() => {});
    currentJob = null;
  }
}
async function loop() {
  if (loopActive) return;
  loopActive = true;
  try {
    let config = await settings();
    if (!config.enabled || !config.apiKey || !config.tabId) return;
    if (!config.workerId) { config.workerId = crypto.randomUUID(); await chrome.storage.local.set({ workerId: config.workerId }); }
    await connect(config);
    while ((await settings()).enabled) {
      config = await settings();
      const response = await request('/bridge/next?workerId=' + encodeURIComponent(config.workerId), { timeoutMs: 25000 });
      if (response.status === 204) continue;
      if (!response.ok) throw safeError('请求队列不可用（HTTP ' + response.status + '）');
      const job = await response.json();
      try { await runJob(job, config); }
      catch {
        await request('/bridge/result', { method: 'POST', body: JSON.stringify({ workerId: config.workerId, jobId: job.id, nonce: job.nonce, kind: 'error', status: 502, code: 'notion_network_error' }) }).catch(() => {});
        throw safeError('浏览器任务失败，请检查 Notion 登录和本地桥接');
      }
    }
  } catch (error) { await status(error.message || '连接已停止'); }
  finally { loopActive = false; }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.kind === 'wake') { void loop(); reply({ ok: true }); return; }
  if (message?.kind !== 'result' || !currentJob) return;
  const data = message.result;
  if (sender.tab?.id !== currentJob.tabId || sender.frameId !== 0 || data?.jobId !== currentJob.id || data.nonce !== currentJob.nonce) return;
  const job = currentJob;
  resultChain = resultChain.then(async () => {
    const response = await request('/bridge/result', { method: 'POST', body: JSON.stringify({
      workerId: job.workerId, jobId: job.id, nonce: job.nonce, kind: data.kind,
      ...(data.kind === 'delta' ? { text: data.text } : {}),
      ...(data.kind === 'error' ? { status: data.status, code: data.code } : {})
    }) });
    if (!response.ok) throw safeError('本地请求已取消或不再接受结果');
  });
  resultChain.then(() => reply({ ok: true }), () => reply({ ok: false }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'notion2api-wake') void loop(); });
chrome.runtime.onStartup.addListener(() => void loop());
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('notion2api-wake', { periodInMinutes: 0.5 }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled?.newValue === false) {
    void settings().then(config => request('/bridge/disconnect', { method: 'POST', body: JSON.stringify({ workerId: config.workerId }) })).catch(() => {});
  }
});
