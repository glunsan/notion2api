# 浏览器桥接与 OpenCodex

当前已安装的 OpenCodex 2.81.0 没有 Notion 内置适配器。可用的接入结构是：

```text
API 客户端 → OpenCodex → 本机 Notion2API → 已登录的 Chrome Notion 标签页 → Notion AI
```

浏览器模式代码已提供，**扩展尚未启用，真实生成尚未验证，OpenCodex provider 尚未注册**。本地测试证明的是任务转发、文本解析和失败处理。

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

扩展的正文请求在该真实 Notion 页面内发出，沿用浏览器的正常会话和网络环境。扩展不读取 Cookie、浏览器登录存储或密码；只传输本次客户端提示、所选工作区/user ID 和正文答案。只提取 assistant 文本，不转发思考、工具输出、页面内容或完整原始响应。保留正常登录、验证码、额度限制和授权提示，遇到拒绝就返回错误。

点击“停止连接”会使本机 worker 失效并终止本地等待。已经在 Notion 开始的生成是否同步停止，未验证。关闭标签页、浏览器休眠或退出会导致桥接不可用。

## 真实验证与注册

```powershell
npm run smoke
# 只有上一步真实 JSON 与 SSE 请求都成功后才注册：
pwsh.exe -NoProfile -File scripts/connect-opencodex.ps1 -Model notion-auto -Register
```

接入脚本还会重新要求一条随机挑战生成成功，才创建 `notion2api` provider。模型只声明文本能力。密钥通过 stdin 导入，不放命令行；注册保留现有默认 provider，遇到同名项或配置并发变化就停止。脚本不替换现有 OpenCodex 安装，也不重启它。

成功后可显式选择 `notion2api/notion-auto`。之后还必须验证通过 OpenCodex 的最终生成；模型列表出现不等于额度代理成功。Notion 自身的系统指令仍然生效，当前不支持工具调用、图片或文件。

## 撤销

先确认同名项确属本桥接，且不是默认 provider，再使用当前 CLI 正常删除：

```powershell
ocx provider remove notion2api --live --yes --json
```

停用/移除 Chrome 扩展和停止自己启动的桥接进程即可停止使用。源码、会话文件及本地密钥不会由接入脚本自动删除。
