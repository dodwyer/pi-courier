interface WritableTarget {
  write(chunk: string): unknown;
}

interface ActivityRendererOptions {
  raw?: boolean;
  stdout?: WritableTarget;
  stderr?: WritableTarget;
}

interface ControlResponse {
  activity?: {
    frame?: Record<string, unknown>;
  };
}

/** Decode only visible newline escapes while retaining partial sequences between RPC frames. */
export class LiteralNewlineDecoder {
  private carry = "";

  write(chunk: string): string {
    const input = this.carry + chunk;
    this.carry = "";
    const partial = longestPartialNewlineEscape(input);
    const complete = partial ? input.slice(0, -partial.length) : input;
    this.carry = partial;
    return complete.replace(/\\r\\n|\\n/g, "\n");
  }

  flush(): string {
    const remaining = this.carry;
    this.carry = "";
    return remaining;
  }
}

export class ActivityRenderer {
  private readonly raw: boolean;
  private readonly stdout: WritableTarget;
  private readonly stderr: WritableTarget;
  private readonly decoder = new LiteralNewlineDecoder();
  private streamKind?: string;

  constructor(options: ActivityRendererOptions = {}) {
    this.raw = options.raw ?? false;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
  }

  render(response: ControlResponse): void {
    const frame = response.activity?.frame;
    if (!frame) return;
    switch (frame.type) {
      case "message_update": {
        const event = frame.assistantMessageEvent as Record<string, unknown> | undefined;
        const delta = event?.delta ?? event?.text ?? event?.thinking;
        if (delta !== undefined && delta !== null && delta !== "") {
          this.writeStream(String(event?.type ?? "message_update"), String(delta));
        }
        return;
      }
      case "tool_execution_start":
        this.flush();
        this.stdout.write(`\n\x1b[36m🔧 ${String(frame.toolName ?? "tool")}\x1b[0m\n`);
        return;
      case "tool_execution_end":
        this.flush();
        this.stdout.write(`\x1b[2m${frame.isError ? "tool failed" : "tool complete"}\x1b[0m\n`);
        return;
      case "turn_start":
        this.flush();
        this.stdout.write("\n\x1b[1mOMP\x1b[0m\n");
        return;
      case "turn_end":
      case "agent_end":
        this.flush();
        this.stdout.write("\n");
        return;
      case "process_stderr":
        this.flush();
        this.stderr.write(`\x1b[33m${String(frame.message)}\x1b[0m\n`);
    }
  }

  flush(): void {
    if (!this.raw) this.stdout.write(this.decoder.flush());
    this.streamKind = undefined;
  }

  private writeStream(kind: string, chunk: string): void {
    if (this.streamKind !== undefined && this.streamKind !== kind) this.flush();
    this.streamKind = kind;
    this.stdout.write(this.raw ? chunk : this.decoder.write(chunk));
  }
}

function longestPartialNewlineEscape(input: string): string {
  for (const prefix of ["\\r\\", "\\r", "\\"] as const) {
    if (input.endsWith(prefix)) return prefix;
  }
  return "";
}
