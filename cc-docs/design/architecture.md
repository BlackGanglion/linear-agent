# Egg — 核心架构

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

## 2. 整体架构：主子 Agent

```
┌─────────────────────────────────────────────────────────────────┐
│                        Egg (Hono Server)                         │
│                                                                 │
│  ┌───────────────────────────────────────────────────────┐      │
│  │ HTTP Layer (routes/)                                   │      │
│  │ POST /webhooks/linear → 验签 → AgentRegistry → 子agent │      │
│  │ GET  /oauth/authorize → 发起 OAuth                     │      │
│  │ GET  /oauth/callback  → 换 token                       │      │
│  │ GET  /health, /status → 健康检查                       │      │
│  └─────────────────────┬─────────────────────────────────┘      │
│                        │                                        │
│  ┌─────────────────────▼─────────────────────────────────┐      │
│  │ Agent Layer (agent/)                                   │      │
│  │                                                        │      │
│  │  AgentRegistry                                         │      │
│  │  ├── SubAgent: "linear-triage"                         │      │
│  │  │   invoke({ issueId }) → IssueTriage.triageIssue()   │      │
│  │  │   asTool() → AgentTool for main agent               │      │
│  │  └── (future sub-agents...)                            │      │
│  │                                                        │      │
│  │  Main Agent (预留)                                      │      │
│  │  └── tools = registry.asTools()                        │      │
│  │                                                        │      │
│  │  Tools (tool/)                                         │      │
│  │  ├── fetch_trace — Langfuse trace 查询                  │      │
│  │  └── submit_triage_result — 写回 Linear                 │      │
│  └───────────┬───────────────────────────────────────────┘      │
│              │                                                  │
│  ┌───────────▼───────────────────────────────────────────┐      │
│  │ Infra Layer (infra/linear/)                            │      │
│  │ LinearApiClient — 封装 token 自动刷新                   │      │
│  │ OAuth — OAuth 2.0 授权 + token 管理                    │      │
│  │ Webhook — LinearWebhookClient 验签 + 事件分发           │      │
│  └───────────────────────────────────────────────────────┘      │
│                                                                 │
│  ┌───────────────────────────────────────────────────────┐      │
│  │ Utils (utils/)                                         │      │
│  │ config.ts — 环境变量加载                                │      │
│  │ logger.ts — 文件 + 控制台日志                           │      │
│  └───────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 技术选型

### 3.1 HTTP Server：Hono

独立 Hono 服务，通过 `@hono/node-server` 运行。

```typescript
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const app = new Hono();
app.post("/webhooks/linear", async (c) => { /* ... */ });
serve({ fetch: app.fetch, port: config.port });
```

### 3.2 Linear API：@linear/sdk

使用 Linear 官方 TypeScript SDK，通过 OAuth token 认证：

```typescript
import { LinearClient } from "@linear/sdk";

class LinearApiClient {
  private tokenProvider: () => Promise<string>;
  async getClient(): Promise<LinearClient> { /* ... */ }
}
```

### 3.3 Webhook 验签：@linear/sdk/webhooks

```typescript
import { LinearWebhookClient } from "@linear/sdk/webhooks";

const webhookClient = new LinearWebhookClient(webhookSecret);
const handler = webhookClient.createHandler();
handler.on("Issue", (payload) => { /* ... */ });
```

### 3.4 Agent 框架：@mariozechner/pi-agent-core

使用 pi-agent-core 的 Agent 类驱动 tool-calling 循环：

```typescript
import { Agent } from "@mariozechner/pi-agent-core";

const agent = new Agent({
  initialState: { systemPrompt, model, tools: [fetchTraceTool, submitTool] },
  getApiKey: async () => apiKey,
  toolExecution: "sequential",
});
await agent.prompt(userPrompt, images);
```

### 3.5 OAuth 2.0 认证

完整的 OAuth 2.0 流程，token 自动刷新：

- 授权地址：`/oauth/authorize` → 重定向到 Linear
- 回调地址：`/oauth/callback` → 换 token + 存储
- Token 存储：`.data/oauth-token.json`
- 自动刷新：过期前 5 分钟自动 refresh
- Agent ID：首次 OAuth 回调时通过 `viewer { id }` 查询并缓存

---

## 4. 核心链路

### 4.1 Webhook → 子 Agent

```
Linear Issue.create → Webhook → SDK 验签 → routes/webhook.ts
    → AgentRegistry.get("linear-triage").invoke({ issueId })
        → IssueTriage.triageIssue()
            → collectContext() → buildPrompt()
            → Agent (pi-agent-core) tool-calling 循环
                → fetch_trace / submit_triage_result
            → 更新 issue + 发评论
```

### 4.2 SubAgent 接口

```typescript
interface SubAgent {
  name: string;
  description: string;
  invoke(input: Record<string, unknown>): Promise<SubAgentResult>;
  asTool(): AgentTool;  // 转换为主 agent 的工具
}
```

- `invoke()`: 直接调用入口（webhook、定时任务等）
- `asTool()`: 包装为 AgentTool，供主 agent 在 tool-calling 循环中使用

---

## 5. 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| **服务入口** | `bootstrap.ts` | Hono 路由注册，创建 AgentRegistry，串联各模块 |
| **SubAgent 接口** | `src/agent/types.ts` | SubAgent、SubAgentResult 类型定义 |
| **Agent 注册表** | `src/agent/registry.ts` | 注册/查找子 agent，转换为 tools |
| **Linear Triage** | `src/agent/sub/linear-triage/` | 子 agent：Issue 自动分诊 |
| **Agent 工具** | `src/agent/tool/` | fetch_trace、submit_triage_result |
| **Linear 客户端** | `src/infra/linear/client.ts` | LinearClient 封装，token provider 模式 |
| **OAuth** | `src/infra/linear/oauth.ts` | OAuth 2.0 完整流程 + token 自动刷新 |
| **Webhook** | `src/infra/linear/webhook.ts` | LinearWebhookClient 验签 + 事件路由 |
| **路由** | `src/routes/` | health、oauth、webhook 路由 |
| **配置** | `src/utils/config.ts` | 环境变量加载与校验 |
| **日志** | `src/utils/logger.ts` | 文件 + 控制台日志（按日分文件） |
| **Triage Prompt** | `prompts/triage.md` | 分诊系统提示词 |

---

## 6. 配置

所有配置通过环境变量（`.env` 文件）：

| 变量 | 必填 | 说明 |
|------|------|------|
| `LINEAR_WEBHOOK_SECRET` | 是 | Linear Webhook 签名密钥 |
| `LINEAR_CLIENT_ID` | 是 | Linear OAuth 应用 Client ID |
| `LINEAR_CLIENT_SECRET` | 是 | Linear OAuth 应用 Client Secret |
| `LINEAR_REDIRECT_URI` | 是 | OAuth 回调地址 |
| `LLM_PROVIDER` | 否 | LLM 提供商（`moonshot` \| `claude`，默认 moonshot） |
| `LLM_API_KEY` | 是 | LLM API Key |
| `LLM_BASE_URL` | 否 | LLM API 地址 |
| `LLM_MODEL` | 否 | LLM 模型名称 |
| `PORT` | 否 | 服务端口（默认 3000） |
| `TOKEN_STORE_PATH` | 否 | OAuth Token 存储路径（默认 `.data/oauth-token.json`） |

---

## 7. 目录结构

```
├── bootstrap.ts              # 服务入口
├── package.json
├── tsconfig.json
├── prompts/
│   └── triage.md             # 分诊系统提示词
├── src/
│   ├── agent/
│   │   ├── types.ts          # SubAgent 接口
│   │   ├── registry.ts       # Agent 注册表
│   │   ├── main/             # 主 agent（预留）
│   │   ├── sub/
│   │   │   └── linear-triage/
│   │   │       ├── index.ts  # SubAgent 实现
│   │   │       └── triage.ts # 分诊逻辑
│   │   └── tool/
│   │       ├── fetch-trace.ts
│   │       └── submit-triage.ts
│   ├── infra/
│   │   └── linear/
│   │       ├── client.ts     # Linear SDK 客户端
│   │       ├── oauth.ts      # OAuth 2.0
│   │       └── webhook.ts    # Webhook 验签
│   ├── utils/
│   │   ├── config.ts         # 环境变量
│   │   └── logger.ts         # 日志
│   └── routes/
│       ├── health.ts
│       ├── oauth.ts
│       └── webhook.ts
├── cc-docs/
│   ├── design/               # 设计文档
│   └── linear/               # Linear API 参考文档
└── log/                      # 运行日志（按日分文件）
```
