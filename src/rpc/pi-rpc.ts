/**
 * Direct Oh My Pi RPC process adapter.
 *
 * OMP is a compiled executable. Unlike upstream Pi's RpcClient it must be
 * spawned directly, not as `node <cliPath>`. The adapter deliberately keeps
 * the wire types local so courier releases can pin and smoke-test an OMP
 * version without taking a runtime dependency on OMP's package internals.
 */
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { logger } from "../logger.js";

export interface RpcModelInfo {
  id: string;
  provider: string;
  name?: string;
}

export interface RpcSessionState {
  model?: RpcModelInfo;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  [key: string]: unknown;
}

export interface RpcSlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  location?: string;
  path?: string;
}

export interface RpcFrame {
  type: string;
  id?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
  [key: string]: unknown;
}

export type RpcEventListener = (frame: RpcFrame) => void;

export interface PiRpcOptions {
  cliPath?: string;
  cwd: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class PiRpc {
  private child?: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<RpcEventListener>();
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequest = 1;

  constructor(private readonly options: PiRpcOptions) {}

  get isConnected(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  static resolveCliPath(explicit?: string): string {
    if (explicit) return explicit;
    if (process.env.OMP_CLI_PATH) return process.env.OMP_CLI_PATH;
    try {
      const binary = execFileSync("which", ["omp"], { encoding: "utf-8" }).trim();
      if (binary) return fs.realpathSync(binary);
    } catch {
      // Fall through to the actionable error below.
    }
    throw new Error("Cannot locate omp. Set ompCliPath or OMP_CLI_PATH to the compiled OMP executable.");
  }

  async start(): Promise<void> {
    if (this.isConnected) return;
    fs.mkdirSync(this.options.cwd, { recursive: true });

    const cliPath = PiRpc.resolveCliPath(this.options.cliPath);
    const args = ["--mode", "rpc-ui", ...(this.options.args ?? [])];
    const child = spawn(cliPath, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const lines = readline.createInterface({ input: child.stdout });
    let ready = false;
    let readyResolve: (() => void) | undefined;
    let readyReject: ((error: Error) => void) | undefined;
    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    lines.on("line", (line) => {
      if (!line.trim()) return;
      let frame: RpcFrame;
      try {
        frame = JSON.parse(line) as RpcFrame;
      } catch (err) {
        logger.warn(`[omp-rpc] ignoring non-JSON stdout: ${line.slice(0, 300)} (${(err as Error).message})`);
        return;
      }
      if (frame.type === "ready") {
        ready = true;
        readyResolve?.();
        this.emit(frame);
        return;
      }
      if (frame.type === "response" && frame.id) {
        const pending = this.pending.get(frame.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(frame.id);
          if (frame.success === false) pending.reject(new Error(frame.error ?? `${pending.command} failed`));
          else pending.resolve(frame.data);
          return;
        }
      }
      this.emit(frame);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf-8").trimEnd();
      if (!message) return;
      logger.warn(`[omp] ${message}`);
      this.emit({ type: "process_stderr", message });
    });

    child.once("error", (err) => {
      if (!ready) readyReject?.(err);
      this.rejectPending(err);
    });
    child.once("exit", (code, signal) => {
      const err = new Error(`omp exited (code=${code ?? "null"}, signal=${signal ?? "none"})`);
      if (!ready) readyReject?.(err);
      this.rejectPending(err);
      this.emit({ type: "process_exit", code, signal });
      this.child = undefined;
      lines.close();
    });

    const timeoutMs = this.options.startupTimeoutMs ?? 30_000;
    const timeout = setTimeout(() => readyReject?.(new Error(`omp RPC did not become ready within ${timeoutMs}ms`)), timeoutMs);
    try {
      await readyPromise;
    } catch (err) {
      child.kill("SIGTERM");
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.stdin.end();
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  onEvent(listener: RpcEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string): Promise<void> {
    try {
      await this.command("prompt", { message: text });
    } catch (err) {
      if (!/streaming/i.test((err as Error).message)) throw err;
      await this.command("steer", { message: text });
    }
  }

  async respondToUi(id: string, response: { confirmed?: boolean; value?: string; cancelled?: boolean }): Promise<void> {
    this.write({ type: "extension_ui_response", id, ...response });
  }

  async newSession(): Promise<{ cancelled: boolean }> {
    return (await this.command("new_session")) as { cancelled: boolean };
  }

  async compact(customInstructions?: string): Promise<{ summary: string; tokensBefore: number }> {
    return (await this.command("compact", customInstructions ? { customInstructions } : {})) as {
      summary: string;
      tokensBefore: number;
    };
  }

  async abort(): Promise<void> {
    await this.command("abort");
  }

  async getState(): Promise<RpcSessionState> {
    return (await this.command("get_state")) as RpcSessionState;
  }

  async getAvailableModels(): Promise<RpcModelInfo[]> {
    const data = (await this.command("get_available_models")) as RpcModelInfo[] | { models?: RpcModelInfo[] };
    return Array.isArray(data) ? data : (data.models ?? []);
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    return this.command("set_model", { provider, modelId });
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.command("set_thinking_level", { level });
  }

  async setSessionName(name: string): Promise<void> {
    await this.command("set_session_name", { name });
  }

  async getSessionStats(): Promise<{ sessionId: string; totalMessages: number; cost: number; tokens: { total: number } }> {
    return (await this.command("get_session_stats")) as {
      sessionId: string;
      totalMessages: number;
      cost: number;
      tokens: { total: number };
    };
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    return (await this.command("export_html", outputPath ? { outputPath } : {})) as { path: string };
  }

  async bash(command: string): Promise<{ output: string; exitCode: number | undefined }> {
    return (await this.command("bash", { command })) as { output: string; exitCode: number | undefined };
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    return (await this.command("switch_session", { sessionPath })) as { cancelled: boolean };
  }

  async getCommands(): Promise<RpcSlashCommandInfo[]> {
    const data = (await this.command("get_commands")) as { commands?: RpcSlashCommandInfo[] } | RpcSlashCommandInfo[];
    return Array.isArray(data) ? data : (data.commands ?? []);
  }

  private async command(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.isConnected) throw new Error("omp RPC not connected");
    const id = `courier_${this.nextRequest++}`;
    const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { command: type, resolve, reject, timer });
    });
    this.write({ id, type, ...fields });
    return promise;
  }

  private write(frame: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) throw new Error("omp RPC stdin is unavailable");
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private emit(frame: RpcFrame): void {
    for (const listener of this.listeners) listener(frame);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
