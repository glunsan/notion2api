import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export async function loadConfig({ env = process.env, root = projectRoot } = {}) {
  let session = {};
  const local = path.join(root, '.local');
  try { session = JSON.parse(await readFile(path.join(local, 'notion-session.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('本地 Notion 会话文件格式不正确。'); }
  let apiKey = env.API_KEY;
  if (!apiKey) {
    await mkdir(local, { recursive: true });
    const keyPath = path.join(local, 'api-key.txt');
    try { apiKey = (await readFile(keyPath, 'utf8')).trim(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      apiKey = 'n2a_' + randomBytes(32).toString('hex');
      try { await writeFile(keyPath, apiKey + '\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; apiKey = (await readFile(keyPath, 'utf8')).trim(); }
    }
  }
  if (apiKey.length < 24) throw new Error('API_KEY 至少需要 24 个字符。');
  const host = env.HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('此版本只允许本机监听：HOST=127.0.0.1 或 ::1。');
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 至 65535。');
  const transport = env.NOTION_TRANSPORT || 'direct';
  if (!['direct', 'browser'].includes(transport)) throw new Error('NOTION_TRANSPORT 必须为 direct 或 browser。');
  if (transport === 'browser' && (host !== '127.0.0.1' || port !== 8787)) throw new Error('当前浏览器扩展只支持 HOST=127.0.0.1、PORT=8787。');
  return {
    host, port, apiKey, transport,
    tokenV2: env.NOTION_TOKEN_V2 || session.tokenV2,
    userId: env.NOTION_USER_ID || session.userId,
    spaceId: env.NOTION_SPACE_ID || session.spaceId,
    clientVersion: session.clientVersion,
    deviceId: session.deviceId,
    browserId: session.browserId,
    cellHint: session.cellHint,
    sessionPath: path.join(local, 'notion-session.json'),
    apiKeyPath: path.join(local, 'api-key.txt')
  };
}
