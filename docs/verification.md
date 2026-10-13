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
