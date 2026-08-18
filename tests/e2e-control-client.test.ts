import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requestWorkspaceStatus } from "../src/e2e/control-client";

describe("E2E control client", () => {
  const dirs: string[] = [];
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads a matching workspace status", async () => {
    const socketPath = await serve({
      ok: true,
      workspace: { name: "smoke-dev", path: "/srv/threads-canary/smoke-dev" },
      thread: { rootEventId: "$event", profile: "development", status: "idle", lastActivity: 1 },
    });
    await expect(requestWorkspaceStatus(socketPath, "smoke-dev")).resolves.toMatchObject({
      workspace: { name: "smoke-dev" },
      thread: { rootEventId: "$event", status: "idle" },
    });
  });

  it("maps an unknown workspace to undefined", async () => {
    const socketPath = await serve({ ok: false, error: "Unknown workspace smoke-dev" });
    await expect(requestWorkspaceStatus(socketPath, "smoke-dev")).resolves.toBeUndefined();
  });

  async function serve(response: Record<string, unknown>): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "courier-e2e-control-"));
    dirs.push(dir);
    const socketPath = join(dir, "control.sock");
    const server = net.createServer((socket) => {
      socket.once("data", () => socket.end(`${JSON.stringify(response)}\n`));
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    return socketPath;
  }
});
