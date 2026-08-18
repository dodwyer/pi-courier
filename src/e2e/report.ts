import * as fs from "node:fs";
import * as path from "node:path";
import type { E2eRunReport } from "./types.js";

export function writeReports(reportDir: string, report: E2eRunReport): { jsonPath: string; markdownPath: string } {
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const base = `${report.suite}-${report.runId}`;
  const jsonPath = path.join(reportDir, `${base}.json`);
  const markdownPath = path.join(reportDir, `${base}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(markdownPath, renderMarkdown(report), { mode: 0o600 });
  return { jsonPath, markdownPath };
}

export function renderMarkdown(report: E2eRunReport): string {
  const lines = [
    `# Courier E2E: ${report.suite}`,
    "",
    `- Run: \`${report.runId}\``,
    `- Status: **${report.status.toUpperCase()}**`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    ...(report.roomId ? [`- Matrix room: \`${report.roomId}\``] : []),
    ...(report.error ? [`- Error: ${report.error}`] : []),
    "",
  ];
  for (const item of report.cases) {
    lines.push(`## ${item.id}`, "", `- Profile: \`${item.profile}\``, `- Workspace: \`${item.workspace}\``,
      `- Status: **${item.status.toUpperCase()}**`, `- Duration: ${item.durationSeconds}s`);
    if (item.error) lines.push(`- Error: ${item.error}`);
    lines.push("", "| Check | Result | Detail |", "| --- | --- | --- |");
    for (const check of item.checks) {
      lines.push(`| ${escapeCell(check.name)} | ${check.passed ? "PASS" : "FAIL"} | ${escapeCell(check.detail)} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
