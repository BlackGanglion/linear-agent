import { LinearClient, LinearDocument as L } from "@linear/sdk";
import type { ActivityContent, LinearIssue } from "../types";

/** Token provider — returns the current access token. Allows dynamic token refresh. */
export type TokenProvider = () => string | Promise<string>;

export class LinearApiClient {
  private readonly getToken: TokenProvider;
  private clientCache: { token: string; client: LinearClient } | null = null;

  constructor(tokenOrProvider: string | TokenProvider) {
    this.getToken =
      typeof tokenOrProvider === "string"
        ? () => tokenOrProvider
        : tokenOrProvider;
  }

  private async getClient(): Promise<LinearClient> {
    const token = await this.getToken();
    if (this.clientCache && this.clientCache.token === token) {
      return this.clientCache.client;
    }
    const client = new LinearClient({ accessToken: token });
    this.clientCache = { token, client };
    return client;
  }

  async getIssue(issueId: string): Promise<LinearIssue> {
    const client = await this.getClient();
    const issue = await client.issue(issueId);
    const state = await issue.state;
    const team = await issue.team;
    const assignee = await issue.assignee;
    const labelsConnection = await issue.labels();

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      url: issue.url,
      priority: issue.priority,
      state: {
        id: state?.id ?? "",
        name: state?.name ?? "",
        type: state?.type ?? "",
      },
      assignee: assignee ? { id: assignee.id, name: assignee.name } : undefined,
      team: {
        id: team?.id ?? "",
        key: team?.key ?? "",
        name: team?.name ?? "",
      },
      labels: labelsConnection.nodes.map((l) => ({ name: l.name })),
    };
  }

  async emitActivity(
    sessionId: string,
    content: ActivityContent,
  ): Promise<void> {
    const client = await this.getClient();
    await client.createAgentActivity({
      agentSessionId: sessionId,
      content: toSdkContent(content),
    });
  }
}

/**
 * Convert our ActivityContent to the Linear SDK content format.
 * The SDK v80 type definitions are stricter than what the API actually requires,
 * so we match the pattern from Linear's official weather-bot example (SDK v58).
 */
function toSdkContent(content: ActivityContent): L.AgentActivityContent {
  switch (content.type) {
    case "thought":
      return {
        type: L.AgentActivityType.Thought,
        body: content.body,
      } as L.AgentActivityContent;
    case "action":
      return {
        type: L.AgentActivityType.Action,
        action: content.action,
        parameter: content.parameter ?? "",
      } as L.AgentActivityContent;
    case "response":
      return {
        type: L.AgentActivityType.Response,
        body: content.body,
      } as L.AgentActivityContent;
    case "error":
      return {
        type: L.AgentActivityType.Error,
        body: content.body,
      } as L.AgentActivityContent;
  }
}
