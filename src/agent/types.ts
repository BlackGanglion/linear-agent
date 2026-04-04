import type { AgentTool } from "@mariozechner/pi-agent-core";

/**
 * Sub-agent definition. Each sub-agent is:
 * 1. Directly invocable via webhook or programmatic trigger
 * 2. Wrappable as an AgentTool for the main agent
 */
export interface SubAgent {
  /** Unique name, e.g. "linear-triage" */
  name: string;

  /** Human-readable description */
  description: string;

  /**
   * Direct invocation — webhook or programmatic trigger.
   * Each agent defines its own input shape.
   */
  invoke(input: Record<string, unknown>): Promise<SubAgentResult>;

  /**
   * Convert this sub-agent into an AgentTool for the main agent.
   */
  asTool(): AgentTool;
}

export interface SubAgentResult {
  success: boolean;
  message: string;
  details?: unknown;
}
