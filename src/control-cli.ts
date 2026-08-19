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
    default:
      console.log("Usage: courierctl list | status <workspace> | watch <workspace> [--raw] | resume <workspace> <message...> | attach <workspace> [--abort] | adopt <workspace>");
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
  console.log("Readable Matrix progress and ten-minute usage reports are disabled while attached. Exit with Ctrl+D, then use courierctl resume for a Matrix-visible run.");
  try {
    const result = spawnSync(cliPath, args, { cwd: String(thread.workspacePath), env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } finally {
    await request({ command: "release", workspace });
  }
}

main().catch((err) => {
  console.error(`courierctl: ${(err as Error).message}`);
  process.exit(1);
});
