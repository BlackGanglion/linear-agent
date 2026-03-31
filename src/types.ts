/**
 * Re-export Linear SDK types we use, plus our own plugin types.
 */
export type {
  AgentSessionEventWebhookPayload,
  AgentSessionWebhookPayload,
  CommentChildWebhookPayload,
  GuidanceRuleWebhookPayload,
} from "@linear/sdk";

/** Parsed agent session event for internal routing */
export interface AgentSessionEvent {
  sessionId: string;
  issueId: string;
  agentId: string;
  status: string;
  message?: string;
  signal?: "stop";
}

/** Linear issue (query result, simplified) */
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  priority: number;
  state: { id: string; name: string; type: string };
  assignee?: { id: string; name: string };
  team: { id: string; key: string; name: string };
  labels: Array<{ name: string }>;
}

/** Activity content variants for Linear Agent Session */
export type ActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter?: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

/** Plugin configuration (OAuth) */
export interface PluginConfig {
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenStorePath: string;
  defaultDir?: string;
}

/** Validated plugin config (all required fields present) */
export function validateConfig(
  raw: Record<string, unknown> | undefined,
): PluginConfig | null {
  if (!raw) return null;
  const webhookSecret =
    typeof raw["webhookSecret"] === "string" ? raw["webhookSecret"] : "";
  const clientId =
    typeof raw["clientId"] === "string" ? raw["clientId"] : "";
  const clientSecret =
    typeof raw["clientSecret"] === "string" ? raw["clientSecret"] : "";
  const redirectUri =
    typeof raw["redirectUri"] === "string" ? raw["redirectUri"] : "";
  const tokenStorePath =
    typeof raw["tokenStorePath"] === "string"
      ? raw["tokenStorePath"]
      : ".data/oauth-token.json";
  if (!webhookSecret || !clientId || !clientSecret || !redirectUri) return null;
  return {
    webhookSecret,
    clientId,
    clientSecret,
    redirectUri,
    tokenStorePath,
    defaultDir:
      typeof raw["defaultDir"] === "string" ? raw["defaultDir"] : undefined,
  };
}
