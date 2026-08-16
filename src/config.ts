import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { MsgBridgeConfig } from "./types.js";

const CONFIG_PATH = process.env.PI_COURIER_CONFIG ?? path.join(os.homedir(), ".pi", "pi-courier.json");
const CONFIG_DIR = path.dirname(CONFIG_PATH);

const DEFAULT_PROFILES: NonNullable<MsgBridgeConfig["profiles"]> = {
  research: {
    tools: ["read", "grep", "glob", "web_search", "write", "edit"],
    approvalMode: "write",
  },
  development: {
    tools: ["read", "grep", "glob", "lsp", "edit", "write", "bash", "python", "notebook", "inspect_image", "web_search", "todo"],
    approvalMode: "always-ask",
  },
  "autonomous-development": {
    tools: ["read", "grep", "glob", "lsp", "edit", "write", "bash", "python", "notebook", "inspect_image", "web_search", "todo", "task"],
    approvalMode: "yolo",
  },
};

/**
 * Load config from file and env vars (env vars override file).
 */
export function loadConfig(): MsgBridgeConfig {
  const stateDir = process.env.PI_COURIER_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "omp-courier");
  const config: MsgBridgeConfig = {
    workspaceRoot: process.env.PI_WORKSPACE_ROOT ?? "/srv/threads",
    stateDir,
    controlSocket: process.env.PI_COURIER_SOCKET ?? path.join(stateDir, "control.sock"),
    maxWorkers: 4,
    idleTimeoutSeconds: 1800,
    approvalTimeoutSeconds: 600,
    profiles: DEFAULT_PROFILES,
    externalWorkspaces: {},
  };

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const stats = fs.statSync(CONFIG_PATH);
      const mode = stats.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        console.warn(`⚠️  Config file ${CONFIG_PATH} has insecure permissions (${mode.toString(8)}). Should be 0600.`);
      }

      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      Object.assign(config, fileConfig);
    } catch (err) {
      console.error("Failed to load config file:", err);
    }
  }

  // Environment variables override file config (higher priority).
  // Matrix connection requires both PI_MATRIX_HOMESERVER and
  // PI_MATRIX_ACCESS_TOKEN to be set; the other PI_* vars apply individually.
  if (process.env.PI_MATRIX_HOMESERVER && (process.env.PI_MATRIX_ACCESS_TOKEN || process.env.PI_MATRIX_ACCESS_TOKEN_FILE)) {
    config.matrix = {
      homeserverUrl: process.env.PI_MATRIX_HOMESERVER,
      accessToken: process.env.PI_MATRIX_ACCESS_TOKEN,
      accessTokenFile: process.env.PI_MATRIX_ACCESS_TOKEN_FILE,
      ...(process.env.PI_MATRIX_ENCRYPTION !== undefined
        ? { encryption: process.env.PI_MATRIX_ENCRYPTION === "true" }
        : {}),
    };
  } else if (process.env.PI_MATRIX_ENCRYPTION !== undefined && config.matrix) {
    config.matrix.encryption = process.env.PI_MATRIX_ENCRYPTION === "true";
  }

  // Trusted users via env: comma-separated MXIDs, e.g.
  // "PI_MATRIX_TRUSTED_USERS=@barry:matrix.purplelin.com,@alice:matrix.purplelin.com"
  if (process.env.PI_MATRIX_TRUSTED_USERS) {
    const users = process.env.PI_MATRIX_TRUSTED_USERS.split(",")
      .map((u) => u.trim())
      .filter(Boolean)
      .map((u) => (u.startsWith("matrix:") ? u : `matrix:${u}`));
    if (users.length > 0) {
      config.auth = {
        ...(config.auth ?? {}),
        trustedUsers: users,
        adminUserId: config.auth?.adminUserId ?? users[0],
      };
    }
  }

  // Working directory via env (container deployments: /root/Projects etc.)
  if (process.env.PI_WORKDIR) {
    config.workdir = process.env.PI_WORKDIR;
  }

  if (process.env.OMP_CLI_PATH) config.ompCliPath = process.env.OMP_CLI_PATH;

  if (config.matrix?.accessTokenFile && !config.matrix.accessToken) {
    try {
      config.matrix.accessToken = fs.readFileSync(config.matrix.accessTokenFile, "utf-8").trim();
    } catch (err) {
      throw new Error(`Cannot read Matrix access token file ${config.matrix.accessTokenFile}: ${(err as Error).message}`);
    }
  }

  if (config.authBroker?.tokenFile) {
    try {
      fs.accessSync(config.authBroker.tokenFile, fs.constants.R_OK);
    } catch (err) {
      throw new Error(`Cannot read OMP auth broker token file ${config.authBroker.tokenFile}: ${(err as Error).message}`);
    }
  }

  // Log level via env (debug/info/warn/error)
  if (process.env.PI_LOG_LEVEL) {
    config.logLevel = process.env.PI_LOG_LEVEL;
  }

  config.profiles = { ...DEFAULT_PROFILES, ...(config.profiles ?? {}) };
  config.externalWorkspaces ??= {};
  config.stateDir ??= stateDir;
  config.controlSocket ??= path.join(config.stateDir, "control.sock");
  if (config.matrix) {
    config.matrix.storageDir ??= path.join(config.stateDir, "matrix");
  }

  return config;
}

/**
 * Save config to file with secure permissions.
 */
export function saveConfig(config: MsgBridgeConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch (err) {
    console.warn("Failed to set directory permissions:", err);
  }
}
