#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import { ActivityRenderer } from "./activity-renderer.js";

const socketPath = process.env.PI_COURIER_SOCKET ?? "/run/omp-courier/control.sock";

interface ControlResponse {
  ok: boolean;
  error?: string;
  activity?: {
    frame?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

async function request(command: Record<string, unknown>, renderer?: ActivityRenderer): Promise<ControlResponse[]> {
  return new Promise((resolve, reject) => {
    const responses: ControlResponse[] = [];
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf-8");
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const response = JSON.parse(line) as ControlResponse;
        if (!response.ok) {
          socket.destroy();
          reject(new Error(response.error ?? "Courier control request failed"));
          return;
        }
        responses.push(response);
        renderer?.render(response);
      }
    });
    socket.once("end", () => {
      renderer?.flush();
      resolve(responses);
    });
    if (renderer) {
      process.once("SIGINT", () => {
        renderer.flush();
        socket.end();
        resolve(responses);
      });
    }
  });
}

async function main(): Promise<void> {
  const [command, workspace, ...rest] = process.argv.slice(2);
  if (command === "env") {
    await environmentCommand(workspace, rest);
    return;
  }
  if (command === "reference") {
    if (workspace !== "add" || rest.length !== 2) {
      throw new Error("Usage: courierctl reference add <workspace> <source-workspace>@<git-commit>");
    }
    const [target, reference] = rest;
    const [response] = await request({ command: "reference-add", workspace: target, reference });
    console.log(JSON.stringify(response.reference, null, 2));
    return;
  }
  switch (command) {
    case "list": {
      const [response] = await request({ command: "list" });
      const workspaces = response.workspaces as Array<Record<string, unknown>>;
      for (const item of workspaces) {
        console.log(`${item.name}\t${item.activeThreadKey ? "active" : "idle"}\t${item.path}`);
      }
      return;
    }
    case "status":
      console.log(JSON.stringify((await request({ command: "status", workspace }))[0], null, 2));
      return;
    case "adopt":
      console.log(JSON.stringify((await request({ command: "adopt", workspace }))[0], null, 2));
      return;
    case "watch":
      if (!workspace || rest.some((argument) => argument !== "--raw")) {
        throw new Error("Usage: courierctl watch <workspace> [--raw]");
      }
      console.log(`Watching ${workspace}. Press Ctrl+C to stop.\n`);
      await request({ command: "watch", workspace }, new ActivityRenderer({ raw: rest.includes("--raw") }));
      return;
    case "attach":
      await attach(workspace, rest.includes("--abort"));
      return;
    case "resume": {
      if (!workspace || rest.length === 0) throw new Error("Usage: courierctl resume <workspace> <message...>");
      await request({ command: "resume", workspace, message: rest.join(" ") });
      console.log(`Run resumed for ${workspace}. Progress and usage updates will be posted to its Matrix thread.`);
      return;
    }
    case "migrate": {
      if (!workspace || rest.length) throw new Error("Usage: courierctl migrate <workspace>");
      await request({ command: "migrate", workspace });
      console.log(`Workflow contract migrated for ${workspace}. The reconciliation gate is running in Matrix.`);
      return;
    }
    case "artifacts": {
      if (!workspace || rest.length) throw new Error("Usage: courierctl artifacts <workspace>");
      const [response] = await request({ command: "audit-artifacts", workspace });
      const violations = response.violations as Array<{ path: string; reason: string; detail: string }>;
      if (!violations.length) {
        console.log(`Artifact policy passed for ${workspace}.`);
        return;
      }
      for (const violation of violations) console.log(`${violation.reason}\t${violation.path}\t${violation.detail}`);
      process.exitCode = 1;
      return;
    }
    default:
      usage();
      process.exitCode = 2;
  }
}

async function attach(workspace: string | undefined, abort: boolean): Promise<void> {
  if (!workspace) throw new Error("Usage: courierctl attach <workspace> [--abort]");
  const [response] = await request({ command: "lease", workspace, abort });
  const thread = response.thread as Record<string, unknown>;
  const profile = response.profile as { tools?: string[]; approvalMode?: string; model?: string; configFiles?: string[] } | undefined;
  const references = response.references as Array<{ hostPath?: string }> | undefined;
  const cliPath = String(response.ompCliPath ?? "omp");
  const args = [
    "--profile", String(thread.profile),
    "--cwd", String(thread.workspacePath),
    "--session-dir", String(thread.sessionDir),
    ...(thread.sessionFile ? ["--resume", String(thread.sessionFile)] : []),
    ...(profile?.approvalMode ? ["--approval-mode", profile.approvalMode] : []),
    ...(profile?.tools?.length ? ["--tools", profile.tools.join(",")] : []),
    ...(profile?.model ? ["--model", profile.model] : []),
    ...((profile?.configFiles ?? []).flatMap((file) => ["--config", file])),
    ...((references ?? []).flatMap((reference) => reference.hostPath ? ["--add-dir", reference.hostPath] : [])),
  ];
  const env = { ...process.env };
  const runtimeEnvironment = response.runtimeEnvironment as Record<string, string> | undefined;
  Object.assign(env, runtimeEnvironment ?? {});
  const authBroker = response.authBroker as { url?: string; tokenFile?: string } | undefined;
  if (authBroker?.url && authBroker.tokenFile) {
    env.OMP_AUTH_BROKER_URL = authBroker.url;
    env.OMP_AUTH_BROKER_TOKEN = fs.readFileSync(authBroker.tokenFile, "utf-8").trim();
  }
  console.log(`Opening native OMP for ${workspace}. Matrix ownership is paused until exit.`);
  console.log("Readable Matrix progress and ten-minute usage reports are disabled while attached. Exit with Ctrl+D, then use courierctl resume for a Matrix-visible run.");
  try {
    const result = spawnSync(cliPath, args, { cwd: String(thread.workspacePath), env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } finally {
    await request({ command: "release", workspace });
  }
}

async function environmentCommand(action: string | undefined, args: string[]): Promise<void> {
  const [workspace, ...rest] = args;
  switch (action) {
    case "list": {
      if (args.length) throw new Error("Usage: courierctl env list");
      const [response] = await request({ command: "env-list" });
      const environments = response.environments as Array<Record<string, unknown>>;
      if (!environments.length) {
        console.log("No isolated workspace environments exist.");
        return;
      }
      for (const environment of environments) {
        console.log(`${environment.workspace}\t${environment.state}\t${environment.instance}\t${environment.runtime}`);
      }
      return;
    }
    case "status":
    case "start":
    case "stop": {
      if (!workspace || rest.length) throw new Error(`Usage: courierctl env ${action} <workspace>`);
      const [response] = await request({ command: `env-${action}`, workspace });
      console.log(JSON.stringify(response.environment, null, 2));
      return;
    }
    case "shell": {
      if (!workspace || rest.length) throw new Error("Usage: courierctl env shell <workspace>");
      const [response] = await request({ command: "env-shell", workspace });
      const shell = response.shell as { command: string; args: string[]; env?: Record<string, string> };
      console.log(`Opening ${workspace}'s isolated VM. Exit the shell to return it to the stopped state.`);
      try {
        const result = spawnSync(shell.command, shell.args, { env: { ...process.env, ...(shell.env ?? {}) }, stdio: "inherit" });
        if (result.error) throw result.error;
        if (result.status !== 0) process.exitCode = result.status ?? 1;
      } finally {
        await request({ command: "env-stop", workspace });
      }
      return;
    }
    case "rebuild":
    case "destroy": {
      if (!workspace || rest.length !== 2 || rest[0] !== "--confirm") {
        throw new Error(`Usage: courierctl env ${action} <workspace> --confirm <workspace>`);
      }
      const [response] = await request({ command: `env-${action}`, workspace, confirmation: rest[1] });
      if (action === "rebuild") console.log(JSON.stringify(response.environment, null, 2));
      else console.log(`Destroyed ${workspace}'s VM. Workspace files were retained.`);
      return;
    }
    case "tunnel-command": {
      if (!workspace || rest.length < 1 || rest.length > 2) {
        throw new Error("Usage: courierctl env tunnel-command <workspace> <guest-port> [local-port]");
      }
      const guestPort = parsePort(rest[0]);
      const localPort = rest[1] ? parsePort(rest[1]) : guestPort;
      const [response] = await request({ command: "env-tunnel-command", workspace, guestPort, localPort });
      console.log(String(response.tunnelCommand));
      return;
    }
    default:
      usage();
      process.exitCode = 2;
  }
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ports must be integers between 1 and 65535");
  return port;
}

function usage(): void {
  console.log([
    "Usage:",
    "  courierctl list | status <workspace> | watch <workspace> [--raw]",
    "  courierctl resume <workspace> <message...> | attach <workspace> [--abort] | adopt <workspace>",
    "  courierctl migrate <workspace> | artifacts <workspace>",
    "  courierctl reference add <workspace> <source-workspace>@<git-commit>",
    "  courierctl env list",
    "  courierctl env status|start|shell|stop <workspace>",
    "  courierctl env rebuild|destroy <workspace> --confirm <workspace>",
    "  courierctl env tunnel-command <workspace> <guest-port> [local-port]",
  ].join("\n"));
}

main().catch((err) => {
  console.error(`courierctl: ${(err as Error).message}`);
  process.exit(1);
});
