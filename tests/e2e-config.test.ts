import { describe, expect, it } from "vitest";
import { makeRunId, makeWorkspaceName, validateE2eSuiteConfig } from "../src/e2e/config";

const valid = {
  schemaVersion: 1,
  suite: "courier-smoke",
  matrix: {
    homeserverUrl: "https://matrix.example.test",
    accessTokenFile: "/run/credentials/token",
    botUserId: "@bob-canary:example.test",
    storageDir: "/var/lib/courier-e2e/matrix",
  },
  courier: {
    controlSocket: "/run/courier-canary/control.sock",
    workspaceRoot: "/srv/threads-canary",
  },
  reportDir: "/var/lib/courier-e2e/reports",
  cases: [{ id: "dev", profile: "development", kind: "development", prompt: "Build a fixture." }],
};

describe("E2E suite configuration", () => {
  it("accepts a fixed suite and applies the bounded timeout default", () => {
    const config = validateE2eSuiteConfig(valid);
    expect(config.caseTimeoutSeconds).toBe(7200);
    expect(config.cases).toHaveLength(1);
  });

  it("rejects duplicate case IDs", () => {
    expect(() => validateE2eSuiteConfig({
      ...valid,
      cases: [valid.cases[0], valid.cases[0]],
    })).toThrow("Duplicate E2E case id");
  });

  it("rejects suites whose generated workspace names would exceed Courier limits", () => {
    expect(() => validateE2eSuiteConfig({ ...valid, suite: "x".repeat(50) }))
      .toThrow("longer than 63");
  });

  it("rejects insecure homeservers and arbitrary case kinds", () => {
    expect(() => validateE2eSuiteConfig({
      ...valid,
      matrix: { ...valid.matrix, homeserverUrl: "http://matrix.example.test" },
    })).toThrow("must use HTTPS");
    expect(() => validateE2eSuiteConfig({
      ...valid,
      cases: [{ ...valid.cases[0], kind: "shell" }],
    })).toThrow("development or research");
  });

  it("generates bounded, stable workspace names", () => {
    expect(makeRunId(new Date("2026-08-18T12:34:56.789Z"))).toBe("20260818t123456z");
    expect(makeWorkspaceName("courier-smoke", "20260818t123456z", "dev"))
      .toBe("courier-smoke-20260818t123456z-dev");
    expect(() => makeWorkspaceName("x".repeat(60), "run", "case")).toThrow("longer than 63");
  });
});
