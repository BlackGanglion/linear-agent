import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig } from "./src/config";
import { createLogger } from "./src/logger";
import {
  getAuthorizationUrl,
  handleOAuthCallback,
  getAccessToken,
  type OAuthConfig,
} from "./src/api/oauth";
import { createWebhookHandler } from "./src/webhook/handler";
import { LinearApiClient } from "./src/linear/client";
import { IssueTriage } from "./src/triage/triage";

const config = loadConfig();
const logger = createLogger("log");

const oauthConfig: OAuthConfig = {
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  redirectUri: config.redirectUri,
  webhookSecret: config.webhookSecret,
  tokenStorePath: config.tokenStorePath,
};

// --- Token provider ---

async function getToken(): Promise<string> {
  const result = await getAccessToken(oauthConfig);
  if (!result) {
    throw new Error(
      "No valid OAuth token. Please authorize first via /oauth/authorize",
    );
  }
  return result.accessToken;
}

async function getAgentId(): Promise<string | null> {
  const result = await getAccessToken(oauthConfig);
  return result?.agentId ?? null;
}

// --- Linear client & triage ---

const linearClient = new LinearApiClient(getToken);
const triage = new IssueTriage(
  linearClient,
  {
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    apiKey: config.llmApiKey,
  },
  logger,
);

// --- Webhook gap detection ---

/** Track last seen issue number per team prefix to detect missed webhooks */
const lastSeenNumber = new Map<string, number>();

function parseIdentifier(identifier: string): { prefix: string; number: number } | null {
  const match = identifier.match(/^([A-Z]+)-(\d+)$/);
  if (!match) return null;
  return { prefix: match[1]!, number: parseInt(match[2]!, 10) };
}

async function handleMissedIssues(prefix: string, from: number, to: number) {
  for (let n = from; n < to; n++) {
    const identifier = `${prefix}-${n}`;
    logger.warn(`[webhook-gap] Missed webhook for ${identifier}, fetching via API`);
    try {
      const issueId = await linearClient.getIssueIdByIdentifier(identifier);
      if (issueId) {
        logger.warn(`[webhook-gap] Recovering ${identifier} (id=${issueId})`);
        void triage.triageIssue(issueId);
      } else {
        logger.warn(`[webhook-gap] ${identifier} not found (may be deleted or private)`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[webhook-gap] Failed to recover ${identifier}: ${msg}`);
    }
  }
}

// --- Webhook handler ---

const webhookHandler = createWebhookHandler(
  config.webhookSecret,
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

      void triage.triageIssue(issueId);
    },
  },
  logger,
);

// --- App ---

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.get("/status", async (c) => {
  const token = await getAccessToken(oauthConfig);
  return c.json({
    authorized: !!token,
    agentId: token?.agentId ?? null,
  });
});

// OAuth

app.get("/oauth/authorize", (c) => {
  return c.redirect(getAuthorizationUrl(oauthConfig));
});

app.get("/oauth/callback", async (c) => {
  const error = c.req.query("error");
  if (error) {
    const desc = c.req.query("error_description") ?? error;
    logger.error(`OAuth error from Linear: ${desc}`);
    return c.html(`<h1>OAuth Error</h1><p>${desc}</p>`, 400);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) {
    return c.html("<h1>Missing code or state parameter</h1>", 400);
  }

  const result = await handleOAuthCallback(oauthConfig, code, state);
  if (!result.success) {
    return c.html(
      `<h1>${result.title}</h1><p>${result.message}</p>`,
      result.status as 400 | 403 | 500,
    );
  }

  return c.html(`
    <h1>Authorization Successful</h1>
    <p>Agent ID: <code>${result.agentId}</code></p>
    <p>Token expires: ${result.expiresAt ?? "unknown"}</p>
    <p>You can close this page.</p>
  `);
});

// Webhook — delegate to Linear SDK handler (Fetch API)

app.post("/webhooks/linear", async (c) => {
  // Check auth before processing
  const agentId = await getAgentId();
  if (!agentId) {
    logger.warn(
      "Webhook received but no OAuth token available. Please authorize first.",
    );
    return c.text("Not authorized. Visit /oauth/authorize first.", 503);
  }

  const response = await webhookHandler(c.req.raw);
  return response;
});

// --- Start ---

serve({ fetch: app.fetch, port: config.port }, () => {
  logger.info(
    `linear-agent server listening on http://localhost:${config.port}`,
  );
  logger.info(`LLM: ${config.llmBaseUrl} / ${config.llmModel}`);
});
