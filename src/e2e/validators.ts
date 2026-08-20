import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { auditArtifactRoot } from "../runtime/workflow-contract.js";
import type { E2eCaseKind, E2eCheckResult } from "./types.js";

interface DevelopmentState {
  schemaVersion?: number;
  contractSha256?: string;
  workflow?: string;
  status?: string;
  baseCommit?: string;
  tasks?: Array<{ id?: string; status?: string }>;
  reviews?: Array<{
    stage?: string;
    taskId?: string;
    actualModel?: string | null;
    verdict?: string;
  }>;
}

export function validateWorkspace(kind: E2eCaseKind, workspacePath: string): E2eCheckResult[] {
  const checks: E2eCheckResult[] = [];
  checkFile(checks, workspacePath, ".courier/transcript.md");
  if (kind === "development") validateDevelopment(workspacePath, checks);
  else validateResearch(workspacePath, checks);
  return checks;
}

function validateDevelopment(workspacePath: string, checks: E2eCheckResult[]): void {
  checkFile(checks, workspacePath, ".courier/development/state.json");
  checkFile(checks, workspacePath, ".courier/development/run-contract.json");
  checkFile(checks, workspacePath, ".courier/development/plan.md");
  checkFile(checks, workspacePath, ".courier/development/tasks.md");
  const statePath = path.join(workspacePath, ".courier/development/state.json");
  let state: DevelopmentState | undefined;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as DevelopmentState;
    add(checks, "development state", state.schemaVersion === 2 && state.workflow === "standard" && state.status === "completed",
      `schema=${state.schemaVersion ?? "missing"}, workflow=${state.workflow ?? "missing"}, status=${state.status ?? "missing"}`);
  } catch (err) {
    add(checks, "development state", false, (err as Error).message);
  }
  if (state) validateDevelopmentGates(state, checks);
  validateDevelopmentContract(workspacePath, state, checks);
  validateResolvedTaskModels(workspacePath, checks);
  const violations = auditArtifactRoot(workspacePath, {
    root: ".courier",
    forbiddenDirectories: [".venv", "venv", "node_modules", "target", "dist", "build", "cache", ".cache", "tools"],
    maxFileBytes: 5 * 1024 * 1024,
    forbidExecutables: true,
  });
  add(checks, "bounded Courier artifacts", violations.length === 0,
    violations.length === 0 ? "pass" : violations.map((item) => `${item.reason}:${item.path}`).join(", "));
  const gitStatus = runGit(workspacePath, ["status", "--porcelain"]);
  add(checks, "clean Git worktree", gitStatus.ok && gitStatus.stdout === "", gitStatus.ok ? (gitStatus.stdout || "clean") : gitStatus.error);
  const head = runGit(workspacePath, ["rev-parse", "HEAD"]);
  add(checks, "final local commit", head.ok && Boolean(state?.baseCommit) && head.stdout !== state?.baseCommit,
    head.ok ? `HEAD=${head.stdout}, base=${state?.baseCommit ?? "missing"}` : head.error);
}

function validateResolvedTaskModels(workspacePath: string, checks: E2eCheckResult[]): void {
  const directory = path.join(workspacePath, ".courier/development/task-results");
  const actual = new Map<string, string[]>();
  try {
    for (const name of fs.readdirSync(directory).filter((candidate) => candidate.endsWith(".json"))) {
      const envelope = JSON.parse(fs.readFileSync(path.join(directory, name), "utf-8")) as {
        results?: Array<{ agent?: string; resolvedModel?: string }>;
      };
      for (const result of envelope.results ?? []) {
        if (!result.agent || !result.resolvedModel) continue;
        actual.set(result.agent, [...(actual.get(result.agent) ?? []), result.resolvedModel]);
      }
    }
  } catch (error) {
    add(checks, "true-model task routing", false, (error as Error).message);
    return;
  }
  const required: Record<string, string> = {
    "architecture-planner": "anthropic/claude-fable-5:max",
    "plan-reviewer": "openai-codex/gpt-5.6-sol:max",
    "task-plan-reviewer": "anthropic/claude-opus-5:max",
    "implementation-agent": "openai-codex/gpt-5.6-sol:xhigh",
    "implementation-reviewer": "anthropic/claude-opus-5:max",
    reviewer: "openai-codex/gpt-5.6-sol:max",
    "acceptance-reviewer": "anthropic/claude-fable-5:max",
  };
  const mismatches = Object.entries(required).flatMap(([agent, model]) => {
    const observed = actual.get(agent) ?? [];
    return observed.length > 0 && observed.every((candidate) => candidate === model)
      ? []
      : [`${agent}: expected ${model}, observed ${observed.join(", ") || "none"}`];
  });
  if (actual.has("sonic")) mismatches.push("sonic: persistence-only model session is not permitted");
  add(checks, "true-model task routing", mismatches.length === 0,
    mismatches.length === 0 ? "all required roles used their exact provider/model/effort" : mismatches.join("; "));
}

function validateDevelopmentContract(
  workspacePath: string,
  state: DevelopmentState | undefined,
  checks: E2eCheckResult[],
): void {
  try {
    const contract = JSON.parse(fs.readFileSync(
      path.join(workspacePath, ".courier/development/run-contract.json"),
      "utf-8",
    )) as Record<string, unknown>;
    const models = contract.modelMap as Record<string, unknown> | undefined;
    const passed = contract.schemaVersion === 2
      && typeof contract.contractSha256 === "string"
      && contract.contractSha256 === state?.contractSha256
      && models?.lead === "openai-codex/gpt-5.6-sol:max"
      && models?.["architecture-planner"] === "anthropic/claude-fable-5:max"
      && models?.["task-plan-reviewer"] === "anthropic/claude-opus-5:max"
      && models?.["implementation-agent"] === "openai-codex/gpt-5.6-sol:xhigh"
      && models?.["implementation-reviewer"] === "anthropic/claude-opus-5:max"
      && models?.["acceptance-reviewer"] === "anthropic/claude-fable-5:max";
    add(checks, "workflow contract and exact model map", passed,
      passed ? String(contract.contractSha256) : "missing, mismatched, or incorrect contract/model map");
  } catch (error) {
    add(checks, "workflow contract and exact model map", false, (error as Error).message);
  }
}

function validateDevelopmentGates(state: DevelopmentState, checks: E2eCheckResult[]): void {
  const tasks = state.tasks ?? [];
  const reviews = state.reviews ?? [];
  add(checks, "completed tasks", tasks.length > 0 && tasks.every((task) => task.status === "completed"),
    `${tasks.filter((task) => task.status === "completed").length}/${tasks.length} completed`);
  requirePassingReview(checks, reviews, "plan", "openai-codex/gpt-5.6-sol", "Codex plan review");
  requirePassingReview(checks, reviews, "task_plan", "anthropic/claude-opus-5", "Opus task-plan review");
  for (const task of tasks) {
    const passed = reviews.some((review) => review.stage === "implementation" && review.taskId === task.id &&
      review.actualModel === "anthropic/claude-opus-5" && review.verdict === "pass");
    add(checks, `Opus implementation review ${task.id ?? "unknown"}`, passed, passed ? "pass" : "missing passing review");
  }
  requirePassingReview(checks, reviews, "integrated", "openai-codex/gpt-5.6-sol", "Codex integrated review");
  requirePassingReview(checks, reviews, "acceptance", "anthropic/claude-fable-5", "Fable acceptance review");
}

function requirePassingReview(
  checks: E2eCheckResult[],
  reviews: NonNullable<DevelopmentState["reviews"]>,
  stage: string,
  model: string,
  name: string,
): void {
  const passed = reviews.some((review) => review.stage === stage && review.actualModel === model && review.verdict === "pass");
  add(checks, name, passed, passed ? `${stage} passed with ${model}` : `missing passing ${stage} review from ${model}`);
}

function validateResearch(workspacePath: string, checks: E2eCheckResult[]): void {
  for (const relative of [
    "README.md",
    "research/brief.md",
    "research/evidence.md",
    "research/options.md",
    "research/recommendation.md",
    "research/risks.md",
  ]) checkFile(checks, workspacePath, relative);
  const briefsDir = path.join(workspacePath, "development-briefs");
  const briefs = fs.existsSync(briefsDir)
    ? fs.readdirSync(briefsDir).filter((name) => name.endsWith(".md"))
    : [];
  add(checks, "development brief", briefs.length > 0, briefs.length > 0 ? briefs.join(", ") : "no Markdown briefs found");
  const evidencePath = path.join(workspacePath, "research/evidence.md");
  const recommendationPath = path.join(workspacePath, "research/recommendation.md");
  let sourceCount = 0;
  for (const file of [evidencePath, recommendationPath]) {
    if (!fs.existsSync(file)) continue;
    sourceCount += fs.readFileSync(file, "utf-8").match(/https:\/\/[^\s)>]+/g)?.length ?? 0;
  }
  add(checks, "traceable web sources", sourceCount >= 3, `${sourceCount} URL references found`);
  const briefPath = path.join(workspacePath, "research/brief.md");
  const brief = fs.existsSync(briefPath) ? fs.readFileSync(briefPath, "utf-8") : "";
  add(checks, "bounded evidence rounds", /three|3/i.test(brief) && /round/i.test(brief),
    /round/i.test(brief) ? "round budget recorded" : "round budget not found");
}

function checkFile(checks: E2eCheckResult[], workspacePath: string, relative: string): void {
  const target = path.join(workspacePath, relative);
  let passed = false;
  let detail = "missing";
  try {
    const stats = fs.statSync(target);
    passed = stats.isFile() && stats.size > 0;
    detail = passed ? `${stats.size} bytes` : "not a non-empty regular file";
  } catch {
    // Keep missing result.
  }
  add(checks, relative, passed, detail);
}

function runGit(cwd: string, args: string[]): { ok: true; stdout: string } | { ok: false; error: string } {
  const result = spawnSync("git", ["-c", `safe.directory=${path.resolve(cwd)}`, ...args], { cwd, encoding: "utf-8" });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: (result.stderr || `git exited ${result.status}`).trim() };
  return { ok: true, stdout: result.stdout.trim() };
}

function add(checks: E2eCheckResult[], name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}
