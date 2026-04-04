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
  output: unknown;
  parentObservationId: string | null;
}

/** Extract a concise summary from observations: which tools were called, which errored */
function summarizeObservations(
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

export const fetchTraceTool: AgentTool = {
  name: "fetch_trace",
  label: "Fetch Trace",
  description:
    "从 lab.gooo.ai 获取 trace 详情。当 issue 描述中包含 https://lab.gooo.ai/project/{projectId}/traces/{traceId} 格式的链接时使用此工具，返回 trace 涉及的工具调用及异常信息，辅助判断问题类型和负责人。",
  parameters: Type.Object({
    url: Type.String({
      description:
        "完整的 lab.gooo.ai trace 链接，如 https://lab.gooo.ai/project/abc123/traces/def456",
    }),
  }),

  execute: async (_toolCallId: string, params: unknown) => {
    const { url } = params as { url: string };
    const traceId = parseTraceId(url);

    if (!traceId) {
      throw new Error(`Could not parse traceId from URL: ${url}`);
    }

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

    const { toolCounts, errors } = summarizeObservations(obsBody.data);

    const toolSummary = [...toolCounts.entries()]
      .map(([name, count]) => `${name}(${count}次)`)
      .join(", ");

    let text: string;
    if (errors.length > 0) {
      const parts = errors.map((e) => `${e.tool} tool 出现异常: ${e.error}`);
      text = parts.join("\n");
    } else if (toolSummary) {
      text = `调用了 ${toolSummary} tool，未发现异常`;
    } else {
      text = "该 trace 中未发现 tool 调用记录";
    }

    return {
      content: [{ type: "text" as const, text }],
      details: {},
    };
  },
};
