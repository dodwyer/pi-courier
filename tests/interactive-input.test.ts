import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerManager } from "../src/runtime/worker-manager";
import type { ExternalMessage, MsgBridgeConfig } from "../src/types";

describe("OMP interactive input bridge", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips confirm, select, input, editor, and explicit cancellation", async () => {
    const harness = await createHarness(dirs);
    try {
      const threaded = { ...harness.message, threadRootId: harness.record.rootEventId };

      await harness.manager.prompt(threaded, "confirm");
      const confirmId = await interactionId(harness.replies, "!approve");
      await harness.manager.resolveApproval(threaded, confirmId, true);

      await harness.manager.prompt(threaded, "select");
      const selectId = await interactionId(harness.replies, "!choose");
      await expect(harness.manager.resolveSelection(threaded, selectId, "3")).rejects.toThrow("between 1 and 2");
      await expect(
        harness.manager.resolveSelection({ ...threaded, chatId: "another-room" }, selectId, "2"),
      ).rejects.toThrow("another Matrix thread");
      await expect(harness.manager.resolveSelection(threaded, selectId, "2")).resolves.toBe("second option");

      await harness.manager.prompt(threaded, "input");
      const inputId = await interactionId(harness.replies, "!answer");
      await harness.manager.resolveTextInput(threaded, inputId, "short response");

      await harness.manager.prompt(threaded, "editor");
      const editorId = await interactionId(harness.replies, "!answer", inputId);
      await harness.manager.resolveTextInput(threaded, editorId, "  first line\nsecond line\n");

      await harness.manager.prompt(threaded, "cancel");
      const cancelId = await interactionId(harness.replies, "!choose", selectId);
      await harness.manager.cancelInteraction(threaded, cancelId);

      await waitFor(() => readResponses(harness.responseLog).length === 5);
      expect(readResponses(harness.responseLog)).toEqual([
        { type: "extension_ui_response", id: "ui-confirm", confirmed: true },
        { type: "extension_ui_response", id: "ui-select", value: "second option" },
        { type: "extension_ui_response", id: "ui-input", value: "short response" },
        { type: "extension_ui_response", id: "ui-editor", value: "  first line\nsecond line\n" },
        { type: "extension_ui_response", id: "ui-cancel", cancelled: true },
      ]);
    } finally {
      await harness.manager.shutdown();
    }
  });

  it("honors OMP timeouts, remote cancellation, and worker cleanup", async () => {
    const harness = await createHarness(dirs);
    try {
      const threaded = { ...harness.message, threadRootId: harness.record.rootEventId };

      await harness.manager.prompt(threaded, "timeout");
      const timedId = await interactionId(harness.replies, "!choose");
      await waitFor(() => readResponses(harness.responseLog).length === 1);
      expect(readResponses(harness.responseLog)[0]).toEqual({
        type: "extension_ui_response",
        id: "ui-timeout",
        cancelled: true,
        timedOut: true,
      });
      await expect(harness.manager.resolveSelection(threaded, timedId, "1")).rejects.toThrow("Unknown or expired");

      await harness.manager.prompt(threaded, "withdraw");
      const withdrawnId = await interactionId(harness.replies, "!choose", timedId);
      await waitFor(() => harness.replies.some((text) => text.includes(`withdrew interaction ${withdrawnId}`)));
      await expect(harness.manager.resolveSelection(threaded, withdrawnId, "1")).rejects.toThrow("Unknown or expired");

      await harness.manager.prompt(threaded, "select");
      const stoppedId = await interactionId(harness.replies, "!choose", withdrawnId);
      await harness.manager.stop(threaded);
      await expect(harness.manager.resolveSelection(threaded, stoppedId, "1")).rejects.toThrow("Unknown or expired");
    } finally {
      await harness.manager.shutdown();
    }
  });
});

async function createHarness(dirs: string[]): Promise<{
  manager: WorkerManager;
  message: ExternalMessage;
  record: Awaited<ReturnType<WorkerManager["start"]>>;
  replies: string[];
  responseLog: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "omp-interaction-test-"));
  dirs.push(dir);
  const responseLog = join(dir, "responses.jsonl");
  const fakeOmp = join(dir, "omp");
  writeFileSync(fakeOmp, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const responseLog = ${JSON.stringify(responseLog)};
const send = frame => process.stdout.write(JSON.stringify(frame) + "\\n");
send({type:"ready"});
const rl = readline.createInterface({input: process.stdin});
rl.on("line", line => {
  const frame = JSON.parse(line);
  if (frame.type === "get_state") {
    send({type:"response",id:frame.id,command:frame.type,success:true,data:{sessionId:"test",sessionFile:process.cwd()+"/session.jsonl",model:{id:"fake",provider:"test"}}});
  } else if (frame.type === "prompt") {
    send({type:"response",id:frame.id,command:frame.type,success:true,data:{agentInvoked:true}});
    send({type:"turn_start"});
    if (frame.message === "confirm") send({type:"extension_ui_request",id:"ui-confirm",method:"confirm",title:"Confirm",message:"Continue?"});
    if (frame.message === "select") send({type:"extension_ui_request",id:"ui-select",method:"select",title:"Choose",options:["first option","second option"]});
    if (frame.message === "input") send({type:"extension_ui_request",id:"ui-input",method:"input",title:"Name",placeholder:"short text"});
    if (frame.message === "editor") send({type:"extension_ui_request",id:"ui-editor",method:"editor",title:"Edit",prefill:"starting text"});
    if (frame.message === "cancel") send({type:"extension_ui_request",id:"ui-cancel",method:"select",title:"Cancel",options:["one"]});
    if (frame.message === "timeout") send({type:"extension_ui_request",id:"ui-timeout",method:"select",title:"Timeout",options:["one"],timeout:20});
    if (frame.message === "withdraw") {
      send({type:"extension_ui_request",id:"ui-withdraw",method:"select",title:"Withdraw",options:["one"]});
      setTimeout(() => send({type:"extension_ui_request",id:"cancel-withdraw",method:"cancel",targetId:"ui-withdraw"}), 20);
    }
  } else if (frame.type === "extension_ui_response") {
    fs.appendFileSync(responseLog, JSON.stringify(frame) + "\\n");
    send({type:"agent_end"});
  } else if (frame.type === "abort") {
    send({type:"response",id:frame.id,command:frame.type,success:true});
  }
});
`, { mode: 0o755 });
  chmodSync(fakeOmp, 0o755);
  const config: MsgBridgeConfig = {
    workspaceRoot: join(dir, "threads"),
    stateDir: join(dir, "state"),
    controlSocket: join(dir, "control.sock"),
    ompCliPath: fakeOmp,
    approvalTimeoutSeconds: 60,
    externalWorkspaces: {},
    profiles: { development: { tools: ["read", "write"], approvalMode: "always-ask" } },
  };
  const replies: string[] = [];
  const manager = new WorkerManager({
    config,
    sendReply: async (_record, text) => { replies.push(text); },
    sendTyping: async () => {},
  });
  const msg = message();
  const record = await manager.start(msg, "development", "interactive");
  return { manager, message: msg, record, replies, responseLog };
}

function message(): ExternalMessage {
  return {
    chatId: "room",
    transport: "matrix",
    content: "",
    username: "david",
    userId: "@david:example.com",
    timestamp: new Date(),
    messageId: "$root",
    isGroupChat: false,
  };
}

async function interactionId(replies: string[], command: string, exclude?: string): Promise<string> {
  let found = "";
  await waitFor(() => {
    const match = replies
      .map((text) => new RegExp(`\\${command} ([a-f0-9]{8})`).exec(text)?.[1])
      .find((id) => id && id !== exclude);
    if (!match) return false;
    found = match;
    return true;
  });
  return found;
}

function readResponses(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
