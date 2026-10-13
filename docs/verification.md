# 验证记录

初次测试：2026-10-13 Asia/Taipei；Notion 网页版本 `23.13.20261012.2141`。无账户邮箱、会话 token、工作区 ID 或原始响应随代码公开。

| 验证项 | 结果 |
| --- | --- |
| 网页正常登录并在目标工作区新对话 | 成功 |
| 网页最小 AI 测试 | 精确回复 `NOTION2API_OK` |
| 桌面本人会话导入 | 成功，本地文件单独保存 |
| `app.notion.com/api/v3/getSpaces` | 200，目标工作区可访问 |
| `getThreadTranscript` 读取本次 UI 测试对话 | 200，正文为 `NOTION2API_OK`，`turn_completed`，session idle |
| `getPersonalAgentCreditUsage` | 200，`type: not_configured`；剩余额度未知 |
| 旧 `runInferenceTranscript` 最小请求 | HTTP 200，但响应事件为 `temporarily-unavailable`，没有答案 |
| 新 `createAgentThread` | 400，`UserValidationError` / `generic_error` |
| 新 `sendEventToAgentThread`，本次 UI 测试对话 | 400，`UserValidationError` / `generic_error` |
| 本地测试 | 31/31 通过，使用隔离模拟上游，不代表 Notion 生成成功 |

曾核对富文本输入、当前客户端版本、正常 Origin/Referer、记录 ID 分片格式，以及本人正常登录上下文；生成接口仍返回相同错误。错误没有给出可确认的具体原因。没有移植网络指纹模拟、挑战处理、重试换账号或付费/权限标志覆盖。

下一项所需证据是**同一账号正常网页成功生成的 Network 请求**与本地请求的区别，包括端点、正文和必要请求头名称。可在本地对照；不要把包含 Cookie 或授权信息的 HAR 上传 GitHub。当前截图与原始诊断文件只留本地，未加入 Git 仓库。

## 2026-10-13 Asia/Taipei：桌面抓取与 OpenCodex 路线

本次已打开正常登录的 Notion 桌面版，并从 AI 标签页的 Network 面板捕获真实 `createAgentThread` 200 请求，提取了完整正文和请求上下文用于本地对照。Cookie、通知凭证和原始抓取文件没有放入源码或公开说明。

浏览器迁移期间请求含两个同名 `token_v2`。按浏览器顺序优先的一项与先前导入凭证一致；“凭证不同”曾由取末项的诊断解析造成，已修正。不能把它归为本次故障根因。补齐正常登录/路由上下文后，Node 直连仍返回相同 400，具体服务端原因未确认。系统代理已只读检查，未修改系统设置。

已核验当前 OpenCodex 2.81.0 的真实安装包和 CLI：没有 Notion 内置适配器或通用浏览器 provider，可添加独立 `openai-chat` 上游。接入脚本已提供，默认只验证，真实挑战成功才注册，并保留原默认上游。

新增浏览器桥接把本次请求放在真实登录页内执行，不读取 Cookie 或浏览器登录存储；扩展权限已由本人启用。所有相关本地测试使用隔离模拟数据；最终可用性仍需扩展内真实生成及 OpenCodex 下游验证。

最终本地套件 **75/75 通过**，覆盖桥接 Origin/Bearer/nonce、租约、停止/关闭、输出限制、HTTP 整合及浏览器文本解析。Chrome 扩展 JS 语法和 PowerShell 启动脚本语法通过。已从真实用户进程验证隐藏启动的本机服务 `/health` 返回 200、`ready:false`，准确表示扩展尚未连接；没有把进程 PID 当作服务可用证据。OpenCodex 实际注册保持未执行。

以上为早期阶段记录，最新结果见后续章节。

## 0.2.1：扩展取队列 403 修复

已从真实扩展请求的脱敏服务诊断确认：`POST /bridge/connect` 有合法扩展 Origin，返回 200；随后的 `GET /bridge/next` 无 Origin，返回 403 / `bridge_origin_forbidden`。没有记录密钥、提示正文、worker ID 或原始 Notion 响应。

扩展改用 `POST /bridge/next`，worker ID 在有界 JSON 正文中传递。服务来源、Bearer、worker 绑定及 nonce 校验保持生效，不接受无来源的 GET 或 POST。保持原 GET 的兼容支持。补充 HTTP 回归、POST 长轮询的停止/冲突处理以及跨重连的旧请求拒绝测试；旧代码先出现两项预期失败，修复后 **78/78 本地测试通过**。临时诊断进程已停止，正式本地服务已更新。真实生成与 OpenCodex 下游调用仍以实际结果为准。

## 真实浏览器生成与 OpenCodex 注册

本人启用并重新加载 Chrome 扩展后，`npm run smoke` 完成两次真实 Notion 调用：JSON 请求 HTTP 200，精确回复 `NOTION2API_OK`；SSE 请求 HTTP 200，同样精确回复，接收 5 个正文 chunk 和正常 `[DONE]`。没有将本地模拟或 readiness 用作真实生成证据。

注册前的随机挑战也真实通过。核对已安装 OpenCodex 的校验器确认，`apiKeyTransport` 覆盖只支持 Anthropic 适配器；`openai-chat` 自带 Bearer，不设置该覆盖字段。批量 CAS 仍因其他旧上游解析到 Fake-IP 198.18/15 被拒；这些失败没有保存 Notion provider。改用已安装 OpenCodex 的正常管理鉴权与单 provider POST/PATCH，在完整公开快照和随机归属核验下创建禁用项、用 stdin 导入桥接 key、再启用。没有修改其他上游、DNS、代理或默认路由。

注册回读成功：provider 为 `notion2api`，模型为 `notion2api/notion-auto`，默认 provider 保持 `openai`。

最终通过现有 OpenCodex 的 `POST http://127.0.0.1:10100/v1/responses` 发起一条全新的随机挑战；请求只有 `model/input/stream` 三字段，使用服务既有 loopback 入站方式，不创建数据面 key、不修改鉴权设置。实测 HTTP **200**，`object: response`、`status: completed`，assistant 正文与随机挑战完全匹配。完整链路为：客户端 → OpenCodex → 本机 Notion2API → 本人正常登录的 Chrome Notion 标签页 → Notion AI。

这些结果证明当时的文本生成可用；剩余额度数字、图片/文件/工具调用、Notion 远端任务取消与长期运行仍未验证。
