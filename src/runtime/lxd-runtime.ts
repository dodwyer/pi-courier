import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { LxdVmRuntimeConfig, MsgBridgeConfig, OmpProfileConfig } from "../types.js";
import type { WorkspaceRecord } from "./state-store.js";

function execFileClosedStdin(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    // LXC can prompt on missing trust or authorization. Courier is unattended:
    // EOF turns that into a visible failure instead of an indefinitely hung run.
    child.stdin?.end();
  });
}

interface LxdInstance {
  name: string;
  status?: string;
  status_code?: number;
  config?: Record<string, string>;
  state?: {
    network?: Record<string, { addresses?: Array<{ family?: string; address?: string; scope?: string }> }>;
  };
}

export interface RuntimeEnvironmentStatus {
  runtime: string;
  workspace: string;
  instance: string;
  state: "missing" | "running" | "stopped" | "unknown";
  guestWorkspace: string;
  address?: string;
}

export interface RuntimeShellCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Owns persistent, idle-stopped LXD VMs while OMP itself remains on the host. */
export class LxdRuntimeManager {
  constructor(private readonly config: MsgBridgeConfig) {}

  async ensure(profile: OmpProfileConfig, workspace: WorkspaceRecord): Promise<NodeJS.ProcessEnv> {
    const resolved = this.resolveProfileRuntime(profile, workspace);
    if (!resolved) return {};
    const { name, runtime } = resolved;
    const instance = runtimeInstanceName(workspace.name, workspace.path);
    const instances = await this.instances(runtime);
    let current = instances.find((candidate) => candidate.name === instance);
    if (!current) {
      await this.run(runtime, [
        "init",
        `${runtime.remote}:${runtime.image}`,
        `${runtime.remote}:${instance}`,
        "--project", runtime.project,
        "--vm",
        ...(runtime.profile ? ["--profile", runtime.profile] : []),
      ]);
      try {
        await this.run(runtime, [
          "config", "device", "add", `${runtime.remote}:${instance}`, "workspace", "disk",
          `source=${workspace.path}`,
          `path=${runtime.guestWorkspace ?? "/workspace"}`,
          "--project", runtime.project,
        ]);
        await this.run(runtime, [
          "config", "set", `${runtime.remote}:${instance}`,
          `user.courier.workspace=${workspace.name}`,
          `user.courier.workspace_path_sha256=${createHash("sha256").update(workspace.path).digest("hex")}`,
          "--project", runtime.project,
        ]);
      } catch (error) {
        await this.run(runtime, ["delete", `${runtime.remote}:${instance}`, "--project", runtime.project]).catch(() => {});
        throw error;
      }
      current = { name: instance, status: "Stopped" };
    }
    if (!isRunning(current)) {
      const running = instances.filter(isRunning).length;
      if (running >= (runtime.maxRunning ?? 3)) {
        throw new Error(`Runtime ${name} already has its maximum of ${runtime.maxRunning ?? 3} running VMs`);
      }
      await this.run(runtime, ["start", `${runtime.remote}:${instance}`, "--project", runtime.project]);
      await this.waitReady(runtime, instance);
    }
    return runtimeEnvironment(name, runtime, workspace, instance);
  }

  async stop(profile: OmpProfileConfig, workspace: WorkspaceRecord): Promise<void> {
    const resolved = this.resolveProfileRuntime(profile, workspace);
    if (!resolved) return;
    const instance = runtimeInstanceName(workspace.name, workspace.path);
    const current = (await this.instances(resolved.runtime)).find((candidate) => candidate.name === instance);
    if (current && isRunning(current)) {
      await this.run(resolved.runtime, ["stop", `${resolved.runtime.remote}:${instance}`, "--project", resolved.runtime.project]);
    }
  }

  async list(): Promise<RuntimeEnvironmentStatus[]> {
    const statuses: RuntimeEnvironmentStatus[] = [];
    for (const [runtimeName, runtime] of Object.entries(this.config.runtimes ?? {})) {
      for (const instance of await this.instances(runtime)) {
        const workspace = instance.config?.["user.courier.workspace"];
        if (!workspace) continue;
        statuses.push(toStatus(runtimeName, runtime, workspace, instance));
      }
    }
    return statuses.sort((a, b) => a.workspace.localeCompare(b.workspace));
  }

  async status(profile: OmpProfileConfig, workspace: WorkspaceRecord): Promise<RuntimeEnvironmentStatus | undefined> {
    const resolved = this.resolveProfileRuntime(profile, workspace);
    if (!resolved) return undefined;
    const instanceName = runtimeInstanceName(workspace.name, workspace.path);
    const instance = (await this.instances(resolved.runtime)).find((candidate) => candidate.name === instanceName);
    return instance
      ? toStatus(resolved.name, resolved.runtime, workspace.name, instance)
      : {
          runtime: resolved.name,
          workspace: workspace.name,
          instance: instanceName,
          state: "missing",
          guestWorkspace: resolved.runtime.guestWorkspace ?? "/workspace",
        };
  }

  async rebuild(profile: OmpProfileConfig, workspace: WorkspaceRecord): Promise<RuntimeEnvironmentStatus> {
    await this.destroy(profile, workspace);
    await this.ensure(profile, workspace);
    return (await this.status(profile, workspace))!;
  }

  async destroy(profile: OmpProfileConfig, workspace: WorkspaceRecord): Promise<void> {
    const resolved = this.requiredProfileRuntime(profile, workspace);
    const instance = runtimeInstanceName(workspace.name, workspace.path);
    const current = (await this.instances(resolved.runtime)).find((candidate) => candidate.name === instance);
    if (current) {
      await this.run(resolved.runtime, ["delete", `${resolved.runtime.remote}:${instance}`, "--project", resolved.runtime.project, "--force"]);
    }
  }

  async shellCommand(profile: OmpProfileConfig, workspace: WorkspaceRecord): Promise<RuntimeShellCommand> {
    const environment = await this.ensure(profile, workspace);
    const resolved = this.requiredProfileRuntime(profile, workspace);
    const instance = runtimeInstanceName(workspace.name, workspace.path);
    return {
      command: resolved.runtime.commandPath ?? "lxc",
      args: execPrefix(resolved.runtime, instance, true),
      env: { ...process.env, ...environment },
    };
  }

  async tunnelCommand(profile: OmpProfileConfig, workspace: WorkspaceRecord, guestPort: number, localPort = guestPort): Promise<string> {
    const resolved = this.requiredProfileRuntime(profile, workspace);
    if (!validPort(guestPort) || !validPort(localPort)) throw new Error("ports must be integers between 1 and 65535");
    const status = await this.status(profile, workspace);
    if (status?.state !== "running" || !status.address) {
      throw new Error(`Environment ${workspace.name} must be running with an IPv4 address; run courierctl env start ${workspace.name}`);
    }
    const identity = resolved.runtime.sshIdentityFile ? ` -i ${shellQuote(resolved.runtime.sshIdentityFile)}` : "";
    return `ssh -N -o ExitOnForwardFailure=yes${identity} -L ${localPort}:127.0.0.1:${guestPort} ${shellQuote(`${resolved.runtime.sshUser ?? "developer"}@${status.address}`)}`;
  }

  profileRuntime(profile: OmpProfileConfig, workspace: WorkspaceRecord): { name: string; runtime: LxdVmRuntimeConfig } | undefined {
    return this.resolveProfileRuntime(profile, workspace);
  }

  private resolveProfileRuntime(profile: OmpProfileConfig, workspace: WorkspaceRecord): { name: string; runtime: LxdVmRuntimeConfig } | undefined {
    if (!profile.runtime) return undefined;
    if (workspace.kind !== "managed") {
      throw new Error(`Profile runtime ${profile.runtime} is limited to managed workspaces; use a host profile for ${workspace.name}`);
    }
    const root = path.resolve(this.config.workspaceRoot ?? "/srv/threads");
    const expected = path.join(root, workspace.name);
    if (path.resolve(workspace.path) !== expected) throw new Error(`Managed workspace ${workspace.name} is outside workspaceRoot`);
    const runtime = this.config.runtimes?.[profile.runtime];
    if (!runtime) throw new Error(`Unknown execution runtime ${profile.runtime}`);
    if (runtime.type !== "lxd-vm") throw new Error(`Unsupported execution runtime type ${(runtime as { type?: string }).type}`);
    return { name: profile.runtime, runtime };
  }

  private requiredProfileRuntime(profile: OmpProfileConfig, workspace: WorkspaceRecord): { name: string; runtime: LxdVmRuntimeConfig } {
    const resolved = this.resolveProfileRuntime(profile, workspace);
    if (!resolved) throw new Error("Workspace profile does not use an isolated runtime");
    return resolved;
  }

  private async instances(runtime: LxdVmRuntimeConfig): Promise<LxdInstance[]> {
    const result = await this.run(runtime, ["list", `${runtime.remote}:`, "--project", runtime.project, "--format", "json"]);
    const parsed = JSON.parse(result.stdout || "[]") as unknown;
    if (!Array.isArray(parsed)) throw new Error(`LXD returned invalid instance inventory for project ${runtime.project}`);
    return parsed as LxdInstance[];
  }

  private async waitReady(runtime: LxdVmRuntimeConfig, instance: string): Promise<void> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await this.run(runtime, [...execPrefix(runtime, instance, false), "true"]);
        return;
      } catch (error) {
        lastError = error as Error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error(`LXD VM ${instance} did not become ready: ${lastError?.message ?? "unknown error"}`);
  }

  private async run(runtime: LxdVmRuntimeConfig, args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileClosedStdin(runtime.commandPath ?? "lxc", args);
    } catch (error) {
      const detail = error as Error & { stderr?: string };
      throw new Error(`LXD command failed: ${detail.stderr?.trim() || detail.message}`);
    }
  }
}

export function runtimeInstanceName(workspaceName: string, workspacePath: string): string {
  const slug = workspaceName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
  const digest = createHash("sha256").update(path.resolve(workspacePath)).digest("hex").slice(0, 10);
  return `omp-${slug}-${digest}`;
}

function runtimeEnvironment(
  runtimeName: string,
  runtime: LxdVmRuntimeConfig,
  workspace: WorkspaceRecord,
  instance: string,
): NodeJS.ProcessEnv {
  return {
    OMP_COURIER_RUNTIME: runtimeName,
    OMP_COURIER_LXD_COMMAND: runtime.commandPath ?? "lxc",
    OMP_COURIER_LXD_REMOTE: runtime.remote,
    OMP_COURIER_LXD_PROJECT: runtime.project,
    OMP_COURIER_LXD_INSTANCE: instance,
    OMP_COURIER_HOST_WORKSPACE: workspace.path,
    OMP_COURIER_GUEST_WORKSPACE: runtime.guestWorkspace ?? "/workspace",
    OMP_COURIER_GUEST_UID: String(runtime.user ?? 995),
    OMP_COURIER_GUEST_GID: String(runtime.group ?? 988),
  };
}

function execPrefix(runtime: LxdVmRuntimeConfig, instance: string, interactive: boolean): string[] {
  return [
    "exec", `${runtime.remote}:${instance}`,
    "--project", runtime.project,
    "--cwd", runtime.guestWorkspace ?? "/workspace",
    "--user", String(runtime.user ?? 995),
    "--group", String(runtime.group ?? 988),
    ...(interactive ? ["--mode", "interactive"] : []),
    "--", interactive ? "bash" : "sh", ...(interactive ? ["-l"] : ["-c"]),
  ];
}

function isRunning(instance: LxdInstance): boolean {
  return instance.status_code === 103 || instance.status?.toLowerCase() === "running";
}

function toStatus(runtimeName: string, runtime: LxdVmRuntimeConfig, workspace: string, instance: LxdInstance): RuntimeEnvironmentStatus {
  const state = isRunning(instance)
    ? "running"
    : instance.status?.toLowerCase() === "stopped" || instance.status_code === 102
      ? "stopped"
      : "unknown";
  return {
    runtime: runtimeName,
    workspace,
    instance: instance.name,
    state,
    guestWorkspace: runtime.guestWorkspace ?? "/workspace",
    address: instanceAddress(instance),
  };
}

function instanceAddress(instance: LxdInstance): string | undefined {
  for (const network of Object.values(instance.state?.network ?? {})) {
    const address = network.addresses?.find((candidate) => candidate.family === "inet" && candidate.scope === "global")?.address;
    if (address) return address;
  }
  return undefined;
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
