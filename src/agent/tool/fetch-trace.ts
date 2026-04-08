import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const LANGFUSE_BASE_URL = "https://lab.gooo.ai/api/public";

/** Parse traceId from a lab.gooo.ai trace URL */
function parseTraceId(url: string): string | null {
  const match = url.match(
    /https?:\/\/lab\.gooo\.ai\/project\/[^/]+\/traces\/([a-f0-9]+)/,
  );
  return match?.[1] ?? null;
}

interface Observation {
  id: string;
  name: string;
  type: string;
  level: string;
  statusMessage: string | null;
  input: unknown;
  output: unknown;
  parentObservationId: string | null;
}

/** Extract a concise summary from observations: which tools were called, which errored */
function summarizeTools(
  observations: Observation[],
): { toolCounts: Map<string, number>; errors: Array<{ tool: string; error: string }> } {
  const toolCounts = new Map<string, number>();
  const errors: Array<{ tool: string; error: string }> = [];

  for (const ob of observations) {
    // Only look at call-tool-* spans
    if (!ob.name.startsWith("call-tool-")) continue;

    const toolName = ob.name.replace("call-tool-", "");
    toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);

    if (ob.level === "ERROR") {
      let errorMsg = ob.statusMessage ?? "";
      if (!errorMsg && ob.output) {
        // Try to extract error message from output
        const out = ob.output as Record<string, unknown>;
        if (typeof out["value"] === "string") {
          try {
            const parsed = JSON.parse(out["value"] as string) as Record<string, unknown>;
            errorMsg = (parsed["message"] as string) ?? "";
          } catch {
            errorMsg = out["value"] as string;
          }
        } else if (typeof out["message"] === "string") {
          errorMsg = out["message"] as string;
        }
      }

      // Also check parent spans for statusMessage if we don't have one
      if (!errorMsg) {
        const parent = observations.find(
          (p) => p.id === ob.parentObservationId && p.level === "ERROR",
        );
        if (parent?.statusMessage) {
          errorMsg = parent.statusMessage;
        }
      }

      errors.push({ tool: toolName, error: errorMsg || "unknown error" });
    }
  }

  return { toolCounts, errors };
}

/** Max characters per single message and total conversation output */
const MAX_MSG_LENGTH = 500;
const MAX_TOTAL_LENGTH = 4000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...（已截断）";
}

/** Extract text content from a message */
function extractMessageText(msg: Record<string, unknown>): string {
  const content = msg["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((c) => c["type"] === "text")
      .map((c) => c["text"] as string)
      .join("\n");
  }
  return "";
}

/** Extract assistant text from a generation's output */
function extractAssistantOutput(gen: Observation): string {
  if (!gen.output || typeof gen.output !== "object") return "";
  const output = gen.output as Record<string, unknown>;
  if (typeof output["content"] === "string") return output["content"];
  const message = output["message"] as Record<string, unknown> | undefined;
  if (message && typeof message["content"] === "string") return message["content"];
  return "";
}

/**
 * Extract conversation content from GENERATION observations.
 * Focuses on the first user input and the last assistant output
 * to keep output concise and relevant for quality analysis.
 */
function summarizeConversation(observations: Observation[]): string {
  const generations = observations.filter((ob) => ob.type === "GENERATION");

  if (generations.length === 0) {
    return "该 trace 中未发现 LLM 对话记录";
  }

  // Find the first user message across all generations
  let firstUserMsg = "";
  for (const gen of generations) {
    if (firstUserMsg) break;
    if (!gen.input || typeof gen.input !== "object") continue;
    const input = gen.input as Record<string, unknown>;
    const messages = input["messages"] as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(messages)) continue;
    for (const msg of messages) {
      if ((msg["role"] as string) === "user") {
        const text = extractMessageText(msg);
        if (text) {
          firstUserMsg = text;
          break;
        }
      }
    }
  }

  // Find the last assistant output across all generations (reverse search)
  let lastAssistantMsg = "";
  for (let i = generations.length - 1; i >= 0; i--) {
    const text = extractAssistantOutput(generations[i]!);
    if (text) {
      lastAssistantMsg = text;
      break;
    }
  }

  const parts: string[] = [];

  if (firstUserMsg) {
    parts.push(`[用户原始输入] ${truncate(firstUserMsg, MAX_MSG_LENGTH)}`);
  }
  if (lastAssistantMsg) {
    parts.push(`[最终助手输出] ${truncate(lastAssistantMsg, MAX_TOTAL_LENGTH - MAX_MSG_LENGTH)}`);
  }

  if (parts.length === 0) {
    return "该 trace 中未提取到有效的对话内容";
  }

  return parts.join("\n\n");
}

/** Fetch observations from Langfuse */
async function fetchObservations(traceId: string): Promise<Observation[]> {
  const publicKey = process.env["LANGFUSE_PUBLIC_KEY"] ?? "";
  const secretKey = process.env["LANGFUSE_SECRET_KEY"] ?? "";

  if (!publicKey || !secretKey) {
    throw new Error("LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY not configured");
  }

  const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const headers = { Authorization: `Basic ${credentials}` };

  const obsRes = await fetch(
    `${LANGFUSE_BASE_URL}/observations?traceId=${traceId}`,
    { headers },
  );

  if (!obsRes.ok) {
    throw new Error(`Langfuse observations API returned ${obsRes.status} ${obsRes.statusText}`);
  }

  const obsBody = (await obsRes.json()) as { data: Observation[] };
  return obsBody.data;
}

export const fetchTraceTool: AgentTool = {
  name: "fetch_trace",
  label: "Fetch Trace",
  description:
    "从 lab.gooo.ai 获取 trace 详情。支持两种模式：tools（默认）提取工具调用及异常信息，用于判断问题类型和负责人；conversation 提取 LLM 对话内容，用于分析用户反馈质量不佳的具体原因。",
  parameters: Type.Object({
    url: Type.String({
      description:
        "完整的 lab.gooo.ai trace 链接，如 https://lab.gooo.ai/project/abc123/traces/def456",
    }),
    mode: Type.Union(
      [Type.Literal("tools"), Type.Literal("conversation")],
      {
        description:
          "提取模式。tools：提取工具调用和异常信息（默认）；conversation：提取 LLM 对话内容，用于分析输出质量问题。",
        default: "tools",
      },
    ),
  }),

  execute: async (_toolCallId: string, params: unknown) => {
    const { url, mode = "tools" } = params as { url: string; mode?: string };
    const traceId = parseTraceId(url);

    if (!traceId) {
      throw new Error(`Could not parse traceId from URL: ${url}`);
    }

    const observations = await fetchObservations(traceId);

    let text: string;

    if (mode === "conversation") {
      text = summarizeConversation(observations);
    } else {
      const { toolCounts, errors } = summarizeTools(observations);

      const toolSummary = [...toolCounts.entries()]
        .map(([name, count]) => `${name}(${count}次)`)
        .join(", ");

      if (errors.length > 0) {
        const parts = errors.map((e) => `${e.tool} tool 出现异常: ${e.error}`);
        text = parts.join("\n");
      } else if (toolSummary) {
        text = `调用了 ${toolSummary} tool，未发现异常`;
      } else {
        text = "该 trace 中未发现 tool 调用记录";
      }
    }

    return {
      content: [{ type: "text" as const, text }],
      details: {},
    };
  },
};
