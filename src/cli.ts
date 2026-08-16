#!/usr/bin/env node
import * as fs from "node:fs";
import { loadConfig } from "./config.js";

function usage(): void {
  console.log(`pi-courier — Matrix threads to isolated Oh My Pi workers

Usage:
  pi-courier run [--level debug|info|warn|error]
  pi-courier check-config
  pi-courier setup

The durable service is installed as a system-level unit by the starbug Ansible
role. User-level systemd installation and self-update commands are intentionally
not provided by this fork.`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "run": {
      const { main: run } = await import("./standalone.js");
      await run(args);
      return;
    }
    case "check-config": {
      const config = loadConfig();
      if (!config.matrix?.homeserverUrl) throw new Error("matrix.homeserverUrl is required");
      if (!config.matrix.accessToken) throw new Error("matrix accessToken or readable accessTokenFile is required");
      if (!config.workspaceRoot || !config.stateDir || !config.controlSocket) throw new Error("workspaceRoot, stateDir, and controlSocket are required");
      if (!config.profiles || Object.keys(config.profiles).length === 0) throw new Error("at least one OMP profile is required");
      if (config.ompCliPath && !fs.existsSync(config.ompCliPath)) throw new Error(`ompCliPath does not exist: ${config.ompCliPath}`);
      console.log("Configuration is valid.");
      return;
    }
    case "setup": {
      const { runSetup } = await import("./setup.js");
      await runSetup();
      return;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      usage();
      return;
    default:
      usage();
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((err) => {
  console.error(`pi-courier: ${(err as Error).message}`);
  process.exit(1);
});
