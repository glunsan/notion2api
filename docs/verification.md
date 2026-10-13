# 验证记录

本次测试：2026-10-12 America/Los_Angeles；Notion 网页版本 `23.13.20261012.2141`。无账户邮箱、会话 token、工作区 ID 或原始响应随代码公开。

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

新增浏览器桥接把本次请求放在真实登录页内执行，不读取 Cookie 或浏览器登录存储；当前扩展权限尚未启用。所有相关本地测试使用隔离模拟数据；最终可用性仍需扩展内真实生成及 OpenCodex 下游验证。

最终本地套件 **75/75 通过**，覆盖桥接 Origin/Bearer/nonce、租约、停止/关闭、输出限制、HTTP 整合及浏览器文本解析。Chrome 扩展 JS 语法和 PowerShell 启动脚本语法通过。已从真实用户进程验证隐藏启动的本机服务 `/health` 返回 200、`ready:false`，准确表示扩展尚未连接；没有把进程 PID 当作服务可用证据。OpenCodex 实际注册保持未执行。
