/** Pure transcript/members grouping. No React, no DOM — safe to unit test directly. */
import type { WebAgent, WebBlock, WebEntry, WebTool, WebOwner } from "../contracts";

export interface WorkGroup {
  kind: "work";
  id: string;
  tools: WebTool[];
  thinking: string[];
  notices: string[];
  running: boolean;
  hasError: boolean;
  timestamp: string;
}
export interface MessageGroup {
  kind: "message";
  id: string;
  entry: WebEntry;
  blocks: WebBlock[];
}
export type TranscriptGroup = WorkGroup | MessageGroup;

export interface TranscriptGroupOptions {
  liveTools?: WebTool[];
  streamId?: string;
}

interface WorkAccumulator {
  id: string;
  timestamp: string;
  tools: Map<string, WebTool>;
  thinking: string[];
  notices: string[];
  running: boolean;
}

/** Field-level merge for the same tool observed twice (streamed call vs persisted result). */
export function mergeTool(a: WebTool, b: WebTool): WebTool {
  return {
    ...a,
    ...b,
    args: a.args ?? b.args,
    result: a.result ?? b.result,
    isError: a.isError || b.isError,
  };
}

export function groupTranscript(
  entries: WebEntry[],
  options: TranscriptGroupOptions = {},
): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  const work: { current: WorkAccumulator | null } = { current: null };
  const workSegments = new Map<string, number>();

  const ensureCurrent = (entry: WebEntry): WorkAccumulator => {
    if (!work.current) {
      const segment = workSegments.get(entry.id) ?? 0;
      workSegments.set(entry.id, segment + 1);
      work.current = {
        id: segment === 0 ? entry.id : `${entry.id}:work${segment + 1}`,
        timestamp: entry.timestamp,
        tools: new Map(),
        thinking: [],
        notices: [],
        running: false,
      };
    }
    return work.current;
  };

  const addTool = (entry: WebEntry, tool: WebTool): void => {
    const accumulator = ensureCurrent(entry);
    const existing = accumulator.tools.get(tool.toolCallId);
    accumulator.tools.set(tool.toolCallId, existing ? mergeTool(existing, tool) : tool);
  };

  const flush = (): void => {
    const current = work.current;
    if (!current) return;
    work.current = null;
    if (current.tools.size > 0 || current.thinking.length > 0 || current.notices.length > 0) {
      groups.push({
        kind: "work",
        id: `${current.id}:work`,
        tools: [...current.tools.values()],
        thinking: current.thinking,
        notices: current.notices,
        running: current.running,
        hasError: [...current.tools.values()].some((tool) => tool.isError === true),
        timestamp: current.timestamp,
      });
    }
  };

  for (const entry of entries) {
    const isStream = entry.id === options.streamId;
    if (entry.role === "user" || entry.role === "system") {
      flush();
      groups.push({ kind: "message", id: entry.id, entry, blocks: entry.blocks });
      continue;
    }
    if (entry.role === "tool") {
      for (const block of entry.blocks) {
        if (block.type === "tool") addTool(entry, block.tool);
        else if (block.type === "thinking") ensureCurrent(entry).thinking.push(block.text);
        else if (block.type === "notice") ensureCurrent(entry).notices.push(block.text);
      }
      continue;
    }
    // assistant: each text block renders as its own message row and closes the
    // work group accumulated before it; thinking/tool blocks join that group.
    let textIndex = 0;
    for (const block of entry.blocks) {
      if (block.type === "text") {
        if (block.text.trim() === "") continue;
        flush();
        textIndex += 1;
        groups.push({
          kind: "message",
          id: `${entry.id}:text${textIndex}`,
          entry,
          blocks: [block],
        });
      } else if (block.type === "tool") {
        addTool(entry, block.tool);
      } else if (block.type === "thinking") {
        ensureCurrent(entry).thinking.push(block.text);
      } else {
        ensureCurrent(entry).notices.push(block.text);
      }
    }
    if (isStream && work.current) work.current.running = true;
  }

  for (const tool of options.liveTools ?? []) {
    const accumulator = ensureCurrent({
      id: `live:${tool.toolCallId}`,
      timestamp: "",
      role: "assistant",
      blocks: [],
    });
    accumulator.running = true;
    const existing = accumulator.tools.get(tool.toolCallId);
    accumulator.tools.set(tool.toolCallId, existing ? mergeTool(existing, tool) : tool);
  }
  flush();
  return groups;
}

/** Collapsed-header copy. Brevity matters: the header also carries icons/badges. */
export function workSummary(group: WorkGroup): string {
  const names = group.tools.map((tool) => tool.toolName);
  if (names.length === 0) {
    if (group.thinking.length > 0) return "思考过程";
    if (group.notices.length > 0) return "会话提示";
    return "工作过程";
  }
  const shown = names.slice(0, 2).join("、");
  return names.length > 2 ? `${shown} 等 ${names.length} 项` : shown;
}

/** Name of the most recent tool still awaiting its result — the live action. */
export function runningAction(group: WorkGroup): string | null {
  for (let index = group.tools.length - 1; index >= 0; index -= 1) {
    const tool = group.tools[index];
    if (tool.result === undefined) return tool.toolName;
  }
  return null;
}

export interface MemberGroup {
  owner: WebOwner | null;
  root?: WebAgent;
  children: WebAgent[];
}

/** Nesting depth of an agent within the registry's parentId chains (root = 0). */
export function agentDepth(agent: WebAgent, agents: WebAgent[]): number {
  let depth = 0;
  let parentId = agent.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    depth += 1;
    seen.add(parentId);
    parentId = agents.find((item) => item.id === parentId)?.parentId;
  }
  return depth;
}

function isDescendant(agent: WebAgent, ancestorId: string, agents: WebAgent[]): boolean {
  let parentId = agent.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    if (parentId === ancestorId) return true;
    seen.add(parentId);
    parentId = agents.find((item) => item.id === parentId)?.parentId;
  }
  return false;
}

/**
 * Group registry agents under their owning owner (resolved by walking parentId
 * chains up to a known owner id). Agents whose chain never reaches a known
 * owner (e.g. Main's direct task subagents) land in the `owner: null` group.
 */
export function groupMembers(agents: WebAgent[], owners: WebOwner[]): MemberGroup[] {
  const byOwner = new Map<string, MemberGroup>();
  let fallback: MemberGroup | null = null;
  for (const owner of owners) byOwner.set(owner.id, { owner, children: [] });
  for (const agent of agents) {
    if (owners.some((owner) => owner.id === agent.id)) {
      const group = byOwner.get(agent.id);
      if (group) group.root = agent;
      continue;
    }
    let ancestor: WebAgent | undefined = agent;
    const seen = new Set<string>();
    let target: MemberGroup | null = null;
    while (ancestor?.parentId && !seen.has(ancestor.parentId)) {
      seen.add(ancestor.parentId);
      if (byOwner.has(ancestor.parentId)) {
        target = byOwner.get(ancestor.parentId) ?? null;
        break;
      }
      ancestor = agents.find((item) => item.id === ancestor?.parentId);
    }
    if (target) target.children.push(agent);
    else {
      if (!fallback) fallback = { owner: null, children: [] };
      fallback.children.push(agent);
    }
  }
  const groups = [...byOwner.values()];
  for (const group of groups) {
    group.children.sort(
      (first, second) =>
        agentDepth(first, agents) - agentDepth(second, agents) || first.id.localeCompare(second.id),
    );
  }
  if (fallback && fallback.children.length > 0) groups.push(fallback);
  return groups;
}
