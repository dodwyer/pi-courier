import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectOperatorStatus, projectStatusMarkdown, RunReporter } from "../src/runtime/run-reporter";

describe("RunReporter", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reports live and settled usage per resolved model without exposing task prompts", async () => {
    let now = 0;
    const messages: string[] = [];
    const reporter = new RunReporter({
      intervalSeconds: 0,
      readableProgress: true,
      finalUsage: true,
      now: () => now,
      send: async (text) => { messages.push(text); },
    });

    await reporter.handle({ type: "agent_start" });
    await reporter.handle({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        usage: { input: 100, output: 50, cacheRead: 25, cacheWrite: 0, totalTokens: 175 },
      },
    });
    await reporter.handle({ type: "tool_execution_start", toolCallId: "task-1", toolName: "task", args: {
      agent: "architecture-planner",
      task: "SECRET INTERNAL SCHEMA AND PROMPT",
    } });
    await reporter.handle({
      type: "tool_execution_update",
      toolCallId: "task-1",
      toolName: "task",
      partialResult: { details: { progress: [{
        id: "Architect",
        status: "running",
        resolvedModel: "anthropic/claude-fable-5:max",
        tokens: 1_000,
      }] } },
    });
    await reporter.handle({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: {} });
    now = 600_000;
    await reporter.report();

    expect(messages[0]).toContain("Architecture planning started");
    expect(messages[0]).not.toContain("SECRET INTERNAL");
    expect(messages[1]).toContain("Run update · 10 minutes");
    expect(messages[1]).toContain("Claude Fable 5 (anthropic): ~1,000 (+1,000)");
    expect(messages[1]).toContain("GPT-5.6 Sol (openai-codex): 175 (+175)");
    expect(messages[1]).toContain("100 input · 25 cache reads · 50 output");
    expect(messages[1]).toContain("1 read/search");

    now = 720_000;
    await reporter.handle({
      type: "tool_execution_end",
      toolCallId: "task-1",
      toolName: "task",
      result: { details: { results: [{
        id: "Architect",
        agent: "architecture-planner",
        exitCode: 0,
        durationMs: 720_000,
        resolvedModel: "anthropic/claude-fable-5:max",
        usage: { input: 500, output: 500, cacheRead: 1_500, cacheWrite: 500, totalTokens: 3_000 },
        structuredOutput: { data: { verdict: "pass", confidence: 0.97 } },
      }] } },
    });
    await reporter.handle({ type: "agent_end" });

    expect(messages[2]).toContain("Architecture planning passed");
    expect(messages[2]).toContain("97% confidence");
    expect(messages[3]).toContain("Final model usage · 12m 0s");
    expect(messages[3]).toContain("Claude Fable 5 (anthropic): 3,000 (+2,000)");
    expect(messages[3]).not.toContain("~ includes live agent tokens");
  });

  it("emits a periodic update at the configured interval while a run is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T10:00:00Z"));
    const messages: string[] = [];
    const reporter = new RunReporter({
      intervalSeconds: 600,
      readableProgress: false,
      finalUsage: false,
      send: async (text) => { messages.push(text); },
    });
    await reporter.handle({ type: "agent_start" });
    await reporter.handle({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-5",
        usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0, totalTokens: 35 },
      },
    });

    await vi.advanceTimersByTimeAsync(599_999);
    expect(messages).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Run update · 10 minutes");
    expect(messages[0]).toContain("Claude Opus 5 (anthropic): 35 (+35)");
    reporter.close();
  });

  it("emits lean operator updates with broker capacity instead of token telemetry", async () => {
    vi.useFakeTimers();
    const started = new Date("2026-08-18T10:00:00Z").getTime();
    vi.setSystemTime(started);
    const workspace = mkdtempSync(join(tmpdir(), "courier-operator-test-"));
    dirs.push(workspace);
    const statusFilePath = join(workspace, ".courier", "development", "status.md");
    mkdirSync(join(workspace, ".courier", "development"), { recursive: true });
    writeFileSync(statusFilePath, `# Development status

## Matrix update

- Finished: Architecture revision 5 completed.
- Current: Codex is reviewing the architecture (8m).
- Next: Create implementation tasks if accepted.

## Durable ledger
`);
    const messages: string[] = [];
    const reporter = new RunReporter({
      intervalSeconds: 600,
      progressHeartbeatSeconds: 60,
      readableProgress: true,
      finalUsage: true,
      format: "operator",
      usageMode: "capacity",
      capacityStaleSeconds: 900,
      timeZone: "Europe/Berlin",
      runLabel: "development",
      workspacePath: workspace,
      statusFilePath,
      capacityFetcher: async () => capacityFixture(started + 600_000),
      send: async (text) => { messages.push(text); },
    });
    await reporter.handle({ type: "agent_start" });
    await reporter.handle({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        usage: { input: 100, output: 20, totalTokens: 120 },
      },
    });
    await reporter.handle({
      type: "tool_execution_update",
      toolCallId: "fable",
      toolName: "task",
      partialResult: { details: { progress: [{ id: "architect", status: "running", resolvedModel: "anthropic/claude-fable-5:max", tokens: 500 }] } },
    });

    await vi.advanceTimersByTimeAsync(600_000);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Development update · 10m");
    expect(messages[0]).toContain("Finished:** Architecture revision 5 completed.");
    expect(messages[0]).toContain("Current:** Codex is reviewing the architecture (8m).");
    expect(messages[0]).toContain("Next:** Create implementation tasks if accepted.");
    expect(messages[0]).toContain("OpenAI Codex: 91% 7d");
    expect(messages[0]).toContain("Anthropic: 91% 5h");
    expect(messages[0]).toContain("Claude Fable: 77% 7d");
    expect(messages[0]).not.toContain("Model tokens");
    expect(messages[0]).not.toContain("Activity:");
    expect(messages[0]).not.toContain("Still working");
    reporter.close();
  });

  it("resets the ten-minute deadline after a meaningful operator update", async () => {
    vi.useFakeTimers();
    const started = new Date("2026-08-18T10:00:00Z").getTime();
    vi.setSystemTime(started);
    const workspace = mkdtempSync(join(tmpdir(), "courier-operator-deadline-test-"));
    dirs.push(workspace);
    const statusFilePath = join(workspace, "status.md");
    writeFileSync(statusFilePath, "## Matrix update\n- Finished: Brief accepted.\n- Current: Architecture planning.\n- Next: Architecture review.\n");
    const messages: string[] = [];
    const reporter = new RunReporter({
      intervalSeconds: 600,
      readableProgress: true,
      finalUsage: false,
      format: "operator",
      usageMode: "none",
      workspacePath: workspace,
      statusFilePath,
      send: async (text) => { messages.push(text); },
    });
    await reporter.handle({ type: "agent_start" });
    await vi.advanceTimersByTimeAsync(300_000);
    writeFileSync(statusFilePath, "## Matrix update\n- Finished: Architecture planning completed.\n- Current: Architecture review.\n- Next: Task decomposition.\n");
    expect(await reporter.reportStatus()).toBe("sent");
    await vi.advanceTimersByTimeAsync(599_999);
    expect(messages).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(messages).toHaveLength(2);
    reporter.close();
  });

  it("restores logical elapsed time and monotonic task-result numbering after a crash", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "courier-reporter-restart-test-"));
    dirs.push(workspace);
    const taskResultDirectoryPath = join(workspace, "task-results");
    const stateFilePath = join(workspace, "session", "run-reporter.json");
    let now = new Date("2026-08-18T10:00:00Z").getTime();
    const first = new RunReporter({
      intervalSeconds: 0,
      readableProgress: false,
      finalUsage: false,
      format: "operator",
      usageMode: "none",
      stateFilePath,
      taskResultDirectoryPath,
      now: () => now,
      send: async () => {},
    });
    await first.handle({ type: "agent_start" });
    await first.handle({ type: "tool_execution_end", toolCallId: "one", toolName: "task", result: { details: { results: [] } } });
    now += 15 * 60_000;
    first.close();

    const messages: string[] = [];
    const second = new RunReporter({
      intervalSeconds: 0,
      readableProgress: false,
      finalUsage: false,
      format: "operator",
      usageMode: "none",
      stateFilePath,
      taskResultDirectoryPath,
      now: () => now,
      send: async (text) => { messages.push(text); },
    });
    await second.handle({ type: "agent_start" });
    await second.report();
    await second.handle({ type: "tool_execution_end", toolCallId: "two", toolName: "task", result: { details: { results: [] } } });

    expect(messages[0]).toContain("15m");
    expect(readdirSync(taskResultDirectoryPath).sort()).toEqual(["0001-one.json", "0002-two.json"]);
    second.close();
  });

  it("emits bounded delegated-stage heartbeats and persists task result envelopes mechanically", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T10:00:00Z"));
    const workspace = mkdtempSync(join(tmpdir(), "courier-task-result-test-"));
    dirs.push(workspace);
    const taskResultDirectoryPath = join(workspace, ".courier", "development", "task-results");
    const messages: string[] = [];
    const reporter = new RunReporter({
      intervalSeconds: 0,
      progressHeartbeatSeconds: 60,
      readableProgress: false,
      finalUsage: false,
      taskResultDirectoryPath,
      send: async (text) => { messages.push(text); },
    });
    await reporter.handle({ type: "agent_start" });
    await reporter.handle({
      type: "tool_execution_start",
      toolCallId: "task-long",
      toolName: "task",
      args: { agent: "implementation-agent", task: "hidden prompt" },
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages).toEqual([expect.stringContaining("Still working · 1m 0s")]);
    expect(messages[0]).not.toContain("hidden prompt");

    await reporter.handle({
      type: "tool_execution_end",
      toolCallId: "task-long",
      toolName: "task",
      result: { details: { results: [{
        id: "implement",
        agent: "implementation-agent",
        exitCode: 0,
        resolvedModel: "openai-codex/gpt-5.6-sol:xhigh",
        structuredOutput: { data: { verdict: "pass" } },
      }] } },
    });
    const files = readdirSync(taskResultDirectoryPath);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(taskResultDirectoryPath, files[0]), "utf-8"))).toMatchObject({
      schemaVersion: 1,
      toolCallId: "task-long",
      results: [{ resolvedModel: "openai-codex/gpt-5.6-sol:xhigh" }],
    });
    expect(statSync(taskResultDirectoryPath).mode & 0o777).toBe(0o770);
    expect(statSync(join(taskResultDirectoryPath, files[0])).mode & 0o777).toBe(0o660);
    reporter.close();
  });

  it("repairs a private task-result directory for the workspace runtime", () => {
    const workspace = mkdtempSync(join(tmpdir(), "courier-task-result-mode-test-"));
    dirs.push(workspace);
    const taskResultDirectoryPath = join(workspace, "task-results");
    mkdirSync(taskResultDirectoryPath, { recursive: true, mode: 0o700 });
    chmodSync(taskResultDirectoryPath, 0o700);

    const reporter = new RunReporter({
      intervalSeconds: 0,
      readableProgress: false,
      finalUsage: false,
      taskResultDirectoryPath,
      send: async () => {},
    });

    expect(statSync(taskResultDirectoryPath).mode & 0o777).toBe(0o770);
    reporter.close();
  });

  it("projects and deduplicates the explicit Matrix section from a bounded workspace status file", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "courier-status-test-"));
    dirs.push(workspace);
    const statusDir = join(workspace, ".courier", "development");
    mkdirSync(statusDir, { recursive: true });
    const statusFilePath = join(statusDir, "status.md");
    writeFileSync(statusFilePath, `# Development status

- Status: implementation
- Current gate: task 2

## Matrix update

- Architecture and task plan are accepted.
- Building the HTTP surface now.
- Next: Opus implementation review.

## Internal ledger

- raw protocol detail that must not reach Matrix
`);
    const messages: string[] = [];
    const reporter = new RunReporter({
      intervalSeconds: 0,
      readableProgress: true,
      finalUsage: true,
      statusFilePath,
      workspacePath: workspace,
      send: async (text) => { messages.push(text); },
    });

    expect(await reporter.reportStatus()).toBe("sent");
    expect(await reporter.reportStatus()).toBe("unchanged");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Building the HTTP surface now");
    expect(messages[0]).not.toContain("raw protocol detail");

    await reporter.handle({ type: "agent_start" });
    await reporter.report();
    expect(messages[1]).toContain("Workspace update");
    expect(messages[1]).toContain("Model tokens");
    await reporter.report();
    expect(messages[2]).toContain("workspace status is unchanged");
    expect(messages[2]).not.toContain("Building the HTTP surface now");
  });

  it("falls back to concise status metadata for legacy status files", () => {
    expect(projectStatusMarkdown(`# Status\n\n- Status: task manifest accepted\n- Current gate: host preflight\n- Updated: now\n- Internal: noisy\n`))
      .toBe("📍 **Workspace status**\n• **Status:** task manifest accepted\n• **Current gate:** host preflight\n• **Updated:** now");
  });

  it("parses the strict operator status contract and omits the durable ledger", () => {
    expect(projectOperatorStatus(`## Matrix update
- Finished: Build completed.
- Current: Opus implementation review.
- Next: Run integrated validation.
- Action needed: Approve the external deployment.

## Durable ledger
- secret: raw
`)).toEqual({
      finished: "Build completed.",
      current: "Opus implementation review.",
      next: "Run integrated validation.",
      actionNeeded: "Approve the external deployment.",
    });
  });

  it("stops an unheaded legacy ledger after the Matrix update bullet block", () => {
    expect(projectStatusMarkdown(`# Status

## Matrix update

- Current gate is host preflight.
- Next: restore the reference checkout.

- Historical planner identity: invalid
- raw protocol detail
`)).toBe("📍 **Workspace update**\n- Current gate is host preflight.\n- Next: restore the reference checkout.");
  });
});

function capacityFixture(fetchedAt: number): unknown {
  return {
    reports: [
      {
        provider: "openai-codex",
        fetchedAt,
        limits: [
          { scope: { provider: "openai-codex", windowId: "7d", shared: true }, window: { id: "7d", resetsAt: fetchedAt + 86_400_000 }, amount: { remaining: 91 }, status: "ok" },
          { scope: { provider: "openai-codex", windowId: "5h", tier: "spark", modelId: "GPT-5.3-Codex-Spark" }, window: { id: "5h" }, amount: { remaining: 100 }, status: "ok" },
        ],
      },
      {
        provider: "anthropic",
        fetchedAt,
        limits: [
          { scope: { provider: "anthropic", windowId: "5h", shared: true }, window: { id: "5h", resetsAt: fetchedAt + 3_600_000 }, amount: { remaining: 91 }, status: "ok" },
          { scope: { provider: "anthropic", windowId: "7d", shared: true }, window: { id: "7d", resetsAt: fetchedAt + 86_400_000 }, amount: { remaining: 78 }, status: "ok" },
          { scope: { provider: "anthropic", windowId: "7d", tier: "fable" }, window: { id: "7d", resetsAt: fetchedAt + 86_400_000 }, amount: { remaining: 77 }, status: "ok" },
        ],
      },
    ],
  };
}
