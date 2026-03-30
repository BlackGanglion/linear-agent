import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type {
  // AgentSessionEventWebhookPayload,
  EntityWebhookPayloadWithIssueData,
} from "@linear/sdk";
import type { PluginLogger } from "./logger-types";

export interface WebhookHandlerCallbacks {
  // AgentSession 回调（暂时注释掉，保留接口）
  // onSessionCreated: (payload: AgentSessionEventWebhookPayload) => void;
  // onSessionPrompted: (payload: AgentSessionEventWebhookPayload) => void;
  // onSessionStopped: (payload: AgentSessionEventWebhookPayload) => void;

  // Issue 回调
  onIssueCreated?: (payload: EntityWebhookPayloadWithIssueData) => void;
}

/**
 * Create a webhook handler using Linear SDK's LinearWebhookClient.
 * Handles signature verification, event parsing, and type-safe routing automatically.
 */
export function createWebhookHandler(
  webhookSecret: string,
  _agentId: string,
  callbacks: WebhookHandlerCallbacks,
  logger: PluginLogger,
) {
  const webhookClient = new LinearWebhookClient(webhookSecret);
  const handler = webhookClient.createHandler();

  // --- AgentSession 事件处理（暂时注释掉） ---
  // handler.on("AgentSessionEvent", (payload) => {
  //   logger.info(`AgentSessionEvent: action=${payload.action} session=${payload.agentSession.id}`);
  //   logger.info(`Payload:\n${JSON.stringify(payload, null, 2).slice(0, 2000)}`);
  //
  //   if (payload.appUserId && payload.appUserId !== agentId) {
  //     logger.info(`Skipping event for different agent: ${payload.appUserId}`);
  //     return;
  //   }
  //
  //   switch (payload.action) {
  //     case "created":
  //       callbacks.onSessionCreated(payload);
  //       break;
  //     case "prompted":
  //       callbacks.onSessionPrompted(payload);
  //       break;
  //     case "stopped":
  //       callbacks.onSessionStopped(payload);
  //       break;
  //     default:
  //       logger.info(`Unhandled AgentSessionEvent action: ${payload.action}`);
  //   }
  // });

  // --- Issue 事件处理 ---
  handler.on("Issue", (payload) => {
    logger.info(
      `Issue event: action=${payload.action} id=${payload.data.id} title=${payload.data.title}`,
    );

    if (payload.action === "create" && callbacks.onIssueCreated) {
      callbacks.onIssueCreated(payload);
    }
  });

  // Log other event types
  handler.on("*", (payload) => {
    if (payload.type !== "Issue") {
      logger.info(
        `Webhook: type=${payload.type} action=${String((payload as Record<string, unknown>)["action"] ?? "")}`,
      );
    }
  });

  return handler;
}
