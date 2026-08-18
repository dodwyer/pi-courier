#!/usr/bin/env node
import { loadE2eSuiteConfig } from "./e2e/config.js";
import { runE2eSuite } from "./e2e/runner.js";

function usage(): void {
  console.log("Usage: courier-e2e run --config <suite.json>");
}

async function main(): Promise<void> {
  const [command, configFlag, configPath, ...rest] = process.argv.slice(2);
  if (command !== "run" || configFlag !== "--config" || !configPath || rest.length > 0) {
    usage();
    process.exitCode = 2;
    return;
  }
  const config = loadE2eSuiteConfig(configPath);
  const { report, paths } = await runE2eSuite(config);
  console.log(JSON.stringify({ status: report.status, runId: report.runId, reports: paths }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch((err) => {
  console.error(`courier-e2e: ${(err as Error).message}`);
  process.exit(1);
});
