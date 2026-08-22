import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("preserves and repairs the last Matrix thread across an SSH operator lease", () => {
    const manager = new WorkspaceManager(root, {}, store);
    const workspace = manager.resolve("nomadmade");
    store.upsertThread({
      threadKey: "matrix-thread",
      roomId: "room",
      rootEventId: "root",
      transport: "matrix",
      username: "operator",
      workspace: workspace.name,
      workspacePath: workspace.path,
      profile: "development",
      sessionDir: join(state, "session"),
      sessionFile: join(state, "session.jsonl"),
      status: "stopped",
      lastActivity: Date.now(),
    });
    store.acquireWorkspace(workspace.name, "matrix-thread");
    store.releaseWorkspace(workspace.name, "matrix-thread");
    store.acquireOperatorLease(workspace.name, "ssh:123");
    expect(store.getWorkspace(workspace.name)).toMatchObject({
      activeThreadKey: "ssh:123",
      lastThreadKey: "matrix-thread",
    });
    store.releaseWorkspace(workspace.name, "ssh:123");

    // Simulate the pre-fix persisted state and verify startup repairs it.
    store.acquireWorkspace(workspace.name, "ssh:legacy");
    store.close();
    store = new StateStore(state);
    expect(store.getWorkspace(workspace.name)?.lastThreadKey).toBe("matrix-thread");
    expect(store.getLastThreadForWorkspace(workspace.name)?.threadKey).toBe("matrix-thread");
  });

  it("copies an approved brief into a clean managed workspace with provenance", () => {
    const manager = new WorkspaceManager(root, {}, store);
    const source = manager.resolve("research-source");
    const briefDir = join(source.path, "development-briefs");
    mkdirSync(briefDir, { recursive: true });
    const content = "# Build brief\n\nShip the approved tool.\n";
    writeFileSync(join(briefDir, "tool.md"), content);

    const handoff = manager.createFromBrief("build-tool", "research-source/development-briefs/tool.md");

    expect(readFileSync(join(handoff.workspace.path, "BRIEF.md"), "utf-8")).toBe(content);
    expect(statSync(join(handoff.workspace.path, "BRIEF.md")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(handoff.workspace.path, ".courier", "handoff.json"), "utf-8"))).toMatchObject({
      version: 1,
      sourceWorkspace: "research-source",
      sourcePath: "development-briefs/tool.md",
      sourceSha256: handoff.sourceSha256,
    });
    expect(handoff.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: handoff.workspace.path, encoding: "utf-8" })).toBe("");
  });

  it("exports an exact managed-workspace commit as an immutable reference", () => {
    const manager = new WorkspaceManager(root, {}, store);
    const source = manager.resolve("source-project");
    writeFileSync(join(source.path, "contract.txt"), "version one\n");
    execFileSync("git", ["add", "contract.txt"], { cwd: source.path });
    execFileSync("git", ["commit", "-m", "Add contract"], { cwd: source.path });
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source.path, encoding: "utf-8" }).trim();
    const target = manager.resolve("target-project");
    const cacheRoot = join(state, "references");
    const targetRoot = join(cacheRoot, target.name);
    mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
    chmodSync(targetRoot, 0o700);

    const snapshot = manager.createReferenceSnapshot(target, `source-project@${revision.slice(0, 12)}`, cacheRoot);

    try {
      expect(snapshot.revision).toBe(revision);
      expect(snapshot.guestPath).toBe(`/references/source-project-${revision.slice(0, 12)}`);
      expect(statSync(targetRoot).mode & 0o777).toBe(0o755);
      expect(readFileSync(join(snapshot.hostPath, "contract.txt"), "utf-8")).toBe("version one\n");
      expect(statSync(join(snapshot.hostPath, "contract.txt")).mode & 0o222).toBe(0);
      expect(() => manager.createReferenceSnapshot(target, "source-project@deadbee", join(state, "references")))
        .toThrow(/not available locally/);
    } finally {
      // The production cache intentionally remains immutable. Restore only
      // this test-owned fixture so a non-root CI runner can remove its tempdir.
      chmodSync(snapshot.hostPath, 0o755);
      chmodSync(join(snapshot.hostPath, "contract.txt"), 0o644);
    }
  });

  it("rejects unsafe or oversized brief references without creating a target", () => {
    const manager = new WorkspaceManager(root, {}, store);
    const source = manager.resolve("research-source");
    const briefDir = join(source.path, "development-briefs");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(join(source.path, "outside.md"), "outside");
    symlinkSync("../outside.md", join(briefDir, "linked.md"));
    writeFileSync(join(briefDir, "large.md"), Buffer.alloc(256 * 1024 + 1));

    expect(() => manager.createFromBrief("traversal", "research-source/development-briefs/../outside.md")).toThrow(/beneath/);
    expect(() => manager.createFromBrief("symlink", "research-source/development-briefs/linked.md")).toThrow(/escapes/);
    expect(() => manager.createFromBrief("oversized", "research-source/development-briefs/large.md")).toThrow(/exceeds/);
    expect(() => manager.createFromBrief("absolute", "/research-source/development-briefs/large.md")).toThrow(/must be/);
    expect(() => manager.createFromBrief("external", "repo:starbug/development-briefs/brief.md")).toThrow(/must match/);
    for (const target of ["traversal", "symlink", "oversized", "absolute", "external"]) {
      expect(() => statSync(join(root, target))).toThrow();
      expect(store.getWorkspace(target)).toBeUndefined();
    }
  });

  it("refuses to overwrite an existing handoff target", () => {
    const manager = new WorkspaceManager(root, {}, store);
    const source = manager.resolve("research-source");
    const briefDir = join(source.path, "development-briefs");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(join(briefDir, "tool.md"), "approved\n");
    manager.resolve("existing-target");

    expect(() => manager.createFromBrief("existing-target", "research-source/development-briefs/tool.md")).toThrow(/already exists/);
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
