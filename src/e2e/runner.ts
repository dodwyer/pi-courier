import * as fs from "node:fs";
import * as path from "node:path";
import {
  DMs,
  LogService,
  MatrixClient,
  RichConsoleLogger,
  RustSdkCryptoStorageProvider,
  RustSdkCryptoStoreType,
  SimpleFsStorageProvider,
} from "matrix-bot-sdk";
import { makeRunId, makeWorkspaceName } from "./config.js";
import { requestWorkspaceStatus } from "./control-client.js";
import { writeReports } from "./report.js";
import { requireExactDirectMembers, waitForMember } from "./room.js";
import type { E2eCaseConfig, E2eCaseReport, E2eRunReport, E2eSuiteConfig } from "./types.js";
import { validateWorkspace } from "./validators.js";

interface BotError {
  eventId: string;
  body: string;
}

export async function runE2eSuite(config: E2eSuiteConfig): Promise<{ report: E2eRunReport; paths: { jsonPath: string; markdownPath: string } }> {
  const runId = makeRunId();
  const startedAt = new Date();
  const report: E2eRunReport = {
    schemaVersion: 1,
    suite: config.suite,
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    status: "failed",
    cases: [],
  };
  let client: MatrixClient | undefined;
  const botErrors: BotError[] = [];
  try {
    const token = fs.readFileSync(config.matrix.accessTokenFile, "utf-8").trim();
    if (!token) throw new Error("Matrix access token file is empty");
    fs.mkdirSync(config.matrix.storageDir, { recursive: true, mode: 0o700 });
    const storage = new SimpleFsStorageProvider(path.join(config.matrix.storageDir, "matrix-store.json"));
    const crypto = new RustSdkCryptoStorageProvider(
      path.join(config.matrix.storageDir, "matrix-crypto"),
      RustSdkCryptoStoreType.Sqlite,
    );
    client = new MatrixClient(config.matrix.homeserverUrl, token, storage, crypto);
    client.on("room.message", (roomId: string, event: Record<string, any>) => {
      if (roomId !== report.roomId || event.sender !== config.matrix.botUserId) return;
      const body = event.content?.body;
      if (typeof body === "string" && body.startsWith("❌")) {
        botErrors.push({ eventId: String(event.event_id ?? "unknown"), body });
      }
    });
    LogService.setLogger(new RichConsoleLogger());
    await client.start();
    const driverUserId = await client.getUserId();
    if (driverUserId === config.matrix.botUserId) throw new Error("Canary driver and Courier bot must be different Matrix users");
    const dms = new DMs(client);
    const roomId = await dms.getOrCreateDm(config.matrix.botUserId);
    report.roomId = roomId;
    await waitForMember(client, roomId, config.matrix.botUserId, 60_000);
    requireExactDirectMembers(await client.getJoinedRoomMembers(roomId), driverUserId, config.matrix.botUserId);
    const encryption = await client.getRoomStateEvent(roomId, "m.room.encryption", "") as { algorithm?: string };
    if (encryption.algorithm !== "m.megolm.v1.aes-sha2") {
      throw new Error(`Canary room ${roomId} is not encrypted with Megolm`);
    }
    for (const testCase of config.cases) {
      const workspace = makeWorkspaceName(config.suite, runId, testCase.id);
      const caseReport = await runCase(client, config, testCase, workspace, roomId, botErrors);
      report.cases.push(caseReport);
      if (caseReport.status === "failed") break;
    }
    report.status = report.cases.length === config.cases.length && report.cases.every((item) => item.status === "passed")
      ? "passed"
      : "failed";
  } catch (err) {
    report.error = (err as Error).message;
    report.status = "failed";
  } finally {
    client?.stop();
    report.finishedAt = new Date().toISOString();
  }
  const paths = writeReports(config.reportDir, report);
  return { report, paths };
}

async function runCase(
  client: MatrixClient,
  config: E2eSuiteConfig,
  testCase: E2eCaseConfig,
  workspace: string,
  roomId: string,
  botErrors: BotError[],
): Promise<E2eCaseReport> {
  const started = new Date();
  const report: E2eCaseReport = {
    id: testCase.id,
    profile: testCase.profile,
    kind: testCase.kind,
    workspace,
    startedAt: started.toISOString(),
    finishedAt: started.toISOString(),
    durationSeconds: 0,
    status: "failed",
    checks: [],
  };
  const firstErrorIndex = botErrors.length;
  try {
    const eventId = await client.sendMessage(roomId, {
      msgtype: "m.text",
      body: `!start ${testCase.profile} ${workspace} ${testCase.prompt}`,
    });
    report.eventId = eventId;
    await waitForCompletion(config, workspace, eventId, testCase.profile, botErrors, firstErrorIndex);
    const workspacePath = path.join(config.courier.workspaceRoot, workspace);
    report.checks = validateWorkspace(testCase.kind, workspacePath);
    report.status = report.checks.every((check) => check.passed) ? "passed" : "failed";
    if (report.status === "failed") report.error = "One or more artifact checks failed";
  } catch (err) {
    report.error = (err as Error).message;
  } finally {
    const finished = new Date();
    report.finishedAt = finished.toISOString();
    report.durationSeconds = Math.max(0, Math.round((finished.getTime() - started.getTime()) / 1000));
  }
  return report;
}

async function waitForCompletion(
  config: E2eSuiteConfig,
  workspace: string,
  rootEventId: string,
  expectedProfile: string,
  botErrors: BotError[],
  firstErrorIndex: number,
): Promise<void> {
  const deadline = Date.now() + (config.caseTimeoutSeconds ?? 7200) * 1000;
  let sawWork = false;
  while (Date.now() < deadline) {
    const botError = botErrors.slice(firstErrorIndex).find((item) => item.body.startsWith("❌"));
    if (botError) throw new Error(`Courier rejected the case: ${botError.body}`);
    const status = await requestWorkspaceStatus(config.courier.controlSocket, workspace);
    if (status?.thread?.rootEventId === rootEventId) {
      if (status.thread.profile !== expectedProfile) {
        throw new Error(`Courier selected profile ${status.thread.profile}, expected ${expectedProfile}`);
      }
      if (["starting", "busy"].includes(status.thread.status)) sawWork = true;
      if (["stopped", "error"].includes(status.thread.status)) {
        throw new Error(`Courier worker entered terminal failure state: ${status.thread.status}`);
      }
      if (sawWork && status.thread.status === "idle") return;
    }
    await delay(1000);
  }
  throw new Error(`Timed out waiting for ${workspace} to finish`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
