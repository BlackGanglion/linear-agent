# 数据流设计

## 1. 核心场景数据流

### 1.1 场景 A：Issue 自动分诊

```
用户在 Linear 中创建新 Issue
            │
            ▼
Linear 发送 webhook: Issue.create
            │
    ┌───────▼───────┐
    │ Webhook Handler│
    │ LinearWebhookClient
    │ 1. SDK 自动 HMAC 验签
    │ 2. 解析事件类型
    │ 3. 返回 200
    └───────┬───────┘
            │
    ┌───────▼───────┐
    │ Event Router  │
    │ type=Issue, action=create
    │ → onIssueCreated callback
    └───────┬───────┘
            │ async (void)
    ┌───────▼──────────────┐
    │ IssueTriage           │
    │ .collectContext()     │
    │ 1. client.issue(id)  │ ← @linear/sdk
    │ 2. issue.assignee    │   检查已有字段
    │ 3. issue.labels()    │
    │ 4. 全部已有 → 跳过   │
    │ 5. team.memberships()│   仅当需要分配
    │ 6. team.labels()     │   仅当需要标签
    │ 7. team.states()     │
    └───────┬──────────────┘
            │
    ┌───────▼──────────────┐
    │ .buildPrompt()       │
    │ TRIAGE_PROMPT        │
    │ + issue 信息          │
    │ + 已有字段（标记无需判断）│
    │ + 需要判断的字段 + 选项│
    └───────┬──────────────┘
            │
    ┌───────▼──────────────┐
    │ LLM 调用              │
    │ @mariozechner/pi-ai  │
    │ complete() 单次调用   │
    │ response_format:     │
    │   json_object        │
    │ → 返回 JSON 文本      │
    └───────┬──────────────┘
            │
    ┌───────▼──────────────┐
    │ .parseResult()       │
    │ JSON.parse 提取:     │
    │ { assigneeId,        │
    │   priority,          │
    │   labelIds,          │
    │   reason }           │
    └───────┬──────────────┘
            │
    ┌───────▼──────────────┐
    │ .applyResult()       │
    │ 1. issue.update({    │
    │      assigneeId,     │
    │      priority,       │ → Linear API
    │      labelIds        │
    │    })                │
    │ 2. client.createComment({
    │      issueId,        │ → 分诊理由评论
    │      body: 理由      │
    │    })                │
    └──────────────────────┘
```

**关键设计：**
- 只更新缺失字段 — 已有 assignee/priority/labels 的不覆盖
- 全部已有时直接跳过 — 不浪费 LLM 调用
- agent 自身 ID (agentId) 从成员列表中排除 — 避免分配给自己
- 使用 `response_format: json_object` 确保 LLM 输出合法 JSON

### 1.2 场景 B：@mention 代码分析

```
用户在 Linear issue 评论中 @mention Agent
            │
            ▼
Linear 发送 webhook: Comment.create
            │
    ┌───────▼───────┐
    │ Webhook Handler│ 验签 + 200
    └───────┬───────┘
            │
    ┌───────▼───────────────┐
    │ Mention 检测           │
    │ 1. 按 agentId 匹配    │ ← OAuth 回调时获取的 bot user ID
    │ 2. 按 @*agent 模式匹配 │ ← 正则 fallback
    │ 3. 未 mention → 跳过   │
    └───────┬───────────────┘
            │
    ┌───────▼───────────────┐
    │ MentionHandler         │
    │ .handleMention()       │
    │ 1. 获取 issue 详情     │
    │ 2. 获取所有评论         │
    │ 3. 构建 markdown 上下文│
    │    (issue + 评论线程)   │
    └───────┬───────────────┘
            │
    ┌───────▼───────────────┐
    │ LLM Tool Calling 循环  │
    │ 最多 5 轮              │
    │                        │
    │ tools: [claude_code]   │
    │ claude_code 工具:      │
    │   execFile("claude",   │
    │     ["-p", prompt,     │
    │      "--output-format",│
    │      "text",           │
    │      "--max-turns", 10]│
    │   )                    │
    │ 运行在 CLAUDE_CODE_DIR │
    │ 超时: 2 分钟           │
    │ 输出上限: 1MB          │
    │                        │
    │ 循环直到:              │
    │ - LLM 返回纯文本(无工具)│
    │ - 达到 5 轮上限         │
    └───────┬───────────────┘
            │
    ┌───────▼───────────────┐
    │ 发 Linear 评论          │
    │ 前缀: 🤖 **Code Agent** │
    │ body: LLM 最终回复      │
    └───────────────────────┘
```

---

## 2. 时序约束

### Issue Triage

```
t=0ms       收到 webhook (Issue.create)
t<100ms     SDK 验签完成，返回 HTTP 200
t~100ms     开始异步 collectContext()
t~500-2s    Linear SDK 查询完成 (issue + team + members + labels + states)
t~2-3s      buildPrompt() + 启动 LLM 调用
t~5-30s     LLM 执行（JSON mode，通常较快）
t~end       applyResult(): issue.update() + createComment()
```

### @mention 代码分析

```
t=0ms       收到 webhook (Comment.create)
t<100ms     SDK 验签完成，返回 HTTP 200
t~100ms     mention 检测 + 开始异步处理
t~500-2s    Linear SDK 查询 issue + 评论
t~2-3s      构建上下文 + 启动 LLM tool calling
t~5s-10min  LLM 多轮执行（可能调用 claude_code 多次）
t=end       发评论回复
```

---

## 3. 错误处理

| 场景 | 处理 | 对用户可见 |
|------|------|-----------|
| SDK 验签失败 | LinearWebhookClient 返回错误，HTTP 非 200 | 否 |
| OAuth token 过期 | 自动 refresh，失败则记录错误 | 否（仅日志） |
| Issue 无 team | collectContext 返回 null，跳过 | 否 |
| Issue 已完整分诊 | collectContext 返回 null，跳过 | 否 |
| LLM 调用失败 | 记录 error 日志，不更新 issue | 否（仅日志） |
| JSON 解析失败 | 记录 warn 日志，跳过 | 否（仅日志） |
| Linear API 调用失败 | 异常冒泡，由上层 catch | 否（仅日志） |
| claude_code 工具超时 | 2 分钟超时，进程被 kill | 否 |
| Mention 评论非 bot | 跳过处理 | 否 |

---

## 4. 数据类型定义

### 4.1 Webhook 事件（由 @linear/sdk 类型约束）

```typescript
// Issue 事件
handler.on("Issue", (payload) => {
  // payload.action: "create" | "update" | "remove"
  // payload.data.id, payload.data.identifier, payload.data.title
});

// Comment 事件
handler.on("Comment", (payload) => {
  // payload.action: "create" | "update" | "remove"
  // payload.data.body, payload.data.issueId, payload.data.userId
});
```

### 4.2 分诊相关类型（src/triage/triage.ts）

```typescript
/** Issue 上下文 — 传给 LLM 分析 */
interface IssueContext {
  identifier: string;
  title: string;
  description: string;
  teamName: string;
  teamMembers: TeamMember[];
  availableLabels: AvailableLabel[];
  workflowStates: WorkflowState[];
  existing: {
    hasAssignee: boolean;
    assigneeName?: string;
    hasPriority: boolean;
    priority?: number;
    hasLabels: boolean;
    labelNames?: string[];
  };
}

/** Triage 结果 — LLM 返回的 JSON */
interface TriageResult {
  assigneeId?: string;
  priority?: number;     // 0=无, 1=紧急, 2=高, 3=中, 4=低
  labelIds?: string[];
  reason: string;
}
```

### 4.3 OAuth 相关类型（src/api/oauth.ts）

```typescript
interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  webhookSecret: string;     // 用于 CSRF state 生成
  tokenStorePath: string;
}

interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  agentId?: string;          // bot 的 Linear user ID
  createdAt: number;
  updatedAt: number;
}
```

### 4.4 LLM 配置

```typescript
interface LLMConfig {
  baseUrl: string;    // OpenAI 兼容 API 地址
  model: string;      // 模型名称
  apiKey: string;
}
```

### 4.5 Mention 相关类型（src/mention/handler.ts）

```typescript
interface MentionConfig {
  llmConfig: LLMConfig;
  projectDir?: string;   // Claude Code 工作目录
}

// claude_code 工具定义
const claudeCodeTool = {
  name: "claude_code",
  description: "Run Claude Code CLI to analyze codebase",
  parameters: {
    prompt: { type: "string", description: "Analysis prompt" },
  },
};
```

### 4.6 应用配置（src/config.ts）

```typescript
interface AppConfig {
  port: number;
  linearWebhookSecret: string;
  linearClientId: string;
  linearClientSecret: string;
  linearRedirectUri: string;
  tokenStorePath: string;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  claudeCodeDir?: string;
}
```
