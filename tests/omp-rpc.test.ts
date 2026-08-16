import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpc, type RpcFrame } from "../src/rpc/pi-rpc";

describe("PiRpc OMP adapter", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("spawns the configured executable directly and correlates RPC frames", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-rpc-test-"));
    dirs.push(dir);
    const fakeOmp = join(dir, "omp");
    writeFileSync(fakeOmp, `#!/usr/bin/env node
const readline = require("node:readline");
process.stdout.write(JSON.stringify({type:"ready"}) + "\\n");
const rl = readline.createInterface({input: process.stdin});
rl.on("line", line => {
  const frame = JSON.parse(line);
  if (frame.type === "get_state") {
    process.stdout.write(JSON.stringify({type:"response", id:frame.id, command:frame.type, success:true, data:{sessionId:"test", sessionFile:"/tmp/test.jsonl", model:{id:"model",provider:"test"}}}) + "\\n");
  } else if (frame.type === "prompt") {
    process.stdout.write(JSON.stringify({type:"response", id:frame.id, command:frame.type, success:true, data:{agentInvoked:true}}) + "\\n");
    process.stdout.write(JSON.stringify({type:"turn_start"}) + "\\n");
  }
});
`, { mode: 0o755 });
    chmodSync(fakeOmp, 0o755);
    const rpc = new PiRpc({ cliPath: fakeOmp, cwd: dir });
    const events: RpcFrame[] = [];
    rpc.onEvent((event) => events.push(event));
    await rpc.start();
    expect((await rpc.getState()).sessionId).toBe("test");
    await rpc.prompt("hello");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.some((event) => event.type === "turn_start")).toBe(true);
    await rpc.stop();
  });
});
