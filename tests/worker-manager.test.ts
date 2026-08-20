import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerManager } from "../src/runtime/worker-manager";
import type { ExternalMessage, MsgBridgeConfig } from "../src/types";

describe("WorkerManager", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("isolates Matrix threads in named workspaces and routes their replies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-worker-test-"));
    dirs.push(dir);
    const fakeOmp = join(dir, "omp");
    writeFileSync(fakeOmp, `#!/usr/bin/env node
const readline = require("node:readline");
process.stdout.write(JSON.stringify({type:"ready"}) + "\\n");
const rl = readline.createInterface({input: process.stdin});
rl.on("line", line => {
  const frame = JSON.parse(line);
  if (frame.type === "get_state") {
    process.stdout.write(JSON.stringify({type:"response",id:frame.id,command:frame.type,success:true,data:{sessionId:process.pid.toString(),sessionFile:process.cwd()+"/session.jsonl",model:{id:"fake",provider:"test"}}})+"\\n");
  } else if (frame.type === "prompt") {
    process.stdout.write(JSON.stringify({type:"response",id:frame.id,command:frame.type,success:true,data:{agentInvoked:true}})+"\\n");
    process.stdout.write(JSON.stringify({type:"turn_start"})+"\\n");
    const content = frame.message === "tool-only" ? [
      {type:"toolCall",name:"secret_tool",arguments:{token:"raw-tool-secret"}}
    ] : [
      {type:"text",text:"reply:"+frame.message},
      {type:"thinking",text:"hidden reasoning"},
      {type:"toolCall",name:"secret_tool",arguments:{token:"raw-tool-secret"}}
    ];
    process.stdout.write(JSON.stringify({type:"turn_end",message:{role:"assistant",content}})+"\\n");
    process.stdout.write(JSON.stringify({type:"agent_end"})+"\\n");
  } else if (frame.type === "abort") {
    process.stdout.write(JSON.stringify({type:"response",id:frame.id,command:frame.type,success:true})+"\\n");
  }
});
`, { mode: 0o755 });
    chmodSync(fakeOmp, 0o755);
    const config: MsgBridgeConfig = {
      workspaceRoot: join(dir, "threads"),
      stateDir: join(dir, "state"),
      controlSocket: join(dir, "control.sock"),
      ompCliPath: fakeOmp,
      maxWorkers: 4,
      idleTimeoutSeconds: 3600,
      approvalTimeoutSeconds: 60,
      hideToolCalls: true,
      externalWorkspaces: {},
      profiles: {
        research: { tools: ["read", "write"], approvalMode: "write" },
        development: { tools: ["read", "write"], approvalMode: "always-ask" },
      },
    };
    const replies: Array<{ workspace: string; text: string }> = [];
    const manager = new WorkerManager({
      config,
      sendReply: async (record, text) => { replies.push({ workspace: record.workspace, text }); },
      sendTyping: async () => {},
    });
    const first = message("$root-a", "room-a");
    const second = message("$root-b", "room-b");
    const firstRecord = await manager.start(first, "research", "nomadmade");
    const secondRecord = await manager.start(second, "research", "another-topic");
    await manager.prompt({ ...first, threadRootId: firstRecord.rootEventId }, "alpha");
    await manager.prompt({ ...second, threadRootId: secondRecord.rootEventId }, "beta");
    await manager.prompt({ ...first, threadRootId: firstRecord.rootEventId }, "tool-only");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(replies.some((reply) => reply.workspace === "nomadmade" && reply.text.startsWith("reply:alpha"))).toBe(true);
    expect(replies.some((reply) => reply.workspace === "another-topic" && reply.text.startsWith("reply:beta"))).toBe(true);
    expect(replies.some((reply) => reply.text.includes("raw-tool-secret") || reply.text.includes("secret_tool"))).toBe(false);
    expect(replies.some((reply) => reply.text === "")).toBe(false);
    expect(firstRecord.sessionDir).not.toBe(secondRecord.sessionDir);
    const firstTranscript = readFileSync(join(firstRecord.workspacePath, ".courier", "transcript.md"), "utf-8");
    const secondTranscript = readFileSync(join(secondRecord.workspacePath, ".courier", "transcript.md"), "utf-8");
    expect(firstTranscript).toContain("Human-readable Matrix conversation mirror");
    expect(firstTranscript).toContain("**Sender:** `@david:example.com`");
    expect(firstTranscript).toContain("alpha");
    expect(firstTranscript).toContain("reply:alpha");
    expect(firstTranscript).not.toContain("hidden reasoning");
    expect(firstTranscript).not.toContain("raw-tool-secret");
    expect(firstTranscript).not.toContain("secret_tool");
    expect(firstTranscript).not.toContain("beta");
    expect(secondTranscript).toContain("beta");
    expect(statSync(join(firstRecord.workspacePath, ".courier", "transcript.md")).mode & 0o777).toBe(0o600);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: firstRecord.workspacePath, encoding: "utf-8" })).toBe("");

    const source = manager.workspaces.resolve("research-source");
    mkdirSync(join(source.path, "development-briefs"), { recursive: true });
    writeFileSync(join(source.path, "development-briefs", "tool.md"), "# Approved\n");
    const handoffMessage = message("$root-c", "room-c");
    const handoffRecord = await manager.startFromBrief(
      handoffMessage,
      "development",
      "build-tool",
      "research-source/development-briefs/tool.md",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(readFileSync(join(handoffRecord.workspacePath, "BRIEF.md"), "utf-8")).toBe("# Approved\n");
    expect(readFileSync(join(handoffRecord.workspacePath, ".courier", "transcript.md"), "utf-8")).toContain(
      "Read BRIEF.md and use it as the approved development brief.",
    );
    await expect(
      manager.startFromBrief(first, "development", "must-not-exist", "research-source/development-briefs/tool.md"),
    ).rejects.toThrow(/already initialized/);
    expect(existsSync(join(dir, "threads", "must-not-exist"))).toBe(false);
    expect(manager.store.getThread(firstRecord.threadKey)).toBeDefined();
    await manager.shutdown();
  }, 15_000);

  it("rolls back a new brief workspace when the development worker cannot start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-worker-handoff-failure-"));
    dirs.push(dir);
    const manager = new WorkerManager({
      config: {
        workspaceRoot: join(dir, "threads"),
        stateDir: join(dir, "state"),
        controlSocket: join(dir, "control.sock"),
        ompCliPath: join(dir, "missing-omp"),
        externalWorkspaces: {},
        profiles: { development: { tools: ["read", "write"], approvalMode: "always-ask" } },
      },
      sendReply: async () => {},
      sendTyping: async () => {},
    });
    const source = manager.workspaces.resolve("research-source");
    mkdirSync(join(source.path, "development-briefs"), { recursive: true });
    writeFileSync(join(source.path, "development-briefs", "tool.md"), "# Approved\n");
    const msg = message("$failed-root", "failed-room");

    await expect(
      manager.startFromBrief(msg, "development", "failed-build", "research-source/development-briefs/tool.md"),
    ).rejects.toThrow();
    expect(existsSync(join(dir, "threads", "failed-build"))).toBe(false);
    expect(manager.store.getWorkspace("failed-build")).toBeUndefined();
    expect(manager.store.getThread("failed-room\u001f$failed-root")).toBeUndefined();
    expect(readdirSync(join(dir, "state", "sessions"))).toEqual([]);
    await manager.shutdown();
  });

  it("blocks a changed workflow contract until an explicit migration starts a clean lead session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-worker-contract-test-"));
    dirs.push(dir);
    const fakeOmp = join(dir, "omp");
    writeFileSync(fakeOmp, `#!/usr/bin/env node
const readline = require("node:readline");
process.stdout.write(JSON.stringify({type:"ready"}) + "\\n");
const rl = readline.createInterface({input: process.stdin});
rl.on("line", line => {
  const frame = JSON.parse(line);
  if (frame.type === "get_state") {
    process.stdout.write(JSON.stringify({type:"response",id:frame.id,command:frame.type,success:true,data:{sessionId:process.pid.toString(),sessionFile:process.cwd()+"/session-"+process.pid+".jsonl"}})+"\\n");
  } else if (frame.type === "prompt") {
    process.stdout.write(JSON.stringify({type:"response",id:frame.id,command:frame.type,success:true,data:{agentInvoked:true}})+"\\n");
    process.stdout.write(JSON.stringify({type:"agent_start"})+"\\n");
    process.stdout.write(JSON.stringify({type:"agent_end"})+"\\n");
  } else if (frame.type === "new_session") {
    process.stdout.write(JSON.stringify({type:"response",id:frame.id,command:frame.type,success:true,data:{cancelled:false}})+"\\n");
  }
});
`, { mode: 0o755 });
    chmodSync(fakeOmp, 0o755);
    const promptFile = join(dir, "AGENTS.md");
    const configFile = join(dir, "development.yml");
    writeFileSync(promptFile, "workflow one\n");
    writeFileSync(configFile, "modelRoles: {}\n");
    const config: MsgBridgeConfig = {
      workspaceRoot: join(dir, "threads"),
      stateDir: join(dir, "state"),
      controlSocket: join(dir, "control.sock"),
      ompCliPath: fakeOmp,
      externalWorkspaces: {},
      profiles: {
        development: {
          tools: ["read", "task"],
          approvalMode: "write",
          configFiles: [configFile],
          workflowContract: {
            version: "development-v2",
            stateDirectory: ".courier/development",
            promptFiles: [promptFile],
            expectedModels: { lead: "test/fake:max" },
            toolchainIdentity: "test-image-1",
            rotationRequestFile: ".courier/development/rotate.json",
          },
        },
      },
    };
    const replies: string[] = [];
    const manager = new WorkerManager({
      config,
      sendReply: async (_record, text) => { replies.push(text); },
      sendTyping: async () => {},
    });
    const record = await manager.start(message("$contract-root", "contract-room"), "development", "contract-workspace");
    expect(record.workflowContractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(join(record.workspacePath, ".courier", "development", "run-contract.json"))).toBe(true);

    const ledger = join(record.workspacePath, ".courier", "development", "state.json");
    writeFileSync(ledger, "{}\n");
    writeFileSync(join(record.workspacePath, ".courier", "development", "rotate.json"), JSON.stringify({
      schemaVersion: 1,
      contractSha256: record.workflowContractHash,
      acceptedTask: "TASK-1",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      summary: "Task one passed its independent review.",
      nextTask: "TASK-2",
      ledgerPaths: [".courier/development/state.json"],
    }));
    await manager.prompt({ ...message("$rotation-prompt", "contract-room"), threadRootId: "$contract-root" }, "finish task one");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replies).toContainEqual(expect.stringContaining("Lead context rotated"));
    expect(existsSync(join(record.workspacePath, ".courier", "development", "rotate.json"))).toBe(false);
    expect(readdirSync(join(record.workspacePath, ".courier", "development", "rotations"))).toHaveLength(1);

    writeFileSync(promptFile, "workflow two\n");
    await expect(manager.resumeWorkspace(record.workspace, "continue product work")).rejects.toThrow(/run !migrate/);

    const migrated = await manager.migrateWorkspace(record.workspace);
    expect(migrated.workflowContractHash).not.toBe(record.workflowContractHash);
    expect(migrated.sessionDir).toContain("-migration-");
    await manager.shutdown();
  });
});

function message(messageId: string, chatId: string): ExternalMessage {
  return {
    chatId,
    transport: "matrix",
    content: "",
    username: "david",
    userId: "@david:example.com",
    timestamp: new Date(),
    messageId,
    isGroupChat: false,
  };
}
