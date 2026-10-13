import { loadConfig } from './config.mjs';
import { NotionProvider } from './notion.mjs';
import { createServer } from './server.mjs';
import { BrowserRelayProvider } from './browser-relay.mjs';

const config = await loadConfig();
const provider = config.transport === 'browser' ? new BrowserRelayProvider(config) : new NotionProvider(config);
const server = createServer({ provider, apiKey: config.apiKey });
server.on('error', error => { console.error(`服务启动失败：${error.code || 'unknown_error'}`); process.exitCode = 1; });
server.listen(config.port, config.host, () => {
  console.log(`Notion2API: http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}/v1`);
  console.log(`本地 API 密钥文件：${config.apiKeyPath}`);
  console.log(`传输模式：${config.transport === 'browser' ? '浏览器桥接（等待扩展连接）' : '直接请求（当前真实生成未通过）'}`);
  console.log(config.transport === 'browser'
    ? `工作区元数据：${config.userId && config.spaceId ? '已配置，等待扩展连接' : '未配置，请先导入本人会话并选择工作区'}`
    : `Notion 会话：${provider.ready ? '已配置，运行 npm run doctor 验证' : '未配置，请先导入本地会话'}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { provider.close?.(); server.close(); });
