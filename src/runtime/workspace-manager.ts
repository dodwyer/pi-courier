import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExternalWorkspaceConfig } from "../types.js";
import type { StateStore, WorkspaceRecord } from "./state-store.js";

const WORKSPACE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const GIT_REVISION = /^[a-f0-9]{7,40}$/i;
const MAX_BRIEF_BYTES = 256 * 1024;

export interface BriefHandoff {
  workspace: WorkspaceRecord;
  sourceWorkspace: string;
  sourcePath: string;
  sourceSha256: string;
}

export interface WorkspaceReferenceSnapshot {
  sourceWorkspace: string;
  revision: string;
  hostPath: string;
  guestPath: string;
}

export class WorkspaceManager {
  constructor(
    private readonly root: string,
    private readonly external: Record<string, ExternalWorkspaceConfig>,
    private readonly store: StateStore,
  ) {
    fs.mkdirSync(root, { recursive: true, mode: 0o750 });
    for (const [alias, config] of Object.entries(external)) {
      this.store.upsertWorkspace({ name: `repo:${alias}`, path: path.resolve(config.path), kind: "external" });
    }
  }

  resolve(name: string, create = true): WorkspaceRecord {
    if (name.startsWith("repo:")) return this.resolveExternal(name);
    validateWorkspaceName(name);
    const workspacePath = path.resolve(this.root, name);
    const relative = path.relative(path.resolve(this.root), workspacePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Workspace path escapes workspaceRoot");

    const metadataPath = path.join(workspacePath, ".courier", "workspace.json");
    if (!fs.existsSync(workspacePath)) {
      if (!create) throw new Error(`Workspace ${name} does not exist`);
      this.initialize(name, workspacePath, metadataPath);
    } else if (!fs.existsSync(metadataPath)) {
      throw new Error(`Refusing unmanaged directory ${workspacePath}; run courierctl adopt ${name}`);
    }

    this.store.upsertWorkspace({ name, path: workspacePath, kind: "managed" });
    return this.store.getWorkspace(name)!;
  }

  adopt(name: string): WorkspaceRecord {
    validateWorkspaceName(name);
    const workspacePath = path.resolve(this.root, name);
    if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) {
      throw new Error(`Cannot adopt missing directory ${workspacePath}`);
    }
    const metadataDir = path.join(workspacePath, ".courier");
    const metadataPath = path.join(metadataDir, "workspace.json");
    fs.mkdirSync(metadataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(metadataPath, `${JSON.stringify({ version: 1, name, adoptedAt: new Date().toISOString() }, null, 2)}\n`, {
      mode: 0o600,
    });
    ensureGitIgnore(workspacePath);
    if (!fs.existsSync(path.join(workspacePath, ".git"))) execFileSync("git", ["init", "-b", "main"], { cwd: workspacePath });
    this.store.upsertWorkspace({ name, path: workspacePath, kind: "managed" });
    return this.store.getWorkspace(name)!;
  }

  createFromBrief(targetName: string, reference: string): BriefHandoff {
    validateWorkspaceName(targetName);
    const snapshot = this.readBrief(reference);
    const workspacePath = path.resolve(this.root, targetName);
    const relative = path.relative(path.resolve(this.root), workspacePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Workspace path escapes workspaceRoot");
    if (fs.existsSync(workspacePath) || this.store.getWorkspace(targetName)) {
      throw new Error(`Brief handoff target ${targetName} already exists`);
    }

    const metadataPath = path.join(workspacePath, ".courier", "workspace.json");
    try {
      this.initialize(targetName, workspacePath, metadataPath);
      fs.writeFileSync(path.join(workspacePath, "BRIEF.md"), snapshot.content, { mode: 0o600 });
      fs.writeFileSync(
        path.join(workspacePath, ".courier", "handoff.json"),
        `${JSON.stringify({
          version: 1,
          sourceWorkspace: snapshot.sourceWorkspace,
          sourcePath: snapshot.sourcePath,
          sourceSha256: snapshot.sourceSha256,
          copiedAt: new Date().toISOString(),
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
      execFileSync("git", ["add", "BRIEF.md"], { cwd: workspacePath });
      execFileSync("git", ["commit", "-m", "Import approved development brief"], { cwd: workspacePath });
      this.store.upsertWorkspace({ name: targetName, path: workspacePath, kind: "managed" });
      return {
        workspace: this.store.getWorkspace(targetName)!,
        sourceWorkspace: snapshot.sourceWorkspace,
        sourcePath: snapshot.sourcePath,
        sourceSha256: snapshot.sourceSha256,
      };
    } catch (err) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      this.store.deleteWorkspace(targetName);
      throw err;
    }
  }

  rollbackCreatedWorkspace(workspace: WorkspaceRecord): void {
    const expectedPath = path.resolve(this.root, workspace.name);
    if (workspace.kind !== "managed" || workspace.path !== expectedPath) {
      throw new Error(`Refusing to remove non-handoff workspace ${workspace.name}`);
    }
    const current = this.store.getWorkspace(workspace.name);
    if (current?.activeThreadKey) throw new Error(`Workspace ${workspace.name} is still active`);
    const metadataPath = path.join(expectedPath, ".courier", "workspace.json");
    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as { name?: string };
      if (metadata.name !== workspace.name) throw new Error(`Workspace metadata mismatch for ${workspace.name}`);
    }
    fs.rmSync(expectedPath, { recursive: true, force: true });
    this.store.deleteWorkspace(workspace.name);
  }

  createReferenceSnapshot(
    target: WorkspaceRecord,
    specification: string,
    cacheRoot: string,
  ): WorkspaceReferenceSnapshot {
    if (target.kind !== "managed") throw new Error("References can only be attached to managed workspaces");
    const separator = specification.lastIndexOf("@");
    if (separator <= 0 || separator === specification.length - 1) {
      throw new Error("Reference must be <managed-workspace>@<git-commit>");
    }
    const sourceName = specification.slice(0, separator);
    const requestedRevision = specification.slice(separator + 1);
    validateWorkspaceName(sourceName);
    if (!GIT_REVISION.test(requestedRevision)) throw new Error("Reference revision must be a 7-40 character Git commit ID");
    if (sourceName === target.name) throw new Error("A workspace cannot reference itself");
    const source = this.resolve(sourceName, false);
    if (source.kind !== "managed" || !fs.existsSync(path.join(source.path, ".git"))) {
      throw new Error(`Reference source ${sourceName} must be a managed Git workspace`);
    }
    const gitArgs = ["-c", `safe.directory=${source.path}`];
    let revision: string;
    try {
      revision = execFileSync("git", [...gitArgs, "rev-parse", "--verify", `${requestedRevision}^{commit}`], {
        cwd: source.path,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      throw new Error(`Reference ${sourceName}@${requestedRevision} is not available locally`);
    }
    const targetRoot = path.resolve(cacheRoot, target.name);
    const hostPath = path.join(targetRoot, `${sourceName}-${revision}`);
    const guestPath = `/references/${sourceName}-${revision.slice(0, 12)}`;
    if (!fs.existsSync(hostPath)) {
      fs.mkdirSync(targetRoot, { recursive: true, mode: 0o755 });
      const temporary = path.join(targetRoot, `.snapshot-${sourceName}-${process.pid}-${Date.now()}`);
      const archive = `${temporary}.tar`;
      try {
        fs.mkdirSync(temporary, { mode: 0o700 });
        execFileSync("git", [...gitArgs, "archive", "--format=tar", `--output=${archive}`, revision], {
          cwd: source.path,
          stdio: ["ignore", "pipe", "pipe"],
        });
        execFileSync("tar", ["-xf", archive, "-C", temporary]);
        makeReferenceReadOnly(temporary);
        fs.renameSync(temporary, hostPath);
      } catch (error) {
        fs.rmSync(temporary, { recursive: true, force: true });
        throw new Error(`Could not create immutable reference ${sourceName}@${revision.slice(0, 12)}: ${(error as Error).message}`);
      } finally {
        fs.rmSync(archive, { force: true });
      }
    }
    return { sourceWorkspace: sourceName, revision, hostPath, guestPath };
  }

  private resolveExternal(name: string): WorkspaceRecord {
    const alias = name.slice("repo:".length);
    const config = this.external[alias];
    if (!config) throw new Error(`Unknown external workspace ${name}`);
    const workspacePath = path.resolve(config.path);
    if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) {
      throw new Error(`External workspace ${name} is unavailable at ${workspacePath}`);
    }
    ensureLocalGitExclude(workspacePath);
    this.store.upsertWorkspace({ name, path: workspacePath, kind: "external" });
    return this.store.getWorkspace(name)!;
  }

  private readBrief(reference: string): {
    sourceWorkspace: string;
    sourcePath: string;
    sourceSha256: string;
    content: Buffer;
  } {
    if (!reference || reference.includes("\\") || path.posix.isAbsolute(reference)) {
      throw new Error("Brief reference must be <workspace>/development-briefs/<brief>.md");
    }
    const separator = reference.indexOf("/");
    if (separator <= 0) throw new Error("Brief reference must be <workspace>/development-briefs/<brief>.md");
    const sourceWorkspace = reference.slice(0, separator);
    const sourcePath = reference.slice(separator + 1);
    validateWorkspaceName(sourceWorkspace);
    if (
      path.posix.normalize(sourcePath) !== sourcePath
      || !sourcePath.startsWith("development-briefs/")
      || sourcePath === "development-briefs/"
      || path.posix.extname(sourcePath) !== ".md"
    ) {
      throw new Error("Brief must be a Markdown file beneath development-briefs");
    }

    const source = this.resolve(sourceWorkspace, false);
    if (source.kind !== "managed") throw new Error("Brief source must be a managed Courier workspace");
    const sourceRoot = fs.realpathSync(source.path);
    let briefRoot: string;
    try {
      briefRoot = fs.realpathSync(path.join(source.path, "development-briefs"));
    } catch {
      throw new Error(`Development brief ${reference} does not exist`);
    }
    const briefRootRelative = path.relative(sourceRoot, briefRoot);
    if (!briefRootRelative || briefRootRelative.startsWith("..") || path.isAbsolute(briefRootRelative)) {
      throw new Error("development-briefs must be a directory inside the source workspace");
    }
    const candidate = path.resolve(source.path, ...sourcePath.split("/"));
    let realCandidate: string;
    try {
      realCandidate = fs.realpathSync(candidate);
    } catch {
      throw new Error(`Development brief ${reference} does not exist`);
    }
    const relative = path.relative(briefRoot, realCandidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Brief path escapes development-briefs");
    }

    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) throw new Error("Development brief must be a regular file");
      if (stat.size > MAX_BRIEF_BYTES) throw new Error(`Development brief exceeds ${MAX_BRIEF_BYTES} bytes`);
      const content = fs.readFileSync(descriptor);
      return {
        sourceWorkspace,
        sourcePath,
        sourceSha256: createHash("sha256").update(content).digest("hex"),
        content,
      };
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  private initialize(name: string, workspacePath: string, metadataPath: string): void {
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(metadataPath, `${JSON.stringify({ version: 1, name, createdAt: new Date().toISOString() }, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(workspacePath, "README.md"), `# ${name}\n\nWorkspace managed by OMP Courier.\n`, { mode: 0o640 });
    fs.writeFileSync(path.join(workspacePath, ".gitignore"), ".courier/\n", { mode: 0o640 });
    execFileSync("git", ["init", "-b", "main"], { cwd: workspacePath });
    execFileSync("git", ["config", "user.name", "OMP Courier"], { cwd: workspacePath });
    execFileSync("git", ["config", "user.email", "omp-courier@localhost"], { cwd: workspacePath });
    execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: workspacePath });
    execFileSync("git", ["commit", "-m", "Initialize OMP workspace"], { cwd: workspacePath });
  }
}

export function validateWorkspaceName(name: string): void {
  if (!WORKSPACE_NAME.test(name)) {
    throw new Error("Workspace name must match ^[a-z0-9][a-z0-9-]{0,62}$ (or use repo:<configured-name>)");
  }
}

function ensureGitIgnore(workspacePath: string): void {
  const ignorePath = path.join(workspacePath, ".gitignore");
  const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf-8") : "";
  if (existing.split(/\r?\n/).includes(".courier/")) return;
  fs.appendFileSync(ignorePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}.courier/\n`, { mode: 0o640 });
}

function ensureLocalGitExclude(workspacePath: string): void {
  let excludePath: string;
  try {
    const gitPath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: workspacePath,
      encoding: "utf-8",
    }).trim();
    excludePath = path.resolve(workspacePath, gitPath);
  } catch {
    return;
  }
  fs.mkdirSync(path.dirname(excludePath), { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf-8") : "";
  if (existing.split(/\r?\n/).includes(".courier/")) return;
  fs.appendFileSync(excludePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}.courier/\n`, { mode: 0o600 });
}

function makeReferenceReadOnly(root: string): void {
  const visit = (target: string): void => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(target);
      const resolved = path.resolve(path.dirname(target), link);
      const relative = path.relative(root, resolved);
      if (path.isAbsolute(link) || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`reference contains an escaping symbolic link at ${path.relative(root, target)}`);
      }
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) visit(path.join(target, entry));
      fs.chmodSync(target, 0o555);
      return;
    }
    if (stat.isFile()) fs.chmodSync(target, stat.mode & 0o111 ? 0o555 : 0o444);
  };
  visit(root);
}
