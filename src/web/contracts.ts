/** JSON-only presentation contracts. This module must stay browser-safe. */
export type InputBehavior = "followUp" | "steer";
export interface WebInput {
  epoch: string;
  clientInputId: string;
  text: string;
  behavior: InputBehavior;
}
export interface WebReceipt extends WebInput {
  state: "received" | "admitted" | "handled" | "rejected";
  receivedAt: number;
  updatedAt: number;
  error?: string;
}
export type WebUIRequest =
  | {
      epoch: string;
      requestId: string;
      expiresAt: number;
      kind: "select";
      title: string;
      options: string[];
    }
  | {
      epoch: string;
      requestId: string;
      expiresAt: number;
      kind: "confirm";
      title: string;
      message: string;
    }
  | {
      epoch: string;
      requestId: string;
      expiresAt: number;
      kind: "input";
      title: string;
      placeholder?: string;
    }
  | {
      epoch: string;
      requestId: string;
      expiresAt: number;
      kind: "editor";
      title: string;
      prefill: string;
    };
export type WebUIResponse =
  | { kind: "select"; value?: string }
  | { kind: "confirm"; value: boolean }
  | { kind: "input"; value?: string }
  | { kind: "editor"; value?: string };
export interface WebOwner {
  id: string;
  title: string;
  /** Primary workspace entry's checkout branch, when it is a Git worktree. */
  branch?: string;
  worktree: string;
}
export interface WebAgent {
  id: string;
  displayName: string;
  kind: string;
  parentId?: string;
  status: string;
  activity?: string;
}
export interface WebTool {
  toolCallId: string;
  toolName: string;
  args?: string;
  result?: string;
  isError?: boolean;
}
export type WebBlock =
  | { type: "text" | "thinking" | "notice"; text: string }
  | { type: "tool"; tool: WebTool };
export interface WebEntry {
  id: string;
  timestamp: string;
  role: "user" | "assistant" | "tool" | "system";
  blocks: WebBlock[];
  toolCallId?: string;
}
export interface WebSession {
  sessionId: string;
  ownerId?: string;
  parentSessionId?: string;
  active: boolean;
  isStreaming: boolean;
  stream: WebEntry | null;
  activeTools: WebTool[];
  error?: string;
}
export interface WebHistory {
  sessionId: string;
  ownerId?: string;
  entries: WebEntry[];
  nextBeforeEntryId: string | null;
  stream: WebEntry | null;
  activeTools: WebTool[];
}
export interface WebCooperationMessage {
  id: string;
  operationId: string;
  from: string;
  to: string;
  body: string;
  ts: number;
  relatedOwnerIds: string[];
  delivery: { outcome: string; error?: string; buffered?: boolean };
}
export interface WebCooperationPage {
  items: WebCooperationMessage[];
  nextBefore: string | null;
  coverage: { recordedSince: number | null; hasGaps: boolean; warnings: string[] };
}
export interface WebSnapshot {
  epoch: string;
  seq: number;
  mainSessionId: string;
  project: { name: string; repoRoot: string };
  owners: WebOwner[];
  agents: WebAgent[];
  sessions: WebSession[];
  cooperation: WebCooperationMessage[];
  pendingUIRequests: WebUIRequest[];
  inputReceipts: WebReceipt[];
  health: { degraded: boolean; issues: string[] };
  closing: boolean;
}
export type WebPatch =
  | { kind: "state"; snapshot: WebSnapshot }
  | { kind: "entry"; sessionId: string; entry: WebEntry }
  | { kind: "session"; session: WebSession }
  | { kind: "cooperation"; message: WebCooperationMessage }
  | { kind: "receipt"; receipt: WebReceipt }
  | { kind: "noop" };
export interface WebEvent {
  epoch: string;
  seq: number;
  patch: WebPatch;
}
export interface WebNotification {
  message: string;
  level: "info" | "warning" | "error";
}
export interface WebError {
  error: { code: string; message: string };
}
