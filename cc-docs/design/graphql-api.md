# Linear API 使用规格

## 1. 认证

使用 OAuth 2.0 获取 access token，通过 `@linear/sdk` 的 `LinearClient` 访问 API：

```typescript
import { LinearClient } from "@linear/sdk";

class LinearApiClient {
  private tokenProvider: () => Promise<string>;
  private cachedClient: LinearClient | null = null;
  private cachedToken: string | null = null;

  async getClient(): Promise<LinearClient> {
    const token = await this.tokenProvider();
    if (token !== this.cachedToken) {
      this.cachedClient = new LinearClient({ accessToken: token });
      this.cachedToken = token;
    }
    return this.cachedClient!;
  }
}
```

Token 自动刷新由 OAuth 模块处理，`tokenProvider` 每次返回最新有效 token。

## 2. SDK 调用

### 2.1 获取 Issue 详情

```typescript
const client = await linearClient.getClient();
const issue = await client.issue(issueId);
// issue.identifier, issue.title, issue.description, issue.priority
```

### 2.2 获取关联数据（按需）

```typescript
// 团队
const team = await issue.team;

// 负责人（检查是否已分配）
const assignee = await issue.assignee;

// 已有标签
const existingLabels = await issue.labels();
// existingLabels.nodes[].name

// 团队成员（仅当需要分配时）
const memberships = await team.memberships();
for (const m of memberships.nodes) {
  const user = await m.user;
  // user.id, user.name, user.displayName, user.active
}

// 团队可用标签（仅当需要加标签时）
const labels = await team.labels();
// labels.nodes[].id, labels.nodes[].name

// 工作流状态
const states = await team.states();
// states.nodes[].id, states.nodes[].name, states.nodes[].type
```

### 2.3 获取 Issue 评论（mention 场景）

```typescript
const comments = await issue.comments();
for (const comment of comments.nodes) {
  // comment.body, comment.createdAt
  const user = await comment.user;
  // user.name, user.id
}
```

### 2.4 更新 Issue

```typescript
await issue.update({
  assigneeId: "user-uuid",
  priority: 2,
  labelIds: ["label-uuid-1", "label-uuid-2"],
});
```

### 2.5 创建 Comment

```typescript
await client.createComment({
  issueId: "issue-uuid",
  body: "**Issue 自动分诊结果：**\n\n- **负责人** → John\n- **优先级** → 高\n\n> 判断理由...",
});
```

### 2.6 获取当前用户（Agent ID）

```typescript
const me = await client.viewer;
// me.id — 用于 mention 检测和成员列表排除
```

## 3. Webhook 签名验证

使用 `@linear/sdk/webhooks` 的 `LinearWebhookClient`，自动完成 HMAC-SHA256 验签：

```typescript
import { LinearWebhookClient } from "@linear/sdk/webhooks";

const webhookClient = new LinearWebhookClient(webhookSecret);
const handler = webhookClient.createHandler();

// Issue 事件
handler.on("Issue", (payload) => {
  if (payload.action === "create") {
    // payload.data.id, payload.data.identifier, payload.data.title
  }
});

// Comment 事件
handler.on("Comment", (payload) => {
  if (payload.action === "create") {
    // payload.data.body, payload.data.issueId, payload.data.userId
  }
});
```

## 4. OAuth 2.0 流程

### 4.1 授权

```
GET /oauth/authorize
→ 重定向到 https://linear.app/oauth/authorize?
    client_id=<CLIENT_ID>
    &redirect_uri=<REDIRECT_URI>
    &response_type=code
    &scope=read,write
    &state=<HMAC_STATE>
```

State 参数使用 `webhookSecret + timestamp` 的 SHA256 哈希，防止 CSRF。

### 4.2 Token 交换

```
GET /oauth/callback?code=<CODE>&state=<STATE>
→ POST https://api.linear.app/oauth/token
    grant_type=authorization_code
    &code=<CODE>
    &client_id=<CLIENT_ID>
    &client_secret=<CLIENT_SECRET>
    &redirect_uri=<REDIRECT_URI>
```

### 4.3 Token 刷新

```typescript
// 自动刷新：过期前 5 分钟触发
async function refreshToken(refreshToken: string): Promise<TokenSet> {
  // POST https://api.linear.app/oauth/token
  //   grant_type=refresh_token
  //   &refresh_token=<REFRESH_TOKEN>
  //   &client_id=<CLIENT_ID>
  //   &client_secret=<CLIENT_SECRET>
}
```

### 4.4 Token 存储

Token 持久化到 `.data/oauth-token.json`：

```json
{
  "accessToken": "lin_oauth_xxx",
  "refreshToken": "lin_refresh_xxx",
  "expiresAt": 1234567890000,
  "agentId": "user-uuid-of-bot",
  "createdAt": 1234567890000,
  "updatedAt": 1234567890000
}
```
