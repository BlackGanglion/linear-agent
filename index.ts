import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
// import type { AgentSessionEventWebhookPayload } from "@linear/sdk";
import { createWebhookHandler } from "./src/webhook/handler";
// import { LinearApiClient } from "./src/api/linear";     // AgentSession 用
// import { SessionManager } from "./src/session/manager"; // AgentSession 用
import { IssueTriage } from "./src/issue/triage";
import { runLinearAgent } from "./src/agent/linear-agent"; // AgentSession 注释代码中也使用
import { validateConfig } from "./src/types";

export default definePluginEntry({
  id: "openclaw-linear-agent",
  name: "Linear Agent",
  description:
    "Linear Agent Session integration — receive @mentions, run agents, stream results back to Linear",
  register(api) {
    const rawConfig = validateConfig(api.pluginConfig);
    if (!rawConfig) {
      api.logger.error(
        "openclaw-linear-agent: missing required config (webhookSecret, linearApiKey, agentId). Plugin disabled.",
      );
      return;
    }
    const config = rawConfig;
    const logger = api.logger;

    // --- Issue 自动分诊 ---
    const triage = new IssueTriage(() => config.linearApiKey, logger, {
      excludeUserId: config.agentId,
    });

    logger.info(`openclaw-linear-agent: registered, agentId=${config.agentId}`);

    // Create webhook handler using Linear SDK
    const webhookHandler = createWebhookHandler(
      config.webhookSecret,
      config.agentId,
      {
        onIssueCreated: (payload) => {
          const issueId = payload.data.id;
          if (!issueId) {
            logger.warn("Issue created without id");
            return;
          }
          logger.info(
            `New issue: ${String(payload.data.identifier)} — ${String(payload.data.title)}`,
          );
          void handleIssueTriage(issueId);
        },
      },
      logger,
    );

    // Register webhook HTTP route
    api.registerHttpRoute({
      path: "/webhooks/linear",
      auth: "plugin",
      handler: (req, res) => {
        void webhookHandler(req, res);
      },
    });

    /** Issue 分诊：收集上下文 → OpenClaw agent 分析 → 应用结果 */
    async function handleIssueTriage(issueId: string): Promise<void> {
      try {
        const context = await triage.collectContext(issueId);
        if (!context) return;

        const prompt = triage.buildAgentPrompt(context);

        // 调用 Linear 专属 agent（独立记忆，不受其他渠道影响）
        const agentResult = await runLinearAgent({
          sessionKey: `triage-${issueId}`,
          prompt,
          systemPrompt:
            "你是一个 Linear issue 分诊助手。只输出 JSON 结果，不要输出其他内容。",
          workspaceDir: config.defaultDir,
          logger,
        });

        if (!agentResult.success) {
          logger.error(
            `Triage agent failed for ${context.identifier}: ${agentResult.output}`,
          );
          return;
        }

        const result = triage.parseTriageResult(agentResult.output);
        if (result) {
          await triage.applyTriageResult(issueId, result, context);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Issue triage failed: ${msg}`);
      }
    }

    // --- AgentSession 相关（暂时注释掉） ---
    // const linearApi = new LinearApiClient(config.linearApiKey);
    // const sessions = new SessionManager();
    //
    // const cleanupInterval = setInterval(() => sessions.cleanup(), 30 * 60 * 1000);
    // cleanupInterval.unref();
    //
    // function extractMessage(payload: AgentSessionEventWebhookPayload): string {
    //   const comments = payload.previousComments;
    //   if (Array.isArray(comments) && comments.length > 0) {
    //     const last = comments[comments.length - 1];
    //     if (last?.body) return last.body;
    //   }
    //   if (payload.promptContext) return payload.promptContext;
    //   if (payload.agentSession.comment?.body) return payload.agentSession.comment.body;
    //   return "";
    // }
    //
    // async function handleAgentSession(
    //   linearSessionId: string,
    //   issueId: string,
    //   message: string,
    // ): Promise<void> {
    //   const state = sessions.create(linearSessionId, issueId);
    //
    //   // 立即发送 thought 满足 Linear 10s 要求
    //   try {
    //     await linearApi.emitActivity(linearSessionId, {
    //       type: "thought",
    //       body: "Analyzing issue...",
    //     });
    //   } catch (err: unknown) {
    //     const msg = err instanceof Error ? err.message : String(err);
    //     logger.warn(`Failed to emit initial thought: ${msg}`);
    //   }
    //
    //   // 构建 prompt 并调用 Linear 专属 agent
    //   const prompt = [
    //     `Linear issue ${issue.identifier}: ${issue.title}`,
    //     issue.description ?? "",
    //     `User message: ${message}`,
    //   ].filter(Boolean).join("\n\n");
    //
    //   const result = await runLinearAgent({
    //     sessionKey: `session-${linearSessionId}`,
    //     prompt,
    //     workspaceDir: config.defaultDir,
    //     logger,
    //   });
    //
    //   // 发送结果到 Linear
    //   if (result.success) {
    //     await linearApi.emitActivity(linearSessionId, {
    //       type: "response",
    //       body: result.output,
    //     });
    //   } else {
    //     await linearApi.emitActivity(linearSessionId, {
    //       type: "error",
    //       body: result.output,
    //     }).catch(() => {});
    //   }
    //
    //   sessions.complete(linearSessionId);
    //   if (!result.success) {
    //     sessions.markError(linearSessionId);
    //   }
    // }
    //
    // function handleStop(linearSessionId: string): void {
    //   const state = sessions.get(linearSessionId);
    //   if (state) {
    //     logger.info(`Stopping session: ${linearSessionId}`);
    //     sessions.stop(linearSessionId);
    //     linearApi
    //       .emitActivity(linearSessionId, { type: "response", body: "Execution stopped by user." })
    //       .catch((err: unknown) => {
    //         const msg = err instanceof Error ? err.message : String(err);
    //         logger.warn(`Failed to send stop response: ${msg}`);
    //       });
    //   } else {
    //     logger.info(`Stop signal for unknown session: ${linearSessionId}`);
    //   }
    // }
  },
});
