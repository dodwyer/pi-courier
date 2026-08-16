import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExternalWorkspaceConfig } from "../types.js";
import type { StateStore, WorkspaceRecord } from "./state-store.js";

const WORKSPACE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

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

  private resolveExternal(name: string): WorkspaceRecord {
    const alias = name.slice("repo:".length);
    const config = this.external[alias];
    if (!config) throw new Error(`Unknown external workspace ${name}`);
    const workspacePath = path.resolve(config.path);
    if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) {
      throw new Error(`External workspace ${name} is unavailable at ${workspacePath}`);
    }
    this.store.upsertWorkspace({ name, path: workspacePath, kind: "external" });
    return this.store.getWorkspace(name)!;
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
