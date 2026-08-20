import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateWorkspace } from "../src/e2e/validators";

describe("E2E artifact validators", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a completed reviewed development workspace", () => {
    const root = workspace();
    git(root, "init", "-q");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.test");
    write(root, ".git/info/exclude", ".courier/\n");
    write(root, "README.md", "base\n");
    git(root, "add", "README.md");
    git(root, "commit", "-qm", "base");
    const baseCommit = git(root, "rev-parse", "HEAD").trim();
    write(root, ".courier/transcript.md", "transcript\n");
    write(root, ".courier/development/plan.md", "plan\n");
    write(root, ".courier/development/tasks.md", "tasks\n");
    const contractSha256 = "a".repeat(64);
    write(root, ".courier/development/run-contract.json", JSON.stringify({
      schemaVersion: 2,
      contractSha256,
      modelMap: {
        lead: "openai-codex/gpt-5.6-sol:max",
        "architecture-planner": "anthropic/claude-fable-5:max",
        "task-plan-reviewer": "anthropic/claude-opus-5:max",
        "implementation-agent": "openai-codex/gpt-5.6-sol:xhigh",
        "implementation-reviewer": "anthropic/claude-opus-5:max",
        "acceptance-reviewer": "anthropic/claude-fable-5:max",
      },
    }));
    write(root, ".courier/development/task-results/0001-models.json", JSON.stringify({
      schemaVersion: 1,
      results: [
        { agent: "architecture-planner", resolvedModel: "anthropic/claude-fable-5:max" },
        { agent: "plan-reviewer", resolvedModel: "openai-codex/gpt-5.6-sol:max" },
        { agent: "task-plan-reviewer", resolvedModel: "anthropic/claude-opus-5:max" },
        { agent: "implementation-agent", resolvedModel: "openai-codex/gpt-5.6-sol:xhigh" },
        { agent: "implementation-reviewer", resolvedModel: "anthropic/claude-opus-5:max" },
        { agent: "reviewer", resolvedModel: "openai-codex/gpt-5.6-sol:max" },
        { agent: "acceptance-reviewer", resolvedModel: "anthropic/claude-fable-5:max" },
      ],
    }));
    write(root, ".courier/development/state.json", JSON.stringify({
      schemaVersion: 2,
      contractSha256,
      workflow: "standard",
      status: "completed",
      baseCommit,
      tasks: [{ id: "DEV-1", status: "completed" }],
      reviews: [
        { stage: "plan", actualModel: "openai-codex/gpt-5.6-sol", verdict: "pass" },
        { stage: "task_plan", actualModel: "anthropic/claude-opus-5", verdict: "pass" },
        { stage: "implementation", taskId: "DEV-1", actualModel: "anthropic/claude-opus-5", verdict: "pass" },
        { stage: "integrated", actualModel: "openai-codex/gpt-5.6-sol", verdict: "pass" },
        { stage: "acceptance", actualModel: "anthropic/claude-fable-5", verdict: "pass" },
      ],
    }));
    write(root, "result.txt", "done\n");
    git(root, "add", "result.txt");
    git(root, "commit", "-qm", "result");
    const checks = validateWorkspace("development", root);
    expect(checks.filter((check) => !check.passed)).toEqual([]);
  });

  it("requires the research decision pack, sources, round budget, and handoff", () => {
    const root = workspace();
    write(root, ".courier/transcript.md", "transcript\n");
    write(root, "README.md", "summary\n");
    write(root, "research/brief.md", "Three evidence rounds.\n");
    write(root, "research/evidence.md", "https://one.test https://two.test\n");
    write(root, "research/options.md", "options\n");
    write(root, "research/recommendation.md", "https://three.test\n");
    write(root, "research/risks.md", "risks\n");
    write(root, "development-briefs/canary.md", "brief\n");
    const checks = validateWorkspace("research", root);
    expect(checks.filter((check) => !check.passed)).toEqual([]);
  });

  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), "courier-e2e-workspace-"));
    dirs.push(root);
    return root;
  }

  function write(root: string, relative: string, content: string): void {
    const target = join(root, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }

  function git(root: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf-8" });
  }
});
