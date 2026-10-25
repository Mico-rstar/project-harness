import { describe, expect, test } from "bun:test";
import {
  agentDepth,
  groupMembers,
  groupTranscript,
  mergeTool,
  runningAction,
  workSummary,
  type WorkGroup,
} from "../src/web/client/groups";
import type { WebAgent, WebBlock, WebEntry, WebOwner, WebTool } from "../src/web/contracts";

function entry(id: string, role: WebEntry["role"], blocks: WebBlock[]): WebEntry {
  return { id, timestamp: "2026-10-25T10:00:00.000Z", role, blocks };
}

function toolBlock(toolCallId: string, extra: Partial<WebTool> = {}): WebBlock {
  return { type: "tool", tool: { toolCallId, toolName: "edit", ...extra } };
}

function workGroups(groups: ReturnType<typeof groupTranscript>): WorkGroup[] {
  return groups.filter((group): group is WorkGroup => group.kind === "work");
}

describe("groupTranscript", () => {
  test("tool calls, results and thinking between texts collapse into one work group", () => {
    const groups = groupTranscript([
      entry("e1", "assistant", [toolBlock("s1", { args: "{}" })]),
      entry("e2", "tool", [toolBlock("s1", { result: "done" })]),
      entry("e3", "assistant", [{ type: "thinking", text: "hmm" }]),
      entry("e4", "assistant", [{ type: "text", text: "All good" }]),
    ]);
    const work = workGroups(groups);
    expect(work).toHaveLength(1);
    expect(work[0].tools).toEqual([{ toolCallId: "s1", toolName: "edit", args: "{}", result: "done" }]);
    expect(work[0].thinking).toEqual(["hmm"]);
    expect(work[0].running).toBe(false);
    expect(groups.filter((group) => group.kind === "message")).toHaveLength(1);
  });

  test("blocks before the first text form a work group; text closes it and later tools open a new one", () => {
    const groups = groupTranscript([
      entry("e1", "assistant", [
        { type: "thinking", text: "plan" },
        toolBlock("s1"),
        { type: "text", text: "first" },
        toolBlock("s2"),
        { type: "text", text: "second" },
      ]),
    ]);
    expect(groups).toHaveLength(4);
    const [first, second, third, fourth] = groups;
    expect(first.kind).toBe("work");
    expect(first.kind === "work" && first.thinking).toEqual(["plan"]);
    expect(first.kind === "work" && first.tools.map((tool) => tool.toolCallId)).toEqual(["s1"]);
    expect(second.kind).toBe("message");
    expect(second.kind === "message" && second.blocks[0]).toEqual({ type: "text", text: "first" });
    expect(third.kind).toBe("work");
    expect(third.kind === "work" && third.tools.map((tool) => tool.toolCallId)).toEqual(["s2"]);
    expect(fourth.kind).toBe("message");
    expect(fourth.kind === "message" && fourth.blocks[0]).toEqual({ type: "text", text: "second" });
  });

  test("work segment IDs stay unique and stable as streamed content grows or history is prepended", () => {
    const assistant = entry("assistant-1", "assistant", [
      { type: "thinking", text: "plan" },
      { type: "text", text: "first" },
      toolBlock("call-1"),
      { type: "text", text: "second" },
      { type: "thinking", text: "follow-up" },
    ]);
    const initial = groupTranscript([assistant]);
    const initialIds = initial.map((group) => group.id);
    const initialWorkIds = workGroups(initial).map((group) => group.id);

    const appended = groupTranscript([
      { ...assistant, blocks: [...assistant.blocks, toolBlock("call-2")] },
    ]);
    const prepended = groupTranscript([
      entry("older-user", "user", [{ type: "text", text: "earlier context" }]),
      assistant,
    ]);

    expect(new Set(initialIds).size).toBe(initialIds.length);
    expect(new Set(appended.map((group) => group.id)).size).toBe(appended.length);
    expect(new Set(prepended.map((group) => group.id)).size).toBe(prepended.length);
    expect(
      workGroups(appended).slice(0, initialWorkIds.length).map((group) => group.id),
    ).toEqual(initialWorkIds);
    expect(workGroups(prepended).map((group) => group.id)).toEqual(initialWorkIds);
  });

  test("streamed empty text placeholders do not terminate the running work group", () => {
    const groups = groupTranscript([
      entry("s", "assistant", [{ type: "text", text: "  " }, toolBlock("s1")]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("work");
  });

  test("user and system entries render whole and terminate the work group", () => {
    const user = entry("u1", "user", [{ type: "text", text: "hello" }]);
    const groups = groupTranscript([
      entry("a1", "assistant", [toolBlock("s1")]),
      user,
      entry("sys", "system", [{ type: "notice", text: "会话上下文已整理" }]),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0].kind).toBe("work");
    expect(groups[1].kind === "message" && groups[1].entry).toBe(user);
    expect(groups[1].kind === "message" && groups[1].blocks).toEqual(user.blocks);
    expect(groups[2].kind === "message" && groups[2].blocks).toEqual([
      { type: "notice", text: "会话上下文已整理" },
    ]);
  });

  test("stream tool call, persisted result and live tool merge into one card marked running", () => {
    const groups = groupTranscript(
      [
        entry("stream", "assistant", [toolBlock("s1", { args: "{\n  \"path\": \"a\"\n}" })]),
        entry("t1", "tool", [toolBlock("s1", { result: "ok" })]),
      ],
      { liveTools: [{ toolCallId: "s1", toolName: "edit" }], streamId: "stream" },
    );
    const work = workGroups(groups);
    expect(work).toHaveLength(1);
    expect(work[0].running).toBe(true);
    expect(work[0].tools).toEqual([
      { toolCallId: "s1", toolName: "edit", args: '{\n  "path": "a"\n}', result: "ok" },
    ]);
  });

  test("live tools with no transcript entries still form one running group", () => {
    const groups = groupTranscript([], {
      liveTools: [
        { toolCallId: "a", toolName: "read" },
        { toolCallId: "b", toolName: "bash" },
      ],
    });
    const work = workGroups(groups);
    expect(work).toHaveLength(1);
    expect(work[0].running).toBe(true);
    expect(work[0].tools.map((tool) => tool.toolCallId)).toEqual(["a", "b"]);
  });

  test("error flags aggregate onto the group header", () => {
    const groups = groupTranscript([
      entry("e1", "assistant", [toolBlock("s1")]),
      entry("e2", "tool", [toolBlock("s1", { result: "boom", isError: true })]),
    ]);
    expect(workGroups(groups)[0].hasError).toBe(true);
  });

  test("empty input yields no groups and empty accumulators are dropped", () => {
    expect(groupTranscript([])).toEqual([]);
    expect(groupTranscript([entry("e1", "assistant", [])])).toEqual([]);
  });
});

describe("workSummary", () => {
  test("names join with counts, thinking-only and notice-only get fixed copy", () => {
    const single = workGroups(groupTranscript([entry("e", "assistant", [toolBlock("1")])]))[0];
    expect(workSummary(single)).toBe("edit");
    const many = workGroups(
      groupTranscript([
        entry("e", "assistant", [toolBlock("1"), toolBlock("2", { toolName: "bash" }), toolBlock("3", { toolName: "read" })]),
      ]),
    )[0];
    expect(workSummary(many)).toBe("edit、bash 等 3 项");
    const thinkingOnly = workGroups(
      groupTranscript([entry("e", "assistant", [{ type: "thinking", text: "x" }])]),
    )[0];
    expect(workSummary(thinkingOnly)).toBe("思考过程");
  });
});

describe("mergeTool", () => {
  test("streamed args and persisted results combine without losing error state", () => {
    expect(
      mergeTool({ toolCallId: "s1", toolName: "edit", args: "{}" }, { toolCallId: "s1", toolName: "edit", result: "ok", isError: true }),
    ).toEqual({ toolCallId: "s1", toolName: "edit", args: "{}", result: "ok", isError: true });
  });
});

describe("runningAction", () => {
  test("names the newest tool still awaiting its result; completed groups have none", () => {
    const live = workGroups(
      groupTranscript(
        [
          entry("e1", "assistant", [toolBlock("s1", { toolName: "read", args: "{}" })]),
          entry("e2", "tool", [toolBlock("s1", { result: "ok" })]),
          entry("e3", "assistant", [toolBlock("s2", { toolName: "bash", args: "ls" })]),
        ],
        { liveTools: [{ toolCallId: "s2", toolName: "bash", args: "ls" }] },
      ),
    )[0];
    expect(runningAction(live)).toBe("bash");
    const done = workGroups(
      groupTranscript([
        entry("e1", "assistant", [toolBlock("s1", { args: "{}" })]),
        entry("e2", "tool", [toolBlock("s1", { result: "ok" })]),
      ]),
    )[0];
    expect(runningAction(done)).toBeNull();
  });
});

describe("groupMembers", () => {
  const owners: WebOwner[] = [{ id: "ow", title: "看板", branch: "ow", worktree: "/w" }];
  const agents: WebAgent[] = [
    { id: "main", displayName: "main", kind: "main", status: "running" },
    { id: "ow", displayName: "看板", kind: "sub", parentId: "main", status: "idle" },
    { id: "sub1", displayName: "sub1", kind: "sub", parentId: "ow", status: "parked" },
    { id: "sub2", displayName: "sub2", kind: "sub", parentId: "ow", status: "parked" },
    { id: "deep", displayName: "deep", kind: "sub", parentId: "sub1", status: "parked" },
    { id: "loose", displayName: "loose", kind: "sub", parentId: "main", status: "parked" },
  ];

  test("agents nest under their owning owner; unowned agents land in the fallback group", () => {
    const groups = groupMembers(agents, owners);
    expect(groups).toHaveLength(2);
    const owned = groups.find((group) => group.owner?.id === "ow");
    expect(owned?.root?.id).toBe("ow");
    expect(owned?.children.map((agent) => agent.id)).toEqual(["sub1", "sub2", "deep"]);
    const fallback = groups.find((group) => group.owner === null);
    expect(fallback?.children.map((agent) => agent.id)).toEqual(["main", "loose"]);
  });

  test("owners without a live registry entry still form a group", () => {
    const groups = groupMembers([], owners);
    expect(groups).toHaveLength(1);
    expect(groups[0].owner?.id).toBe("ow");
    expect(groups[0].root).toBeUndefined();
  });

  test("agentDepth reflects the parentId chain", () => {
    const deep = agents.find((agent) => agent.id === "deep");
    expect(deep && agentDepth(deep, agents)).toBe(3);
  });
});
