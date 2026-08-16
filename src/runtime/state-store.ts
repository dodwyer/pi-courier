import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ThreadRecord {
  threadKey: string;
  roomId: string;
  rootEventId: string;
  transport: string;
  username: string;
  workspace: string;
  workspacePath: string;
  profile: string;
  sessionDir: string;
  sessionFile?: string;
  status: string;
  lastActivity: number;
}

export interface WorkspaceRecord {
  name: string;
  path: string;
  kind: "managed" | "external";
  activeThreadKey?: string;
  lastThreadKey?: string;
  updatedAt: number;
}

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(stateDir, "courier.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        name TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('managed', 'external')),
        active_thread_key TEXT,
        last_thread_key TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        thread_key TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        root_event_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        username TEXT NOT NULL,
        workspace TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        profile TEXT NOT NULL,
        session_dir TEXT NOT NULL,
        session_file TEXT,
        status TEXT NOT NULL,
        last_activity INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS threads_room_root ON threads(room_id, root_event_id);
    `);
    // A process restart terminates every child, so no persisted lease remains active.
    this.db.exec("UPDATE workspaces SET active_thread_key = NULL; UPDATE threads SET status = 'stopped' WHERE status != 'stopped';");
  }

  close(): void {
    this.db.close();
  }

  upsertWorkspace(record: Omit<WorkspaceRecord, "updatedAt">): void {
    this.db.prepare(`
      INSERT INTO workspaces(name, path, kind, active_thread_key, last_thread_key, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        path=excluded.path,
        kind=excluded.kind,
        active_thread_key=workspaces.active_thread_key,
        last_thread_key=COALESCE(excluded.last_thread_key, workspaces.last_thread_key),
        updated_at=excluded.updated_at
    `).run(record.name, record.path, record.kind, record.activeThreadKey ?? null, record.lastThreadKey ?? null, Date.now());
  }

  getWorkspace(name: string): WorkspaceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE name = ?").get(name) as Record<string, unknown> | undefined;
    return row ? workspaceFromRow(row) : undefined;
  }

  listWorkspaces(): WorkspaceRecord[] {
    const rows = this.db.prepare("SELECT * FROM workspaces ORDER BY name").all() as Record<string, unknown>[];
    return rows.map(workspaceFromRow);
  }

  acquireWorkspace(name: string, threadKey: string): void {
    const workspace = this.getWorkspace(name);
    if (!workspace) throw new Error(`Workspace ${name} is not registered`);
    if (workspace.activeThreadKey && workspace.activeThreadKey !== threadKey) {
      throw new Error(`Workspace ${name} is active in another Matrix thread (${workspace.activeThreadKey})`);
    }
    this.db.prepare("UPDATE workspaces SET active_thread_key = ?, last_thread_key = ?, updated_at = ? WHERE name = ?")
      .run(threadKey, threadKey, Date.now(), name);
  }

  releaseWorkspace(name: string, threadKey: string): void {
    this.db.prepare("UPDATE workspaces SET active_thread_key = NULL, updated_at = ? WHERE name = ? AND active_thread_key = ?")
      .run(Date.now(), name, threadKey);
  }

  upsertThread(record: ThreadRecord): void {
    this.db.prepare(`
      INSERT INTO threads(thread_key, room_id, root_event_id, transport, username, workspace, workspace_path, profile, session_dir, session_file, status, last_activity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_key) DO UPDATE SET
        transport=excluded.transport,
        username=excluded.username,
        workspace=excluded.workspace,
        workspace_path=excluded.workspace_path,
        profile=excluded.profile,
        session_dir=excluded.session_dir,
        session_file=COALESCE(excluded.session_file, threads.session_file),
        status=excluded.status,
        last_activity=excluded.last_activity
    `).run(
      record.threadKey,
      record.roomId,
      record.rootEventId,
      record.transport,
      record.username,
      record.workspace,
      record.workspacePath,
      record.profile,
      record.sessionDir,
      record.sessionFile ?? null,
      record.status,
      record.lastActivity,
    );
  }

  getThread(threadKey: string): ThreadRecord | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE thread_key = ?").get(threadKey) as Record<string, unknown> | undefined;
    return row ? threadFromRow(row) : undefined;
  }

  getThreadByRoomRoot(roomId: string, rootEventId: string): ThreadRecord | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE room_id = ? AND root_event_id = ?")
      .get(roomId, rootEventId) as Record<string, unknown> | undefined;
    return row ? threadFromRow(row) : undefined;
  }

  getLastThreadForWorkspace(name: string): ThreadRecord | undefined {
    const workspace = this.getWorkspace(name);
    return workspace?.lastThreadKey ? this.getThread(workspace.lastThreadKey) : undefined;
  }

  listThreads(): ThreadRecord[] {
    const rows = this.db.prepare("SELECT * FROM threads ORDER BY last_activity DESC").all() as Record<string, unknown>[];
    return rows.map(threadFromRow);
  }

  setThreadStatus(threadKey: string, status: string, sessionFile?: string): void {
    this.db.prepare("UPDATE threads SET status = ?, session_file = COALESCE(?, session_file), last_activity = ? WHERE thread_key = ?")
      .run(status, sessionFile ?? null, Date.now(), threadKey);
  }
}

function workspaceFromRow(row: Record<string, unknown>): WorkspaceRecord {
  return {
    name: String(row.name),
    path: String(row.path),
    kind: row.kind as WorkspaceRecord["kind"],
    activeThreadKey: row.active_thread_key ? String(row.active_thread_key) : undefined,
    lastThreadKey: row.last_thread_key ? String(row.last_thread_key) : undefined,
    updatedAt: Number(row.updated_at),
  };
}

function threadFromRow(row: Record<string, unknown>): ThreadRecord {
  return {
    threadKey: String(row.thread_key),
    roomId: String(row.room_id),
    rootEventId: String(row.root_event_id),
    transport: String(row.transport),
    username: String(row.username),
    workspace: String(row.workspace),
    workspacePath: String(row.workspace_path),
    profile: String(row.profile),
    sessionDir: String(row.session_dir),
    sessionFile: row.session_file ? String(row.session_file) : undefined,
    status: String(row.status),
    lastActivity: Number(row.last_activity),
  };
}
