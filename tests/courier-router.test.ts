import { describe, expect, it, vi } from "vitest";
import { CourierRouter } from "../src/runtime/courier-router";
import type { WorkerManager } from "../src/runtime/worker-manager";
import type { ExternalMessage, MsgBridgeConfig } from "../src/types";

describe("CourierRouter", () => {
  it("routes the exact brief handoff syntax to the development workflow", async () => {
    const startFromBrief = vi.fn(async () => ({
      profile: "development",
      workspacePath: "/srv/threads/build-tool",
      rootEventId: "$root",
    }));
    const replies: string[] = [];
    const router = new CourierRouter({
      config: config(),
      workers: { startFromBrief } as unknown as WorkerManager,
      reply: async (_msg, text) => { replies.push(text); },
    });

    await router.handle(message("!start development build-tool --brief research-source/development-briefs/tool.md"));

    expect(startFromBrief).toHaveBeenCalledWith(
      expect.anything(),
      "development",
      "build-tool",
      "research-source/development-briefs/tool.md",
    );
    expect(replies[0]).toContain("from approved brief");
  });

  it("rejects prompts mixed with a brief handoff", async () => {
    const startFromBrief = vi.fn();
    const replies: string[] = [];
    const router = new CourierRouter({
      config: config(),
      workers: { startFromBrief } as unknown as WorkerManager,
      reply: async (_msg, text) => { replies.push(text); },
    });

    await router.handle(message("!start development build-tool please --brief research-source/development-briefs/tool.md"));

    expect(startFromBrief).not.toHaveBeenCalled();
    expect(replies[0]).toContain("Usage: !start development");
  });
});

function config(): MsgBridgeConfig {
  return {
    profiles: { development: { tools: ["read", "write"], approvalMode: "always-ask" } },
  };
}

function message(content: string): ExternalMessage {
  return {
    chatId: "room",
    transport: "matrix",
    content,
    username: "david",
    userId: "@david:example.com",
    timestamp: new Date(),
    messageId: "$root",
    isGroupChat: false,
  };
}
