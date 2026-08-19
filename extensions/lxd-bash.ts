import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";

interface BashParams {
  command: string;
  env?: Record<string, string>;
  timeout?: number;
  cwd?: string;
  pty?: boolean;
}

/** Replace OMP's built-in Bash with an LXD-backed implementation. */
export default function lxdBash(pi: ExtensionAPI) {
  const z = pi.zod;
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name}; Courier must start this profile through its configured runtime`);
    return value;
  };
  const hostRoot = required("OMP_COURIER_HOST_WORKSPACE");
  const guestRoot = required("OMP_COURIER_GUEST_WORKSPACE");

  const guestCwd = (candidate?: string): string => {
    const host = candidate || hostRoot;
    const relative = path.relative(path.resolve(hostRoot), path.resolve(host));
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Bash cwd must remain inside the managed workspace (${hostRoot})`);
    }
    return relative ? path.posix.join(guestRoot, ...relative.split(path.sep)) : guestRoot;
  };

  const execute = async (params: BashParams, signal?: AbortSignal) => {
    if (params.pty) throw new Error("PTY Bash is available through `courierctl env shell`, not an unattended agent turn");
    const args = [
      "exec", `${required("OMP_COURIER_LXD_REMOTE")}:${required("OMP_COURIER_LXD_INSTANCE")}`,
      "--project", required("OMP_COURIER_LXD_PROJECT"),
      "--cwd", guestCwd(params.cwd),
      "--user", required("OMP_COURIER_GUEST_UID"),
      "--group", required("OMP_COURIER_GUEST_GID"),
    ];
    for (const [name, value] of Object.entries(params.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
      args.push("--env", `${name}=${value}`);
    }
    args.push("--", "bash", "-lc", params.command);
    return pi.exec(required("OMP_COURIER_LXD_COMMAND"), args, {
      signal,
      timeout: params.timeout === 0 ? undefined : Math.max(1, params.timeout ?? 300) * 1000,
      cwd: hostRoot,
    });
  };

  pi.registerTool({
    name: "bash",
    label: "Bash (isolated VM)",
    description: "Execute a shell command inside this workspace's isolated Ubuntu VM. The workspace is mounted at /workspace; Docker and build tools run inside the VM.",
    loadMode: "essential",
    approval: "write",
    strict: true,
    parameters: z.object({
      command: z.string().describe("command to execute"),
      env: z.record(z.string(), z.string()).optional().describe("extra environment variables"),
      timeout: z.number().optional().describe("timeout in seconds; 0 disables the deadline"),
      cwd: z.string().optional().describe("host workspace path; mapped into /workspace"),
      pty: z.boolean().optional().describe("interactive PTY (not available to unattended turns)"),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await execute(params as BashParams, signal);
      const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
      return {
        content: [{ type: "text", text: output || "(no output)" }],
        details: { exitCode: result.code, killed: result.killed, runtime: "lxd-vm" },
        isError: result.code !== 0,
      };
    },
  });

  pi.on("user_bash", async (event) => {
    const result = await execute({ command: event.command, cwd: event.cwd });
    const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
    return {
      result: {
        output,
        exitCode: result.code,
        cancelled: result.killed,
        truncated: false,
        totalLines: output ? output.split(/\r?\n/).length : 0,
        totalBytes: Buffer.byteLength(output),
      },
    };
  });
}
