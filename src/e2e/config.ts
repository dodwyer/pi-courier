import * as fs from "node:fs";
import * as path from "node:path";
import type { E2eCaseConfig, E2eSuiteConfig } from "./types.js";

const WORKSPACE_COMPONENT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MATRIX_USER_ID = /^@[^:\s]+:[^\s]+$/;

export function loadE2eSuiteConfig(configPath: string): E2eSuiteConfig {
  const absolutePath = path.resolve(configPath);
  const raw = JSON.parse(fs.readFileSync(absolutePath, "utf-8")) as unknown;
  return validateE2eSuiteConfig(raw, path.dirname(absolutePath));
}

export function validateE2eSuiteConfig(value: unknown, configDir = process.cwd()): E2eSuiteConfig {
  if (!isRecord(value)) throw new Error("E2E suite config must be a JSON object");
  if (value.schemaVersion !== 1) throw new Error("E2E suite config schemaVersion must be 1");
  const suite = requiredString(value, "suite");
  if (!WORKSPACE_COMPONENT.test(suite)) {
    throw new Error("E2E suite name must use lowercase letters, digits, and hyphens");
  }
  const matrix = requiredRecord(value, "matrix");
  const courier = requiredRecord(value, "courier");
  const botUserId = requiredString(matrix, "botUserId");
  if (!MATRIX_USER_ID.test(botUserId)) throw new Error("matrix.botUserId must be a Matrix user ID");
  const homeserverUrl = requiredString(matrix, "homeserverUrl");
  if (!homeserverUrl.startsWith("https://")) throw new Error("matrix.homeserverUrl must use HTTPS");
  const accessTokenFile = resolvePath(configDir, requiredString(matrix, "accessTokenFile"));
  const storageDir = resolvePath(configDir, requiredString(matrix, "storageDir"));
  const controlSocket = resolvePath(configDir, requiredString(courier, "controlSocket"));
  const workspaceRoot = resolvePath(configDir, requiredString(courier, "workspaceRoot"));
  const reportDir = resolvePath(configDir, requiredString(value, "reportDir"));
  const caseTimeoutSeconds = optionalPositiveInteger(value.caseTimeoutSeconds, "caseTimeoutSeconds") ?? 7200;
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error("E2E suite config must contain at least one case");
  }
  const cases = value.cases.map((item, index) => validateCase(item, index));
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate E2E case id: ${item.id}`);
    ids.add(item.id);
    makeWorkspaceName(suite, "20000101t000000z", item.id);
  }
  return {
    schemaVersion: 1,
    suite,
    matrix: { homeserverUrl, accessTokenFile, botUserId, storageDir },
    courier: { controlSocket, workspaceRoot },
    reportDir,
    caseTimeoutSeconds,
    cases,
  };
}

export function makeRunId(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase();
}

export function makeWorkspaceName(suite: string, runId: string, caseId: string): string {
  const name = `${suite}-${runId}-${caseId}`;
  if (!WORKSPACE_COMPONENT.test(name)) {
    throw new Error(`Generated workspace name is invalid or longer than 63 characters: ${name}`);
  }
  return name;
}

function validateCase(value: unknown, index: number): E2eCaseConfig {
  if (!isRecord(value)) throw new Error(`cases[${index}] must be an object`);
  const id = requiredString(value, "id");
  if (!WORKSPACE_COMPONENT.test(id)) throw new Error(`cases[${index}].id is not a valid workspace component`);
  const profile = requiredString(value, "profile");
  if (!WORKSPACE_COMPONENT.test(profile)) throw new Error(`cases[${index}].profile is invalid`);
  const kind = requiredString(value, "kind");
  if (kind !== "development" && kind !== "research") {
    throw new Error(`cases[${index}].kind must be development or research`);
  }
  const prompt = requiredString(value, "prompt");
  if (prompt.length > 16_384) throw new Error(`cases[${index}].prompt is too long`);
  return { id, profile, kind, prompt };
}

function requiredRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const child = value[key];
  if (!isRecord(child)) throw new Error(`${key} must be an object`);
  return child;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const child = value[key];
  if (typeof child !== "string" || !child.trim()) throw new Error(`${key} must be a non-empty string`);
  return child.trim();
}

function optionalPositiveInteger(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${key} must be a positive integer`);
  return value as number;
}

function resolvePath(base: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
