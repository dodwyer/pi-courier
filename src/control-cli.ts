#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";

const socketPath = process.env.PI_COURIER_SOCKET ?? "/run/omp-courier/control.sock";

interface ControlResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function request(command: Record<string, unknown>, stream = false): Promise<ControlResponse[]> {
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
        if (stream) renderActivity(response);
      }
    });
    socket.once("end", () => resolve(responses));
    if (stream) {
      process.once("SIGINT", () => {
        socket.end();
        resolve(responses);
      });
    }
  });
}

async function main(): Promise<void> {
  const [command, workspace, ...rest] = process.argv.slice(2);
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
      console.log(`Watching ${workspace}. Press Ctrl+C to stop.\n`);
      await request({ command: "watch", workspace }, true);
      return;
    case "attach":
      await attach(workspace, rest.includes("--abort"));
      return;
    default:
      console.log("Usage: courierctl list | status <workspace> | watch <workspace> | attach <workspace> [--abort] | adopt <workspace>");
      process.exitCode = 2;
  }
}

async function attach(workspace: string | undefined, abort: boolean): Promise<void> {
  if (!workspace) throw new Error("Usage: courierctl attach <workspace> [--abort]");
  const [response] = await request({ command: "lease", workspace, abort });
  const thread = response.thread as Record<string, unknown>;
  const profile = response.profile as { tools?: string[]; approvalMode?: string; model?: string; configFiles?: string[] } | undefined;
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
  ];
  const env = { ...process.env };
  const authBroker = response.authBroker as { url?: string; tokenFile?: string } | undefined;
  if (authBroker?.url && authBroker.tokenFile) {
    env.OMP_AUTH_BROKER_URL = authBroker.url;
    env.OMP_AUTH_BROKER_TOKEN = fs.readFileSync(authBroker.tokenFile, "utf-8").trim();
  }
  console.log(`Opening native OMP for ${workspace}. Matrix ownership is paused until exit.`);
  try {
    const result = spawnSync(cliPath, args, { cwd: String(thread.workspacePath), env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } finally {
    await request({ command: "release", workspace });
  }
}

function renderActivity(response: ControlResponse): void {
  const activity = response.activity as { frame?: Record<string, unknown> } | undefined;
  const frame = activity?.frame;
  if (!frame) return;
  switch (frame.type) {
    case "message_update": {
      const event = frame.assistantMessageEvent as Record<string, unknown> | undefined;
      const delta = event?.delta ?? event?.text ?? event?.thinking;
      if (delta) process.stdout.write(String(delta));
      return;
    }
    case "tool_execution_start":
      process.stdout.write(`\n\x1b[36m🔧 ${String(frame.toolName ?? "tool")}\x1b[0m\n`);
      return;
    case "tool_execution_end":
      process.stdout.write(`\x1b[2m${frame.isError ? "tool failed" : "tool complete"}\x1b[0m\n`);
      return;
    case "turn_start":
      process.stdout.write("\n\x1b[1mOMP\x1b[0m\n");
      return;
    case "turn_end":
    case "agent_end":
      process.stdout.write("\n");
      return;
    case "process_stderr":
      process.stderr.write(`\x1b[33m${String(frame.message)}\x1b[0m\n`);
  }
}

main().catch((err) => {
  console.error(`courierctl: ${(err as Error).message}`);
  process.exit(1);
});
