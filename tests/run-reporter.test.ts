import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectStatusMarkdown, RunReporter } from "../src/runtime/run-reporter";

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
  });

  it("falls back to concise status metadata for legacy status files", () => {
    expect(projectStatusMarkdown(`# Status\n\n- Status: task manifest accepted\n- Current gate: host preflight\n- Updated: now\n- Internal: noisy\n`))
      .toBe("📍 **Workspace status**\n• **Status:** task manifest accepted\n• **Current gate:** host preflight\n• **Updated:** now");
  });
});
