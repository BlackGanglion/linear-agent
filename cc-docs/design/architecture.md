# Linear Agent — 核心架构

## 1. 部署模型

```
┌─────────────┐   HTTPS Webhook   ┌─────────┐   localhost   ┌──────────────────┐
│   Linear    │ ────────────────→ │  Funnel  │ ───────────→ │  Local Mac       │
│   (Cloud)   │                   │  (隧道)   │              │                  │
│             │   @linear/sdk     │          │              │  Hono Server     │
│             │ ←──────────────── │          │              │  (standalone)    │
└─────────────┘                   └─────────┘              └──────────────────┘
```

**关键约束：**
- **单实例** — 本地 Mac 运行，无需考虑水平扩展
- **内存优先** — 进程重启才丢失状态（OAuth token 持久化到文件）
- **Funnel 公网 URL** — 需要配置为 Linear webhook 回调地址

---

## 2. 技术选型

### 2.1 HTTP Server：Hono

独立 Hono 服务，通过 `@hono/node-server` 运行。

```typescript
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const app = new Hono();
app.post("/webhooks/linear", async (c) => { /* ... */ });
serve({ fetch: app.fetch, port: config.port });
```

### 2.2 Linear API：@linear/sdk

使用 Linear 官方 TypeScript SDK，通过 OAuth token 认证：

```typescript
import { LinearClient } from "@linear/sdk";

class LinearApiClient {
  private tokenProvider: () => Promise<string>;
  // 每次调用自动获取最新 token，缓存 client 实例
  async getClient(): Promise<LinearClient> { /* ... */ }
}
```

### 2.3 Webhook 验签：@linear/sdk/webhooks

```typescript
import { LinearWebhookClient } from "@linear/sdk/webhooks";

const webhookClient = new LinearWebhookClient(webhookSecret);
const handler = webhookClient.createHandler();
handler.on("Issue", (payload) => { /* ... */ });
handler.on("Comment", (payload) => { /* ... */ });
```

### 2.4 LLM 调用：@mariozechner/pi-ai

统一的 OpenAI 兼容 API 调用库，支持 tool calling：

```typescript
import { complete, type Message } from "@mariozechner/pi-ai";

// Triage：单次调用，返回 JSON
const result = await complete(messages, {
  model: { provider: "openai-compatible", model: config.llmModel },
  responseFormat: { type: "json_object" },
});

// Mention：多轮 tool calling 循环
const result = await complete(messages, {
  model: { ... },
  tools: [claudeCodeTool],
});
```

### 2.5 OAuth 2.0 认证

完整的 OAuth 2.0 流程，token 自动刷新：

- 授权地址：`/oauth/authorize` → 重定向到 Linear
- 回调地址：`/oauth/callback` → 换 token + 存储
- Token 存储：`.data/oauth-token.json`
- 自动刷新：过期前 5 分钟自动 refresh
- Agent ID：首次 OAuth 回调时通过 `viewer { id }` 查询并缓存

---

## 3. 核心链路

### 3.1 Issue 自动分诊

```
Linear Issue.create → Webhook → SDK 验签 → Issue 路由 → 收集上下文 → 构建 prompt
                                                        → LLM 调用 (JSON mode)
                                                        → 解析结果
                                                        → 更新 issue + 发评论
```

### 3.2 @mention 代码分析

```
用户在 issue 评论中 @mention Agent
            │
Linear Comment.create → Webhook → SDK 验签 → Comment 路由
            │
            ├─ 检测是否 mention 了 bot（按 agentId 或 @*agent 模式匹配）
            │
            └─ MentionHandler.handleMention()
               → 收集 issue + 全部评论
               → LLM 多轮 tool calling（最多 5 轮）
                 └─ claude_code 工具：调用本地 Claude CLI 分析代码
               → 提取最终文本回复
               → 发 Linear 评论
```

### 3.3 整体架构

```
┌────────────────────────────────────────────────────────────────┐
│                   Linear Agent (Hono Server)                    │
│                                                                │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ HTTP Layer (Hono)                                     │      │
│  │ POST /webhooks/linear → 验签 → 事件路由 → 返回 200    │      │
│  │ GET  /oauth/authorize → 发起 OAuth                    │      │
│  │ GET  /oauth/callback  → 换 token                      │      │
│  │ GET  /health, /status → 健康检查                      │      │
│  └─────────────────────┬────────────────────────────────┘      │
│                        │                                       │
│  ┌─────────────────────▼────────────────────────────────┐      │
│  │ Event Router (webhook/handler.ts)                     │      │
│  │ Issue.create   → onIssueCreated callback              │      │
│  │ Comment.create → onCommentCreated callback            │      │
│  └───────┬─────────────────────────────┬────────────────┘      │
│          │                             │                       │
│  ┌───────▼──────────────┐     ┌───────▼──────────────┐        │
│  │ Issue Triage          │     │ Mention Handler       │        │
│  │ (triage/triage.ts)    │     │ (mention/handler.ts)  │        │
│  │                       │     │                       │        │
│  │ 1. collectContext()   │     │ 1. 检测 mention       │        │
│  │ 2. 检查是否需要分诊    │     │ 2. 收集 issue+评论    │        │
│  │ 3. buildPrompt()     │     │ 3. LLM tool calling   │        │
│  │ 4. LLM 调用 (JSON)   │     │    (claude_code 工具) │        │
│  │ 5. 解析 + 更新 issue  │     │ 4. 发评论回复         │        │
│  └───────┬──────────────┘     └───────┬──────────────┘        │
│          │                             │                       │
│  ┌───────▼─────────────────────────────▼────────────────┐      │
│  │ Linear API (通过 @linear/sdk)                         │      │
│  │ LinearApiClient — 封装 token 自动刷新                  │      │
│  │ - client.issue(id) — 获取 issue 详情                  │      │
│  │ - team.memberships() — 获取团队成员                   │      │
│  │ - team.labels() — 获取可用标签                        │      │
│  │ - team.states() — 获取工作流状态                      │      │
│  │ - issue.update({...}) — 更新 assignee/priority/labels │      │
│  │ - client.createComment({...}) — 发评论               │      │
│  └───────────────────────────────────────────────────────┘      │
│                                                                │
│  ┌───────────────────────────────────────────────────────┐      │
│  │ OAuth (api/oauth.ts)                                   │      │
│  │ - OAuth 2.0 授权流程 + CSRF state 验证                 │      │
│  │ - Token 自动刷新（过期前 5min）                        │      │
│  │ - Token 持久化到 .data/oauth-token.json               │      │
│  │ - Agent ID 自动获取（viewer query）                    │      │
│  └───────────────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────────┘
```

---

## 4. 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| **服务入口** | `index.ts` | Hono 路由注册，串联 OAuth + Webhook + Triage + Mention |
| **配置** | `src/config.ts` | 环境变量加载与校验 |
| **日志** | `src/logger.ts` | 文件 + 控制台日志（按日分文件） |
| **OAuth** | `src/api/oauth.ts` | OAuth 2.0 完整流程 + token 自动刷新 + Agent ID 获取 |
| **Linear 客户端** | `src/linear/client.ts` | LinearClient 封装，token provider 模式 |
| **Webhook Handler** | `src/webhook/handler.ts` | LinearWebhookClient 验签 + 事件路由 |
| **Logger 类型** | `src/webhook/logger-types.ts` | PluginLogger 接口定义 |
| **Issue Triage** | `src/triage/triage.ts` | 上下文收集 → prompt 构建 → LLM 调用 → 结果解析 → 应用 |
| **Mention Handler** | `src/mention/handler.ts` | @mention 检测 → LLM tool calling → 发评论 |
| **Triage Prompt** | `prompts/triage.md` | 分诊系统提示词 |
| **Mention Prompt** | `prompts/mention.md` | Mention 系统提示词 |

---

## 5. 配置

所有配置通过环境变量（`.env` 文件）：

| 变量 | 必填 | 说明 |
|------|------|------|
| `LINEAR_WEBHOOK_SECRET` | 是 | Linear Webhook 签名密钥 |
| `LINEAR_CLIENT_ID` | 是 | Linear OAuth 应用 Client ID |
| `LINEAR_CLIENT_SECRET` | 是 | Linear OAuth 应用 Client Secret |
| `LINEAR_REDIRECT_URI` | 是 | OAuth 回调地址 |
| `LLM_API_KEY` | 是 | LLM API Key |
| `PORT` | 否 | 服务端口（默认 3000） |
| `LLM_BASE_URL` | 否 | LLM API 地址（默认 `https://api.moonshot.cn/v1`） |
| `LLM_MODEL` | 否 | LLM 模型名称（默认 `kimi-k2.5`） |
| `TOKEN_STORE_PATH` | 否 | OAuth Token 存储路径（默认 `.data/oauth-token.json`） |
| `CLAUDE_CODE_DIR` | 否 | Claude Code 工作目录（mention 代码分析用） |

---

## 6. 目录结构

```
├── index.ts                  # Hono 服务入口
├── package.json
├── tsconfig.json
├── .env.example              # 环境变量模板
├── prompts/
│   ├── triage.md             # 分诊系统提示词
│   └── mention.md            # Mention 系统提示词
├── src/
│   ├── config.ts             # 环境变量加载与校验
│   ├── logger.ts             # 文件 + 控制台日志
│   ├── api/
│   │   └── oauth.ts          # OAuth 2.0 授权流程 + token 管理
│   ├── linear/
│   │   └── client.ts         # Linear SDK 客户端封装
│   ├── webhook/
│   │   ├── handler.ts        # Webhook 验签 + 事件路由
│   │   └── logger-types.ts   # Logger 接口
│   ├── triage/
│   │   └── triage.ts         # Issue 自动分诊
│   └── mention/
│       └── handler.ts        # @mention 代码分析
├── cc-docs/
│   ├── design/               # 设计文档
│   └── linear/               # Linear API 参考文档
└── log/                      # 运行日志（按日分文件）
```
