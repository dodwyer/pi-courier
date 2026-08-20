import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArtifactPolicyConfig, MsgBridgeConfig, OmpProfileConfig } from "../types.js";

export interface WorkflowRunContract {
  schemaVersion: 2;
  profile: string;
  profileVersion: string;
  profileConfigSha256: string;
  promptBundleSha256: string;
  modelMap: Record<string, string>;
  runtime: {
    name: string;
    type: string;
    image: string;
    profile?: string;
  } | null;
  toolchainIdentity: string;
}

export interface CapturedWorkflowContract {
  hash: string;
  value: WorkflowRunContract;
  json: string;
}

export interface ArtifactViolation {
  path: string;
  reason: "forbidden-directory" | "executable" | "oversized";
  detail: string;
}

export function captureWorkflowContract(
  config: MsgBridgeConfig,
  profileName: string,
  profile: OmpProfileConfig,
): CapturedWorkflowContract | undefined {
  const workflow = profile.workflowContract;
  if (!workflow) return undefined;
  if (!workflow.version.trim()) throw new Error(`Profile ${profileName} has an empty workflow contract version`);
  if (!workflow.toolchainIdentity.trim()) throw new Error(`Profile ${profileName} has an empty toolchain identity`);

  const promptBundleSha256 = hashFiles(workflow.promptFiles, `Profile ${profileName} prompt bundle`);
  const configFileSha256 = hashFiles(profile.configFiles ?? [], `Profile ${profileName} configuration`);
  const profileConfigSha256 = sha256(stableJson({
    profile,
    configFileSha256,
  }));
  const runtime = profile.runtime ? config.runtimes?.[profile.runtime] : undefined;
  if (profile.runtime && !runtime) throw new Error(`Profile ${profileName} references unknown runtime ${profile.runtime}`);

  const value: WorkflowRunContract = {
    schemaVersion: 2,
    profile: profileName,
    profileVersion: workflow.version,
    profileConfigSha256,
    promptBundleSha256,
    modelMap: sortRecord(workflow.expectedModels),
    runtime: runtime ? {
      name: profile.runtime!,
      type: runtime.type,
      image: runtime.image,
      ...(runtime.profile ? { profile: runtime.profile } : {}),
    } : null,
    toolchainIdentity: workflow.toolchainIdentity,
  };
  const json = stableJson(value);
  return { hash: sha256(json), value, json };
}

export function auditArtifactRoot(
  workspacePath: string,
  policy: ArtifactPolicyConfig,
): ArtifactViolation[] {
  const workspace = fs.realpathSync(workspacePath);
  const root = resolveWithinWorkspace(workspace, policy.root);
  if (!fs.existsSync(root)) return [];
  const violations: ArtifactViolation[] = [];
  const forbidden = new Set(policy.forbiddenDirectories);
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(workspace, absolute);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (forbidden.has(entry.name)) {
          violations.push({ path: relative, reason: "forbidden-directory", detail: `directory name ${entry.name} is reserved for ephemeral state` });
          continue;
        }
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(absolute);
      if (stat.size > policy.maxFileBytes) {
        violations.push({ path: relative, reason: "oversized", detail: `${stat.size} bytes exceeds ${policy.maxFileBytes}` });
      }
      if (policy.forbidExecutables && (stat.mode & 0o111) !== 0) {
        violations.push({ path: relative, reason: "executable", detail: "executable files belong in the VM image or project tree" });
      }
    }
  };
  visit(root);
  return violations.sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason));
}

export function resolveWithinWorkspace(workspacePath: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error("Workflow paths must be non-empty and workspace-relative");
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, relativePath);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Workflow path escapes the workspace: ${relativePath}`);
  }
  return resolved;
}

function hashFiles(files: string[], label: string): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    let content: Buffer;
    try {
      content = fs.readFileSync(file);
    } catch (error) {
      throw new Error(`${label} cannot read ${file}: ${(error as Error).message}`);
    }
    hash.update(file);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortValue(child)]));
  }
  return value;
}

function sortRecord(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
