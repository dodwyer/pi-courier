import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlServer } from "../src/runtime/control-server";
import type { WorkerManager } from "../src/runtime/worker-manager";
import type { MsgBridgeConfig } from "../src/types";

describe("ControlServer", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("closes long-running watch clients during shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-control-server-test-"));
    dirs.push(dir);
    const socketPath = join(dir, "control.sock");
    const unsubscribe = vi.fn();
    const workers = {
      store: { getWorkspace: () => ({ name: "research" }) },
      onActivity: () => unsubscribe,
    } as unknown as WorkerManager;
    const server = new ControlServer({ controlSocket: socketPath } as MsgBridgeConfig, workers);
    await server.start();
    const client = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    client.write(`${JSON.stringify({ command: "watch", workspace: "research" })}\n`);
    await new Promise<void>((resolve, reject) => {
      client.once("data", () => resolve());
      client.once("error", reject);
    });
    const clientClosed = new Promise<void>((resolve) => client.once("close", () => resolve()));

    await expect(Promise.race([
      server.stop().then(() => "stopped"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 250)),
    ])).resolves.toBe("stopped");
    await clientClosed;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("resumes a stopped workspace through its Matrix-owned worker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-control-resume-test-"));
    dirs.push(dir);
    const socketPath = join(dir, "control.sock");
    const resumeWorkspace = vi.fn().mockResolvedValue({ workspace: "research", status: "idle" });
    const workers = { resumeWorkspace } as unknown as WorkerManager;
    const server = new ControlServer({ controlSocket: socketPath } as MsgBridgeConfig, workers);
    await server.start();

    const response = await socketRequest(socketPath, {
      command: "resume",
      workspace: "research",
      message: "Continue from the accepted task plan.",
    });

    expect(response.ok).toBe(true);
    expect(resumeWorkspace).toHaveBeenCalledWith("research", "Continue from the accepted task plan.");
    await server.stop();
  });
});

async function socketRequest(socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let buffer = "";
    client.setEncoding("utf-8");
    client.once("error", reject);
    client.once("connect", () => client.write(`${JSON.stringify(request)}\n`));
    client.on("data", (chunk) => { buffer += chunk; });
    client.once("end", () => resolve(JSON.parse(buffer.trim()) as Record<string, unknown>));
  });
}
