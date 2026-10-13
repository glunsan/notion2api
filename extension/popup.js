const key = document.getElementById('key'), tabs = document.getElementById('tabs'), status = document.getElementById('status');
async function refresh() {
  const config = await chrome.storage.local.get(['apiKey', 'tabId', 'status']);
  key.value = config.apiKey || '';
  const pages = await chrome.tabs.query({ url: 'https://app.notion.com/*' });
  tabs.replaceChildren(...pages.map(tab => { const option = document.createElement('option'); option.value = String(tab.id); option.textContent = tab.title || 'Notion'; option.selected = tab.id === config.tabId; return option; }));
  status.textContent = config.status || '尚未连接';
}
document.getElementById('open').addEventListener('click', async () => { await chrome.tabs.create({ url: 'https://app.notion.com/ai' }); window.close(); });
document.getElementById('connect').addEventListener('click', async () => {
  if (key.value.trim().length < 24 || !tabs.value) { status.textContent = '请填写本地密钥并选择已登录的 Notion 页面。'; return; }
  await chrome.storage.local.set({ apiKey: key.value.trim(), tabId: Number(tabs.value), enabled: true, status: '正在连接…' });
  await chrome.runtime.sendMessage({ kind: 'wake' });
  status.textContent = '已启用，等待本地服务确认';
});
document.getElementById('stop').addEventListener('click', async () => { await chrome.storage.local.set({ enabled: false, status: '已停止连接' }); status.textContent = '已停止连接'; });
chrome.storage.onChanged.addListener(changes => { if (changes.status) status.textContent = changes.status.newValue; });
await refresh();
