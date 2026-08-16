import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/runtime/state-store";
import { WorkspaceManager } from "../src/runtime/workspace-manager";

describe("WorkspaceManager", () => {
  let root: string;
  let state: string;
  let store: StateStore;

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), "omp-courier-workspace-"));
    root = join(tmp, "threads");
    state = join(tmp, "state");
    store = new StateStore(state);
  });

  afterEach(() => {
    store.close();
    rmSync(join(root, ".."), { recursive: true, force: true });
  });

  it("creates a managed Git workspace with an initial clean commit", () => {
    const manager = new WorkspaceManager(root, {}, store);
    const workspace = manager.resolve("nomadmade");
    expect(workspace.path).toBe(join(root, "nomadmade"));
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: workspace.path, encoding: "utf-8" })).toBe("");
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: workspace.path, encoding: "utf-8" }).trim()).toBe("main");
  });

  it("rejects traversal and unmanaged existing directories", () => {
    const manager = new WorkspaceManager(root, {}, store);
    expect(() => manager.resolve("../escape")).toThrow(/must match/);
    mkdirSync(join(root, "unmanaged"), { recursive: true });
    writeFileSync(join(root, "unmanaged", "notes.txt"), "keep me");
    expect(() => manager.resolve("unmanaged")).toThrow(/Refusing unmanaged directory/);
  });

  it("enforces one active thread lease per workspace", () => {
    const manager = new WorkspaceManager(root, {}, store);
    manager.resolve("nomadmade");
    store.acquireWorkspace("nomadmade", "thread-a");
    manager.resolve("nomadmade");
    expect(() => store.acquireWorkspace("nomadmade", "thread-b")).toThrow(/active in another/);
    store.releaseWorkspace("nomadmade", "thread-a");
    expect(() => store.acquireWorkspace("nomadmade", "thread-b")).not.toThrow();
  });

  it("locally excludes transcript metadata in an external Git workspace", () => {
    const external = join(root, "..", "external");
    mkdirSync(external, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: external });
    const manager = new WorkspaceManager(root, { starbug: { path: external } }, store);
    expect(manager.resolve("repo:starbug").path).toBe(external);
    expect(() => execFileSync("git", ["check-ignore", "-q", ".courier/transcript.md"], { cwd: external })).not.toThrow();
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: external, encoding: "utf-8" })).toBe("");
  });
});
