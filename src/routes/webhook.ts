import type { Hono } from "hono";
import { createWebhookHandler } from "../infra/linear/webhook";
import { getAccessToken, type OAuthConfig } from "../infra/linear/oauth";
import type { LinearApiClient } from "../infra/linear/client";
import type { AgentRegistry } from "../agent/registry";
import type { MainAgent } from "../agent/main";
import type { Logger } from "../utils/logger";

/** Track last seen issue number per team prefix to detect missed webhooks */
const lastSeenNumber = new Map<string, number>();

/** Webhook statistics for monitoring */
export const webhookStats = {
  count: 0,
  errors: 0,
  lastReceivedAt: null as string | null,
};

export function parseIdentifier(identifier: string): { prefix: string; number: number } | null {
  const match = identifier.match(/^([A-Z]+)-(\d+)$/);
  if (!match) return null;
  return { prefix: match[1]!, number: parseInt(match[2]!, 10) };
}

/**
 * Decide whether a newly created issue should be skipped (not triaged).
 * Pure function — safe to unit-test without the webhook stack.
 */
export function shouldSkipNewIssue(
  identifier: string,
  assigneeId: string | null | undefined,
  minIssueNumber: number,
): { skip: boolean; reason?: string } {
  const parsed = parseIdentifier(identifier);
  if (minIssueNumber > 0 && parsed && parsed.number < minIssueNumber) {
    return { skip: true, reason: `number below threshold ${minIssueNumber}` };
  }
  if (assigneeId) {
    return { skip: true, reason: "already assigned" };
  }
  return { skip: false };
}

export function registerWebhookRoutes(
  app: Hono,
  webhookSecret: string,
  oauthConfig: OAuthConfig,
  registry: AgentRegistry,
  linearClient: LinearApiClient,
  mainAgent: MainAgent,
  logger: Logger,
  triageMinIssueNumber: number,
) {
  async function handleMissedIssues(prefix: string, from: number, to: number) {
    const triageAgent = registry.get("linear-triage");
    if (!triageAgent) return;

    for (let n = from; n < to; n++) {
      if (triageMinIssueNumber > 0 && n < triageMinIssueNumber) continue;
      const identifier = `${prefix}-${n}`;
      logger.warn(`[webhook-gap] Missed webhook for ${identifier}, fetching via API`);
      try {
        const issueId = await linearClient.getIssueIdByIdentifier(identifier);
        if (issueId) {
          logger.warn(`[webhook-gap] Recovering ${identifier} (id=${issueId})`);
          void triageAgent.invoke({ issueId }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[webhook-gap] Triage failed for ${identifier}: ${msg}`);
          });
        } else {
          logger.warn(`[webhook-gap] ${identifier} not found (may be deleted or private)`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[webhook-gap] Failed to recover ${identifier}: ${msg}`);
      }
    }
  }

  const webhookHandler = createWebhookHandler(
    webhookSecret,
    {
      onIssueCreated: (payload) => {
        const issueId = payload.data.id;
        if (!issueId) {
          logger.warn("Issue created without id");
          return;
        }

        const identifier = String(payload.data.identifier);
        logger.info(`New issue: ${identifier} — ${String(payload.data.title)}`);

        const decision = shouldSkipNewIssue(
          identifier,
          payload.data.assigneeId,
          triageMinIssueNumber,
        );
        if (decision.skip) {
          logger.info(`Skip triage for ${identifier}: ${decision.reason}`);
          return;
        }

        // Gap detection
        const parsed = parseIdentifier(identifier);
        if (parsed) {
          const lastNum = lastSeenNumber.get(parsed.prefix);
          if (lastNum !== undefined && parsed.number > lastNum + 1) {
            logger.warn(
              `[webhook-gap] Detected gap: last=${parsed.prefix}-${lastNum}, current=${identifier}, missing ${parsed.number - lastNum - 1} issue(s)`,
            );
            void handleMissedIssues(parsed.prefix, lastNum + 1, parsed.number).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[webhook-gap] handleMissedIssues failed: ${msg}`);
          });
          }
          lastSeenNumber.set(parsed.prefix, parsed.number);
        }

        const triageAgent = registry.get("linear-triage");
        if (triageAgent) {
          void triageAgent.invoke({ issueId }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[webhook] Triage failed for ${identifier}: ${msg}`);
          });
        }
      },
      onAgentSessionEvent: (payload) => {
        void mainAgent.handleSessionEvent(payload).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[webhook] handleSessionEvent failed: ${msg}`);
        });
      },
    },
    logger,
  );

  app.post("/webhooks/linear", async (c) => {
    webhookStats.count++;
    webhookStats.lastReceivedAt = new Date().toISOString();

    const token = await getAccessToken(oauthConfig);
    if (!token) {
      webhookStats.errors++;
      logger.warn(
        "Webhook received but no OAuth token available. Please authorize first.",
      );
      return c.text("Not authorized. Visit /oauth/authorize first.", 503);
    }

    try {
      const response = await webhookHandler(c.req.raw);
      return response;
    } catch (err: unknown) {
      webhookStats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[webhook] Handler error: ${msg}`);
      return c.text("Webhook processing error", 500);
    }
  });
}
