import type { Hono } from "hono";
import {
  getAccessToken,
  type OAuthConfig,
} from "../infra/linear/oauth";

export function registerHealthRoutes(app: Hono, oauthConfig: OAuthConfig) {
  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/status", async (c) => {
    const token = await getAccessToken(oauthConfig);
    return c.json({
      authorized: !!token,
      agentId: token?.agentId ?? null,
    });
  });
}
