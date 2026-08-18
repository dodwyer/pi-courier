import * as net from "node:net";
import type { ControlStatusResponse } from "./types.js";

export async function requestWorkspaceStatus(socketPath: string, workspace: string): Promise<ControlStatusResponse | undefined> {
  try {
    return await request(socketPath, { command: "status", workspace }) as unknown as ControlStatusResponse;
  } catch (err) {
    if ((err as Error).message === `Unknown workspace ${workspace}`) return undefined;
    throw err;
  }
}

async function request(socketPath: string, command: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback();
    };
    socket.setEncoding("utf-8");
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("connect", () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        if (!response.ok) {
          finish(() => reject(new Error(String(response.error ?? "Courier control request failed"))));
          return;
        }
        finish(() => resolve(response));
      } catch (err) {
        finish(() => reject(err));
      }
    });
  });
}
