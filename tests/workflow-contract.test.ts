import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MsgBridgeConfig, OmpProfileConfig } from "../src/types";
import { auditArtifactRoot, captureWorkflowContract } from "../src/runtime/workflow-contract";

describe("workflow contracts", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("captures prompt, model, profile, runtime image, and toolchain identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "courier-contract-test-"));
    dirs.push(dir);
    const prompt = join(dir, "AGENTS.md");
    const overlay = join(dir, "profile.yml");
    writeFileSync(prompt, "first prompt\n");
    writeFileSync(overlay, "modelRoles:\n  task: model-a:xhigh\n");
    const profile: OmpProfileConfig = {
      tools: ["read", "task"],
      approvalMode: "write",
      model: "lead:max",
      configFiles: [overlay],
      runtime: "development-vm",
      workflowContract: {
        version: "development-v2",
        stateDirectory: ".courier/development",
        promptFiles: [prompt],
        expectedModels: { lead: "lead:max", implementation: "model-a:xhigh" },
        toolchainIdentity: "toolchain-7",
      },
    };
    const config: MsgBridgeConfig = {
      profiles: { development: profile },
      runtimes: {
        "development-vm": {
          type: "lxd-vm",
          remote: "restricted",
          project: "courier",
          image: "image-generation-7",
          profile: "four-cpu-eight-gib",
        },
      },
    };

    const first = captureWorkflowContract(config, "development", profile)!;
    expect(first.value).toMatchObject({
      schemaVersion: 2,
      profileVersion: "development-v2",
      modelMap: { implementation: "model-a:xhigh", lead: "lead:max" },
      runtime: { image: "image-generation-7", profile: "four-cpu-eight-gib" },
      toolchainIdentity: "toolchain-7",
    });
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);

    writeFileSync(prompt, "changed prompt\n");
    expect(captureWorkflowContract(config, "development", profile)!.hash).not.toBe(first.hash);
  });

  it("rejects caches, virtual environments, executables, and oversized artifacts", () => {
    const workspace = mkdtempSync(join(tmpdir(), "courier-artifact-test-"));
    dirs.push(workspace);
    const root = join(workspace, ".courier");
    mkdirSync(join(root, "development", ".venv"), { recursive: true });
    writeFileSync(join(root, "development", ".venv", "python"), "binary");
    writeFileSync(join(root, "development", "tool.sh"), "#!/bin/sh\n");
    chmodSync(join(root, "development", "tool.sh"), 0o700);
    writeFileSync(join(root, "development", "large.log"), "x".repeat(20));

    const violations = auditArtifactRoot(workspace, {
      root: ".courier",
      forbiddenDirectories: [".venv", "cache", "tools"],
      maxFileBytes: 10,
      forbidExecutables: true,
    });
    expect(violations.map((item) => `${item.reason}:${item.path}`)).toEqual([
      "forbidden-directory:.courier/development/.venv",
      "oversized:.courier/development/large.log",
      "executable:.courier/development/tool.sh",
    ]);
  });
});
