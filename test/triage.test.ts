import "dotenv/config";
import { describe, it, expect, vi } from "vitest";
import { IssueTriage, type IssueContext, type LLMConfig } from "../src/triage/triage";
import type { LinearApiClient } from "../src/linear/client";
import type { PluginLogger } from "../src/webhook/logger-types";

// --- Mock Linear client ---

function createMockLinearClient() {
  const calls: {
    updateIssue: Array<{ issueId: string; input: Record<string, unknown> }>;
    createComment: Array<{ issueId: string; body: string }>;
  } = {
    updateIssue: [],
    createComment: [],
  };

  const client = {
    getIssue: vi.fn(),
    getTeamMembers: vi.fn(),
    getTeamLabels: vi.fn(),
    getWorkflowStates: vi.fn(),
    updateIssue: vi.fn(async (issueId: string, input: Record<string, unknown>) => {
      calls.updateIssue.push({ issueId, input });
    }),
    createComment: vi.fn(async (issueId: string, body: string) => {
      calls.createComment.push({ issueId, body });
    }),
    getIssueIdByIdentifier: vi.fn(),
  } as unknown as LinearApiClient;

  return { client, calls };
}

// --- Mock logger ---

function createMockLogger(): PluginLogger & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    info: (msg: string) => { logs.push(`[INFO] ${msg}`); console.log(`[INFO] ${msg}`); },
    warn: (msg: string) => { logs.push(`[WARN] ${msg}`); console.warn(`[WARN] ${msg}`); },
    error: (msg: string) => { logs.push(`[ERROR] ${msg}`); console.error(`[ERROR] ${msg}`); },
  };
}

// --- Shared labels & states ---

const AVAILABLE_LABELS = [
  { id: "label-bug", name: "Bug" },
  { id: "label-feature", name: "Feature" },
  { id: "label-improvement", name: "Improvement" },
  { id: "label-contact-us", name: "Contact Us" },
  { id: "label-llm-feedback", name: "LLM Feedback" },
  { id: "label-engineering", name: "Engineering" },
  { id: "label-ux", name: "UX" },
];

const WORKFLOW_STATES = [
  { id: "state-triage", name: "Triage", type: "triage" },
  { id: "state-backlog", name: "Backlog", type: "backlog" },
  { id: "state-inprogress", name: "In Progress", type: "started" },
  { id: "state-done", name: "Done", type: "completed" },
];

const TEAM_MEMBERS = [
  { id: "user-dongdong", name: "DongDong", displayName: "DongDong" },
  { id: "user-angela", name: "Angela", displayName: "Angela" },
  { id: "user-senyang", name: "Sen Yang", displayName: "Sen Yang" },
  { id: "user-mindy", name: "Mindy", displayName: "Mindy" },
  { id: "user-dancang", name: "Dancang", displayName: "Dancang" },
  { id: "user-can", name: "can", displayName: "can" },
];

// --- LLM config from env ---

function getLLMConfig(): LLMConfig {
  const baseUrl = process.env["LLM_BASE_URL"];
  const model = process.env["LLM_MODEL"];
  const apiKey = process.env["LLM_API_KEY"];

  if (!baseUrl || !model || !apiKey) {
    throw new Error("Missing LLM_BASE_URL, LLM_MODEL, or LLM_API_KEY in env");
  }

  return { baseUrl, model, apiKey };
}

// --- Tests ---

describe("IssueTriage", () => {
  it("should triage a Contact Us issue", async () => {
    const { client, calls } = createMockLinearClient();
    const logger = createMockLogger();
    const llmConfig = getLLMConfig();

    const context: IssueContext = {
      issueId: "issue-001",
      identifier: "YOU-10001",
      title: "[Contact Us] 文档编辑器中 LaTeX 公式无法正常渲染",
      description: "用户反馈在使用 Write 功能时，输入的 LaTeX 数学公式没有被正确渲染，显示为原始代码。浏览器为 Chrome 最新版本。",
      teamName: "YouMind",
      teamMembers: TEAM_MEMBERS,
      availableLabels: AVAILABLE_LABELS,
      workflowStates: WORKFLOW_STATES,
      currentState: { id: "state-triage", name: "Triage", type: "triage" },
      existing: {
        hasAssignee: false,
        hasPriority: false,
        hasLabels: false,
      },
    };

    const triage = new IssueTriage(client, llmConfig, logger);
    await triage.runTriage(context);

    // Should have called updateIssue
    expect(calls.updateIssue.length).toBe(1);
    const update = calls.updateIssue[0]!;
    expect(update.issueId).toBe("issue-001");

    // Should assign to DongDong (document/Write/LaTeX expert)
    const validMemberIds = TEAM_MEMBERS.map((m) => m.id);
    expect(validMemberIds).toContain(update.input["assigneeId"]);

    // Should set priority (1-4)
    expect(update.input["priority"]).toBeGreaterThanOrEqual(1);
    expect(update.input["priority"]).toBeLessThanOrEqual(4);

    // Should set labels
    const labelIds = update.input["labelIds"] as string[];
    expect(labelIds.length).toBeGreaterThan(0);
    const validLabelIds = AVAILABLE_LABELS.map((l) => l.id);
    for (const id of labelIds) {
      expect(validLabelIds).toContain(id);
    }

    // Should move from triage to backlog
    expect(update.input["stateId"]).toBe("state-backlog");

    // Should have created a comment with reason
    expect(calls.createComment.length).toBe(1);
    expect(calls.createComment[0]!.body.length).toBeGreaterThan(0);

    console.log("\n--- Contact Us Triage Result ---");
    console.log("updateIssue:", JSON.stringify(update.input, null, 2));
    console.log("comment:", calls.createComment[0]!.body);
  }, 60_000);

  it("should triage a Sentry error issue and assign to Mindy", async () => {
    const { client, calls } = createMockLinearClient();
    const logger = createMockLogger();
    const llmConfig = getLLMConfig();

    const context: IssueContext = {
      issueId: "issue-002",
      identifier: "YOU-10002",
      title: "Error: Cannot read properties of undefined (reading 'map') in BoardRenderer",
      description: "Sentry Issue: YOUMIND-3A2\nThis error occurs when users open a board with empty sections.\n\nStack trace:\nTypeError: Cannot read properties of undefined (reading 'map')\n  at BoardRenderer.renderSections (board-renderer.ts:142)\n  at BoardRenderer.render (board-renderer.ts:89)",
      teamName: "YouMind",
      teamMembers: TEAM_MEMBERS,
      availableLabels: AVAILABLE_LABELS,
      workflowStates: WORKFLOW_STATES,
      currentState: { id: "state-triage", name: "Triage", type: "triage" },
      existing: {
        hasAssignee: false,
        hasPriority: false,
        hasLabels: false,
      },
    };

    const triage = new IssueTriage(client, llmConfig, logger);
    await triage.runTriage(context);

    expect(calls.updateIssue.length).toBe(1);
    const update = calls.updateIssue[0]!;

    // Sentry errors should be assigned to Mindy
    expect(update.input["assigneeId"]).toBe("user-mindy");

    // Should be high priority (production error)
    expect(update.input["priority"]).toBeGreaterThanOrEqual(1);
    expect(update.input["priority"]).toBeLessThanOrEqual(2);

    // Should include Bug label
    const labelIds = update.input["labelIds"] as string[];
    expect(labelIds).toContain("label-bug");

    console.log("\n--- Sentry Triage Result ---");
    console.log("updateIssue:", JSON.stringify(update.input, null, 2));
    console.log("comment:", calls.createComment[0]!.body);
  }, 60_000);

  it("should skip non-triageable issues", async () => {
    const { client, calls } = createMockLinearClient();
    const logger = createMockLogger();
    const llmConfig = getLLMConfig();

    const context: IssueContext = {
      issueId: "issue-003",
      identifier: "YOU-10003",
      title: "重构用户权限模块，支持 RBAC",
      description: "当前权限系统过于简单，需要引入基于角色的访问控制。这是 Q3 技术债务清理计划的一部分。",
      teamName: "YouMind",
      teamMembers: TEAM_MEMBERS,
      availableLabels: AVAILABLE_LABELS,
      workflowStates: WORKFLOW_STATES,
      currentState: { id: "state-triage", name: "Triage", type: "triage" },
      existing: {
        hasAssignee: false,
        hasPriority: false,
        hasLabels: false,
      },
    };

    const triage = new IssueTriage(client, llmConfig, logger);
    await triage.runTriage(context);

    // Should NOT call updateIssue (shouldTriage = false)
    expect(calls.updateIssue.length).toBe(0);
    expect(calls.createComment.length).toBe(0);

    // Result log should show shouldTriage: false
    const resultLog = logger.logs.find((l) => l.includes('"shouldTriage": false'));
    expect(resultLog).toBeDefined();

    console.log("\n--- Non-triageable Result ---");
    console.log("Correctly skipped, no Linear updates");
  }, 60_000);

  it("should only update missing fields when some are already set", async () => {
    const { client, calls } = createMockLinearClient();
    const logger = createMockLogger();
    const llmConfig = getLLMConfig();

    const context: IssueContext = {
      issueId: "issue-004",
      identifier: "YOU-10004",
      title: "[LLM Feedback] AI 回答与问题无关，出现幻觉",
      description: "用户反馈在询问关于 Python 排序算法时，AI 回复了关于烹饪的内容，完全无关。",
      teamName: "YouMind",
      teamMembers: TEAM_MEMBERS,
      availableLabels: AVAILABLE_LABELS,
      workflowStates: WORKFLOW_STATES,
      currentState: { id: "state-backlog", name: "Backlog", type: "backlog" },
      existing: {
        hasAssignee: true,
        assigneeName: "Angela",
        hasPriority: false,
        hasLabels: true,
        labelNames: ["LLM Feedback"],
      },
    };

    const triage = new IssueTriage(client, llmConfig, logger);
    await triage.runTriage(context);

    expect(calls.updateIssue.length).toBe(1);
    const update = calls.updateIssue[0]!;

    // Should NOT override existing fields
    expect(update.input["assigneeId"]).toBeUndefined();
    expect(update.input["labelIds"]).toBeUndefined();

    // Should only set priority
    expect(update.input["priority"]).toBeGreaterThanOrEqual(1);
    expect(update.input["priority"]).toBeLessThanOrEqual(4);

    // Should NOT change state (already backlog)
    expect(update.input["stateId"]).toBeUndefined();

    console.log("\n--- Partial Triage Result ---");
    console.log("updateIssue:", JSON.stringify(update.input, null, 2));
  }, 60_000);
});
