import { describe, it, expect, vi } from "vitest";
import { parseIdentifier, shouldSkipNewIssue } from "../src/routes/webhook";
import { IssueTriage, type LLMConfig } from "../src/agent/sub/linear-triage/triage";
import type { LinearApiClient } from "../src/infra/linear/client";
import type { Logger } from "../src/utils/logger";

// --- Shared helpers ---

function createMockLogger(): Logger & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    info: (msg: string) => logs.push(`[INFO] ${msg}`),
    warn: (msg: string) => logs.push(`[WARN] ${msg}`),
    error: (msg: string) => logs.push(`[ERROR] ${msg}`),
  };
}

const DUMMY_LLM_CONFIG: LLMConfig = {
  baseUrl: "http://unused",
  model: "unused",
  apiKey: "unused",
};

// --- parseIdentifier ---

describe("parseIdentifier", () => {
  it("parses valid identifiers", () => {
    expect(parseIdentifier("MOV-6")).toEqual({ prefix: "MOV", number: 6 });
    expect(parseIdentifier("ABC-12345")).toEqual({ prefix: "ABC", number: 12345 });
  });

  it("returns null for invalid identifiers", () => {
    expect(parseIdentifier("mov-6")).toBeNull();
    expect(parseIdentifier("MOV6")).toBeNull();
    expect(parseIdentifier("MOV-")).toBeNull();
    expect(parseIdentifier("")).toBeNull();
    expect(parseIdentifier("MOV-6-extra")).toBeNull();
  });
});

// --- shouldSkipNewIssue ---

describe("shouldSkipNewIssue", () => {
  describe("min issue number threshold", () => {
    it("skips when number is strictly less than threshold", () => {
      const result = shouldSkipNewIssue("MOV-99", null, 100);
      expect(result.skip).toBe(true);
      expect(result.reason).toContain("100");
    });

    it("processes when number equals threshold", () => {
      const result = shouldSkipNewIssue("MOV-100", null, 100);
      expect(result.skip).toBe(false);
    });

    it("processes when number exceeds threshold", () => {
      const result = shouldSkipNewIssue("MOV-101", null, 100);
      expect(result.skip).toBe(false);
    });

    it("is disabled when threshold is 0", () => {
      const result = shouldSkipNewIssue("MOV-1", null, 0);
      expect(result.skip).toBe(false);
    });

    it("is disabled when threshold is negative", () => {
      const result = shouldSkipNewIssue("MOV-1", null, -1);
      expect(result.skip).toBe(false);
    });

    it("does not skip when identifier is unparseable, even if threshold is set", () => {
      const result = shouldSkipNewIssue("not-an-id", null, 100);
      expect(result.skip).toBe(false);
    });
  });

  describe("assignee check", () => {
    it("skips when assigneeId is set", () => {
      const result = shouldSkipNewIssue("MOV-100", "user-123", 0);
      expect(result.skip).toBe(true);
      expect(result.reason).toBe("already assigned");
    });

    it("processes when assigneeId is null", () => {
      const result = shouldSkipNewIssue("MOV-100", null, 0);
      expect(result.skip).toBe(false);
    });

    it("processes when assigneeId is undefined", () => {
      const result = shouldSkipNewIssue("MOV-100", undefined, 0);
      expect(result.skip).toBe(false);
    });

    it("processes when assigneeId is empty string", () => {
      const result = shouldSkipNewIssue("MOV-100", "", 0);
      expect(result.skip).toBe(false);
    });
  });

  describe("combined rules", () => {
    it("threshold wins when both fire (checked first)", () => {
      const result = shouldSkipNewIssue("MOV-50", "user-123", 100);
      expect(result.skip).toBe(true);
      expect(result.reason).toContain("100");
    });

    it("skips when only assignee is set and number is above threshold", () => {
      const result = shouldSkipNewIssue("MOV-200", "user-123", 100);
      expect(result.skip).toBe(true);
      expect(result.reason).toBe("already assigned");
    });
  });
});

// --- collectContext skip-if-assigned ---

interface StubIssueData {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  priority: number;
  hasAssignee: boolean;
  labelCount: number;
}

function createMockLinearClient(data: StubIssueData): LinearApiClient {
  return {
    getIssue: vi.fn(async () => ({
      issue: {
        identifier: data.identifier,
        title: data.title,
        description: data.description ?? "",
        priority: data.priority,
      },
      state: { id: "state-triage", name: "Triage", type: "triage" },
      team: { id: "team-1", name: "YouMind" },
      assignee: data.hasAssignee ? { name: "Alice" } : null,
      labels: Array.from({ length: data.labelCount }, (_, i) => ({
        id: `label-${i}`,
        name: `Label${i}`,
      })),
    })),
    getTeamMembers: vi.fn(async () => [
      { id: "user-1", name: "Alice", displayName: "Alice", active: true },
    ]),
    getTeamLabels: vi.fn(async () => [{ id: "label-bug", name: "Bug" }]),
    getWorkflowStates: vi.fn(async () => [
      { id: "state-triage", name: "Triage", type: "triage" },
      { id: "state-backlog", name: "Backlog", type: "backlog" },
    ]),
  } as unknown as LinearApiClient;
}

describe("IssueTriage.collectContext", () => {
  it("returns null and logs when issue is already assigned", async () => {
    const client = createMockLinearClient({
      id: "issue-001",
      identifier: "MOV-100",
      title: "Sample",
      priority: 0,
      hasAssignee: true,
      labelCount: 0,
    });
    const logger = createMockLogger();

    const triage = new IssueTriage(client, DUMMY_LLM_CONFIG, logger);
    const context = await triage.collectContext("issue-001");

    expect(context).toBeNull();
    expect(logger.logs.some((l) => l.includes("already assigned"))).toBe(true);
    // Should short-circuit before fetching team members/labels/states
    expect(vi.mocked(client.getTeamMembers)).not.toHaveBeenCalled();
    expect(vi.mocked(client.getTeamLabels)).not.toHaveBeenCalled();
    expect(vi.mocked(client.getWorkflowStates)).not.toHaveBeenCalled();
  });

  it("returns context when issue has no assignee", async () => {
    const client = createMockLinearClient({
      id: "issue-002",
      identifier: "MOV-101",
      title: "Sample",
      priority: 0,
      hasAssignee: false,
      labelCount: 0,
    });
    const logger = createMockLogger();

    const triage = new IssueTriage(client, DUMMY_LLM_CONFIG, logger);
    const context = await triage.collectContext("issue-002");

    expect(context).not.toBeNull();
    expect(context?.identifier).toBe("MOV-101");
    expect(context?.existing.hasPriority).toBe(false);
    expect(context?.existing.hasLabels).toBe(false);
  });

  it("returns null when issue has no team", async () => {
    const client = {
      getIssue: vi.fn(async () => ({
        issue: { identifier: "MOV-1", title: "x", description: "", priority: 0 },
        state: null,
        team: null,
        assignee: null,
        labels: [],
      })),
    } as unknown as LinearApiClient;
    const logger = createMockLogger();

    const triage = new IssueTriage(client, DUMMY_LLM_CONFIG, logger);
    const context = await triage.collectContext("issue-x");

    expect(context).toBeNull();
  });
});
