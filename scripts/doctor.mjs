import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';
const config = await loadConfig();
if (!config.tokenV2 || !config.userId) throw new Error('先导入 Notion 登录会话。');
const response = await fetch('https://app.notion.com/api/v3/getSpaces', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `token_v2=${config.tokenV2}; notion_user_id=${config.userId}`, 'x-notion-active-user-header': config.userId },
  body: '{}', signal: AbortSignal.timeout(30000), redirect: 'error'
});
if (!response.ok) { console.error(`Notion 登录验证失败（HTTP ${response.status}）。请正常重新登录后导入；若出现验证页面，请在浏览器处理。`); process.exit(1); }
const result = await response.json();
const spaces = [];
for (const [userId, records] of Object.entries(result)) {
  for (const [spaceId, entry] of Object.entries(records.recordMap?.space || records.space || {})) {
    const data = entry.value?.value || entry.value || entry;
    if (data.name) spaces.push({ userId, spaceId, name: data.name });
  }
}
const requested = process.argv.indexOf('--workspace');
const name = requested === -1 ? undefined : process.argv[requested + 1];
const matches = name ? spaces.filter(space => space.name === name) : spaces.filter(space => space.spaceId === config.spaceId);
const selected = matches.length === 1 ? matches[0] : !name && !config.spaceId && spaces.length === 1 ? spaces[0] : undefined;
console.log(JSON.stringify({ authenticated: true, workspaces: spaces.map(space => ({ name: space.name, selected: space === selected })), aiQuota: 'unknown; use npm run smoke for a real AI request' }, null, 2));
if (!selected) { console.error('工作区选择不明确。运行 npm run doctor -- --workspace "工作区名称"。'); process.exit(1); }
let session = {};
try { session = JSON.parse(await readFile(config.sessionPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
Object.assign(session, selected);
try {
  const htmlResponse = await fetch('https://app.notion.com/ai', { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (htmlResponse.ok) {
    const version = (await htmlResponse.text()).match(/data-notion-version="([^"]+)"/)?.[1];
    if (version) session.clientVersion = version;
  }
} catch { /* Workspace auth remains usable even when public version discovery fails. */ }
await writeFile(config.sessionPath, JSON.stringify(session, null, 2), { mode: 0o600 });
