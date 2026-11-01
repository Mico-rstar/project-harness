import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type {
  ActiveToolSnapshot,
  InputReceipt,
  RuntimeEvent,
  RuntimeSnapshot,
  SessionPage,
  SessionSnapshot,
} from "../runtime/contracts";
import type {
  WebBlock,
  WebEntry,
  WebEvent,
  WebHistory,
  WebReceipt,
  WebSession,
  WebSnapshot,
  WebTool,
} from "./contracts";

const PREVIEW_CHARS = 32_000;
const TEXT_CHARS = 200_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Tool output can contain cyclic or non-JSON values from extensions. */
export function preview(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return truncate(value, PREVIEW_CHARS);
  const seen = new WeakSet<object>();
  let budget = PREVIEW_CHARS;
  let remainingNodes = 1_000;
  let clipped = false;
  function bounded(item: unknown, depth: number): unknown {
    if (--remainingNodes < 0 || budget <= 0 || depth > 12) {
      clipped = true;
      return "[预览已截断]";
    }
    if (typeof item === "string") {
      const result = item.slice(0, Math.max(0, budget));
      budget -= result.length;
      if (result.length < item.length) clipped = true;
      return result;
    }
    if (typeof item === "bigint") return String(item);
    if (typeof item === "number" && !Number.isFinite(item)) return String(item);
    if (typeof item !== "object" || item === null) return item;
    if (seen.has(item)) return "[循环引用]";
    seen.add(item);
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      for (const child of item) {
        if (remainingNodes <= 0 || budget <= 0) {
          clipped = true;
          break;
        }
        result.push(bounded(child, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (remainingNodes <= 0 || budget <= 0) {
        clipped = true;
        break;
      }
      const displayKey = key.slice(0, Math.max(0, budget));
      budget -= displayKey.length;
      result[displayKey] = bounded((item as Record<string, unknown>)[key], depth + 1);
    }
    return result;
  }
  try {
    const result = JSON.stringify(bounded(value, 0), null, 2);
    return truncate(
      `${result ?? String(value)}${clipped ? "\n…（预览已截断）" : ""}`,
      PREVIEW_CHARS,
    );
  } catch {
    return "[无法预览此内容]";
  }
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…（预览已截断）` : value;
}

function blocks(content: unknown): WebBlock[] {
  if (typeof content === "string") return [{ type: "text", text: truncate(content, TEXT_CHARS) }];
  if (!Array.isArray(content)) return [];
  return content.map((part: unknown): WebBlock => {
    const item = record(part);
    if (item?.type === "text") return { type: "text", text: truncate(text(item.text), TEXT_CHARS) };
    if (item?.type === "thinking")
      return { type: "thinking", text: truncate(text(item.thinking), TEXT_CHARS) };
    if (item?.type === "toolCall") {
      return {
        type: "tool",
        tool: {
          toolCallId: text(item.id),
          toolName: text(item.name),
          args: preview(item.arguments),
        },
      };
    }
    return { type: "notice", text: `[${text(item?.type) || "非文本内容"}]` };
  });
}

export function projectMessage(value: unknown, id = "stream", timestamp = ""): WebEntry | null {
  const message = record(value);
  if (!message || typeof message.role !== "string") return null;
  const role =
    message.role === "user"
      ? "user"
      : message.role === "assistant"
        ? "assistant"
        : message.role === "toolResult"
          ? "tool"
          : "system";
  const content = blocks(message.content);
  if (role === "tool") {
    return {
      id,
      timestamp,
      role,
      toolCallId: text(message.toolCallId),
      blocks: [
        {
          type: "tool",
          tool: {
            toolCallId: text(message.toolCallId),
            toolName: text(message.toolName),
            result: content
              .filter((block) => block.type !== "tool")
              .map((block) => block.text)
              .join("\n"),
            isError: message.isError === true,
          },
        },
      ],
    };
  }
  if (typeof message.errorMessage === "string")
    content.push({ type: "notice", text: message.errorMessage });
  return { id, timestamp, role, blocks: content };
}

export function projectEntry(entry: SessionEntry): WebEntry | null {
  if (entry.type === "message") {
    return (
      projectMessage(entry.message, entry.id, entry.timestamp) ?? {
        id: entry.id,
        timestamp: entry.timestamp,
        role: "system",
        blocks: [{ type: "notice", text: "无法显示的消息" }],
      }
    );
  }
  const data = record(entry);
  const labels: Record<string, string> = {
    model_change: "会话模型已设置",
    thinking_level_change: "思考设置已更新",
    compaction: "会话上下文已整理",
    branch_summary: "会话分支摘要",
    custom_message: "会话提示",
  };
  // Bootstrap instructions describe agent workspace setup, not a user conversation.
  if (entry.type === "custom_message" && data?.customType === "project-harness") {
    return {
      id: entry.id,
      timestamp: entry.timestamp,
      role: "system",
      blocks: [{ type: "notice", text: "项目会话已就绪" }],
    };
  }
  // Agent-to-agent IRC deliveries are protocol traffic aimed at the model;
  // the cooperation feed is the user-facing view of the same content.
  if (entry.type === "custom_message" && data?.customType === "irc:incoming") return null;
  const label = labels[entry.type];
  const content = blocks(data?.content);
  // Unrecognized entry types only earn a divider when they carry content.
  if (!label && content.length === 0) return null;
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    role: "system",
    blocks: [{ type: "notice", text: label ?? "会话记录" }, ...content],
  };
}

export function projectTool(tool: ActiveToolSnapshot): WebTool {
  return {
    toolCallId: tool.toolCallId,
    toolName: tool.toolName,
    ...(tool.args === undefined ? {} : { args: preview(tool.args) }),
    ...(tool.partialResult === undefined ? {} : { result: preview(tool.partialResult) }),
  };
}

export function projectSession(session: SessionSnapshot): WebSession {
  return {
    sessionId: session.sessionId,
    ownerId: session.ownerId,
    parentSessionId: session.parentSessionId,
    active: session.active,
    isStreaming: session.isStreaming,
    stream: projectMessage(session.activeAssistantMessage),
    activeTools: session.activeTools.map(projectTool),
    ...(session.model ? { model: session.model } : {}),
    error: session.error,
  };
}

export function projectReceipt(receipt: InputReceipt): WebReceipt {
  return {
    epoch: receipt.epoch,
    clientInputId: receipt.clientInputId,
    text: receipt.text,
    behavior: receipt.behavior,
    state: receipt.state,
    receivedAt: receipt.receivedAt,
    updatedAt: receipt.updatedAt,
    error: receipt.error,
  };
}

export function projectSnapshot(snapshot: RuntimeSnapshot): WebSnapshot {
  return {
    epoch: snapshot.epoch,
    seq: snapshot.seq,
    mainSessionId: snapshot.mainSessionId,
    project: snapshot.project,
    owners: snapshot.owners.map(({ id, title, worktree, entries }) => {
      const primary = entries[0];
      return {
        id,
        title,
        ...(primary?.checkout === undefined ? {} : { branch: primary.checkout }),
        worktree,
      };
    }),
    agents: snapshot.agents.map(({ id, displayName, kind, parentId, status, activity }) => ({
      id,
      displayName,
      kind,
      parentId,
      status,
      activity,
    })),
    sessions: snapshot.sessions.map(projectSession),
    cooperation: snapshot.cooperation,
    pendingUIRequests: snapshot.pendingUIRequests,
    inputReceipts: snapshot.inputReceipts.map(projectReceipt),
    health: snapshot.health,
    closing: snapshot.closing,
  };
}

export function projectHistory(page: SessionPage): WebHistory {
  return {
    sessionId: page.sessionId,
    ownerId: page.ownerId,
    entries: page.entries
      .map(projectEntry)
      .filter((entry): entry is WebEntry => entry !== null),
    nextBeforeEntryId: page.nextBeforeEntryId,
    stream: projectMessage(page.stream),
    activeTools: page.activeTools.map(projectTool),
  };
}

/**
 * Session state is projected after the runtime has applied each SDK event.
 * The browser receives a complete streaming message, never provider deltas.
 */
export function projectEvent(event: RuntimeEvent, snapshot: RuntimeSnapshot): WebEvent {
  const base = { epoch: event.epoch, seq: event.seq };
  if (event.type === "session_entry" && event.sessionId) {
    const entry = projectEntry(event.payload as SessionEntry);
    return {
      ...base,
      patch: entry
        ? { kind: "entry", sessionId: event.sessionId, entry }
        : { kind: "noop" },
    };
  }
  if (event.type === "session_event" && event.sessionId) {
    const session = snapshot.sessions.find((item) => item.sessionId === event.sessionId);
    return {
      ...base,
      patch: session ? { kind: "session", session: projectSession(session) } : { kind: "noop" },
    };
  }
  if (event.type === "cooperation_message") {
    return {
      ...base,
      patch: {
        kind: "cooperation",
        message:
          snapshot.cooperation.find((item) => item.id === record(event.payload)?.id) ??
          (event.payload as WebSnapshot["cooperation"][number]),
      },
    };
  }
  if (event.type === "input_receipt") {
    return {
      ...base,
      patch: { kind: "receipt", receipt: projectReceipt(event.payload as InputReceipt) },
    };
  }
  return { ...base, patch: { kind: "state", snapshot: projectSnapshot(snapshot) } };
}
