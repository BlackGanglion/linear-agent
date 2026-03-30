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

/** Plugin configuration (MVP) */
export interface PluginConfig {
  webhookSecret: string;
  linearApiKey: string;
  agentId: string;
  defaultDir?: string;
}

/** Validated plugin config (all required fields present) */
export function validateConfig(
  raw: Record<string, unknown> | undefined,
): PluginConfig | null {
  if (!raw) return null;
  const webhookSecret =
    typeof raw["webhookSecret"] === "string" ? raw["webhookSecret"] : "";
  const linearApiKey =
    typeof raw["linearApiKey"] === "string" ? raw["linearApiKey"] : "";
  const agentId = typeof raw["agentId"] === "string" ? raw["agentId"] : "";
  if (!webhookSecret || !linearApiKey || !agentId) return null;
  return {
    webhookSecret,
    linearApiKey,
    agentId,
    defaultDir:
      typeof raw["defaultDir"] === "string" ? raw["defaultDir"] : undefined,
  };
}
