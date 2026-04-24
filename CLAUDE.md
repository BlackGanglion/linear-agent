# Egg

LLM 驱动的工作自动化 Agent，采用主子 agent 架构。

## 命令

```bash
npm run dev        # tsx --watch bootstrap.ts
npm start          # tsx bootstrap.ts
npm run typecheck  # tsc --noEmit
npm test           # vitest run
```

## 架构

主子 agent 架构：主 agent（预留）通过 `AgentRegistry` 管理子 agent，子 agent 既可作为主 agent 的 tool 调用，也可被 webhook 直接触发。

### 目录结构

```
bootstrap.ts                  # 入口：拉起 Hono server，注册路由
src/
├── agent/                    # Agent 部分
│   ├── types.ts              # SubAgent 接口
│   ├── registry.ts           # AgentRegistry
│   ├── main/                 # 主 agent（预留）
│   ├── sub/                  # 子 agent
│   │   └── linear-triage/    # Linear issue 自动分诊
│   └── tool/                 # Agent 工具（fetch_trace、submit_triage_result）
├── infra/                    # 基础设施
│   └── linear/               # Linear SDK、OAuth、Webhook
├── utils/                    # 工具模块（config、logger）
└── routes/                   # Hono 路由（health、oauth、webhook）
prompts/
└── triage.md                 # 分诊系统 prompt
```

## 关键模式

- 子 agent 实现 `SubAgent` 接口（`invoke()` + `asTool()`）
- 工具使用 `AgentTool`（from `@mariozechner/pi-agent-core`），错误直接 `throw`，不要返回 `isError`
- `submit_triage_result` 是工厂函数（`createSubmitTriageTool`），捕获 `linearClient` 和 `context`，在 `execute` 中直接写入 Linear
- LLM 通过 OpenAI 兼容 API 调用（默认 Moonshot/Kimi）
- Webhook 通过 `AgentRegistry` 查找并直接调用子 agent

## 代码规范

- 仅添加必要 log，在分类 issue 的主链路上，不添加没有必要的 log
- TypeScript strict 模式，ES2022
- 中文用于面向用户的文案（Linear 评论、工具描述）
- 不要自动提交代码，每次需要提交时向用户确认
- 遇到较大变化时，自动写入 history.md 记录优化内容
- 项目架构变化时，同步更新 `cc-docs/design/` 下的设计文档

## 测试

- `test/triage.test.ts` — 集成测试，mock Linear API，真实调用 LLM
- 需要 `.env` 中配置 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`
- 测试涉及真实 LLM 调用，不要自动运行，需要时向用户申请

## 参考代码

- `cc-origin/` — 仅用于参考，不要修改或运行其中的代码和测试

## 参考文档

- `cc-docs/design/` — 项目架构设计文档（architecture、data-flow、graphql-api、tools-spec）
- `cc-docs/linear/` — Linear API 调用说明文档（auth、best-practices、communication、overview、session-api、session-lifecycle、signals、webhook-types）

## 环境变量

必需：`LINEAR_WEBHOOK_SECRET`、`LINEAR_CLIENT_ID`、`LINEAR_CLIENT_SECRET`、`LINEAR_REDIRECT_URI`

LLM：`LLM_PROVIDER`（`moonshot` | `claude`，默认 moonshot）、`MOONSHOT_API_KEY`、`CLAUDE_API_KEY`；可选覆盖 `<PROVIDER>_BASE_URL`、`<PROVIDER>_MODEL`

可选：`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`（fetch_trace 工具用）、`PORT`（默认 3000）、`TRIAGE_MIN_ISSUE_NUMBER`（严格小于该编号的 issue 跳过分诊，未设置或 0 不生效）
