import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RpcFrame } from "../rpc/pi-rpc.js";

interface RunReporterOptions {
  intervalSeconds: number;
  readableProgress: boolean;
  finalUsage: boolean;
  progressHeartbeatSeconds?: number;
  format?: "detailed" | "operator";
  usageMode?: "tokens" | "capacity" | "none";
  capacityStaleSeconds?: number;
  timeZone?: string;
  runLabel?: string;
  authBroker?: { url: string; tokenFile: string };
  capacityFetcher?: () => Promise<unknown>;
  initialModels?: string[];
  send: (text: string) => Promise<void>;
  statusFilePath?: string;
  workspacePath?: string;
  taskResultDirectoryPath?: string;
  stateFilePath?: string;
  now?: () => number;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

interface ActiveTaskUsage {
  model: string;
  tokens: number;
}

interface RunningStage {
  labels: string[];
  startedAt: number;
  lastHeartbeatAt: number;
}

interface OperatorStatus {
  finished: string;
  current: string;
  next: string;
  actionNeeded?: string;
}

interface CapacityLimit {
  provider: string;
  windowId: string;
  tier?: string;
  modelId?: string;
  shared?: boolean;
  remaining: number;
  resetsAt?: number;
  status?: string;
}

interface CapacitySnapshot {
  fetchedAt: number;
  limits: CapacityLimit[];
}

interface ReporterCheckpoint {
  schemaVersion: 1;
  active: boolean;
  startedAt: number;
  lastOperatorUpdateAt: number;
  usedModels: string[];
  lastCapacity?: CapacitySnapshot;
  lastFinished?: string;
  nextActionHint?: string;
}

type ReportKind = "periodic" | "final";
export type StatusProjectionResult = "sent" | "unchanged" | "unavailable";

const EMPTY_USAGE: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_STATUS_PROJECTION_CHARS = 3_000;
const MAX_TASK_RESULT_BYTES = 1024 * 1024;

/**
 * Turns native OMP RPC activity into small, user-facing Matrix updates.
 *
 * OMP exposes exact provider usage on completed messages and task results. Its
 * live task progress intentionally exposes a smaller running counter that
 * excludes cache reads, so in-flight totals are marked as estimates until the
 * task settles and exact usage replaces them.
 */
export class RunReporter {
  private readonly now: () => number;
  private active = false;
  private startedAt = 0;
  private timer?: NodeJS.Timeout;
  private progressTimer?: NodeJS.Timeout;
  private readonly exactUsage = new Map<string, UsageTotals>();
  private readonly activeTaskUsage = new Map<string, ActiveTaskUsage>();
  private readonly settledTaskIds = new Set<string>();
  private readonly lastReportedTotals = new Map<string, number>();
  private readonly runningStages = new Map<string, RunningStage>();
  private reads = 0;
  private writes = 0;
  private commands = 0;
  private issues = 0;
  private lastStatusProjection?: string;
  private taskResultSequence = 0;
  private restoredActive = false;
  private lastOperatorUpdateAt = 0;
  private readonly usedModels = new Set<string>();
  private lastCapacity?: CapacitySnapshot;
  private lastFinished = "No phase completed since the previous update.";
  private nextActionHint = "Continue to the next incomplete workflow gate.";

  constructor(private readonly options: RunReporterOptions) {
    this.now = options.now ?? Date.now;
    this.loadCheckpoint();
    for (const model of options.initialModels ?? []) {
      const normalized = normalizedModel(model);
      if (normalized) this.usedModels.add(normalized);
    }
    this.prepareTaskResultDirectory();
    this.taskResultSequence = existingTaskResultSequence(options.taskResultDirectoryPath);
    this.loadModelsFromTaskResults();
  }

  async handle(frame: RpcFrame): Promise<void> {
    switch (frame.type) {
      case "agent_start":
      case "turn_start":
        this.startRun();
        return;
      case "message_end":
        this.recordAssistantMessage(frame.message);
        return;
      case "tool_execution_start":
        await this.handleToolStart(frame);
        return;
      case "tool_execution_update":
        this.handleTaskProgress(frame);
        return;
      case "tool_execution_end":
        await this.handleToolEnd(frame);
        return;
      case "agent_end":
      case "agent_settled":
        await this.finishRun();
        return;
      case "process_exit":
        this.stopTimer();
    }
  }

  async report(kind: ReportKind = "periodic"): Promise<void> {
    if (!this.active) return;
    if (this.options.format === "operator") {
      await this.reportOperator(kind);
      return;
    }
    const rows = this.usageRows();
    const elapsed = Math.max(0, this.now() - this.startedAt);
    const title = kind === "final"
      ? `📊 **Final model usage · ${formatDuration(elapsed)}**`
      : `📊 **Run update · ${formatElapsedMinutes(elapsed)}**`;
    const lines = [title];

    if (kind === "periodic") {
      const status = this.readStatusProjection();
      if (status && status !== this.lastStatusProjection) {
        this.lastStatusProjection = status;
        lines.push(status, "");
      } else if (status) {
        lines.push(`**Current work:** ${this.currentWork()} · workspace status is unchanged.`);
      }
      else lines.push(`**Current work:** ${this.currentWork()}`);
    }
    lines.push("**Model tokens processed — run total (since the last update)**");
    if (rows.length === 0) {
      lines.push("• No completed model response has reported token usage yet.");
    } else {
      for (const row of rows) {
        const approximate = row.activeTokens > 0 ? "~" : "";
        const previous = this.lastReportedTotals.get(row.model) ?? 0;
        const delta = Math.max(0, row.totalTokens - previous);
        const components = [
          row.input > 0 ? `${formatTokens(row.input)} input` : undefined,
          row.cacheRead > 0 ? `${formatTokens(row.cacheRead)} cache reads` : undefined,
          row.cacheWrite > 0 ? `${formatTokens(row.cacheWrite)} cache writes` : undefined,
          row.output > 0 ? `${formatTokens(row.output)} output` : undefined,
          row.activeTokens > 0 ? `~${formatTokens(row.activeTokens)} live` : undefined,
        ].filter((part): part is string => part !== undefined);
        lines.push(`• ${displayModel(row.model)}: ${approximate}${formatTokens(row.totalTokens)} (+${formatTokens(delta)})${components.length > 0 ? ` · ${components.join(" · ")}` : ""}`);
        this.lastReportedTotals.set(row.model, row.totalTokens);
      }
    }

    if (this.activeTaskUsage.size > 0) {
      lines.push("_~ includes live agent tokens; cache reads are added when that agent finishes._");
    }
    lines.push(`**Activity:** ${this.reads} read/search · ${this.writes} write/edit · ${this.commands} command/check${this.issues ? ` · ${this.issues} issue${this.issues === 1 ? "" : "s"} handled` : ""}`);
    if (kind === "periodic") lines.push("No action is needed unless the agent asks a specific question.");
    await this.options.send(lines.join("\n"));
  }

  async reportStatus(): Promise<StatusProjectionResult> {
    if (this.options.format === "operator") {
      const status = this.readOperatorStatus();
      if (!status) return "unavailable";
      const projection = JSON.stringify(status);
      if (projection === this.lastStatusProjection) return "unchanged";
      this.lastStatusProjection = projection;
      await this.sendOperator(status, "periodic");
      return "sent";
    }
    const projection = this.readStatusProjection();
    if (!projection) return "unavailable";
    if (projection === this.lastStatusProjection) return "unchanged";
    this.lastStatusProjection = projection;
    await this.options.send(projection);
    return "sent";
  }

  close(): void {
    this.stopTimer();
    this.active = false;
  }

  private startRun(): void {
    if (this.active) return;
    this.active = true;
    const continuing = this.restoredActive && this.startedAt > 0;
    if (!continuing) {
      this.startedAt = this.now();
      this.lastOperatorUpdateAt = 0;
      this.usedModels.clear();
      for (const model of this.options.initialModels ?? []) {
        const normalized = normalizedModel(model);
        if (normalized) this.usedModels.add(normalized);
      }
      this.lastCapacity = undefined;
      this.lastFinished = "No phase completed since the previous update.";
      this.nextActionHint = "Continue to the next incomplete workflow gate.";
    }
    this.restoredActive = false;
    this.exactUsage.clear();
    this.activeTaskUsage.clear();
    this.settledTaskIds.clear();
    this.lastReportedTotals.clear();
    this.runningStages.clear();
    this.reads = 0;
    this.writes = 0;
    this.commands = 0;
    this.issues = 0;
    this.lastStatusProjection = undefined;
    if (this.options.intervalSeconds > 0) {
      if (this.options.format === "operator") this.scheduleOperatorReport();
      else {
        this.timer = setInterval(() => void this.report().catch(() => {}), this.options.intervalSeconds * 1000);
        this.timer.unref();
      }
    }
    const heartbeatSeconds = this.options.progressHeartbeatSeconds ?? 0;
    if (heartbeatSeconds > 0 && this.options.format !== "operator") {
      this.progressTimer = setInterval(
        () => void this.reportProgressHeartbeat().catch(() => {}),
        heartbeatSeconds * 1000,
      );
      this.progressTimer.unref();
    }
    this.persistCheckpoint();
  }

  private async finishRun(): Promise<void> {
    if (!this.active) return;
    this.stopTimer();
    const recentlyReported = this.options.format === "operator"
      && this.lastOperatorUpdateAt > 0
      && this.now() - this.lastOperatorUpdateAt < 2_000;
    if (this.options.finalUsage && !recentlyReported) await this.report("final");
    this.active = false;
    this.runningStages.clear();
    this.activeTaskUsage.clear();
    this.persistCheckpoint();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.timer = undefined;
    this.progressTimer = undefined;
  }

  private recordAssistantMessage(value: unknown): void {
    const message = record(value);
    if (message?.role !== "assistant") return;
    const model = modelKey(message.provider, message.model);
    const usage = usageTotals(message.usage);
    if (!model || !usage) return;
    this.observeModel(model);
    this.addExactUsage(model, usage);
  }

  private async handleToolStart(frame: RpcFrame): Promise<void> {
    const toolName = String(frame.toolName ?? "");
    this.countTool(toolName);
    if (toolName !== "task") return;
    const toolCallId = String(frame.toolCallId ?? `task-${this.runningStages.size + 1}`);
    const labels = taskItems(frame.args).map((item) => stageLabel(String(item.agent ?? "task"), item.name));
    const startedAt = this.now();
    this.runningStages.set(toolCallId, { labels, startedAt, lastHeartbeatAt: startedAt });
    if (this.options.format === "operator") {
      this.nextActionHint = nextActionAfterStage(labels);
      const status = await this.reportStatus();
      if (status === "unavailable") await this.reportOperator("periodic");
      return;
    }
    if (!this.options.readableProgress) return;
    const heading = labels.length === 1 ? `${labels[0]} started` : `${labels.length} specialist tasks started`;
    const detail = labels.length === 1
      ? stageDescription(labels[0])
      : labels.map((label) => `• ${label}`).join("\n");
    await this.options.send(`🔄 **${heading}**\n${detail}`);
  }

  private handleTaskProgress(frame: RpcFrame): void {
    if (String(frame.toolName ?? "") !== "task") return;
    const details = toolDetails(frame.partialResult);
    const progress = Array.isArray(details?.progress) ? details.progress : [];
    const toolCallId = String(frame.toolCallId ?? "task");
    for (const value of progress) {
      const item = record(value);
      if (!item) continue;
      const id = String(item.id ?? item.index ?? "unknown");
      const status = String(item.status ?? "running");
      const model = normalizedModel(item.resolvedModel);
      const tokens = nonNegativeNumber(item.tokens);
      const key = `${toolCallId}:${id}`;
      if (["completed", "failed", "aborted"].includes(status)) {
        if (!this.settledTaskIds.has(id)) this.activeTaskUsage.delete(key);
      } else if (model && tokens !== undefined) {
        this.observeModel(model);
        this.activeTaskUsage.set(key, { model, tokens });
      }
    }
  }

  private async handleToolEnd(frame: RpcFrame): Promise<void> {
    const toolName = String(frame.toolName ?? "");
    const result = record(frame.result);
    const frameFailed = frame.isError === true || result?.isError === true;
    if (toolName !== "task") {
      if (frameFailed) this.issues += 1;
      return;
    }
    const details = toolDetails(frame.result);
    const results = Array.isArray(details?.results) ? details.results : [];
    const toolCallId = String(frame.toolCallId ?? "task");
    for (const value of results) this.settleTaskResult(toolCallId, value);
    const persisted = this.persistTaskResult(toolCallId, results, frameFailed);
    if (!persisted && this.options.taskResultDirectoryPath) {
      this.issues += 1;
      await this.options.send("⚠️ Courier could not persist the normalized task envelope. The lead must record the gate evidence before advancing.");
    }
    if (frameFailed && results.length === 0) this.issues += 1;
    const stage = this.runningStages.get(toolCallId);
    this.runningStages.delete(toolCallId);
    if (this.options.format === "operator") {
      if (stage) {
        this.lastFinished = operatorStageOutcome(stage, results, this.now());
        this.nextActionHint = nextActionAfterStage(stage.labels);
      }
      const status = await this.reportStatus();
      if (status === "unavailable") await this.reportOperator("periodic");
      return;
    }
    if (!this.options.readableProgress || !stage) return;
    await this.options.send(formatStageResult(stage, results, this.now()));
  }

  private settleTaskResult(toolCallId: string, value: unknown): void {
    const result = record(value);
    if (!result) return;
    const id = String(result.id ?? result.index ?? "unknown");
    const model = normalizedModel(result.resolvedModel)
      ?? this.activeTaskUsage.get(`${toolCallId}:${id}`)?.model;
    const usage = usageTotals(result.usage);
    if (model) this.observeModel(model);
    if (!this.settledTaskIds.has(id) && model && usage) {
      this.addExactUsage(model, usage);
      this.settledTaskIds.add(id);
    }
    for (const key of this.activeTaskUsage.keys()) {
      if (key.endsWith(`:${id}`)) this.activeTaskUsage.delete(key);
    }
    if (nonNegativeNumber(result.exitCode) !== 0) this.issues += 1;
  }

  private addExactUsage(model: string, usage: UsageTotals): void {
    const current = this.exactUsage.get(model) ?? EMPTY_USAGE;
    this.exactUsage.set(model, {
      input: current.input + usage.input,
      output: current.output + usage.output,
      cacheRead: current.cacheRead + usage.cacheRead,
      cacheWrite: current.cacheWrite + usage.cacheWrite,
      totalTokens: current.totalTokens + usage.totalTokens,
    });
  }

  private usageRows(): Array<UsageTotals & { model: string; totalTokens: number; activeTokens: number }> {
    const activeByModel = new Map<string, number>();
    for (const usage of this.activeTaskUsage.values()) {
      activeByModel.set(usage.model, (activeByModel.get(usage.model) ?? 0) + usage.tokens);
    }
    const models = new Set([...this.exactUsage.keys(), ...activeByModel.keys()]);
    return [...models]
      .map((model) => {
        const activeTokens = activeByModel.get(model) ?? 0;
        const exact = this.exactUsage.get(model) ?? EMPTY_USAGE;
        return { ...exact, model, activeTokens, totalTokens: exact.totalTokens + activeTokens };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
  }

  private currentWork(): string {
    const labels = [...this.runningStages.values()].flatMap((stage) => stage.labels);
    if (labels.length === 0) return "The lead agent is coordinating and synthesizing the work.";
    return labels.join(", ");
  }

  private async reportOperator(kind: ReportKind): Promise<void> {
    const status = this.readOperatorStatus() ?? {
      finished: this.lastFinished,
      current: this.currentWork(),
      next: kind === "final" ? "Await the next operator request." : this.nextActionHint,
    };
    this.lastStatusProjection = JSON.stringify(status);
    await this.sendOperator(status, kind);
  }

  private async sendOperator(status: OperatorStatus, kind: ReportKind): Promise<void> {
    await this.refreshCapacity();
    const elapsed = Math.max(0, this.now() - this.startedAt);
    const label = readableWords(this.options.runLabel ?? "run");
    const lines = [
      `⏱️ **${label} update · ${formatOperatorElapsed(elapsed)}**`,
      "",
      `**Finished:** ${status.finished}`,
      `**Current:** ${status.current}`,
      `**Next:** ${status.next}`,
      ...(status.actionNeeded ? [`**Action needed:** ${status.actionNeeded}`] : []),
    ];
    if ((this.options.usageMode ?? "tokens") === "capacity") {
      lines.push("", ...this.capacityLines());
    }
    await this.options.send(lines.join("\n"));
    this.lastOperatorUpdateAt = this.now();
    this.persistCheckpoint();
    if (this.active && kind === "periodic") this.scheduleOperatorReport();
  }

  private scheduleOperatorReport(): void {
    if (this.options.format !== "operator" || !this.active || this.options.intervalSeconds <= 0) return;
    if (this.timer) clearTimeout(this.timer);
    const intervalMs = this.options.intervalSeconds * 1000;
    const anchor = this.lastOperatorUpdateAt || this.startedAt;
    const delay = Math.max(1, intervalMs - Math.max(0, this.now() - anchor));
    this.timer = setTimeout(() => void this.report().catch(() => this.scheduleOperatorReport()), delay);
    this.timer.unref();
  }

  private async refreshCapacity(): Promise<void> {
    if ((this.options.usageMode ?? "tokens") !== "capacity") return;
    try {
      let payload: unknown;
      if (this.options.capacityFetcher) payload = await this.options.capacityFetcher();
      else if (this.options.authBroker) {
        const token = fs.readFileSync(this.options.authBroker.tokenFile, "utf-8").trim();
        const response = await fetch(new URL("/v1/usage", this.options.authBroker.url), {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`broker returned ${response.status}`);
        payload = await response.json();
      } else return;
      const snapshot = normalizeCapacityPayload(payload);
      if (snapshot) this.lastCapacity = snapshot;
    } catch {
      // Capacity is advisory operator telemetry. A stale marker is safer than
      // failing the OMP run or replacing it with inferred token counts.
    }
  }

  private capacityLines(): string[] {
    const snapshot = this.lastCapacity;
    if (!snapshot) return ["**Capacity left:** unavailable"];
    const staleAfterMs = Math.max(1, this.options.capacityStaleSeconds ?? 900) * 1000;
    const stale = this.now() - snapshot.fetchedAt > staleAfterMs;
    const relevant = relevantCapacityLimits(snapshot.limits, this.usedModels);
    if (relevant.length === 0) {
      const checked = formatClock(snapshot.fetchedAt, this.options.timeZone);
      return [`**Capacity left:** unavailable for the models observed in this run · checked ${checked}${stale ? " · stale" : ""}`];
    }
    const title = stale
      ? `**Capacity left · stale since ${formatClock(snapshot.fetchedAt, this.options.timeZone)}:**`
      : "**Capacity left:**";
    return [title, ...formatCapacityGroups(relevant, this.options.timeZone).map((line) => `• ${line}`)];
  }

  private observeModel(model: string): void {
    const normalized = normalizedModel(model);
    if (!normalized || this.usedModels.has(normalized)) return;
    this.usedModels.add(normalized);
    this.persistCheckpoint();
  }

  private loadCheckpoint(): void {
    const stateFilePath = this.options.stateFilePath;
    if (!stateFilePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFilePath, "utf-8")) as ReporterCheckpoint;
      if (parsed.schemaVersion !== 1) return;
      this.restoredActive = parsed.active === true;
      this.startedAt = nonNegativeNumber(parsed.startedAt) ?? 0;
      this.lastOperatorUpdateAt = nonNegativeNumber(parsed.lastOperatorUpdateAt) ?? 0;
      for (const model of parsed.usedModels ?? []) this.observeModel(model);
      if (parsed.lastCapacity && nonNegativeNumber(parsed.lastCapacity.fetchedAt) !== undefined) {
        this.lastCapacity = parsed.lastCapacity;
      }
      if (typeof parsed.lastFinished === "string") this.lastFinished = cleanOperatorField(parsed.lastFinished);
      if (typeof parsed.nextActionHint === "string") this.nextActionHint = cleanOperatorField(parsed.nextActionHint);
    } catch {
      // A missing or partial checkpoint only affects presentation continuity.
    }
  }

  private persistCheckpoint(): void {
    const stateFilePath = this.options.stateFilePath;
    if (!stateFilePath) return;
    try {
      fs.mkdirSync(path.dirname(stateFilePath), { recursive: true, mode: 0o700 });
      const payload: ReporterCheckpoint = {
        schemaVersion: 1,
        active: this.active || this.restoredActive,
        startedAt: this.startedAt,
        lastOperatorUpdateAt: this.lastOperatorUpdateAt,
        usedModels: [...this.usedModels].sort(),
        lastCapacity: this.lastCapacity,
        lastFinished: this.lastFinished,
        nextActionHint: this.nextActionHint,
      };
      const temporary = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, stateFilePath);
    } catch {
      // Reporting state must never break the agent lifecycle.
    }
  }

  private loadModelsFromTaskResults(): void {
    const directory = this.options.taskResultDirectoryPath;
    if (!directory) return;
    try {
      for (const name of fs.readdirSync(directory).filter((candidate) => candidate.endsWith(".json")).slice(-2_000)) {
        const target = path.join(directory, name);
        if (fs.statSync(target).size > MAX_TASK_RESULT_BYTES) continue;
        const envelope = record(JSON.parse(fs.readFileSync(target, "utf-8")));
        const results = Array.isArray(envelope?.results) ? envelope.results : [];
        for (const result of results) {
          const model = normalizedModel(record(result)?.resolvedModel);
          if (model) this.usedModels.add(model);
        }
      }
    } catch {
      // Existing artifacts are only a continuity aid.
    }
  }

  private async reportProgressHeartbeat(): Promise<void> {
    if (!this.active || this.runningStages.size === 0) return;
    const heartbeatMs = Math.max(1, this.options.progressHeartbeatSeconds ?? 0) * 1000;
    const now = this.now();
    const stages = [...this.runningStages.values()].filter((stage) => now - stage.lastHeartbeatAt >= heartbeatMs);
    if (stages.length === 0) return;
    for (const stage of stages) stage.lastHeartbeatAt = now;
    const labels = stages.flatMap((stage) => stage.labels);
    const oldest = Math.min(...stages.map((stage) => stage.startedAt));
    await this.options.send(
      `⏳ **Still working · ${formatDuration(now - oldest)}**\n${labels.join(", ")} is active. No action is needed.`,
    );
  }

  private persistTaskResult(toolCallId: string, values: unknown[], failed: boolean): boolean {
    const directory = this.options.taskResultDirectoryPath;
    if (!directory) return true;
    try {
      this.prepareTaskResultDirectory();
      const normalized = values.map((value) => {
        const result = record(value) ?? {};
        return {
          id: result.id ?? result.index ?? "unknown",
          agent: result.agent ?? "task",
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          resolvedModel: result.resolvedModel,
          usage: result.usage,
          structuredOutput: result.structuredOutput,
          error: result.error,
        };
      });
      const envelope = {
        schemaVersion: 1,
        toolCallId,
        failed,
        results: normalized,
      };
      let serialized = `${JSON.stringify(envelope, null, 2)}\n`;
      if (Buffer.byteLength(serialized) > MAX_TASK_RESULT_BYTES) {
        serialized = `${JSON.stringify({
          schemaVersion: 1,
          toolCallId,
          failed,
          omitted: "normalized result exceeded the durable artifact limit",
          sha256: createHash("sha256").update(serialized).digest("hex"),
          bytes: Buffer.byteLength(serialized),
          results: normalized.map((result) => ({
            id: result.id,
            agent: result.agent,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            resolvedModel: result.resolvedModel,
            usage: result.usage,
            error: result.error,
          })),
        }, null, 2)}\n`;
      }
      let target: string;
      do {
        const sequence = String(++this.taskResultSequence).padStart(4, "0");
        target = path.join(directory, `${sequence}-${safeFilename(toolCallId)}.json`);
      } while (fs.existsSync(target));
      fs.writeFileSync(target, serialized, { mode: 0o660, flag: "wx" });
      fs.chmodSync(target, 0o660);
      return true;
    } catch {
      // Reporting artifacts are a mirror of the native task result. They must
      // never break the OMP RPC lifecycle if the workspace becomes read-only.
      return false;
    }
  }

  private prepareTaskResultDirectory(): void {
    const directory = this.options.taskResultDirectoryPath;
    if (!directory) return;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o770 });
      fs.chmodSync(directory, 0o770);
    } catch {
      // Persistence reports the actionable failure when a task result arrives.
    }
  }

  private countTool(toolName: string): void {
    if (["read", "grep", "glob", "web_search", "browser", "inspect_image"].includes(toolName)) this.reads += 1;
    else if (["write", "edit", "notebook"].includes(toolName)) this.writes += 1;
    else if (["bash", "eval", "python", "lsp"].includes(toolName)) this.commands += 1;
  }

  private readStatusProjection(): string | undefined {
    const markdown = this.readStatusMarkdown();
    return markdown ? projectStatusMarkdown(markdown) : undefined;
  }

  private readOperatorStatus(): OperatorStatus | undefined {
    const markdown = this.readStatusMarkdown();
    return markdown ? projectOperatorStatus(markdown) : undefined;
  }

  private readStatusMarkdown(): string | undefined {
    const statusFilePath = this.options.statusFilePath;
    const workspacePath = this.options.workspacePath;
    if (!statusFilePath || !workspacePath) return undefined;
    try {
      const realWorkspace = fs.realpathSync(workspacePath);
      const realStatus = fs.realpathSync(statusFilePath);
      if (realStatus !== realWorkspace && !realStatus.startsWith(`${realWorkspace}${path.sep}`)) return undefined;
      const stat = fs.statSync(realStatus);
      if (!stat.isFile() || stat.size > MAX_STATUS_BYTES) return undefined;
      return fs.readFileSync(realStatus, "utf-8");
    } catch {
      return undefined;
    }
  }
}

export function projectStatusMarkdown(markdown: string): string | undefined {
  const normalized = markdown.replaceAll("\0", "�").replace(/\r\n?/g, "\n");
  const explicitSection = normalized.match(/^## Matrix update\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im)?.[1];
  // The profile contract makes this a compact bullet block. Stop at the first
  // blank-line boundary as a defensive fallback for legacy ledgers that placed
  // unheaded history immediately after the current Matrix update.
  const explicit = explicitSection?.split(/\n\s*\n/, 1)[0]?.trim();
  if (explicit) return limitProjection(`📍 **Workspace update**\n${explicit}`);

  const fields = new Map<string, string>();
  for (const line of normalized.split("\n")) {
    const match = line.match(/^-\s+(Status|Current gate|Updated):\s*(.+)$/i);
    if (match) fields.set(match[1].toLowerCase(), match[2].trim());
  }
  const lines = [
    fields.get("status") ? `• **Status:** ${fields.get("status")}` : undefined,
    fields.get("current gate") ? `• **Current gate:** ${fields.get("current gate")}` : undefined,
    fields.get("updated") ? `• **Updated:** ${fields.get("updated")}` : undefined,
  ].filter((line): line is string => line !== undefined);
  if (lines.length === 0) return undefined;
  return limitProjection(`📍 **Workspace status**\n${lines.join("\n")}`);
}

export function projectOperatorStatus(markdown: string): OperatorStatus | undefined {
  const normalized = markdown.replaceAll("\0", "�").replace(/\r\n?/g, "\n");
  const section = normalized.match(/^## Matrix update\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im)?.[1]?.trim();
  if (!section) return undefined;
  const fields = new Map<string, string>();
  const bullets: string[] = [];
  for (const line of section.split("\n")) {
    const bullet = line.match(/^[-•]\s+(.+)$/)?.[1]?.trim();
    if (!bullet) continue;
    bullets.push(bullet);
    const field = bullet.match(/^(Finished|Current|Next|Action needed):\s*(.+)$/i);
    if (field) fields.set(field[1].toLowerCase(), cleanOperatorField(field[2]));
  }
  const finished = fields.get("finished") ?? bullets[0];
  const current = fields.get("current") ?? bullets[1];
  const next = fields.get("next") ?? bullets.find((value) => /^next:/i.test(value))?.replace(/^next:\s*/i, "") ?? bullets.at(-1);
  if (!finished || !current || !next) return undefined;
  return {
    finished: cleanOperatorField(finished.replace(/^finished:\s*/i, "")),
    current: cleanOperatorField(current.replace(/^current:\s*/i, "")),
    next: cleanOperatorField(next.replace(/^next:\s*/i, "")),
    ...(fields.get("action needed") ? { actionNeeded: fields.get("action needed") } : {}),
  };
}

function cleanOperatorField(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length <= 1_000 ? singleLine : `${singleLine.slice(0, 997).trimEnd()}…`;
}

function normalizeCapacityPayload(value: unknown): CapacitySnapshot | undefined {
  const reports = record(value)?.reports;
  if (!Array.isArray(reports)) return undefined;
  const limits: CapacityLimit[] = [];
  let fetchedAt = 0;
  for (const reportValue of reports) {
    const report = record(reportValue);
    if (!report) continue;
    fetchedAt = Math.max(fetchedAt, nonNegativeNumber(report.fetchedAt) ?? 0);
    const reportProvider = typeof report.provider === "string" ? report.provider : undefined;
    if (!Array.isArray(report.limits)) continue;
    for (const limitValue of report.limits) {
      const limit = record(limitValue);
      const scope = record(limit?.scope);
      const window = record(limit?.window);
      const amount = record(limit?.amount);
      const provider = typeof scope?.provider === "string" ? scope.provider : reportProvider;
      const windowId = typeof scope?.windowId === "string"
        ? scope.windowId
        : typeof window?.id === "string" ? window.id : undefined;
      const remaining = nonNegativeNumber(amount?.remaining)
        ?? (nonNegativeNumber(amount?.remainingFraction) !== undefined ? nonNegativeNumber(amount?.remainingFraction)! * 100 : undefined);
      if (!provider || !windowId || remaining === undefined) continue;
      limits.push({
        provider,
        windowId,
        ...(typeof scope?.tier === "string" ? { tier: scope.tier } : {}),
        ...(typeof scope?.modelId === "string" ? { modelId: scope.modelId } : {}),
        ...(typeof scope?.shared === "boolean" ? { shared: scope.shared } : {}),
        remaining: Math.max(0, Math.min(100, remaining)),
        ...(nonNegativeNumber(window?.resetsAt) !== undefined ? { resetsAt: nonNegativeNumber(window?.resetsAt) } : {}),
        ...(typeof limit?.status === "string" ? { status: limit.status } : {}),
      });
    }
  }
  return fetchedAt > 0 && limits.length > 0 ? { fetchedAt, limits } : undefined;
}

function relevantCapacityLimits(limits: CapacityLimit[], usedModels: ReadonlySet<string>): CapacityLimit[] {
  const byProvider = new Map<string, string[]>();
  for (const model of usedModels) {
    const [provider] = model.split("/");
    if (!provider) continue;
    const rows = byProvider.get(provider.toLowerCase()) ?? [];
    rows.push(model.toLowerCase());
    byProvider.set(provider.toLowerCase(), rows);
  }
  const deduplicated = new Map<string, CapacityLimit>();
  for (const limit of limits) {
    const models = byProvider.get(limit.provider.toLowerCase());
    if (!models?.length) continue;
    if (limit.tier && !models.some((model) => model.includes(limit.tier!.toLowerCase()))) continue;
    if (limit.modelId) {
      const needle = comparableModel(limit.modelId);
      if (!models.some((model) => comparableModel(model).includes(needle))) continue;
    }
    const key = [limit.provider, limit.tier ?? "", limit.modelId ?? "", limit.windowId, limit.remaining, limit.resetsAt ?? ""].join("\0");
    deduplicated.set(key, limit);
  }
  return [...deduplicated.values()];
}

function formatCapacityGroups(limits: CapacityLimit[], timeZone?: string): string[] {
  const groups = new Map<string, CapacityLimit[]>();
  for (const limit of limits) {
    const label = limit.tier
      ? limit.provider === "anthropic" ? `Claude ${readableWords(limit.tier)}` : `${providerLabel(limit.provider)} ${readableWords(limit.tier)}`
      : limit.modelId ? readableWords(limit.modelId) : providerLabel(limit.provider);
    const rows = groups.get(label) ?? [];
    rows.push(limit);
    groups.set(label, rows);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, rows]) => {
      const windows = rows
        .sort((left, right) => windowOrder(left.windowId) - windowOrder(right.windowId) || left.windowId.localeCompare(right.windowId))
        .map((limit) => {
          const reset = limit.resetsAt ? ` · resets ${formatReset(limit.resetsAt, limit.windowId, timeZone)}` : "";
          return `${Math.round(limit.remaining)}% ${limit.windowId}${reset}`;
        });
      return `${label}: ${windows.join("; ")}`;
    });
}

function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    "openai-codex": "OpenAI Codex",
    anthropic: "Anthropic",
    "google-antigravity": "Google Antigravity",
  };
  return labels[provider] ?? readableWords(provider);
}

function comparableModel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function windowOrder(value: string): number {
  const match = value.match(/^(\d+)([hdw])$/i);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const multiplier = match[2].toLowerCase() === "h" ? 1 : match[2].toLowerCase() === "d" ? 24 : 168;
  return Number(match[1]) * multiplier;
}

function formatReset(value: number, windowId: string, timeZone?: string): string {
  return formatDate(value, {
    ...(windowOrder(windowId) >= 24 ? { weekday: "short" as const } : {}),
    hour: "2-digit",
    minute: "2-digit",
  }, timeZone);
}

function formatClock(value: number, timeZone?: string): string {
  return formatDate(value, { hour: "2-digit", minute: "2-digit" }, timeZone);
}

function formatDate(value: number, options: Intl.DateTimeFormatOptions, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, hour12: false, ...(timeZone ? { timeZone } : {}) }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...options, hour12: false, timeZone: "UTC" }).format(new Date(value));
  }
}

function existingTaskResultSequence(directory: string | undefined): number {
  if (!directory) return 0;
  try {
    return fs.readdirSync(directory).reduce((maximum, name) => {
      const sequence = Number(name.match(/^(\d+)-/)?.[1] ?? 0);
      return Number.isSafeInteger(sequence) ? Math.max(maximum, sequence) : maximum;
    }, 0);
  } catch {
    return 0;
  }
}

function limitProjection(value: string): string {
  if (value.length <= MAX_STATUS_PROJECTION_CHARS) return value;
  return `${value.slice(0, MAX_STATUS_PROJECTION_CHARS - 20).trimEnd()}\n…(status shortened)`;
}

function taskItems(value: unknown): Array<Record<string, unknown>> {
  const args = record(value) ?? {};
  if (Array.isArray(args.tasks)) return args.tasks.map(record).filter((item): item is Record<string, unknown> => item !== undefined);
  return [args];
}

function toolDetails(value: unknown): Record<string, unknown> | undefined {
  const wrapper = record(value);
  if (!wrapper) return undefined;
  return record(wrapper.details) ?? wrapper;
}

function usageTotals(value: unknown): UsageTotals | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const input = nonNegativeNumber(usage.input) ?? 0;
  const output = nonNegativeNumber(usage.output) ?? 0;
  const cacheRead = nonNegativeNumber(usage.cacheRead) ?? 0;
  const cacheWrite = nonNegativeNumber(usage.cacheWrite) ?? 0;
  const totalTokens = nonNegativeNumber(usage.totalTokens) ?? input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, totalTokens };
}

function modelKey(provider: unknown, model: unknown): string | undefined {
  if (typeof model !== "string" || !model.trim()) return undefined;
  if (model.includes("/")) return normalizedModel(model);
  return normalizedModel(`${typeof provider === "string" && provider.trim() ? provider : "unknown"}/${model}`);
}

function normalizedModel(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().replace(/:(?:off|minimal|low|medium|high|xhigh|max|auto)$/i, "");
}

function stageLabel(agent: string, name: unknown): string {
  const labels: Record<string, string> = {
    "architecture-planner": "Architecture planning",
    "plan-reviewer": "Architecture review",
    "task-plan-reviewer": "Task plan review",
    task: "Implementation",
    "implementation-reviewer": "Implementation review",
    reviewer: "Integrated code review",
    "acceptance-reviewer": "Acceptance review",
    "source-researcher": "Source research",
    "technical-analyst": "Technical analysis",
    "market-system-analyst": "Market and operating-model analysis",
    "browser-researcher": "Browser research",
    "evidence-auditor": "Evidence audit",
    "research-critic": "Recommendation challenge",
  };
  if (labels[agent]) return labels[agent];
  if (typeof name === "string" && name.trim()) return readableWords(name);
  return readableWords(agent);
}

function stageDescription(label: string): string {
  const descriptions: Record<string, string> = {
    "Architecture planning": "The architecture agent is shaping the wider plan and acceptance criteria.",
    "Architecture review": "An independent reviewer is checking the plan for gaps, contradictions, and delivery risk.",
    "Task plan review": "An independent reviewer is checking that every build task is bounded and testable.",
    Implementation: "The implementation agent is building and validating the accepted task.",
    "Implementation review": "An independent reviewer is checking the task implementation and its evidence.",
    "Integrated code review": "The complete change is being reviewed across task boundaries.",
    "Acceptance review": "The finished project is being checked against the original brief and acceptance criteria.",
    "Source research": "A specialist is finding and appraising decision-relevant sources.",
    "Technical analysis": "A specialist is examining feasibility, architecture, data, and integration choices.",
    "Market and operating-model analysis": "A specialist is examining users, incentives, markets, and operating models.",
    "Browser research": "A specialist is collecting evidence from pages that require browser interaction.",
    "Evidence audit": "A specialist is tracing important claims back to their sources.",
    "Recommendation challenge": "An independent critic is testing assumptions, omissions, and trade-offs.",
  };
  return descriptions[label] ?? "A specialist agent is working on this bounded part of the run.";
}

function formatStageResult(stage: RunningStage, values: unknown[], now: number): string {
  const results = values.map(record).filter((item): item is Record<string, unknown> => item !== undefined);
  if (results.length <= 1) {
    const result = results[0];
    const label = stage.labels[0] ?? "Specialist task";
    const outcome = resultOutcome(result);
    const model = result ? normalizedModel(result.resolvedModel) : undefined;
    const duration = result ? nonNegativeNumber(result.durationMs) : undefined;
    const elapsed = duration ?? Math.max(0, now - stage.startedAt);
    const confidence = resultConfidence(result);
    const icon = outcome.kind === "passed" || outcome.kind === "completed" ? "✅" : outcome.kind === "revision" ? "🟠" : "⚠️";
    const meta = [model ? displayModel(model) : undefined, formatDuration(elapsed), confidence].filter(Boolean).join(" · ");
    return `${icon} **${label} ${outcome.text}**${meta ? ` · ${meta}` : ""}${outcome.kind === "failed" ? "\nThe lead agent will handle the failure or ask for help if it is genuinely blocked." : ""}`;
  }

  const lines = ["✅ **Specialist round finished**"];
  for (const [index, result] of results.entries()) {
    const label = stage.labels[index] ?? stageLabel(String(result.agent ?? "task"), result.id);
    const outcome = resultOutcome(result);
    const model = normalizedModel(result.resolvedModel);
    const icon = outcome.kind === "passed" || outcome.kind === "completed" ? "✅" : outcome.kind === "revision" ? "🟠" : "⚠️";
    lines.push(`• ${icon} ${label}: ${outcome.text}${model ? ` · ${displayModel(model)}` : ""}`);
  }
  return lines.join("\n");
}

function operatorStageOutcome(stage: RunningStage, values: unknown[], now: number): string {
  const results = values.map(record).filter((item): item is Record<string, unknown> => item !== undefined);
  if (stage.labels.length === 1) {
    const result = results[0];
    const outcome = resultOutcome(result);
    const duration = result ? nonNegativeNumber(result.durationMs) : undefined;
    const elapsed = duration ?? Math.max(0, now - stage.startedAt);
    return `${stage.labels[0]} ${outcome.text} (${formatDuration(elapsed)}).`;
  }
  const failed = results.some((result) => resultOutcome(result).kind === "failed");
  const revision = results.some((result) => resultOutcome(result).kind === "revision");
  const outcome = failed ? "finished with a failure" : revision ? "finished with requested revisions" : "completed";
  return `${stage.labels.length} specialist tasks ${outcome}.`;
}

function nextActionAfterStage(labels: string[]): string {
  const actions: Record<string, string> = {
    "Architecture planning": "Run the independent architecture review.",
    "Architecture review": "Apply only blocking corrections or create the accepted task plan.",
    "Task plan review": "Begin the first accepted implementation task or correct the bounded task plan.",
    Implementation: "Validate the task and run its independent implementation review.",
    "Implementation review": "Advance to the next task or apply the review's blocking correction.",
    "Integrated code review": "Run final acceptance review after any blocking corrections are closed.",
    "Acceptance review": "Finalize the run if accepted or create one bounded correction task.",
    "Source research": "Synthesize the evidence and resolve decision-critical gaps.",
    "Technical analysis": "Integrate feasibility findings into the recommendation.",
    "Market and operating-model analysis": "Integrate market and operating-model findings into the recommendation.",
    "Browser research": "Trace the collected evidence into the decision pack.",
    "Evidence audit": "Repair material traceability gaps, then finalize the recommendation.",
    "Recommendation challenge": "Resolve material criticism and finalize the recommendation.",
  };
  if (labels.length === 1 && actions[labels[0]]) return actions[labels[0]];
  return "Synthesize the completed specialist work and continue to the next bounded gate.";
}

function resultOutcome(result: Record<string, unknown> | undefined): { kind: "passed" | "completed" | "revision" | "failed"; text: string } {
  if (!result || nonNegativeNumber(result.exitCode) !== 0 || result.error) return { kind: "failed", text: "failed" };
  const structured = record(result.structuredOutput);
  const data = record(structured?.data);
  const verdict = String(data?.verdict ?? "").toLowerCase();
  if (verdict === "pass" || verdict === "passed") return { kind: "passed", text: "passed" };
  if (["block", "blocked", "revise", "revision"].includes(verdict)) return { kind: "revision", text: "requested revisions" };
  if (["fail", "failed"].includes(verdict)) return { kind: "failed", text: "failed" };
  return { kind: "completed", text: "completed" };
}

function resultConfidence(result: Record<string, unknown> | undefined): string | undefined {
  const data = record(record(result?.structuredOutput)?.data);
  const confidence = nonNegativeNumber(data?.confidence);
  if (confidence === undefined || confidence > 1) return undefined;
  return `${Math.round(confidence * 100)}% confidence`;
}

function displayModel(model: string): string {
  const [provider, ...idParts] = model.split("/");
  const id = idParts.join("/") || provider;
  const names: Record<string, string> = {
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "gpt-5.6-terra": "GPT-5.6 Terra",
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "claude-fable-5": "Claude Fable 5",
    "claude-opus-5": "Claude Opus 5",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
  };
  const name = names[id] ?? readableWords(id);
  return idParts.length > 0 ? `${name} (${provider})` : name;
}

function readableWords(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function safeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "task";
}

function formatTokens(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatElapsedMinutes(value: number): string {
  const minutes = Math.max(1, Math.floor(value / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function formatOperatorElapsed(value: number): string {
  const minutes = Math.max(1, Math.floor(value / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${minutes}m`;
}

function formatDuration(value: number): string {
  const totalSeconds = Math.max(0, Math.round(value / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
