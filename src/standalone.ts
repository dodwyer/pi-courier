/** Host-native Matrix bridge for isolated Oh My Pi RPC workers. */
import { pathToFileURL } from "node:url";
import { ChallengeAuth } from "./auth/challenge-auth.js";
import { loadConfig } from "./config.js";
import { acquireLock, releaseLock } from "./lock.js";
import { logger, parseLogLevel, setLogLevel } from "./logger.js";
import { ControlServer } from "./runtime/control-server.js";
import { CourierRouter } from "./runtime/courier-router.js";
import { WorkerManager } from "./runtime/worker-manager.js";
import { TransportManager } from "./transports/manager.js";
import { MatrixProvider } from "./transports/matrix.js";
import type { ReplyContext } from "./types.js";

function parseArgs(argv: string[]): { logLevel?: string } {
  const result: { logLevel?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--level") result.logLevel = argv[++i];
    else logger.warn(`[bridge] ignoring unknown argument: ${argv[i]}`);
  }
  return result;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (!acquireLock()) throw new Error("another pi-courier instance is already running");
  const args = parseArgs(argv);
  const config = loadConfig();
  const level = args.logLevel ? parseLogLevel(args.logLevel) : parseLogLevel(config.logLevel ?? "info");
  setLogLevel(level ?? "info");

  const matrix = config.matrix;
  if (!matrix?.homeserverUrl || !matrix.accessToken) {
    releaseLock();
    throw new Error("Matrix homeserver and access token/accessTokenFile are required");
  }
  if (!config.ompCliPath) logger.warn("ompCliPath is not configured; resolving omp from PATH");

  const auth = new ChallengeAuth(
    (code, username) => logger.warn(`Authorization challenge for @${username}: ${code}`),
    (message, authLevel) => logger.info(`[auth:${authLevel ?? "info"}] ${message}`),
    async () => {},
    () => logger.warn("Runtime authorization changes are not persisted; update the Ansible-managed config instead"),
  );
  if (config.auth) auth.loadFromConfig(config.auth);

  const transports = new TransportManager();
  transports.addTransport(new MatrixProvider({
    homeserverUrl: matrix.homeserverUrl,
    accessToken: matrix.accessToken,
    encryption: matrix.encryption,
    allowGroupRooms: matrix.allowGroupRooms,
    storageDir: matrix.storageDir,
  }, auth));

  const workers = new WorkerManager({
    config,
    sendReply: async (record, text, context) => transports.sendMessage(record.roomId, record.transport, text, context),
    sendTyping: async (record) => transports.sendTyping(record.roomId, record.transport),
  });

  const sendIncomingReply = async (
    msg: { chatId: string; transport: string; messageId: string; threadRootId?: string },
    text: string,
    context?: ReplyContext,
  ): Promise<void> => {
    await transports.sendMessage(msg.chatId, msg.transport, text, context ?? {
      threadRootId: msg.threadRootId,
      replyToId: msg.messageId,
    });
  };
  const router = new CourierRouter({ config, workers, reply: sendIncomingReply });
  transports.onMessage((msg) => void router.handle(msg).catch((err) => logger.error(`[bridge] message failed: ${(err as Error).message}`)));
  transports.onError((err, transport) => logger.error(`[bridge] ${transport}: ${err.message}`));

  const control = new ControlServer(config, workers);
  try {
    await transports.connectAll();
    await workers.recoverInterrupted();
    await control.start();
  } catch (err) {
    await workers.shutdown();
    await transports.disconnectAll();
    releaseLock();
    throw err;
  }

  logger.info(`OMP Courier ready (workspaceRoot=${config.workspaceRoot}, maxWorkers=${config.maxWorkers ?? 4})`);
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received; stopping courier`);
    await control.stop();
    await workers.shutdown();
    await transports.disconnectAll();
    releaseLock();
  };
  process.once("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[bridge] fatal: ${(err as Error).stack ?? (err as Error).message}`);
    releaseLock();
    process.exit(1);
  });
}
