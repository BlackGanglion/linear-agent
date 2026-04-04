import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig } from "./src/utils/config";
import { createLogger } from "./src/utils/logger";
import { getAccessToken, type OAuthConfig } from "./src/infra/linear/oauth";
import { LinearApiClient } from "./src/infra/linear/client";
import { AgentRegistry } from "./src/agent/registry";
import { createLinearTriageAgent } from "./src/agent/sub/linear-triage";
import { registerHealthRoutes } from "./src/routes/health";
import { registerOAuthRoutes } from "./src/routes/oauth";
import { registerWebhookRoutes } from "./src/routes/webhook";

const config = loadConfig();
const logger = createLogger("log");

// --- OAuth config ---

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

// --- Shared services ---

const linearClient = new LinearApiClient(getToken);

// --- Agent registry ---

const registry = new AgentRegistry();

registry.register(
  createLinearTriageAgent(linearClient, {
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    apiKey: config.llmApiKey,
  }, logger),
);

// --- Hono app ---

const app = new Hono();

registerHealthRoutes(app, oauthConfig);
registerOAuthRoutes(app, oauthConfig, logger);
registerWebhookRoutes(app, config.webhookSecret, oauthConfig, registry, linearClient, logger);

// --- Start ---

serve({ fetch: app.fetch, port: config.port }, () => {
  logger.info(`egg server listening on http://localhost:${config.port}`);
  logger.info(`LLM: ${config.llmBaseUrl} / ${config.llmModel}`);
});
