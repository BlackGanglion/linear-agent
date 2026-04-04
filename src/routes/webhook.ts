import type { Hono } from "hono";
import { createWebhookHandler } from "../infra/linear/webhook";
import { getAccessToken, type OAuthConfig } from "../infra/linear/oauth";
import type { LinearApiClient } from "../infra/linear/client";
import type { AgentRegistry } from "../agent/registry";
import type { Logger } from "../utils/logger";

/** Track last seen issue number per team prefix to detect missed webhooks */
const lastSeenNumber = new Map<string, number>();

function parseIdentifier(identifier: string): { prefix: string; number: number } | null {
  const match = identifier.match(/^([A-Z]+)-(\d+)$/);
  if (!match) return null;
  return { prefix: match[1]!, number: parseInt(match[2]!, 10) };
}

export function registerWebhookRoutes(
  app: Hono,
  webhookSecret: string,
  oauthConfig: OAuthConfig,
  registry: AgentRegistry,
  linearClient: LinearApiClient,
  logger: Logger,
) {
  async function handleMissedIssues(prefix: string, from: number, to: number) {
    const triageAgent = registry.get("linear-triage");
    if (!triageAgent) return;

    for (let n = from; n < to; n++) {
      const identifier = `${prefix}-${n}`;
      logger.warn(`[webhook-gap] Missed webhook for ${identifier}, fetching via API`);
      try {
        const issueId = await linearClient.getIssueIdByIdentifier(identifier);
        if (issueId) {
          logger.warn(`[webhook-gap] Recovering ${identifier} (id=${issueId})`);
          void triageAgent.invoke({ issueId });
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

        // Gap detection
        const parsed = parseIdentifier(identifier);
        if (parsed) {
          const lastNum = lastSeenNumber.get(parsed.prefix);
          if (lastNum !== undefined && parsed.number > lastNum + 1) {
            logger.warn(
              `[webhook-gap] Detected gap: last=${parsed.prefix}-${lastNum}, current=${identifier}, missing ${parsed.number - lastNum - 1} issue(s)`,
            );
            void handleMissedIssues(parsed.prefix, lastNum + 1, parsed.number);
          }
          lastSeenNumber.set(parsed.prefix, parsed.number);
        }

        const triageAgent = registry.get("linear-triage");
        if (triageAgent) {
          void triageAgent.invoke({ issueId });
        }
      },
    },
    logger,
  );

  app.post("/webhooks/linear", async (c) => {
    const token = await getAccessToken(oauthConfig);
    if (!token) {
      logger.warn(
        "Webhook received but no OAuth token available. Please authorize first.",
      );
      return c.text("Not authorized. Visit /oauth/authorize first.", 503);
    }

    const response = await webhookHandler(c.req.raw);
    return response;
  });
}
