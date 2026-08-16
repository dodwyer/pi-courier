import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    process.stdout.write(JSON.stringify({type:"turn_end",message:{role:"assistant",content:[{type:"text",text:"reply:"+frame.message}]}})+"\\n");
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
      externalWorkspaces: {},
      profiles: { research: { tools: ["read", "write"], approvalMode: "write" } },
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
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(replies).toContainEqual({ workspace: "nomadmade", text: "reply:alpha" });
    expect(replies).toContainEqual({ workspace: "another-topic", text: "reply:beta" });
    expect(firstRecord.sessionDir).not.toBe(secondRecord.sessionDir);
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
