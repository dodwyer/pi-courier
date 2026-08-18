import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/e2e/report";
import type { E2eRunReport } from "../src/e2e/types";

describe("E2E report", () => {
  it("renders failures without embedding suite prompts or credentials", () => {
    const report: E2eRunReport = {
      schemaVersion: 1,
      suite: "courier-smoke",
      runId: "20260818t123456z",
      startedAt: "2026-08-18T12:34:56Z",
      finishedAt: "2026-08-18T12:35:56Z",
      status: "failed",
      roomId: "!room:example.test",
      cases: [{
        id: "dev",
        profile: "development",
        kind: "development",
        workspace: "courier-smoke-20260818t123456z-dev",
        startedAt: "2026-08-18T12:34:56Z",
        finishedAt: "2026-08-18T12:35:56Z",
        durationSeconds: 60,
        status: "failed",
        checks: [{ name: "state|file", passed: false, detail: "missing\nfile" }],
        error: "Artifact check failed",
      }],
    };
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("**FAILED**");
    expect(markdown).toContain("state\\|file");
    expect(markdown).toContain("missing file");
  });
});
