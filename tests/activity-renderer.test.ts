import { describe, expect, it } from "vitest";
import { ActivityRenderer, LiteralNewlineDecoder } from "../src/activity-renderer";

describe("LiteralNewlineDecoder", () => {
  it("decodes literal LF and CRLF escapes without changing other escapes", () => {
    const decoder = new LiteralNewlineDecoder();
    expect(decoder.write("first\\nsecond\\r\\nthird\\tvalue")).toBe("first\nsecond\nthird\\tvalue");
    expect(decoder.flush()).toBe("");
  });

  it("decodes newline escapes split across streaming frames", () => {
    const decoder = new LiteralNewlineDecoder();
    expect(decoder.write("first\\")).toBe("first");
    expect(decoder.write("nsecond\\r")).toBe("\nsecond");
    expect(decoder.write("\\")).toBe("");
    expect(decoder.write("nthird")).toBe("\nthird");
    expect(decoder.flush()).toBe("");
  });

  it("flushes an incomplete escape unchanged", () => {
    const decoder = new LiteralNewlineDecoder();
    expect(decoder.write("path\\")).toBe("path");
    expect(decoder.flush()).toBe("\\");
  });
});

describe("ActivityRenderer", () => {
  it("renders human-readable newlines by default", () => {
    const output: string[] = [];
    const renderer = new ActivityRenderer({ stdout: { write: (chunk) => output.push(chunk) } });
    renderer.render({ activity: { frame: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "one\\n" } } } });
    renderer.render({ activity: { frame: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "two" } } } });
    renderer.flush();
    expect(output.join("")).toBe("one\ntwo");
  });

  it("preserves exact streamed text in raw mode", () => {
    const output: string[] = [];
    const renderer = new ActivityRenderer({ raw: true, stdout: { write: (chunk) => output.push(chunk) } });
    renderer.render({ activity: { frame: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "one\\n" } } } });
    renderer.render({ activity: { frame: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "two" } } } });
    renderer.flush();
    expect(output.join("")).toBe("one\\ntwo");
  });
});
