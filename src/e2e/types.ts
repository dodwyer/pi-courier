export type E2eCaseKind = "development" | "research";

export interface E2eCaseConfig {
  id: string;
  profile: string;
  kind: E2eCaseKind;
  prompt: string;
}

export interface E2eSuiteConfig {
  schemaVersion: 1;
  suite: string;
  matrix: {
    homeserverUrl: string;
    accessTokenFile: string;
    botUserId: string;
    storageDir: string;
  };
  courier: {
    controlSocket: string;
    workspaceRoot: string;
  };
  reportDir: string;
  caseTimeoutSeconds?: number;
  cases: E2eCaseConfig[];
}

export interface E2eCheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface E2eCaseReport {
  id: string;
  profile: string;
  kind: E2eCaseKind;
  workspace: string;
  eventId?: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  status: "passed" | "failed";
  checks: E2eCheckResult[];
  error?: string;
}

export interface E2eRunReport {
  schemaVersion: 1;
  suite: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed";
  roomId?: string;
  error?: string;
  cases: E2eCaseReport[];
}

export interface ControlThreadStatus {
  rootEventId: string;
  profile: string;
  status: string;
  lastActivity: number;
}

export interface ControlStatusResponse {
  ok: true;
  workspace: {
    name: string;
    path: string;
  };
  thread?: ControlThreadStatus;
}
