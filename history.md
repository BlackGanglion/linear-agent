# 优化记录

## 2026-04-03

- **引入 pi-agent-core** — 用 `@mariozechner/pi-agent-core` 的 `Agent` 类替代手写 tool-calling 循环，自动处理消息状态、工具执行、错误处理
- **submit_triage_result 直接写入 Linear** — `submitTriageTool` 改为工厂函数 `createSubmitTriageTool`，在工具 `execute` 中直接调用 `updateIssue` 和 `createComment`，不再需要外部 `applyResult` 流程
- **清理冗余类型和日志** — 删除 `TriageTool` 类型别名和 `types.ts`，工具直接使用 `AgentTool`；移除 5 条非必要日志（already triaged、calling tool、not eligible、updated、done），仅保留主链路结果和异常日志
- **集成测试** — 新增 `test/triage.test.ts`，mock Linear API + 真实 LLM 调用，覆盖 Contact Us、Sentry Error、非分类 issue、部分字段已设置四种场景
- **Langfuse Trace 查询工具** — 新增 `fetch_trace` tool，当 issue 描述中包含 `lab.gooo.ai` trace 链接时，LLM 可调用该工具获取 observations 数据，提取 tool 调用次数及异常信息，辅助更精准地判断问题类型和分配负责人
- **结构化结果提交** — 新增 `submit_triage_result` tool，LLM 通过 tool call 提交结构化的 triage 结果，替代 `response_format: json_object`，解决 tool calling 与 JSON 模式冲突问题
- **中文化工具描述** — 所有工具的 description 和参数说明统一使用中文，与 triage prompt 语言一致

## 2026-04-02

- **Webhook 缺口检测与自动补漏** — 通过内存跟踪每个团队前缀的 issue 编号序列，当检测到编号跳跃时自动通过 API 拉取遗漏的 issue 并补跑 triage，所有缺口事件以 `[webhook-gap]` 前缀记录日志
- **日志时区修正** — 日志时间戳和日志文件名统一使用 Asia/Shanghai 时区（UTC+8），避免服务器时区不一致导致的困惑
- **网络重试机制** — 为 `triageIssue` 增加指数退避重试（最多 3 次），应对 LLM 调用等环节的瞬时网络故障
- **多模态 Triage 支持** — 自动提取 issue 描述中的图片，下载后以 base64 编码发送给 LLM，使 triage 判断能参考截图等视觉信息

## 2026-04-01

- **Webhook 诊断日志** — 为 webhook 端点增加详细的请求诊断日志，辅助排查图片相关问题
- **LLM Triage 资格预判** — 新增 LLM 判断 issue 是否适合自动 triage 的能力，不适合的 issue 跳过处理；triage 完成后自动将 issue 从 triage 状态迁移到 backlog
- **文档更新** — 重写设计文档适配独立架构，README 补充管理员前置条件说明
- **LLM 输出格式优化** — 通过 `response_format: json_object` 强制 LLM 返回 JSON，简化 `parseResult` 解析逻辑
