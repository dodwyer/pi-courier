/**
 * External message received from a messenger transport
 */
export interface ExternalMessage {
  /** Unique chat/channel identifier */
  chatId: string;
  /** Transport type (telegram, whatsapp, etc) */
  transport: string;
  /** Message content/text */
  content: string;
  /** Sender username */
  username: string;
  /** Sender user ID */
  userId: string;
  /** Message timestamp */
  timestamp: Date;
  /** Unique message identifier */
  messageId: string;
  /** Matrix thread root event. Undefined for a room-timeline message. */
  threadRootId?: string;
  /** Is this a group/channel message? */
  isGroupChat: boolean;
  /** Was the bot mentioned? (for group chats) */
  wasMentioned?: boolean;
}

export interface ReplyContext {
  threadRootId?: string;
  replyToId?: string;
}

export type ApprovalMode = "always-ask" | "write" | "yolo";

export interface OmpProfileConfig {
  tools: string[];
  approvalMode: ApprovalMode;
  model?: string;
  configFiles?: string[];
  /** Workspace-relative Markdown file used as the human-readable Matrix projection for this profile. */
  statusFile?: string;
  /** Prefer the status-file projection over forwarding raw lead-agent turn text to Matrix. */
  matrixUpdatesFromStatus?: boolean;
}

export interface ExternalWorkspaceConfig {
  path: string;
}

export interface RunReportingConfig {
  /** Send an in-thread usage summary at this cadence while a run is active. Zero or absent disables periodic summaries. */
  intervalSeconds?: number;
  /** Send plain-language task-stage start and completion updates. */
  readableProgress?: boolean;
  /** Send one final per-model usage summary when the run settles. */
  finalUsage?: boolean;
}

/**
 * Configuration for pi-courier
 */
export interface MsgBridgeConfig {
  matrix?: {
    homeserverUrl: string;
    accessToken?: string;
    accessTokenFile?: string;
    encryption?: boolean;
    allowGroupRooms?: boolean;
    storageDir?: string;
  };
  auth?: {
    trustedUsers?: string[];
    adminUserId?: string;
    channels?: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
  };
  hideToolCalls?: boolean;
  autoConnect?: boolean;
  showWidget?: boolean;
  debug?: boolean;
  /** pi 的工作目录(pi 子进程的 cwd;`--workdir` 参数优先) */
  workdir?: string;
  /** pi 会话存储目录(对应 pi 的 --session-dir) */
  sessionDir?: string;
  /** 显式指定 pi 的 cli.js 路径(默认:PI_CLI_PATH → which pi → 本地 node_modules) */
  cliPath?: string;
  /** 日志级别:debug | info | warn | error(默认 info;`pi-courier logs --level debug` 可查看全量) */
  logLevel?: string;
  workspaceRoot?: string;
  stateDir?: string;
  controlSocket?: string;
  ompCliPath?: string;
  maxWorkers?: number;
  idleTimeoutSeconds?: number;
  approvalTimeoutSeconds?: number;
  runReporting?: RunReportingConfig;
  profiles?: Record<string, OmpProfileConfig>;
  externalWorkspaces?: Record<string, ExternalWorkspaceConfig>;
  authBroker?: {
    url: string;
    tokenFile: string;
  };
  /**
   * 固定设备 ID(仅密码登录适用):重跑 setup 时复用同一个设备,
   * 避免换 token 后设备身份变化导致 M_BAD_JSON / 历史密钥丢失。
   * 由 setup 生成并持久化;删除此字段可重新生成(新设备身份)。
   */
  deviceId?: string;
}

/**
 * Pending remote chat session tracking
 */
export interface PendingRemoteChat {
  chatId: string;
  transport: string;
  username: string;
  messageId: string;
  threadRootId?: string;
}

/**
 * Transport connection status
 */
export interface TransportStatus {
  type: string;
  connected: boolean;
  error?: string;
}
