# LLM 工具规格定义

## 1. Issue 自动分诊（无工具模式）

Triage 不使用 tool calling，通过 prompt 指令 + JSON mode 完成：

1. **输入：** IssueTriage.buildPrompt() 构建的 prompt，包含 issue 信息和可选项
2. **系统提示词：** `prompts/triage.md` — 分诊规则、输出格式、团队上下文
3. **响应格式：** `response_format: { type: "json_object" }` — 强制 JSON 输出
4. **输出：** JSON 格式的 TriageResult

```typescript
// LLM 输出格式
{
  "assigneeId": "成员ID 或 null",
  "priority": 0-4,           // 0=无, 1=紧急, 2=高, 3=中, 4=低
  "labelIds": ["标签ID", ...],
  "reason": "判断理由"
}
```

---

## 2. @mention 代码分析（Tool Calling 模式）

Mention Handler 使用 LLM tool calling 循环，最多 5 轮。

### 2.1 claude_code 工具

Agent 可调用本地 Claude CLI 分析代码仓库。

```typescript
{
  name: "claude_code",
  description: "Run Claude Code CLI to analyze the codebase and answer questions",
  parameters: {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: {
        type: "string",
        description: "The analysis prompt to send to Claude Code",
      },
    },
  },
}
```

**执行方式：**

```typescript
import { execFile } from "node:child_process";

execFile("claude", [
  "-p", toolArgs.prompt,
  "--output-format", "text",
  "--max-turns", "10",
], {
  cwd: config.projectDir,   // CLAUDE_CODE_DIR 环境变量
  timeout: 120_000,          // 2 分钟超时
  maxBuffer: 1024 * 1024,   // 1MB 输出上限
});
```

**约束：**
- 工作目录由 `CLAUDE_CODE_DIR` 环境变量指定
- 每次调用最多运行 2 分钟
- 输出超过 1MB 会被截断
- LLM 最多调用 5 轮工具后强制返回最终回复

### 2.2 Tool Calling 循环

```
LLM 收到系统提示词 + issue 上下文 + 评论线程
            │
            ▼
        ┌──────────┐
        │ LLM 回复  │
        └────┬─────┘
             │
      ┌──────▼──────┐
      │ 有 tool call? │
      │              │
      ├─ 是 ─→ 执行 claude_code ─→ 结果作为 tool_result 追加 ─→ 回到 LLM
      │
      └─ 否 ─→ 提取文本作为最终回复 ─→ 发 Linear 评论
```

### 2.3 系统提示词

使用 `prompts/mention.md`，指导 LLM：
- 理解 issue 上下文和评论线程
- 根据需要调用 `claude_code` 工具分析代码
- 给出有建设性的技术回复
