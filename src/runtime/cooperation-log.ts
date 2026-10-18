import * as fs from "node:fs/promises";
import type { IrcObservation } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { parseJsonlLenient } from "@oh-my-pi/pi-utils/stream";

const MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const CLOSE_DRAIN_TIMEOUT_MS = 2_000;

export type { IrcObservation } from "@oh-my-pi/pi-coding-agent/irc/bus";

export interface CooperationMessage {
  id: string;
  operationId: string;
  from: string;
  to: string;
  body: string;
  ts: number;
  replyTo?: string;
  wakeRelay?: boolean;
  relatedOwnerIds: string[];
  delivery: {
    outcome: "injected" | "woken" | "revived" | "failed" | "unknown";
    error?: string;
    buffered?: boolean;
  };
}

export interface CooperationPage {
  items: CooperationMessage[];
  nextBefore: string | null;
  coverage: { recordedSince: number | null; hasGaps: boolean; warnings: string[] };
}

export interface CooperationLogOptions {
  file: string;
  resolveOwnerIds: (from: string, to: string) => string[];
  knownOwnerIds?: Iterable<string> | (() => Iterable<string>);
  onMessage?: (message: CooperationMessage) => void;
  onHealth?: (health: CooperationPage["coverage"]) => void;
  writer?: (file: string, line: string) => Promise<void>;
  closeDrainTimeoutMs?: number;
}

export interface CooperationReadOptions {
  ownerId?: string;
  before?: string;
  limit?: number;
}

type StoredRecord =
  | { kind: "header"; recordedSince: number }
  | { kind: "gap"; reason: string }
  | {
      kind: "started";
      sequence: number;
      operationId: string;
      message: IrcMessage;
      relatedOwnerIds: string[];
    }
  | {
      kind: "completed";
      operationId: string;
      messageId: string;
      outcome: CooperationMessage["delivery"]["outcome"];
      error?: string;
      buffered?: boolean;
    };

interface StartedRecord extends Extract<StoredRecord, { kind: "started" }> {
  delivery: CooperationMessage["delivery"];
}

function appendLine(file: string, line: string): Promise<void> {
  return fs.appendFile(file, line, "utf8");
}

function cursorFor(sequence: number): string {
  return sequence.toString(36);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessage(value: unknown): value is IrcMessage {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.from === "string" &&
    value.from.length > 0 &&
    typeof value.to === "string" &&
    value.to.length > 0 &&
    typeof value.body === "string" &&
    Number.isSafeInteger(value.ts) &&
    (value.replyTo === undefined || typeof value.replyTo === "string") &&
    (value.wakeRelay === undefined || typeof value.wakeRelay === "boolean")
  );
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "header":
      return Number.isSafeInteger(value.recordedSince) && Number(value.recordedSince) >= 0;
    case "gap":
      return typeof value.reason === "string" && value.reason.length > 0;
    case "started":
      return (
        Number.isSafeInteger(value.sequence) &&
        Number(value.sequence) > 0 &&
        typeof value.operationId === "string" &&
        value.operationId.length > 0 &&
        isMessage(value.message) &&
        Array.isArray(value.relatedOwnerIds) &&
        value.relatedOwnerIds.every((id) => typeof id === "string")
      );
    case "completed":
      return (
        typeof value.operationId === "string" &&
        value.operationId.length > 0 &&
        typeof value.messageId === "string" &&
        value.messageId.length > 0 &&
        (value.outcome === "injected" ||
          value.outcome === "woken" ||
          value.outcome === "revived" ||
          value.outcome === "failed") &&
        (value.error === undefined || typeof value.error === "string") &&
        (value.buffered === undefined || typeof value.buffered === "boolean")
      );
    default:
      return false;
  }
}

function parseCursor(cursor: string): number {
  if (!/^[0-9a-z]+$/.test(cursor)) throw new Error("Invalid cooperation cursor");
  const value = Number.parseInt(cursor, 36);
  if (!Number.isSafeInteger(value) || value < 0 || cursorFor(value) !== cursor) {
    throw new Error("Invalid cooperation cursor");
  }
  return value;
}

export class CooperationLog {
  static async open(options: CooperationLogOptions): Promise<CooperationLog> {
    const log = new CooperationLog(options);
    await log.#load();
    return log;
  }

  readonly #options: CooperationLogOptions;
  #knownOwnerIds: Set<string> | undefined;
  readonly #writer: (file: string, line: string) => Promise<void>;
  readonly #closeDrainTimeoutMs: number;
  readonly #messages = new Map<string, StartedRecord>();
  readonly #warnings = new Set<string>();
  #recordedSince: number | null = null;
  #hasGaps = false;
  #sequence = 0;
  #queuedBytes = 0;
  #gapQueued = false;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #needsSeparator = false;
  #sequenceIds = new Set<number>();

  private constructor(options: CooperationLogOptions) {
    this.#options = options;
    this.#knownOwnerIds = options.knownOwnerIds
      ? new Set(
          typeof options.knownOwnerIds === "function"
            ? options.knownOwnerIds()
            : options.knownOwnerIds,
        )
      : undefined;
    this.#writer = options.writer ?? appendLine;
    this.#closeDrainTimeoutMs = options.closeDrainTimeoutMs ?? CLOSE_DRAIN_TIMEOUT_MS;
  }

  addKnownOwnerId(ownerId: string): void {
    this.#knownOwnerIds?.add(ownerId);
  }

  record(observation: IrcObservation): void {
    if (this.#closed) return;
    const record: StoredRecord =
      observation.type === "send_started"
        ? {
            kind: "started",
            sequence: ++this.#sequence,
            operationId: observation.operationId,
            message: { ...observation.message },
            relatedOwnerIds: [
              ...new Set(
                this.#options.resolveOwnerIds(observation.message.from, observation.message.to),
              ),
            ],
          }
        : {
            kind: "completed",
            operationId: observation.operationId,
            messageId: observation.message.id,
            outcome: observation.thrown ? "failed" : observation.receipt.outcome,
            ...(observation.thrown && observation.receipt.error === undefined
              ? { error: "send threw" }
              : {}),
            ...(observation.receipt.error === undefined
              ? {}
              : { error: observation.receipt.error }),
            ...("buffered" in observation && observation.buffered ? { buffered: true } : {}),
          };
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.#queuedBytes + bytes > MAX_QUEUE_BYTES) {
      this.#hasGaps = true;
      this.#warnings.add(
        "Cooperation log write queue exceeded 8 MiB; some observations were lost.",
      );
      this.#queueGap();
      this.#notifyHealth();
      return;
    }
    this.#queuedBytes += bytes;
    this.#tail = this.#tail.then(async () => {
      try {
        if (this.#gapQueued) {
          await this.#writer(
            this.#options.file,
            `${JSON.stringify({ kind: "gap", reason: "Queue overflow" } satisfies StoredRecord)}\n`,
          );
          this.#gapQueued = false;
        }
        await this.#append(line);
        if (record.kind === "started") {
          const startedRecord: StartedRecord = { ...record, delivery: { outcome: "unknown" } };
          const message = this.#toMessage(startedRecord);
          this.#messages.set(message.id, startedRecord);
          this.#notifyMessage(message);
        } else {
          this.#applyCompletion(record);
          const message = this.#messages.get(record.messageId);
          if (message) this.#notifyMessage(this.#toMessage(message));
        }
      } catch {
        this.#hasGaps = true;
        this.#warnings.add("Cooperation log append failed; observations may be missing.");
        this.#gapQueued = true;
        this.#notifyHealth();
      } finally {
        this.#queuedBytes -= bytes;
      }
    });
  }

  setKnownOwnerIds(ids: Iterable<string>): void {
    this.#knownOwnerIds = new Set(ids);
  }

  async read(options: CooperationReadOptions = {}): Promise<CooperationPage> {
    const { ownerId, before, limit = 100 } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new RangeError("limit must be between 1 and 500");
    if (ownerId !== undefined && this.#knownOwnerIds && !this.#knownOwnerIds.has(ownerId)) {
      throw new Error(`Unknown ownerId: ${ownerId}`);
    }
    const beforeSequence = before === undefined ? Number.POSITIVE_INFINITY : parseCursor(before);
    await this.#tail;
    const all = [...this.#messages.values()]
      .filter((record) => record.sequence < beforeSequence)
      .filter((record) => ownerId === undefined || record.relatedOwnerIds.includes(ownerId))
      .sort((a, b) => a.sequence - b.sequence);
    const page = all.slice(-limit);
    const hasOlder = all.length > page.length;
    return {
      items: page.map((record) => this.#toMessage(record)),
      nextBefore: hasOlder && page[0] ? cursorFor(page[0].sequence) : null,
      coverage: this.#coverage(),
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#tail = this.#tail.then(async () => {
      if (this.#gapQueued) {
        try {
          await this.#append(
            `${JSON.stringify({ kind: "gap", reason: "One or more cooperation log appends failed." } satisfies StoredRecord)}\n`,
          );
          this.#gapQueued = false;
        } catch {
          this.#hasGaps = true;
          this.#warnings.add("Pending gap marker could not be persisted before close.");
          this.#notifyHealth();
        }
      }
    });
    let drained = false;
    await Promise.race([
      this.#tail.then(() => {
        drained = true;
      }),
      Bun.sleep(this.#closeDrainTimeoutMs).then(() => {
        if (drained) return;
        this.#hasGaps = true;
        this.#warnings.add("Cooperation log close timed out while draining writes.");
        this.#notifyHealth();
      }),
    ]);
  }

  async #load(): Promise<void> {
    let text: string;
    try {
      text = await Bun.file(this.#options.file).text();
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const recordedSince = Date.now();
      this.#recordedSince = recordedSince;
      this.#tail = this.#tail.then(async () => {
        try {
          await this.#writer(
            this.#options.file,
            `${JSON.stringify({ kind: "header", recordedSince } satisfies StoredRecord)}\n`,
          );
        } catch {
          this.#hasGaps = true;
          this.#gapQueued = true;
          this.#warnings.add("Cooperation log append failed; observations may be missing.");
          this.#notifyHealth();
        }
      });
      await this.#tail;
      return;
    }
    this.#needsSeparator = text.length > 0 && !text.endsWith("\n");
    const parseWarnings = new Set<string>();
    const decodedRecords = parseJsonlLenient<unknown>(text, {
      onMalformedRecord: () => {
        this.#hasGaps = true;
        this.#warnings.add(
          "Cooperation log contains a malformed record or incomplete tail; valid records remain readable.",
        );
      },
    });
    const records: StoredRecord[] = [];
    for (const value of decodedRecords) {
      if (!isStoredRecord(value)) {
        parseWarnings.add(
          "Cooperation log contains an invalid record shape; valid records remain readable.",
        );
        continue;
      }
      if (value.kind === "started" && this.#sequenceIds.has(value.sequence)) {
        parseWarnings.add(
          "Cooperation log contains duplicate message sequence numbers; valid records remain readable.",
        );
        continue;
      }
      if (value.kind === "started") this.#sequenceIds.add(value.sequence);
      records.push(value);
    }
    for (const warning of parseWarnings) {
      this.#hasGaps = true;
      this.#warnings.add(warning);
    }
    if (this.#needsSeparator) {
      this.#hasGaps = true;
      this.#warnings.add(
        "Cooperation log contains a malformed record or incomplete tail; valid records remain readable.",
      );
    }
    for (const record of records) {
      if (record.kind === "header") this.#recordedSince ??= record.recordedSince;
      else if (record.kind === "gap") {
        this.#hasGaps = true;
        this.#warnings.add(record.reason);
      } else if (record.kind === "started") {
        this.#sequence = Math.max(this.#sequence, record.sequence);
        if (this.#messages.has(record.message.id)) {
          this.#hasGaps = true;
          this.#warnings.add(
            "Cooperation log contains duplicate message IDs; later duplicate ignored.",
          );
          continue;
        }
        this.#messages.set(record.message.id, { ...record, delivery: { outcome: "unknown" } });
      } else if (record.kind === "completed") this.#applyCompletion(record);
    }
  }

  #applyCompletion(record: Extract<StoredRecord, { kind: "completed" }>): void {
    const message = this.#messages.get(record.messageId);
    if (message && message.operationId === record.operationId) {
      message.delivery = {
        outcome: record.outcome,
        ...(record.error === undefined ? {} : { error: record.error }),
        ...(record.buffered === undefined ? {} : { buffered: record.buffered }),
      };
    }
  }

  #toMessage(record: StartedRecord): CooperationMessage {
    return {
      id: record.message.id,
      operationId: record.operationId,
      from: record.message.from,
      to: record.message.to,
      body: record.message.body,
      ts: record.message.ts,
      ...(record.message.replyTo === undefined ? {} : { replyTo: record.message.replyTo }),
      ...(record.message.wakeRelay === undefined ? {} : { wakeRelay: record.message.wakeRelay }),
      relatedOwnerIds: [...record.relatedOwnerIds],
      delivery: { ...record.delivery },
    };
  }

  #queueGap(): void {
    if (this.#gapQueued) return;
    this.#gapQueued = true;
    this.#tail = this.#tail.then(async () => {
      try {
        await this.#append(
          `${JSON.stringify({ kind: "gap", reason: "Queue overflow" } satisfies StoredRecord)}\n`,
        );
        this.#gapQueued = false;
      } catch {
        this.#hasGaps = true;
      }
    });
  }

  async #append(line: string): Promise<void> {
    const content = `${this.#needsSeparator ? "\n" : ""}${line}`;
    this.#needsSeparator = false;
    await this.#writer(this.#options.file, content);
  }

  #coverage(): CooperationPage["coverage"] {
    return {
      recordedSince: this.#recordedSince,
      hasGaps: this.#hasGaps,
      warnings: [...this.#warnings],
    };
  }

  #notifyHealth(): void {
    try {
      this.#options.onHealth?.(this.#coverage());
    } catch {
      // Health observers must not affect message delivery.
    }
  }

  #notifyMessage(message: CooperationMessage): void {
    try {
      this.#options.onMessage?.(message);
    } catch {
      // Event observers must not affect log persistence or message delivery.
    }
  }
}
