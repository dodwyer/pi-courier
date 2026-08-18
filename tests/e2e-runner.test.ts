import { describe, expect, it, vi } from "vitest";
import { requireExactDirectMembers, waitForMember } from "../src/e2e/room";

describe("E2E Matrix room bootstrap", () => {
  it("accepts the configured bot only after it is joined", async () => {
    const getJoinedRoomMembers = vi.fn().mockResolvedValue(["@driver:example.test", "@bot:example.test"]);
    await expect(waitForMember({ getJoinedRoomMembers }, "!room:example.test", "@bot:example.test", 100))
      .resolves.toBeUndefined();
    expect(getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.test");
  });

  it("fails closed when the bot never joins", async () => {
    const getJoinedRoomMembers = vi.fn().mockResolvedValue(["@driver:example.test"]);
    await expect(waitForMember({ getJoinedRoomMembers }, "!room:example.test", "@bot:example.test", 0))
      .rejects.toThrow("Timed out waiting for @bot:example.test");
  });

  it("rejects a room containing any third joined user", () => {
    expect(() => requireExactDirectMembers(
      ["@driver:example.test", "@bot:example.test", "@third:example.test"],
      "@driver:example.test",
      "@bot:example.test",
    )).toThrow("must contain only");
  });
});
