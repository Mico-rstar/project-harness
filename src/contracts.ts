import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { CooperationMessage, CooperationPage, IrcObservation } from "./cooperation-log";
import type { OwnerBinding } from "./project";

export type { CooperationMessage, CooperationPage, IrcObservation };

export type RuntimeHost =
  | { kind: "tui" }
  | { kind: "headless" }
  | {
      kind: "events";
      onUIRequest: (request: RuntimeUIRequest) => void;
      onNotify?: (notification: RuntimeNotification) => void;
      uiTimeoutMs?: number;
    };

export type RuntimeUIRequest =
  | {
      epoch: string;
      requestId: string;
      kind: "select";
      title: string;
      options: string[];
      expiresAt: number;
    }
  | {
      epoch: string;
      requestId: string;
      kind: "confirm";
      title: string;
      message: string;
      expiresAt: number;
    }
  | {
      epoch: string;
      requestId: string;
      kind: "input";
      title: string;
      placeholder?: string;
      expiresAt: number;
    }
  | {
      epoch: string;
      requestId: string;
      kind: "editor";
      title: string;
      prefill: string;
      expiresAt: number;
    };

export type RuntimeUIResponse =
  | { kind: "select"; value?: string }
  | { kind: "confirm"; value: boolean }
  | { kind: "input"; value?: string }
  | { kind: "editor"; value?: string };

export interface RuntimeNotification {
  message: string;
  level: "info" | "warning" | "error";
}

export interface RuntimeEvent {
  epoch: string;
  seq: number;
  type:
    | "session_event"
    | "session_entry"
    | "session_persistence_error"
    | "registry_changed"
    | "subagent_event"
    | "cooperation_message"
    | "health_changed"
    | "input_receipt"
    | "ui_request";
  sessionId?: string;
  ownerId?: string;
  payload: unknown;
}

export interface SessionSnapshot {
  sessionId: string;
  ownerId?: string;
  parentSessionId?: string;
  active: boolean;
  isStreaming: boolean;
  activeAssistantMessage?: unknown;
  activeTools: ActiveToolSnapshot[];
  entryCount: number;
  error?: string;
}

export interface RuntimeHealth {
  degraded: boolean;
  issues: string[];
}

export interface RuntimeSnapshot {
  epoch: string;
  seq: number;
  mainSessionId: string;
  project: {
    name: string;
    repoRoot: string;
  };
  owners: OwnerBinding[];
  agents: RuntimeAgent[];
  sessions: SessionSnapshot[];
  cooperation: CooperationMessage[];
  pendingUIRequests: RuntimeUIRequest[];
  inputReceipts: InputReceipt[];
  health: RuntimeHealth;
  closing: boolean;
}

export interface RuntimeAgent {
  id: string;
  displayName: string;
  kind: string;
  parentId?: string;
  status: string;
  sessionFile: string | null;
  activity?: string;
}

export interface ActiveToolSnapshot {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  partialResult?: unknown;
}

export interface RuntimeObservation {
  snapshot: RuntimeSnapshot;
  unsubscribe: () => void;
}

export interface SessionPage {
  sessionId: string;
  ownerId?: string;
  entries: SessionEntry[];
  nextBeforeEntryId: string | null;
  stream: unknown;
  activeTools: ActiveToolSnapshot[];
}

export type InputBehavior = "followUp" | "steer";
export type InputReceiptState = "received" | "admitted" | "handled" | "rejected";

export interface MainInput {
  epoch: string;
  clientInputId: string;
  text: string;
  behavior?: InputBehavior;
  images?: ImageContent[];
}

export interface InputReceipt {
  epoch: string;
  clientInputId: string;
  text: string;
  behavior: InputBehavior;
  images?: ImageContent[];
  state: InputReceiptState;
  receivedAt: number;
  updatedAt: number;
  error?: string;
}

export interface SessionReadOptions {
  beforeEntryId?: string;
  limit?: number;
}

export interface CooperationReadOptions {
  ownerId?: string;
  before?: string;
  limit?: number;
}

export interface UIRequestResponse {
  epoch: string;
  requestId: string;
  response: RuntimeUIResponse;
}

export interface HarnessRuntime {
  readonly mainSessionId: string;
  snapshot(): RuntimeSnapshot;
  observe(listener: (event: RuntimeEvent) => void): RuntimeObservation;
  readSession(sessionId: string, options?: SessionReadOptions): Promise<SessionPage>;
  readCooperation(options?: CooperationReadOptions): Promise<CooperationPage>;
  submitMainInput(input: MainInput): Promise<InputReceipt>;
  getInputReceipt(input: Pick<MainInput, "epoch" | "clientInputId">): InputReceipt | undefined;
  respondToUIRequest(input: UIRequestResponse): boolean;
  abortMainTurn(): void;
  close(): Promise<void>;
}

export interface SessionEventRecord {
  sessionId: string;
  event: AgentSessionEvent;
}
