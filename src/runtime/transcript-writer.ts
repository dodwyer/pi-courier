import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExternalMessage } from "../types.js";
import type { ThreadRecord } from "./state-store.js";

const HEADER = `# OMP Courier transcript

> Human-readable Matrix conversation mirror. The protected OMP JSONL session is authoritative for resume and attach.
> Hidden reasoning, raw tool results, and approval payloads are not recorded. Text pasted into chat may still be sensitive.

`;

export class TranscriptWriter {
  ensureThread(record: ThreadRecord): void {
    const transcriptPath = this.ensureTranscript(record.workspacePath);
    const marker = `<!-- courier-thread:${digest(record.threadKey)} -->`;
    if (containsMarker(transcriptPath, marker)) return;
    append(transcriptPath, `${marker}\n## Matrix thread · ${new Date(record.lastActivity).toISOString()}\n\n- Profile: \`${inline(record.profile)}\`\n- Matrix root: \`${inline(record.rootEventId)}\`\n\n`);
  }

  appendUser(record: ThreadRecord, msg: ExternalMessage, text: string): void {
    const body = normalize(text);
    if (!body) return;
    this.ensureThread(record);
    const transcriptPath = this.ensureTranscript(record.workspacePath);
    const marker = `<!-- matrix-event:${digest(msg.messageId)} -->`;
    if (containsMarker(transcriptPath, marker)) return;
    const sender = msg.userId || msg.username;
    append(transcriptPath, `${marker}\n### User · ${msg.timestamp.toISOString()}\n\n**Sender:** \`${inline(sender)}\`\n\n${body}\n\n`);
  }

  appendAssistant(record: ThreadRecord, text: string, at = new Date()): void {
    const body = normalize(text);
    if (!body) return;
    this.ensureThread(record);
    append(this.ensureTranscript(record.workspacePath), `### Assistant · ${at.toISOString()}\n\n${body}\n\n`);
  }

  pathFor(workspacePath: string): string {
    return path.join(workspacePath, ".courier", "transcript.md");
  }

  private ensureTranscript(workspacePath: string): string {
    const metadataDir = path.join(workspacePath, ".courier");
    fs.mkdirSync(metadataDir, { recursive: true, mode: 0o700 });
    const transcriptPath = this.pathFor(workspacePath);
    try {
      fs.writeFileSync(transcriptPath, HEADER, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    fs.chmodSync(transcriptPath, 0o600);
    return transcriptPath;
  }
}

function append(transcriptPath: string, text: string): void {
  fs.appendFileSync(transcriptPath, text, { encoding: "utf-8", mode: 0o600 });
}

function containsMarker(transcriptPath: string, marker: string): boolean {
  return fs.readFileSync(transcriptPath, "utf-8").includes(marker);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function inline(value: string): string {
  return value.replaceAll("`", "\\`").replace(/[\r\n\0]/g, " ");
}

function normalize(value: string): string {
  return value.replaceAll("\0", "�").replace(/\r\n?/g, "\n").trim();
}
