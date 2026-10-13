# notion2api

把本人登录的 Notion AI 工作区接到本机 OpenAI Chat Completions 接口的**实验项目**，Node.js 24，无运行依赖。

> **当前状态：尚未打通真实 API 生成。** 正常 Notion 页面生成通过，已抓到桌面版成功的创建请求；Node 直连复测仍返回 `400 UserValidationError`。浏览器桥接与 OpenCodex 接入代码已准备，扩展启用、真实生成和最终 OpenCodex 调用仍待验证。不要把代码测试或 `/health` 的 `ready` 当作额度已代理的证据。

用户希望使用 OpenCodex 时，见 [浏览器桥接与 OpenCodex](docs/browser-bridge.md)。当前 OpenCodex 没有 Notion 内置适配器；接入脚本只有在真实生成挑战成功后才注册独立上游。

## 启动

需要 Node.js 24（最低 22.16）。Windows 自动导入另外需要 Python 3 和 `cryptography`；服务运行不需要 Python。

```powershell
# 在本项目目录中
python -m pip install cryptography
# 先完全退出桌面版 Notion；只导入自己的正常登录会话。
python scripts/import-notion-session.py --output .local/notion-session.json
npm run doctor -- --workspace "你的工作区名称"
npm start
```

也可以复制 `.env.example` 为本地 `.env`，填写自己的 `NOTION_TOKEN_V2`、`NOTION_USER_ID`、`NOTION_SPACE_ID`。Notion 官方 integration token（`ntn_...`）不能替代网页会话。

服务只允许监听本机 `127.0.0.1` 或 `::1`，默认端口 `8787`。首次运行自动生成 `.local/api-key.txt`，作为客户端 Bearer API key。`.local/` 和 `.env` 已加入 `.gitignore`；不要上传登录数据、HAR、Cookie 数据库或原始上游响应。

## 客户端配置

| 设置 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API key | `.local/api-key.txt` 中的值 |
| Model | `notion-auto` |

```powershell
$apiKey = (Get-Content -Raw .local/api-key.txt).Trim()
$payload = @{
  model = 'notion-auto'
  messages = @(@{ role = 'user'; content = '只回复 OK，不要读取或操作工作区。' })
  stream = $false
} | ConvertTo-Json -Depth 6
Invoke-RestMethod 'http://127.0.0.1:8787/v1/chat/completions' `
  -Method Post -Headers @{ Authorization = "Bearer $apiKey" } `
  -ContentType 'application/json; charset=utf-8' -Body $payload
```

真实接通测试：先启动服务，再运行 `npm run smoke`。它最多发起两次 AI 请求，分别检查非流式和流式模式，首个失败即停止。当前本账号预期会返回上游 400，而不是成功答案。

## 范围与限制

- `GET /health` 表示服务和本地配置状态；`ready: true` 只表示三项会话配置齐全。
- `GET /v1/models` 和 `POST /v1/chat/completions` 需要 Bearer 密钥。
- 支持文本 `system/user/assistant` messages；历史会作为引用文本提交到 Notion。`system` 不能覆盖 Notion 自己的上游系统指令。
- 支持 JSON 和 SSE 响应；SSE 从上游文本补丁追加输出，失败时输出错误，不发送成功 `[DONE]`。
- 工具调用、图片、Responses API、温度、token 上限等未实现的参数会明确拒绝。没有伪造 token usage，也没有保证具体底层模型。
- 默认并发 1、请求体上限 1 MiB、120 秒超时。断开会取消本地上游监听；Notion 端已经开始的任务是否停止，**未验证**。
- 请求只选择当前账号的自动模型，不修改工作区权限或付费方案。浏览器能力关闭；工具需询问批准，遇到人工授权等待就返回错误。没有实现工具批准接口。
- 每次请求会尝试创建一条 Notion AI 对话，提示用户内容只在对话内回答。对话可能保存在 Notion 历史中。记忆关闭请求字段的实际行为**未验证**。
- 剩余额度没有查到可靠数字；当前接口返回 `not_configured`，不代表无限额度或没有额度。试用结束、登录失效、额度不足及后端变更都可能影响使用。

## 验证

```powershell
npm test        # 本地协议/浏览器桥接/解析/失败处理测试，不消耗 Notion 额度
npm run doctor # 真实工作区登录验证，不进行 AI 推理
npm run smoke  # 真实 AI 请求；失败会以非零退出码结束
```

见 [验证记录](docs/verification.md) 和 [接口依据](docs/protocol.md)。只有真实 `smoke` 成功才能说明当时的账号额度已可经此接口调用。

MIT License。项目与 Notion 官方无关联；使用未公开的客户端接口，只限本人有权使用的工作区。
