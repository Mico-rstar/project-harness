import { describe, expect, test } from "bun:test";
import { preview, projectMessage, projectSnapshot } from "../src/web/projection";
import type { RuntimeSnapshot } from "../src/runtime/contracts";

describe("Web presentation boundary", () => {
  test("tool calls/results retain their association and errors while non-text media degrades safely", () => {
    const assistant = projectMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Reading a file" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
        { type: "image", data: "private-image-bytes" },
      ],
    });
    expect(assistant?.blocks).toEqual([
      { type: "text", text: "Reading a file" },
      {
        type: "tool",
        tool: { toolCallId: "call-1", toolName: "read", args: '{\n  "path": "README.md"\n}' },
      },
      { type: "notice", text: "[image]" },
    ]);
    expect(
      projectMessage({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "File not found" }],
      }),
    ).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      blocks: [
        { type: "tool", tool: { toolCallId: "call-1", isError: true, result: "File not found" } },
      ],
    });
  });

  test("extension output with cycles and bigint does not break the JSON event stream", () => {
    const output: { count: bigint; self?: object } = { count: 9n };
    output.self = output;
    expect(JSON.parse(preview(output))).toEqual({ count: "9", self: "[循环引用]" });
    expect(preview("a".repeat(40_000))).toContain("预览已截断");
  });

  test("large extension values stop before visiting the full object", () => {
    let visits = 0;
    const values = Array.from({ length: 5_000 }, () => ({
      get detail() {
        visits++;
        return "x".repeat(100);
      },
    }));
    const result = preview(values);
    expect(result).toContain("预览已截断");
    expect(visits).toBeLessThan(500);
    expect(result.length).toBeLessThan(33_000);
  });

  test("browser snapshot does not expose session file addresses or image payloads in input receipts", () => {
    const snapshot: RuntimeSnapshot = {
      epoch: "e",
      seq: 2,
      mainSessionId: "m",
      project: { name: "demo", repoRoot: "/repo" },
      owners: [
        {
          id: "one",
          title: "First",
          branch: "task",
          worktree: "/work",
          baseSha: "sha",
          sharedDir: "/shared",
          sessionFile: "/private/owner.jsonl",
        },
      ],
      agents: [
        {
          id: "one",
          displayName: "First",
          kind: "owner",
          status: "idle",
          sessionFile: "/private/owner.jsonl",
        },
      ],
      sessions: [],
      cooperation: [],
      pendingUIRequests: [],
      inputReceipts: [
        {
          epoch: "e",
          clientInputId: "i",
          text: "hello",
          behavior: "followUp",
          state: "admitted",
          receivedAt: 1,
          updatedAt: 2,
          images: [{ type: "image", mimeType: "image/png", data: "private-image-bytes" }],
        },
      ],
      health: { degraded: false, issues: [] },
      closing: false,
    };
    const json = JSON.stringify(projectSnapshot(snapshot));
    expect(json).not.toContain("/private/");
    expect(json).not.toContain("private-image-bytes");
    expect(JSON.parse(json).owners[0]).toEqual({
      id: "one",
      title: "First",
      branch: "task",
      worktree: "/work",
    });
  });
});
