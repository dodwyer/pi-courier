import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AssistantMessage, extractTextFromMessage, formatToolCalls, splitMessage } from "../formatting.js";
import { logger } from "../logger.js";
import { PiRpc, type RpcFrame } from "../rpc/pi-rpc.js";
import type { ExternalMessage, MsgBridgeConfig, OmpProfileConfig, ReplyContext } from "../types.js";
import { StateStore, type ThreadRecord } from "./state-store.js";
import { WorkspaceManager } from "./workspace-manager.js";

export interface CourierActivity {
  workspace: string;
  threadKey: string;
  at: number;
  frame: RpcFrame;
}

interface LiveWorker {
  record: ThreadRecord;
  rpc: PiRpc;
  busy: boolean;
  lastActivity: number;
}

interface PendingApproval {
  shortId: string;
  rpcId: string;
  threadKey: string;
  timer: NodeJS.Timeout;
}

export interface WorkerManagerDeps {
  config: MsgBridgeConfig;
  sendReply: (record: ThreadRecord, text: string, context?: ReplyContext) => Promise<void>;
  sendTyping: (record: ThreadRecord) => Promise<void>;
}

export class WorkerManager {
  readonly store: StateStore;
  readonly workspaces: WorkspaceManager;
  private readonly workers = new Map<string, LiveWorker>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly activityListeners = new Set<(activity: CourierActivity) => void>();
  private readonly idleTimer: NodeJS.Timeout;

  constructor(private readonly deps: WorkerManagerDeps) {
    const stateDir = required(deps.config.stateDir, "stateDir");
    this.store = new StateStore(stateDir);
    this.workspaces = new WorkspaceManager(
      required(deps.config.workspaceRoot, "workspaceRoot"),
      deps.config.externalWorkspaces ?? {},
      this.store,
    );
    this.idleTimer = setInterval(() => void this.evictIdle(), 30_000);
    this.idleTimer.unref();
  }

  onActivity(listener: (activity: CourierActivity) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  async start(msg: ExternalMessage, profileName: string, workspaceName: string): Promise<ThreadRecord> {
    const profile = this.profile(profileName);
    const rootEventId = msg.threadRootId ?? msg.messageId;
    const threadKey = makeThreadKey(msg.chatId, rootEventId);
    if (this.store.getThread(threadKey)) throw new Error("This Matrix thread is already initialized");
    const workspace = this.workspaces.resolve(workspaceName, true);
    const sessionDir = path.join(required(this.deps.config.stateDir, "stateDir"), "sessions", threadId(threadKey));
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const record: ThreadRecord = {
      threadKey,
      roomId: msg.chatId,
      rootEventId,
      transport: msg.transport,
      username: msg.username,
      workspace: workspace.name,
      workspacePath: workspace.path,
      profile: profileName,
      sessionDir,
      status: "starting",
      lastActivity: Date.now(),
    };
    this.store.upsertThread(record);
    await this.ensureWorker(record, profile);
    return this.store.getThread(threadKey)!;
  }

  async continue(msg: ExternalMessage, workspaceName: string): Promise<ThreadRecord> {
    const workspace = this.workspaces.resolve(workspaceName, false);
    const previous = this.store.getLastThreadForWorkspace(workspace.name);
    if (!previous) throw new Error(`Workspace ${workspaceName} has no previous OMP session`);
    if (!previous.sessionFile) throw new Error(`Workspace ${workspaceName} has no resumable OMP session file`);
    const rootEventId = msg.threadRootId ?? msg.messageId;
    const threadKey = makeThreadKey(msg.chatId, rootEventId);
    if (this.store.getThread(threadKey)) throw new Error("This Matrix thread is already initialized");
    const record: ThreadRecord = {
      ...previous,
      threadKey,
      roomId: msg.chatId,
      rootEventId,
      transport: msg.transport,
      username: msg.username,
      status: "starting",
      lastActivity: Date.now(),
    };
    this.store.upsertThread(record);
    await this.ensureWorker(record, this.profile(record.profile));
    return this.store.getThread(threadKey)!;
  }

  async prompt(msg: ExternalMessage, text: string): Promise<void> {
    if (!msg.threadRootId) throw new Error("Start a Matrix thread with !start <profile> <workspace> first");
    const record = this.store.getThreadByRoomRoot(msg.chatId, msg.threadRootId);
    if (!record) throw new Error("This Matrix thread is not initialized; use !start or !continue at the room timeline");
    const worker = await this.ensureWorker(record, this.profile(record.profile));
    worker.lastActivity = Date.now();
    worker.record.lastActivity = worker.lastActivity;
    this.store.upsertThread(worker.record);
    await worker.rpc.prompt(text);
  }

  async abort(msg: ExternalMessage): Promise<void> {
    const worker = this.workerForMessage(msg);
    await worker.rpc.abort();
  }

  async newSession(msg: ExternalMessage, profileName?: string): Promise<ThreadRecord> {
    const worker = this.workerForMessage(msg);
    if (!profileName || profileName === worker.record.profile) {
      await worker.rpc.newSession();
      await this.refreshState(worker);
      return worker.record;
    }
    const profile = this.profile(profileName);
    await this.stopWorker(worker.record.threadKey);
    worker.record.profile = profileName;
    worker.record.sessionDir = path.join(required(this.deps.config.stateDir, "stateDir"), "sessions", `${threadId(worker.record.threadKey)}-${Date.now()}`);
    worker.record.sessionFile = undefined;
    worker.record.status = "starting";
    this.store.upsertThread(worker.record);
    await this.ensureWorker(worker.record, profile);
    return worker.record;
  }

  async stop(msg: ExternalMessage): Promise<void> {
    const worker = this.workerForMessage(msg);
    await this.stopWorker(worker.record.threadKey);
  }

  status(msg: ExternalMessage): ThreadRecord {
    const root = msg.threadRootId ?? msg.messageId;
    const record = this.store.getThreadByRoomRoot(msg.chatId, root);
    if (!record) throw new Error("No OMP session is associated with this Matrix thread");
    return record;
  }

  async resolveApproval(msg: ExternalMessage, shortId: string, confirmed: boolean): Promise<void> {
    const approval = this.approvals.get(shortId);
    if (!approval) throw new Error(`Unknown or expired approval ${shortId}`);
    const root = msg.threadRootId ?? msg.messageId;
    if (approval.threadKey !== makeThreadKey(msg.chatId, root)) throw new Error("Approval belongs to another Matrix thread");
    const worker = this.workers.get(approval.threadKey);
    if (!worker) throw new Error("OMP worker is no longer running");
    clearTimeout(approval.timer);
    this.approvals.delete(shortId);
    await worker.rpc.respondToUi(approval.rpcId, { confirmed });
  }

  async leaseWorkspace(name: string, abort = false): Promise<ThreadRecord> {
    const workspace = this.store.getWorkspace(name);
    if (!workspace) throw new Error(`Unknown workspace ${name}`);
    const threadKey = workspace.activeThreadKey ?? workspace.lastThreadKey;
    if (!threadKey) throw new Error(`Workspace ${name} has no OMP session`);
    const record = this.store.getThread(threadKey);
    if (!record) throw new Error(`Workspace ${name} has no thread record`);
    const worker = this.workers.get(threadKey);
    if (worker?.busy && !abort) throw new Error("OMP is busy; wait for idle or attach with --abort");
    if (worker?.busy && abort) await worker.rpc.abort();
    await this.stopWorker(threadKey, "attached");
    this.store.acquireWorkspace(name, `ssh:${process.pid}`);
    this.store.setThreadStatus(threadKey, "attached");
    return { ...(this.store.getThread(threadKey) ?? record), status: "attached" };
  }

  releaseWorkspace(name: string): void {
    const workspace = this.store.getWorkspace(name);
    if (!workspace?.activeThreadKey?.startsWith("ssh:")) throw new Error(`Workspace ${name} is not leased over SSH`);
    this.store.releaseWorkspace(name, workspace.activeThreadKey);
    if (workspace.lastThreadKey) this.store.setThreadStatus(workspace.lastThreadKey, "stopped");
  }

  async shutdown(): Promise<void> {
    clearInterval(this.idleTimer);
    await Promise.allSettled([...this.workers.keys()].map((key) => this.stopWorker(key)));
    for (const approval of this.approvals.values()) clearTimeout(approval.timer);
    this.approvals.clear();
    this.store.close();
  }

  private async ensureWorker(record: ThreadRecord, profile: OmpProfileConfig): Promise<LiveWorker> {
    const existing = this.workers.get(record.threadKey);
    if (existing) return existing;
    const maxWorkers = this.deps.config.maxWorkers ?? 4;
    if (this.workers.size >= maxWorkers) {
      const idle = [...this.workers.values()].sort((a, b) => a.lastActivity - b.lastActivity).find((candidate) => !candidate.busy);
      if (!idle) throw new Error(`All ${maxWorkers} OMP workers are busy; try again shortly`);
      await this.stopWorker(idle.record.threadKey);
    }

    this.store.acquireWorkspace(record.workspace, record.threadKey);
    fs.mkdirSync(record.sessionDir, { recursive: true, mode: 0o700 });
    const args = [
      "--profile", record.profile,
      "--cwd", record.workspacePath,
      "--session-dir", record.sessionDir,
      "--approval-mode", profile.approvalMode,
      "--tools", profile.tools.join(","),
      ...(profile.model ? ["--model", profile.model] : []),
      ...((profile.configFiles ?? []).flatMap((file) => ["--config", file])),
      ...(record.sessionFile ? ["--resume", record.sessionFile] : []),
    ];
    const env: NodeJS.ProcessEnv = {};
    if (this.deps.config.authBroker) {
      env.OMP_AUTH_BROKER_URL = this.deps.config.authBroker.url;
      env.OMP_AUTH_BROKER_TOKEN = fs.readFileSync(this.deps.config.authBroker.tokenFile, "utf-8").trim();
    }
    const rpc = new PiRpc({
      cliPath: this.deps.config.ompCliPath,
      cwd: record.workspacePath,
      args,
      env,
    });
    const worker: LiveWorker = { record, rpc, busy: false, lastActivity: Date.now() };
    rpc.onEvent((frame) => void this.handleFrame(worker, frame));
    try {
      await rpc.start();
      this.workers.set(record.threadKey, worker);
      worker.record.status = "idle";
      await this.refreshState(worker);
      return worker;
    } catch (err) {
      this.store.releaseWorkspace(record.workspace, record.threadKey);
      this.store.setThreadStatus(record.threadKey, "failed");
      throw err;
    }
  }

  private async handleFrame(worker: LiveWorker, frame: RpcFrame): Promise<void> {
    worker.lastActivity = Date.now();
    this.publish(worker.record, frame);
    switch (frame.type) {
      case "turn_start":
      case "agent_start":
        worker.busy = true;
        worker.record.status = "busy";
        this.store.setThreadStatus(worker.record.threadKey, "busy");
        await this.deps.sendTyping(worker.record).catch(() => {});
        return;
      case "turn_end": {
        const message = frame.message as AssistantMessage | undefined;
        if (message?.content) {
          const text = extractTextFromMessage(message).trim();
          const toolCalls = formatToolCalls(message);
          const body = [text, toolCalls].filter(Boolean).join("\n\n");
          for (const chunk of splitMessage(body, 4000)) {
            await this.deps.sendReply(worker.record, chunk, {
              threadRootId: worker.record.rootEventId,
            }).catch((err) => logger.error(`[courier] Matrix reply failed: ${(err as Error).message}`));
          }
        }
        return;
      }
      case "agent_end":
      case "agent_settled":
        worker.busy = false;
        worker.record.status = "idle";
        await this.refreshState(worker);
        return;
      case "extension_ui_request":
        await this.handleUiRequest(worker, frame);
        return;
      case "process_exit":
        this.workers.delete(worker.record.threadKey);
        this.store.releaseWorkspace(worker.record.workspace, worker.record.threadKey);
        this.store.setThreadStatus(worker.record.threadKey, "stopped");
        return;
    }
  }

  private async handleUiRequest(worker: LiveWorker, frame: RpcFrame): Promise<void> {
    const rpcId = String(frame.id ?? "");
    const method = String(frame.method ?? "");
    if (!rpcId) return;
    if (!["confirm", "select", "input", "editor"].includes(method)) return;
    if (method !== "confirm") {
      await worker.rpc.respondToUi(rpcId, { cancelled: true });
      await this.deps.sendReply(worker.record, `⚠️ OMP requested unsupported interactive input (${method}); it was cancelled.`, {
        threadRootId: worker.record.rootEventId,
      });
      return;
    }
    const shortId = createHash("sha256").update(`${worker.record.threadKey}:${rpcId}:${randomUUID()}`).digest("hex").slice(0, 8);
    const timeoutMs = (this.deps.config.approvalTimeoutSeconds ?? 600) * 1000;
    const timer = setTimeout(() => {
      this.approvals.delete(shortId);
      void worker.rpc.respondToUi(rpcId, { confirmed: false }).catch(() => {});
      void this.deps.sendReply(worker.record, `⌛ Approval ${shortId} expired and was denied.`, {
        threadRootId: worker.record.rootEventId,
      });
    }, timeoutMs);
    timer.unref();
    this.approvals.set(shortId, { shortId, rpcId, threadKey: worker.record.threadKey, timer });
    const title = String(frame.title ?? "OMP confirmation");
    const message = String(frame.message ?? "Continue?");
    await this.deps.sendReply(
      worker.record,
      `⚠️ **${title}**\n\n${message}\n\nReply \`!approve ${shortId}\` or \`!deny ${shortId}\` within ${Math.round(timeoutMs / 60_000)} minutes.`,
      { threadRootId: worker.record.rootEventId },
    );
  }

  private async refreshState(worker: LiveWorker): Promise<void> {
    try {
      const state = await worker.rpc.getState();
      if (state.sessionFile) worker.record.sessionFile = state.sessionFile;
      worker.record.lastActivity = Date.now();
      this.store.upsertThread(worker.record);
    } catch (err) {
      logger.warn(`[courier] failed to refresh session state for ${worker.record.workspace}: ${(err as Error).message}`);
    }
  }

  private async stopWorker(threadKey: string, status = "stopped"): Promise<void> {
    const worker = this.workers.get(threadKey);
    if (!worker) {
      const record = this.store.getThread(threadKey);
      if (record) {
        this.store.releaseWorkspace(record.workspace, threadKey);
        this.store.setThreadStatus(threadKey, status, record.sessionFile);
      }
      return;
    }
    await this.refreshState(worker);
    this.workers.delete(threadKey);
    await worker.rpc.stop();
    this.store.releaseWorkspace(worker.record.workspace, threadKey);
    this.store.setThreadStatus(threadKey, status, worker.record.sessionFile);
  }

  private workerForMessage(msg: ExternalMessage): LiveWorker {
    if (!msg.threadRootId) throw new Error("Command must be sent inside an initialized Matrix thread");
    const record = this.store.getThreadByRoomRoot(msg.chatId, msg.threadRootId);
    const worker = record ? this.workers.get(record.threadKey) : undefined;
    if (!worker) throw new Error("OMP worker is stopped; send a normal prompt to resume it first");
    return worker;
  }

  private profile(name: string): OmpProfileConfig {
    const profile = this.deps.config.profiles?.[name];
    if (!profile) throw new Error(`Unknown profile ${name}; choose ${Object.keys(this.deps.config.profiles ?? {}).join(", ")}`);
    return profile;
  }

  private publish(record: ThreadRecord, frame: RpcFrame): void {
    const activity = { workspace: record.workspace, threadKey: record.threadKey, at: Date.now(), frame };
    for (const listener of this.activityListeners) listener(activity);
  }

  private async evictIdle(): Promise<void> {
    const cutoff = Date.now() - (this.deps.config.idleTimeoutSeconds ?? 1800) * 1000;
    for (const worker of this.workers.values()) {
      if (!worker.busy && worker.lastActivity < cutoff) await this.stopWorker(worker.record.threadKey);
    }
  }
}

export function makeThreadKey(roomId: string, rootEventId: string): string {
  return `${roomId}\u001f${rootEventId}`;
}

function threadId(threadKey: string): string {
  return createHash("sha256").update(threadKey).digest("hex").slice(0, 24);
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required courier configuration: ${name}`);
  return value;
}
