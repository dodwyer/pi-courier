import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LxdRuntimeManager, runtimeInstanceName } from "../src/runtime/lxd-runtime";
import type { MsgBridgeConfig, OmpProfileConfig } from "../src/types";
import type { WorkspaceRecord } from "../src/runtime/state-store";

describe("LxdRuntimeManager", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("derives stable, path-bound instance names", () => {
    expect(runtimeInstanceName("Rusty_TAMS API", "/srv/threads/rusty-tams-api")).toMatch(/^omp-rusty-tams-api-[a-f0-9]{10}$/);
    expect(runtimeInstanceName("rusty-tams-api", "/srv/threads/rusty-tams-api"))
      .toBe(runtimeInstanceName("rusty-tams-api", "/srv/threads/rusty-tams-api"));
    expect(runtimeInstanceName("rusty-tams-api", "/srv/threads/other"))
      .not.toBe(runtimeInstanceName("rusty-tams-api", "/srv/threads/rusty-tams-api"));
  });

  it("creates, starts, reports, and stops a persistent VM", async () => {
    const fixture = runtimeFixture(dirs);
    const manager = new LxdRuntimeManager(fixture.config);
    const environment = await manager.ensure(fixture.profile, fixture.workspace);

    expect(environment.OMP_COURIER_GUEST_WORKSPACE).toBe("/workspace");
    expect(environment.OMP_COURIER_LXD_PROJECT).toBe("omp-development");
    expect((await manager.status(fixture.profile, fixture.workspace))?.state).toBe("running");

    await manager.stop(fixture.profile, fixture.workspace);
    expect((await manager.status(fixture.profile, fixture.workspace))?.state).toBe("stopped");
    const commands = readFileSync(fixture.log, "utf-8");
    expect(commands).toContain('"init"');
    expect(commands).toContain('"device","add"');
    expect(commands).toContain('"start"');
    expect(commands).toContain('"stop"');
    expect(commands).not.toContain('"delete"');
  });

  it("rejects isolated runtimes for declared external workspaces", async () => {
    const fixture = runtimeFixture(dirs);
    await expect(fixture.manager.ensure(fixture.profile, { ...fixture.workspace, kind: "external" }))
      .rejects.toThrow(/limited to managed workspaces/);
  });
});

function runtimeFixture(dirs: string[]): {
  manager: LxdRuntimeManager;
  config: MsgBridgeConfig;
  profile: OmpProfileConfig;
  workspace: WorkspaceRecord;
  log: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "courier-lxd-test-"));
  dirs.push(dir);
  const state = join(dir, "state.json");
  const log = join(dir, "commands.jsonl");
  const command = join(dir, "lxc");
  writeFileSync(state, "[]\n");
  writeFileSync(command, `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = ${JSON.stringify(state)};
const logPath = ${JSON.stringify(log)};
const args = process.argv.slice(2);
fs.readFileSync(0, "utf8");
fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
const instances = JSON.parse(fs.readFileSync(statePath, "utf8"));
const target = args[0] === "init" ? args[2] : args.find(value => value.startsWith("test:"));
const name = target ? target.slice(5) : undefined;
if (args[0] === "list") {
  process.stdout.write(JSON.stringify(instances));
} else if (args[0] === "init") {
  instances.push({name, status:"Stopped", status_code:102, config:{}});
} else if (args[0] === "config" && args[1] === "set") {
  const instance = instances.find(value => value.name === name);
  for (const pair of args.slice(3)) {
    if (pair === "--project" || pair === "omp-development") continue;
    const separator = pair.indexOf("=");
    if (separator > 0) instance.config[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
} else if (args[0] === "start" || args[0] === "stop") {
  const instance = instances.find(value => value.name === name);
  instance.status = args[0] === "start" ? "Running" : "Stopped";
  instance.status_code = args[0] === "start" ? 103 : 102;
} else if (args[0] === "delete") {
  instances.splice(instances.findIndex(value => value.name === name), 1);
}
fs.writeFileSync(statePath, JSON.stringify(instances));
`, { mode: 0o755 });
  chmodSync(command, 0o755);
  const config: MsgBridgeConfig = {
    workspaceRoot: join(dir, "threads"),
    runtimes: {
      development: {
        type: "lxd-vm",
        remote: "test",
        project: "omp-development",
        image: "golden",
        profile: "development",
        commandPath: command,
      },
    },
  };
  const profile: OmpProfileConfig = { tools: ["bash"], approvalMode: "write", runtime: "development" };
  const workspace: WorkspaceRecord = {
    name: "rusty-tams-api",
    path: join(config.workspaceRoot!, "rusty-tams-api"),
    kind: "managed",
    updatedAt: Date.now(),
  };
  return { manager: new LxdRuntimeManager(config), config, profile, workspace, log };
}
