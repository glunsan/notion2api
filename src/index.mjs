import { loadConfig } from './config.mjs';
import { NotionProvider } from './notion.mjs';
import { createServer } from './server.mjs';

const config = await loadConfig();
const provider = new NotionProvider(config);
const server = createServer({ provider, apiKey: config.apiKey });
server.on('error', error => { console.error(`服务启动失败：${error.code || 'unknown_error'}`); process.exitCode = 1; });
server.listen(config.port, config.host, () => {
  console.log(`Notion2API: http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}/v1`);
  console.log(`本地 API 密钥文件：${config.apiKeyPath}`);
  console.log(`Notion 会话：${provider.ready ? '已配置，运行 npm run doctor 验证' : '未配置，请先导入本地会话'}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
