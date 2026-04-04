import type { SubAgent } from "./types";

export class AgentRegistry {
  private agents = new Map<string, SubAgent>();

  register(agent: SubAgent): void {
    this.agents.set(agent.name, agent);
  }

  get(name: string): SubAgent | undefined {
    return this.agents.get(name);
  }

  all(): SubAgent[] {
    return [...this.agents.values()];
  }

  /** Get all sub-agents as AgentTools (for main agent) */
  asTools() {
    return this.all().map((a) => a.asTool());
  }
}
