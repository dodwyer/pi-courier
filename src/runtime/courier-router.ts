import type { ExternalMessage, MsgBridgeConfig, ReplyContext } from "../types.js";
import { WorkerManager } from "./worker-manager.js";

export interface CourierRouterDeps {
  config: MsgBridgeConfig;
  workers: WorkerManager;
  reply: (msg: ExternalMessage, text: string, context?: ReplyContext) => Promise<void>;
}

export class CourierRouter {
  constructor(private readonly deps: CourierRouterDeps) {}

  async handle(msg: ExternalMessage): Promise<void> {
    const text = msg.content.trim();
    if (!text) return;
    if (!text.startsWith("!")) {
      await this.withError(msg, () => this.deps.workers.prompt(msg, text));
      return;
    }

    const [command, ...parts] = text.split(/\s+/);
    const name = command.toLowerCase();
    switch (name) {
      case "!start":
        await this.withError(msg, async () => {
          if (parts.length < 2) throw new Error("Usage: !start <profile> <workspace> [initial prompt]");
          const [profile, workspace, ...promptParts] = parts;
          const parsed = parseStartOptions(promptParts);
          if (parsed.brief) {
            if (parsed.references.length > 0 || parsed.prompt.length > 0) {
              throw new Error("Usage: !start development <workspace> --brief <source-workspace>/development-briefs/<brief>.md");
            }
            const record = await this.deps.workers.startFromBrief(msg, profile, workspace, parsed.brief);
            await this.reply(
              msg,
              `✅ Started **${record.profile}** in \`${record.workspacePath}\` from approved brief \`${parsed.brief}\`.`,
              record.rootEventId,
            );
          } else {
            const record = await this.deps.workers.start(msg, profile, workspace, parsed.references);
            await this.reply(msg, `✅ Started **${record.profile}** in \`${record.workspacePath}\`.`, record.rootEventId);
            if (parsed.prompt.length === 0) return;
            const threaded = { ...msg, threadRootId: record.rootEventId };
            await this.deps.workers.prompt(threaded, parsed.prompt.join(" "));
          }
        });
        return;
      case "!continue":
        await this.withError(msg, async () => {
          if (parts.length !== 1) throw new Error("Usage: !continue <workspace>");
          const record = await this.deps.workers.continue(msg, parts[0]);
          await this.reply(msg, `✅ Resumed **${record.profile}** in \`${record.workspacePath}\`.`, record.rootEventId);
        });
        return;
      case "!new":
        await this.withError(msg, async () => {
          const record = await this.deps.workers.newSession(msg, parts[0]);
          await this.reply(msg, `✅ New OMP session started with profile **${record.profile}**.`, record.rootEventId);
        });
        return;
      case "!migrate":
        await this.withError(msg, async () => {
          if (parts.length !== 0) throw new Error("Usage: !migrate");
          const record = await this.deps.workers.migrate(msg);
          await this.reply(
            msg,
            `✅ Workflow contract migrated for **${record.workspace}**. The new lead is reconciling the durable ledger and will stop before product work.`,
            record.rootEventId,
          );
        });
        return;
      case "!status":
        await this.withError(msg, async () => {
          const record = this.deps.workers.status(msg);
          const runtime = await this.deps.workers.runtimeStatus(record);
          await this.reply(
            msg,
            [
              `Workspace: **${record.workspace}**`,
              `Profile: **${record.profile}**`,
              `Agent: **${record.status}**`,
              ...(runtime ? [`Environment: **${runtime.state}** (\`${runtime.instance}\`, workspace \`${runtime.guestWorkspace}\`)`] : ["Environment: **host**"]),
              `Path: \`${record.workspacePath}\``,
              `Session: \`${record.sessionFile ?? "not created yet"}\``,
              `Workflow contract: \`${record.workflowContractHash?.slice(0, 12) ?? "legacy (resume-compatible)"}\``,
            ].join("\n"),
            record.rootEventId,
          );
        });
        return;
      case "!stop":
        await this.withError(msg, async () => {
          await this.deps.workers.stop(msg);
          await this.reply(msg, "🛑 OMP worker stopped. Its files and session were retained.");
        });
        return;
      case "!abort":
        await this.withError(msg, async () => {
          await this.deps.workers.abort(msg);
          await this.reply(msg, "🛑 Current OMP turn aborted.");
        });
        return;
      case "!approve":
      case "!deny":
        await this.withError(msg, async () => {
          if (parts.length !== 1) throw new Error(`Usage: ${name} <approval-id>`);
          await this.deps.workers.resolveApproval(msg, parts[0], name === "!approve");
          await this.reply(msg, name === "!approve" ? "✅ Approved." : "⛔ Denied.");
        });
        return;
      case "!choose":
        await this.withError(msg, async () => {
          if (parts.length !== 2) throw new Error("Usage: !choose <interaction-id> <number>");
          const value = await this.deps.workers.resolveSelection(msg, parts[0], parts[1]);
          await this.reply(msg, `✅ Selected: ${value}`);
        });
        return;
      case "!answer":
        await this.withError(msg, async () => {
          const answer = parseAnswer(msg.content);
          await this.deps.workers.resolveTextInput(msg, answer.shortId, answer.value);
          await this.reply(msg, "✅ Answer submitted.");
        });
        return;
      case "!cancel":
        await this.withError(msg, async () => {
          if (parts.length !== 1) throw new Error("Usage: !cancel <interaction-id>");
          await this.deps.workers.cancelInteraction(msg, parts[0]);
          await this.reply(msg, "⛔ Interaction cancelled.");
        });
        return;
      case "!profiles":
        await this.reply(msg, `Profiles:\n${Object.keys(this.deps.config.profiles ?? {}).map((profile) => `• ${profile}`).join("\n")}`);
        return;
      case "!workspaces": {
        const rows = this.deps.workers.store.listWorkspaces();
        await this.reply(msg, rows.length
          ? `Workspaces:\n${rows.map((row) => `• ${row.name} — ${row.activeThreadKey ? "active" : "idle"} — \`${row.path}\``).join("\n")}`
          : "No workspaces have been created yet.");
        return;
      }
      case "!help":
        await this.reply(msg, helpText());
        return;
      default:
        await this.reply(msg, `Unknown courier command ${command}. Use !help.`);
    }
  }

  private async withError(msg: ExternalMessage, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      await this.reply(msg, `❌ ${(err as Error).message}`);
    }
  }

  private async reply(msg: ExternalMessage, text: string, rootEventId?: string): Promise<void> {
    await this.deps.reply(msg, text, {
      threadRootId: rootEventId ?? msg.threadRootId,
      replyToId: msg.messageId,
    });
  }
}

function helpText(): string {
  return [
    "**OMP Courier commands**",
    "• `!start <profile> <workspace> [prompt]`",
    "• `!start <profile> <workspace> [--reference <workspace>@<commit>]… [prompt]`",
    "• `!start development <workspace> --brief <source-workspace>/development-briefs/<brief>.md`",
    "• `!continue <workspace>`",
    "• `!new [profile]`",
    "• `!migrate` after Courier reports a changed workflow contract",
    "• `!status`, `!stop`, `!abort`",
    "• `!approve <id>`, `!deny <id>`",
    "• `!choose <id> <number>`, `!answer <id> <text>`, `!cancel <id>`",
    "• `!profiles`, `!workspaces`",
    "",
    "Dynamic workspaces are created under the configured workspace root. Existing repositories use `repo:<name>`.",
  ].join("\n");
}

function parseStartOptions(parts: string[]): { brief?: string; references: string[]; prompt: string[] } {
  const references: string[] = [];
  let index = 0;
  let brief: string | undefined;
  while (index < parts.length) {
    if (parts[index] === "--reference") {
      if (!parts[index + 1]) throw new Error("--reference requires <workspace>@<git-commit>");
      references.push(parts[index + 1]);
      index += 2;
      continue;
    }
    if (parts[index] === "--brief") {
      if (!parts[index + 1]) throw new Error("--brief requires a development brief path");
      brief = parts[index + 1];
      index += 2;
    }
    break;
  }
  const prompt = parts.slice(index);
  if (prompt.includes("--brief") || prompt.includes("--reference")) {
    throw new Error("Usage: !start development <workspace> --brief <source-workspace>/development-briefs/<brief>.md; start options must precede the prompt");
  }
  return { brief, references, prompt };
}

function parseAnswer(content: string): { shortId: string; value: string } {
  const input = content.trimStart();
  const match = /^!answer[ \t]+(\S+)/i.exec(input);
  if (!match) throw new Error("Usage: !answer <interaction-id> <text>");
  const shortId = match[1];
  let value = input.slice(match[0].length);
  if (value.startsWith("\r\n")) value = value.slice(2);
  else if (value.startsWith("\n")) value = value.slice(1);
  else {
    const separator = /^[ \t]+/.exec(value);
    if (!separator) throw new Error("Usage: !answer <interaction-id> <text>");
    value = value.slice(separator[0].length);
    if (value.startsWith("\r\n")) value = value.slice(2);
    else if (value.startsWith("\n")) value = value.slice(1);
  }
  if (!value.trim()) throw new Error("Answer cannot be empty; use !cancel to cancel the interaction");
  return { shortId, value };
}
