# 浏览器桥接与 OpenCodex

当前已安装的 OpenCodex 2.81.0 没有 Notion 内置适配器。可用的接入结构是：

```text
API 客户端 → OpenCodex → 本机 Notion2API → 已登录的 Chrome Notion 标签页 → Notion AI
```

浏览器模式的真实 JSON 和 SSE 生成已通过，OpenCodex 独立 `notion2api` provider 已注册，默认 provider 保持 `openai`。经 OpenCodex 的 Responses 真实随机挑战也已通过。

## 本机启动

已有 `.local/notion-session.json` 中的工作区/user ID 和 `.local/api-key.txt` 可继续使用。浏览器模式不把该文件中的 Cookie 发给上游。没有这些文件时，先按 README 正常导入本人会话并选择工作区。

```powershell
# 在项目目录中，前台运行；Ctrl+C 停止。
pwsh.exe -NoProfile -File scripts/start-browser-bridge.ps1 -Foreground
```

不带 `-Foreground` 会以隐藏窗口启动一次进程，PID 和日志保存在 `.local/`；不创建开机任务，不安装系统服务。保留 PID 不代表已经监听成功，应检查 `/health`。本版本的浏览器扩展只连接固定地址 `http://127.0.0.1:8787`。

## Chrome 扩展

在 Chrome 的扩展管理页启用开发者模式，加载本项目的 `extension` 目录。加载是用户控制的一次权限授权。扩展申请 `storage`、`scripting`、`alarms`，以及 `https://app.notion.com/*` 和 `http://127.0.0.1/*` 的访问权限；Chrome 的 host permission 不能按端口细分，实际代码固定只访问 8787。

打开正常登录的 `https://app.notion.com/ai`，点击扩展图标，填写本地 `.local/api-key.txt` 中的密钥，选择该 Notion 标签页并连接。密钥保存在该扩展的本机存储中，供连接本机服务使用。

更新本项目代码后，在 Chrome 扩展管理页点击本扩展卡片的“重新加载”，再连接。0.2.1 将取队列请求改为 `POST /bridge/next`，因为 Chrome 扩展的 GET 请求可能没有 Origin。服务仍拒绝缺少或非法 Origin 的请求，仍检查 Bearer、绑定 worker 与任务 nonce；旧的显式带 Origin 的 GET 保持兼容。

扩展的正文请求在该真实 Notion 页面内发出，沿用浏览器的正常会话和网络环境。扩展不读取 Cookie、浏览器登录存储或密码；只传输本次客户端提示、所选工作区/user ID 和正文答案。只提取 assistant 文本，不转发思考、工具输出、页面内容或完整原始响应。保留正常登录、验证码、额度限制和授权提示，遇到拒绝就返回错误。

点击“停止连接”会使本机 worker 失效并终止本地等待。已经在 Notion 开始的生成是否同步停止，未验证。关闭标签页、浏览器休眠或退出会导致桥接不可用。

## 真实验证与注册

```powershell
npm run smoke
# 只有上一步真实 JSON 与 SSE 请求都成功后才注册：
pwsh.exe -NoProfile -File scripts/connect-opencodex.ps1 -Model notion-auto -Register
```

接入脚本还会重新要求一条随机挑战生成成功，才创建 `notion2api` provider。模型只声明文本能力。密钥通过 stdin 导入，不放命令行；注册保留现有默认 provider，遇到同名项或观察到配置变化就停止。脚本不替换现有 OpenCodex 安装，也不重启它。

脚本使用已安装 OpenCodex 的正常管理鉴权和单 provider POST/PATCH，先创建禁用项、导入本地桥接 key、最后启用。每步前后核对完整公开快照和本次随机归属标记，只写新上游。批量 CAS 接口会重新校验所有旧上游的 DNS，在当前 Fake-IP 环境中会拒绝无关旧项；本脚本不为此修改旧上游、DNS 或代理设置。`openai-chat` 自带 Bearer 传输，不使用仅 Anthropic 适配器接受的 `apiKeyTransport` 覆盖字段。

单 provider 接口未提供原子 create-only 条件；需要确保没有其他操作同时注册同名项。脚本不自动重试或覆盖同名项，失败后需先读回当前状态。

成功后可显式选择 `notion2api/notion-auto`。每次新安装仍应验证通过 OpenCodex 的最终生成；模型列表出现不等于额度代理成功。本机已用 `POST http://127.0.0.1:10100/v1/responses` 的 `model/input/stream` 三字段请求验证成功；使用当前服务既有的 loopback 客户端入站模式，没有新增数据面 key 或修改鉴权设置。Notion 自身的系统指令仍然生效，当前不支持工具调用、图片或文件。

## 撤销

先确认同名项确属本桥接，且不是默认 provider，再使用当前 CLI 正常删除：

```powershell
ocx provider remove notion2api --live --yes --json
```

停用/移除 Chrome 扩展和停止自己启动的桥接进程即可停止使用。源码、会话文件及本地密钥不会由接入脚本自动删除。
