import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AssistantMessage, extractTextFromMessage, formatToolCalls, splitMessage } from "../formatting.js";
import { logger } from "../logger.js";
import { PiRpc, type RpcFrame } from "../rpc/pi-rpc.js";
import type { ExternalMessage, MsgBridgeConfig, OmpProfileConfig, ReplyContext } from "../types.js";
import { RunReporter } from "./run-reporter.js";
import { StateStore, type ThreadRecord } from "./state-store.js";
import { TranscriptWriter } from "./transcript-writer.js";
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
  reporter: RunReporter;
}

type InteractiveMethod = "confirm" | "select" | "input" | "editor";

interface PendingInteraction {
  shortId: string;
  rpcId: string;
  threadKey: string;
  method: InteractiveMethod;
  options?: string[];
  timer: NodeJS.Timeout;
}

export interface WorkerManagerDeps {
  config: MsgBridgeConfig;
  sendReply: (record: ThreadRecord, text: string, context?: ReplyContext) => Promise<void>;
  sendTyping: (record: ThreadRecord) => Promise<void>;
}

const BRIEF_HANDOFF_PROMPT = [
  "Read BRIEF.md and use it as the approved development brief.",
  "Validate its assumptions against this workspace, report any genuinely blocking ambiguity, then implement and test the work against its acceptance criteria.",
  "Keep BRIEF.md as the source of scope.",
].join(" ");

export class WorkerManager {
  readonly store: StateStore;
  readonly workspaces: WorkspaceManager;
  readonly transcripts = new TranscriptWriter();
  private readonly workers = new Map<string, LiveWorker>();
  private readonly interactions = new Map<string, PendingInteraction>();
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

  async startFromBrief(
    msg: ExternalMessage,
    profileName: string,
    workspaceName: string,
    briefReference: string,
  ): Promise<ThreadRecord> {
    if (profileName !== "development") throw new Error("Brief handoff is limited to the development profile");
    this.profile(profileName);
    const rootEventId = msg.threadRootId ?? msg.messageId;
    const threadKey = makeThreadKey(msg.chatId, rootEventId);
    if (this.store.getThread(threadKey)) throw new Error("This Matrix thread is already initialized");
    const handoff = this.workspaces.createFromBrief(workspaceName, briefReference);
    const sessionDir = path.join(required(this.deps.config.stateDir, "stateDir"), "sessions", threadId(threadKey));
    try {
      const record = await this.start(msg, profileName, workspaceName);
      await this.prompt({ ...msg, threadRootId: record.rootEventId }, BRIEF_HANDOFF_PROMPT);
      return record;
    } catch (err) {
      await this.stopWorker(threadKey).catch(() => {});
      this.store.releaseWorkspace(workspaceName, threadKey);
      this.store.deleteThread(threadKey);
      this.workspaces.rollbackCreatedWorkspace(handoff.workspace);
      fs.rmSync(sessionDir, { recursive: true, force: true });
      throw err;
    }
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
    this.mirror(() => this.transcripts.appendUser(worker.record, msg, text), worker.record.workspace);
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
    const { interaction, worker } = this.pendingInteraction(msg, shortId, ["confirm"]);
    this.consumeInteraction(interaction);
    await worker.rpc.respondToUi(interaction.rpcId, { confirmed });
  }

  async resolveSelection(msg: ExternalMessage, shortId: string, choice: string): Promise<string> {
    const { interaction, worker } = this.pendingInteraction(msg, shortId, ["select"]);
    if (!/^\d+$/.test(choice)) throw new Error("Choice must be a numbered option");
    const index = Number(choice) - 1;
    const value = interaction.options?.[index];
    if (value === undefined) throw new Error(`Choice must be between 1 and ${interaction.options?.length ?? 0}`);
    this.consumeInteraction(interaction);
    await worker.rpc.respondToUi(interaction.rpcId, { value });
    return value;
  }

  async resolveTextInput(msg: ExternalMessage, shortId: string, value: string): Promise<void> {
    const { interaction, worker } = this.pendingInteraction(msg, shortId, ["input", "editor"]);
    if (!value.trim()) throw new Error("Answer cannot be empty; use !cancel to cancel the interaction");
    this.consumeInteraction(interaction);
    await worker.rpc.respondToUi(interaction.rpcId, { value });
  }

  async cancelInteraction(msg: ExternalMessage, shortId: string): Promise<void> {
    const { interaction, worker } = this.pendingInteraction(msg, shortId, ["select", "input", "editor"]);
    this.consumeInteraction(interaction);
    await worker.rpc.respondToUi(interaction.rpcId, { cancelled: true });
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
    for (const interaction of this.interactions.values()) clearTimeout(interaction.timer);
    this.interactions.clear();
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
    this.mirror(() => this.transcripts.ensureThread(record), record.workspace);
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
    const reporting = this.deps.config.runReporting;
    const reporter = new RunReporter({
      intervalSeconds: reporting?.intervalSeconds ?? 0,
      readableProgress: reporting?.readableProgress ?? false,
      finalUsage: reporting?.finalUsage ?? false,
      send: async (text) => {
        this.mirror(() => this.transcripts.appendAssistant(record, text), record.workspace);
        await this.sendInteractionReply(record, text).catch((err) => {
          logger.error(`[courier] Matrix run update failed: ${(err as Error).message}`);
        });
      },
    });
    const worker: LiveWorker = { record, rpc, reporter, busy: false, lastActivity: Date.now() };
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
    await worker.reporter.handle(frame).catch((err) => {
      logger.warn(`[courier] run reporter ignored an invalid OMP frame: ${(err as Error).message}`);
    });
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
          this.mirror(() => this.transcripts.appendAssistant(worker.record, text), worker.record.workspace);
          const toolCalls = this.deps.config.hideToolCalls ? "" : formatToolCalls(message);
          const body = [text, toolCalls].filter(Boolean).join("\n\n");
          if (!body) return;
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
        worker.reporter.close();
        this.clearInteractions(worker.record.threadKey);
        this.workers.delete(worker.record.threadKey);
        this.store.releaseWorkspace(worker.record.workspace, worker.record.threadKey);
        this.store.setThreadStatus(worker.record.threadKey, "stopped");
        return;
    }
  }

  private async handleUiRequest(worker: LiveWorker, frame: RpcFrame): Promise<void> {
    const rpcId = String(frame.id ?? "");
    const method = String(frame.method ?? "");
    if (method === "cancel") {
      const targetId = String(frame.targetId ?? "");
      const interaction = [...this.interactions.values()].find(
        (candidate) => candidate.threadKey === worker.record.threadKey && candidate.rpcId === targetId,
      );
      if (!interaction) return;
      this.consumeInteraction(interaction);
      await this.sendInteractionReply(worker.record, `ℹ️ OMP withdrew interaction ${interaction.shortId}.`);
      return;
    }
    if (!rpcId) return;
    if (!["confirm", "select", "input", "editor"].includes(method)) return;
    const interactiveMethod = method as InteractiveMethod;
    const rawOptions = frame.options;
    const options = interactiveMethod === "select" && Array.isArray(rawOptions)
      ? rawOptions.filter((option): option is string => typeof option === "string")
      : undefined;
    const rawOptionCount = Array.isArray(rawOptions) ? rawOptions.length : -1;
    if (interactiveMethod === "select" && (!options || options.length === 0 || options.length !== rawOptionCount)) {
      await worker.rpc.respondToUi(rpcId, { cancelled: true });
      await this.sendInteractionReply(worker.record, "⚠️ OMP requested a selection without a valid option list; it was cancelled.");
      return;
    }
    const shortId = this.createInteractionId(worker.record.threadKey, rpcId);
    const timeoutMs = interactionTimeoutMs(frame.timeout, this.deps.config.approvalTimeoutSeconds ?? 600);
    const timer = setTimeout(() => {
      this.interactions.delete(shortId);
      const response = interactiveMethod === "confirm" ? { confirmed: false } : { cancelled: true, timedOut: true };
      void worker.rpc.respondToUi(rpcId, response).catch(() => {});
      const result = interactiveMethod === "confirm" ? "expired and was denied" : "expired and was cancelled";
      void this.sendInteractionReply(worker.record, `⌛ Interaction ${shortId} ${result}.`).catch(() => {});
    }, timeoutMs);
    timer.unref();
    const interaction: PendingInteraction = {
      shortId,
      rpcId,
      threadKey: worker.record.threadKey,
      method: interactiveMethod,
      options,
      timer,
    };
    this.interactions.set(shortId, interaction);
    try {
      await this.sendInteractionReply(worker.record, interactionPrompt(interactiveMethod, shortId, timeoutMs, frame, options));
    } catch (err) {
      this.consumeInteraction(interaction);
      const response = interactiveMethod === "confirm" ? { confirmed: false } : { cancelled: true };
      await worker.rpc.respondToUi(rpcId, response).catch(() => {});
      logger.error(`[courier] failed to deliver OMP ${interactiveMethod} interaction: ${(err as Error).message}`);
    }
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
    this.clearInteractions(threadKey);
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
    worker.reporter.close();
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

  private pendingInteraction(
    msg: ExternalMessage,
    shortId: string,
    expectedMethods: InteractiveMethod[],
  ): { interaction: PendingInteraction; worker: LiveWorker } {
    const interaction = this.interactions.get(shortId);
    if (!interaction) throw new Error(`Unknown or expired interaction ${shortId}`);
    const root = msg.threadRootId ?? msg.messageId;
    if (interaction.threadKey !== makeThreadKey(msg.chatId, root)) throw new Error("Interaction belongs to another Matrix thread");
    if (!expectedMethods.includes(interaction.method)) {
      throw new Error(`Interaction ${shortId} requires a ${interaction.method} response`);
    }
    const worker = this.workers.get(interaction.threadKey);
    if (!worker) throw new Error("OMP worker is no longer running");
    return { interaction, worker };
  }

  private consumeInteraction(interaction: PendingInteraction): void {
    clearTimeout(interaction.timer);
    this.interactions.delete(interaction.shortId);
  }

  private clearInteractions(threadKey: string): void {
    for (const interaction of this.interactions.values()) {
      if (interaction.threadKey === threadKey) this.consumeInteraction(interaction);
    }
  }

  private createInteractionId(threadKey: string, rpcId: string): string {
    let shortId: string;
    do {
      shortId = createHash("sha256").update(`${threadKey}:${rpcId}:${randomUUID()}`).digest("hex").slice(0, 8);
    } while (this.interactions.has(shortId));
    return shortId;
  }

  private async sendInteractionReply(record: ThreadRecord, text: string): Promise<void> {
    for (const chunk of splitMessage(text, 4000)) {
      await this.deps.sendReply(record, chunk, { threadRootId: record.rootEventId });
    }
  }

  private publish(record: ThreadRecord, frame: RpcFrame): void {
    const activity = { workspace: record.workspace, threadKey: record.threadKey, at: Date.now(), frame };
    for (const listener of this.activityListeners) listener(activity);
  }

  private mirror(action: () => void, workspace: string): void {
    try {
      action();
    } catch (err) {
      logger.warn(`[courier] transcript mirror failed for ${workspace}: ${(err as Error).message}`);
    }
  }

  private async evictIdle(): Promise<void> {
    const cutoff = Date.now() - (this.deps.config.idleTimeoutSeconds ?? 1800) * 1000;
    for (const worker of this.workers.values()) {
      if (!worker.busy && worker.lastActivity < cutoff) await this.stopWorker(worker.record.threadKey);
    }
  }
}

function interactionTimeoutMs(requestedTimeout: unknown, configuredTimeoutSeconds: number): number {
  const configured = Math.max(1, configuredTimeoutSeconds) * 1000;
  const requested = Number(requestedTimeout);
  return Number.isFinite(requested) && requested > 0 ? Math.min(configured, Math.floor(requested)) : configured;
}

function interactionPrompt(
  method: InteractiveMethod,
  shortId: string,
  timeoutMs: number,
  frame: RpcFrame,
  options?: string[],
): string {
  const title = String(frame.title ?? `OMP ${method}`);
  const timeout = formatTimeout(timeoutMs);
  switch (method) {
    case "confirm":
      return `⚠️ **${title}**\n\n${String(frame.message ?? "Continue?")}\n\nReply \`!approve ${shortId}\` or \`!deny ${shortId}\` within ${timeout}.`;
    case "select":
      return `❓ **${title}**\n\n${options!.map((option, index) => `${index + 1}. ${option}`).join("\n")}\n\nReply \`!choose ${shortId} <number>\` or \`!cancel ${shortId}\` within ${timeout}.`;
    case "input": {
      const placeholder = frame.placeholder ? `\n\nSuggested format: ${String(frame.placeholder)}` : "";
      return `⌨️ **${title}**${placeholder}\n\nReply \`!answer ${shortId} <text>\` or \`!cancel ${shortId}\` within ${timeout}.`;
    }
    case "editor": {
      const prefill = frame.prefill ? `\n\nCurrent text:\n\n${String(frame.prefill)}` : "";
      return `📝 **${title}**${prefill}\n\nReply with \`!answer ${shortId}\` on the first line and the multiline content below it, or reply \`!cancel ${shortId}\`, within ${timeout}.`;
    }
  }
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs < 60_000) return `${Math.ceil(timeoutMs / 1000)} seconds`;
  return `${Math.ceil(timeoutMs / 60_000)} minutes`;
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
