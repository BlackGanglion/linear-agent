import type { Hono } from "hono";
import {
  getAuthorizationUrl,
  handleOAuthCallback,
  type OAuthConfig,
} from "../infra/linear/oauth";
import type { Logger } from "../utils/logger";

export function registerOAuthRoutes(
  app: Hono,
  oauthConfig: OAuthConfig,
  logger: Logger,
) {
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
}
