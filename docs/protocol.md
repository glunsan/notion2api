# 接口依据与边界

本项目按当前 Notion 正常网页客户端的公开 JavaScript 与本账号最小测试响应编写，不使用 Notion integration API 代替 AI，也不保证这些客户端私有接口继续存在。

本次网页版本：`23.13.20261012.2141`。

## 新版 Agent Service

当前公开客户端资源：[18091-928879d9d2932876.js](https://app.notion.com/_assets/18091-928879d9d2932876.js)。它定义 `createAgentThread`、`sendEventToAgentThread`、`getThreadTranscript`、`listenToThreadTranscript`，以及富文本 content 和 transcript patch 处理。后续服务器部署可能移除旧资源。

创建请求包含本人 spaceId、全新的 threadId、`type: personal_agent`、富文本 content、clientMessageId 等。响应监听使用 `listenToThreadTranscript`，逐行 JSON 中含 `patches`。

已观察到的只读 transcript 包含 `put`、`remove`、`session`、`committed` 操作。公开客户端还实现 `patch` / `ops`，其中 provisional assistant 文本使用 `append /content/0/text`。本地解析器只返回 assistant 的 text，过滤 thinking、tool 与用户文本；未经支持的补丁明确报错。

记录 ID 算法依据当前公开 [7834-2adc96260f2e187a.js](https://app.notion.com/_assets/7834-2adc96260f2e187a.js) 的 IdCreator 思路：UUIDv8 编码工作区分片、日期和 thread 表码；它不替代认证与权限检查。实际资源 hash 以当前客户端 manifest 为准，本链接需在版本变化时重新核对。

## 旧接口参考

公开项目提供旧版 `runInferenceTranscript` 和 workflow transcript 的实现参考：

- [flow-ai 请求构造](https://github.com/pixelbrow720/flow-ai/blob/290a727c85193b0ee86e431e668173e9e3cdf638/src/openai-to-notion.js)
- [flow-ai 旧响应解析](https://github.com/pixelbrow720/flow-ai/blob/290a727c85193b0ee86e431e668173e9e3cdf638/src/notion-client.js)
- [Youahui/notion2api gateway](https://github.com/Youahui/notion2api/blob/189b0ecbe75eec9b5b9ad5df829be11ee17c8c92/backend/internal/service/notion_gateway.go)

本次实测账号已经走新版 Agent Service，所以主适配器不在新接口拒绝后降级到旧接口、切换账号或改变权限配置。

## 兼容边界

对外响应是 OpenAI Chat Completions 形状；这只保证实现范围内的 HTTP 协议，不保证 Notion 的模型选择、上游系统指令、工具能力或账户额度。正式可用性必须以真实 smoke 结果证明。
