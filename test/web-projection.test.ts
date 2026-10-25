import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { preview, projectEntry, projectEvent, projectHistory, projectMessage, projectSession, projectSnapshot } from "../src/web/projection";
import type { RuntimeSnapshot } from "../src/runtime/contracts";

function ircCustomEntry(): SessionEntry {
  return {
    type: "custom_message",
    id: "e-irc",
    parentId: null,
    timestamp: "2026-10-25T00:00:00.000Z",
    customType: "irc:incoming",
    content: [{ type: "text", text: "<irc>protocol traffic</irc>" }],
    display: true,
  };
}

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
          worktree: "/work",
          entries: [{ path: "/work", repo: "/secret-repo", checkout: "task", baseSha: "deadbeefsha" }],
          sharedDir: "/shared",
          sessionFile: "/private/owner.jsonl",
        },
        {
          id: "two",
          title: "Second",
          worktree: "/bound",
          entries: [{ path: "/bound" }],
          sharedDir: "/shared-two",
          sessionFile: "/private/two.jsonl",
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
    expect(json).not.toContain("deadbeefsha");
    expect(json).not.toContain("secret-repo");
    expect(JSON.parse(json).owners).toEqual([
      { id: "one", title: "First", branch: "task", worktree: "/work" },
      { id: "two", title: "Second", worktree: "/bound" },
    ]);
  });

  test("agent-to-agent IRC deliveries and contentless opaque entries stay out of the transcript", () => {
    expect(projectEntry(ircCustomEntry())).toBeNull();

    const opaqueEntry = { type: "mystery", id: "e-x", parentId: null, timestamp: "t" } as unknown as Parameters<
      typeof projectEntry
    >[0];
    expect(projectEntry(opaqueEntry)).toBeNull();

    const opaqueWithContent = {
      ...opaqueEntry,
      content: [{ type: "text", text: "carry-over detail" }],
    } as unknown as Parameters<typeof projectEntry>[0];
    expect(projectEntry(opaqueWithContent)?.blocks).toEqual([
      { type: "notice", text: "会话记录" },
      { type: "text", text: "carry-over detail" },
    ]);

    expect(
      projectEntry({
        type: "custom_message",
        id: "e-boot",
        parentId: null,
        timestamp: "t",
        customType: "project-harness",
        content: [{ type: "text", text: "bootstrap" }],
        display: true,
      })?.blocks,
    ).toEqual([{ type: "notice", text: "项目会话已就绪" }]);

    expect(
      projectEntry({
        type: "compaction",
        id: "e-c",
        parentId: null,
        timestamp: "t",
        summary: "s",
        firstKeptEntryId: "e0",
        tokensBefore: 100,
      })?.blocks,
    ).toEqual([{ type: "notice", text: "会话上下文已整理" }]);
  });

  test("history pages and live entry patches drop filtered entries entirely", () => {
    const ircEntry = ircCustomEntry();
    const page = projectHistory({
      sessionId: "s",
      entries: [ircEntry],
      nextBeforeEntryId: null,
      stream: null,
      activeTools: [],
    });
    expect(page.entries).toEqual([]);

    const event = projectEvent(
      { epoch: "e", seq: 1, type: "session_entry", sessionId: "s", payload: ircEntry },
      {
        epoch: "e",
        seq: 1,
        mainSessionId: "s",
        project: { name: "demo", repoRoot: "/repo" },
        owners: [],
        agents: [],
        sessions: [],
        cooperation: [],
        pendingUIRequests: [],
        inputReceipts: [],
        health: { degraded: false, issues: [] },
        closing: false,
      },
    );
    expect(event.patch).toEqual({ kind: "noop" });
  });

  test("session snapshots expose the active model identity to the browser", () => {
    const session = projectSession({
      sessionId: "s",
      active: true,
      isStreaming: false,
      activeTools: [],
      entryCount: 0,
      model: { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
    });
    expect(session.model).toEqual({
      id: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      provider: "anthropic",
    });
    expect(
      projectSession({
        sessionId: "s",
        active: true,
        isStreaming: false,
        activeTools: [],
        entryCount: 0,
      }).model,
    ).toBeUndefined();
  });
});
