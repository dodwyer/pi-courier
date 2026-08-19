import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { MsgBridgeConfig } from "../types.js";
import type { WorkerManager } from "./worker-manager.js";

interface ControlRequest {
  command?: string;
  workspace?: string;
  abort?: boolean;
  message?: string;
  confirmation?: string;
  guestPort?: number;
  localPort?: number;
}

export class ControlServer {
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly config: MsgBridgeConfig,
    private readonly workers: WorkerManager,
  ) {}

  async start(): Promise<void> {
    const socketPath = this.config.controlSocket;
    if (!socketPath) throw new Error("controlSocket is not configured");
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o755 });
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    this.server = net.createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(socketPath, () => resolve());
    });
    fs.chmodSync(socketPath, 0o660);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of this.sockets) socket.destroy();
      await closed;
    }
    this.sockets.clear();
    if (this.config.controlSocket && fs.existsSync(this.config.controlSocket)) fs.unlinkSync(this.config.controlSocket);
  }

  private handle(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf-8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void this.dispatch(socket, line);
    });
  }

  private async dispatch(socket: net.Socket, line: string): Promise<void> {
    let request: ControlRequest;
    try {
      request = JSON.parse(line) as ControlRequest;
    } catch {
      return this.respond(socket, { ok: false, error: "Invalid JSON request" });
    }
    try {
      switch (request.command) {
        case "list":
          return this.respond(socket, {
            ok: true,
            workspaces: this.workers.store.listWorkspaces(),
            threads: this.workers.store.listThreads(),
          });
        case "status": {
          const workspace = requiredWorkspace(request);
          const record = this.workers.store.getWorkspace(workspace);
          if (!record) throw new Error(`Unknown workspace ${workspace}`);
          return this.respond(socket, {
            ok: true,
            workspace: record,
            thread: record.lastThreadKey ? this.workers.store.getThread(record.lastThreadKey) : undefined,
          });
        }
        case "adopt": {
          const workspace = requiredWorkspace(request);
          return this.respond(socket, { ok: true, workspace: this.workers.workspaces.adopt(workspace) });
        }
        case "lease": {
          const workspace = requiredWorkspace(request);
          const thread = await this.workers.leaseWorkspace(workspace, request.abort === true);
          const profile = this.config.profiles?.[thread.profile];
          return this.respond(socket, {
            ok: true,
            thread,
            ompCliPath: this.config.ompCliPath,
            profile,
            authBroker: this.config.authBroker,
            runtimeEnvironment: await this.workers.runtimeEnvironment(thread),
          });
        }
        case "release": {
          const workspace = requiredWorkspace(request);
          await this.workers.releaseWorkspace(workspace);
          return this.respond(socket, { ok: true });
        }
        case "resume": {
          const workspace = requiredWorkspace(request);
          const thread = await this.workers.resumeWorkspace(workspace, request.message ?? "");
          return this.respond(socket, { ok: true, thread });
        }
        case "watch": {
          const workspace = requiredWorkspace(request);
          if (!this.workers.store.getWorkspace(workspace)) throw new Error(`Unknown workspace ${workspace}`);
          this.respond(socket, { ok: true, watching: workspace }, false);
          const unsubscribe = this.workers.onActivity((activity) => {
            if (activity.workspace === workspace && !socket.destroyed) {
              socket.write(`${JSON.stringify({ ok: true, activity })}\n`);
            }
          });
          socket.once("close", unsubscribe);
          return;
        }
        case "env-list":
          return this.respond(socket, { ok: true, environments: await this.workers.environmentList() });
        case "env-status":
          return this.respond(socket, { ok: true, environment: await this.workers.environmentStatus(requiredWorkspace(request)) });
        case "env-start":
          return this.respond(socket, { ok: true, environment: await this.workers.environmentStart(requiredWorkspace(request)) });
        case "env-stop":
          return this.respond(socket, { ok: true, environment: await this.workers.environmentStop(requiredWorkspace(request)) });
        case "env-shell": {
          const shell = await this.workers.environmentShell(requiredWorkspace(request));
          return this.respond(socket, { ok: true, shell });
        }
        case "env-rebuild": {
          const workspace = requiredWorkspace(request);
          requireConfirmation(request, workspace);
          return this.respond(socket, { ok: true, environment: await this.workers.environmentRebuild(workspace) });
        }
        case "env-destroy": {
          const workspace = requiredWorkspace(request);
          requireConfirmation(request, workspace);
          await this.workers.environmentDestroy(workspace);
          return this.respond(socket, { ok: true });
        }
        case "env-tunnel-command": {
          const workspace = requiredWorkspace(request);
          return this.respond(socket, {
            ok: true,
            tunnelCommand: await this.workers.environmentTunnelCommand(workspace, Number(request.guestPort), request.localPort),
          });
        }
        default:
          throw new Error("Unknown control command");
      }
    } catch (err) {
      this.respond(socket, { ok: false, error: (err as Error).message });
    }
  }

  private respond(socket: net.Socket, response: Record<string, unknown>, close = true): void {
    socket.write(`${JSON.stringify(response)}\n`, () => {
      if (close) socket.end();
    });
  }
}

function requireConfirmation(request: ControlRequest, workspace: string): void {
  if (request.confirmation !== workspace) {
    throw new Error(`Destructive environment action requires --confirm ${workspace}`);
  }
}

function requiredWorkspace(request: ControlRequest): string {
  if (!request.workspace) throw new Error("workspace is required");
  return request.workspace;
}
