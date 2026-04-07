import { Type } from "@mariozechner/pi-ai";
import type { SubAgent, SubAgentResult } from "../../types";
import type { LinearApiClient } from "../../../infra/linear/client";
import type { Logger } from "../../../utils/logger";
import { IssueTriage, type LLMConfig } from "./triage";

export function createLinearTriageAgent(
  linearClient: LinearApiClient,
  llmConfig: LLMConfig,
  logger: Logger,
  excludeUserId?: string,
): SubAgent {
  const triage = new IssueTriage(linearClient, llmConfig, logger, excludeUserId);

  return {
    name: "linear-triage",
    description: "自动分诊 Linear issue（分配负责人、优先级、标签）",

    async invoke(input): Promise<SubAgentResult> {
      const issueId = input["issueId"];
      if (typeof issueId !== "string") {
        return { success: false, message: "missing issueId" };
      }
      try {
        await triage.triageIssue(issueId);
        return { success: true, message: `Triaged issue ${issueId}` };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[linear-triage] Failed to triage ${issueId}: ${msg}`);
        return { success: false, message: `Triage failed: ${msg}` };
      }
    },

    asTool() {
      return {
        name: "linear_triage",
        label: "Linear Issue Triage",
        description: "对 Linear issue 进行自动分诊，分配负责人、优先级和标签。",
        parameters: Type.Object({
          issueId: Type.String({ description: "Linear issue ID" }),
        }),
        execute: async (_toolCallId, params) => {
          const { issueId } = params as { issueId: string };
          const result = await this.invoke({ issueId });
          return {
            content: [{ type: "text" as const, text: result.message }],
            details: result,
          };
        },
      };
    },
  };
}
