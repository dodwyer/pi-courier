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

  it("routes explicit selection, text, multiline editor, and cancellation responses", async () => {
    const resolveSelection = vi.fn(async () => "second option");
    const resolveTextInput = vi.fn(async () => {});
    const cancelInteraction = vi.fn(async () => {});
    const replies: string[] = [];
    const router = new CourierRouter({
      config: config(),
      workers: { resolveSelection, resolveTextInput, cancelInteraction } as unknown as WorkerManager,
      reply: async (_msg, text) => { replies.push(text); },
    });

    await router.handle(message("!choose select01 2"));
    await router.handle(message("!answer input001 a short answer"));
    await router.handle(message("!answer editor01\n  first line\nsecond line\n"));
    await router.handle(message("!cancel editor02"));

    expect(resolveSelection).toHaveBeenCalledWith(expect.anything(), "select01", "2");
    expect(resolveTextInput).toHaveBeenNthCalledWith(1, expect.anything(), "input001", "a short answer");
    expect(resolveTextInput).toHaveBeenNthCalledWith(2, expect.anything(), "editor01", "  first line\nsecond line\n");
    expect(cancelInteraction).toHaveBeenCalledWith(expect.anything(), "editor02");
    expect(replies).toEqual([
      "✅ Selected: second option",
      "✅ Answer submitted.",
      "✅ Answer submitted.",
      "⛔ Interaction cancelled.",
    ]);
  });

  it("rejects an empty explicit answer", async () => {
    const resolveTextInput = vi.fn();
    const replies: string[] = [];
    const router = new CourierRouter({
      config: config(),
      workers: { resolveTextInput } as unknown as WorkerManager,
      reply: async (_msg, text) => { replies.push(text); },
    });

    await router.handle(message("!answer input001   "));

    expect(resolveTextInput).not.toHaveBeenCalled();
    expect(replies[0]).toContain("Answer cannot be empty");
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
