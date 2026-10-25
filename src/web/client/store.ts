import type {
  InputBehavior,
  WebCooperationMessage,
  WebCooperationPage,
  WebEntry,
  WebEvent,
  WebHistory,
  WebInput,
  WebNotification,
  WebPatch,
  WebReceipt,
  WebSnapshot,
  WebUIRequest,
  WebUIResponse,
} from "../contracts";
import { createWebAPI, parseSSEMessage, type ClientSSEMessage, type WebAPI } from "./api";

export interface WebHistoryState {
  data: WebHistory | null;
  loading: boolean;
  error: string | null;
}

export interface WebClientState {
  connection: "disconnected" | "syncing" | "connected" | "error";
  snapshot: WebSnapshot | null;
  histories: Record<string, WebHistoryState>;
  cooperation: WebCooperationPage | null;
  receipts: Record<string, WebReceipt>;
  pendingUIRequests: WebUIRequest[];
  activeSessionId: string | null;
  draft: string;
  inputBehavior: InputBehavior;
  uncertainInputId: string | null;
  error: string | null;
  notification: WebNotification | null;
  cooperationOwnerId: string | null;
}

export interface WebStore {
  getSnapshot(): WebClientState;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  setActiveSession(sessionId: string): void;
  setDraft(text: string): void;
  setInputBehavior(behavior: InputBehavior): void;
  loadHistory(sessionId: string, beforeEntryId?: string): Promise<void>;
  loadCooperation(ownerId?: string, before?: string): Promise<void>;
  submitInput(text?: string, behavior?: InputBehavior): Promise<WebReceipt>;
  retryInput(clientInputId: string): Promise<WebReceipt | null>;
  respond(requestId: string, response: WebUIResponse): Promise<void>;
  abortMain(): Promise<void>;
}

export interface WebEventSource {
  onopen: (() => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
}

const initialState: WebClientState = {
  connection: "disconnected",
  snapshot: null,
  histories: {},
  cooperation: null,
  receipts: {},
  pendingUIRequests: [],
  activeSessionId: null,
  draft: "",
  inputBehavior: "followUp",
  uncertainInputId: null,
  error: null,
  notification: null,
  cooperationOwnerId: null,
};

function mergeEntries(first: WebEntry[], second: WebEntry[]): WebEntry[] {
  const byId = new Map<string, WebEntry>();
  for (const entry of [...first, ...second]) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function mergeHistory(old: WebHistory | null, incoming: WebHistory, append: boolean): WebHistory {
  if (!old || !append) return { ...incoming, entries: mergeEntries([], incoming.entries) };
  return {
    ...incoming,
    entries: mergeEntries(incoming.entries, old.entries),
    nextBeforeEntryId: incoming.nextBeforeEntryId,
    stream: incoming.stream,
    activeTools: incoming.activeTools,
  };
}

function receiptRank(receipt: WebReceipt): number {
  if (receipt.state === "received") return 0;
  if (receipt.state === "admitted") return 1;
  return 2;
}

function mergeReceipt(
  receipts: Record<string, WebReceipt>,
  receipt: WebReceipt,
): Record<string, WebReceipt> {
  const previous = receipts[receipt.clientInputId];
  if (
    previous &&
    (receiptRank(receipt) < receiptRank(previous) ||
      (receiptRank(receipt) === receiptRank(previous) && receipt.updatedAt < previous.updatedAt))
  )
    return receipts;
  return { ...receipts, [receipt.clientInputId]: receipt };
}

function mergeSnapshotReceipts(
  snapshot: WebSnapshot,
  receipts: Record<string, WebReceipt>,
): WebSnapshot {
  const merged = new Map(snapshot.inputReceipts.map((receipt) => [receipt.clientInputId, receipt]));
  for (const receipt of Object.values(receipts)) {
    const current = merged.get(receipt.clientInputId);
    if (
      !current ||
      receiptRank(receipt) > receiptRank(current) ||
      (receiptRank(receipt) === receiptRank(current) && receipt.updatedAt >= current.updatedAt)
    )
      merged.set(receipt.clientInputId, receipt);
  }
  return { ...snapshot, inputReceipts: [...merged.values()] };
}

function cooperationKey(ownerId: string | null): string {
  return ownerId ?? "\u0000global";
}

function withPatch(
  state: WebClientState,
  patch: WebPatch,
  aliases: Map<string, string>,
): WebClientState {
  if (patch.kind === "state") {
    const receipts = patch.snapshot.inputReceipts.reduce(mergeReceipt, state.receipts);
    return {
      ...state,
      snapshot: mergeSnapshotReceipts(patch.snapshot, receipts),
      receipts,
      pendingUIRequests: patch.snapshot.pendingUIRequests,
    };
  }
  if (patch.kind === "receipt") {
    const receipts = mergeReceipt(state.receipts, patch.receipt);
    const inputReceipts = state.snapshot?.inputReceipts ?? [];
    const previous = inputReceipts.find(
      (item) => item.clientInputId === patch.receipt.clientInputId,
    );
    const latestReceipt = state.receipts[patch.receipt.clientInputId] ?? patch.receipt;
    const nextSnapshot = state.snapshot
      ? {
          ...mergeSnapshotReceipts(state.snapshot, receipts),
          inputReceipts:
            previous && receiptRank(previous) > receiptRank(latestReceipt)
              ? inputReceipts
              : [
                  ...inputReceipts.filter(
                    (item) => item.clientInputId !== patch.receipt.clientInputId,
                  ),
                  latestReceipt,
                ],
        }
      : null;
    return { ...state, receipts, snapshot: nextSnapshot };
  }
  if (patch.kind === "cooperation") {
    if (
      state.cooperationOwnerId &&
      !patch.message.relatedOwnerIds.includes(state.cooperationOwnerId)
    )
      return state;
    const old = state.cooperation;
    const items = old?.items ?? [];
    const index = items.findIndex((item) => item.id === patch.message.id);
    const nextItems =
      index === -1
        ? [...items, patch.message]
        : items.map((item, itemIndex) => (itemIndex === index ? patch.message : item));
    return {
      ...state,
      cooperation: old
        ? { ...old, items: nextItems.sort((a, b) => a.ts - b.ts) }
        : {
            items: nextItems,
            nextBefore: null,
            coverage: { recordedSince: null, hasGaps: false, warnings: [] },
          },
    };
  }
  if (patch.kind === "session") {
    const snapshot = state.snapshot;
    const sessions = snapshot
      ? snapshot.sessions.filter((session) => session.sessionId !== patch.session.sessionId)
      : [];
    if (snapshot) sessions.push(patch.session);
    const historyKey = Object.entries(state.histories).find(
      ([id, value]) =>
        (id === patch.session.sessionId || aliases.get(id) === patch.session.sessionId) &&
        value.data,
    )?.[0];
    const history = historyKey ? state.histories[historyKey] : undefined;
    return {
      ...state,
      snapshot: snapshot ? { ...snapshot, sessions } : null,
      histories:
        historyKey && history?.data
          ? {
              ...state.histories,
              [historyKey]: {
                ...history,
                data: {
                  ...history.data,
                  stream: patch.session.stream,
                  activeTools: patch.session.activeTools,
                },
              },
            }
          : state.histories,
    };
  }
  if (patch.kind === "entry") {
    const key = Object.entries(state.histories).find(
      ([id, history]) =>
        (id === patch.sessionId || aliases.get(id) === patch.sessionId) && history.data,
    )?.[0];
    if (!key) return state;
    const current = state.histories[key];
    if (!current?.data) return state;
    return {
      ...state,
      histories: {
        ...state.histories,
        [key]: {
          ...current,
          data: {
            ...current.data,
            entries: mergeEntries(current.data.entries, [patch.entry]),
            stream: patch.entry.role === "assistant" ? null : current.data.stream,
          },
        },
      },
    };
  }
  return state;
}

export function createWebStore(
  options: { baseUrl?: string; api?: WebAPI; eventSource?: (url: string) => WebEventSource } = {},
): WebStore {
  const api = options.api ?? createWebAPI(options.baseUrl);
  const makeEventSource =
    options.eventSource ??
    ((url: string): WebEventSource => {
      const EventSourceWithUrl = globalThis.EventSource as unknown as new (
        eventUrl: string,
      ) => WebEventSource;
      return new EventSourceWithUrl(url);
    });
  let state: WebClientState = {
    ...initialState,
    histories: {},
    receipts: {},
    pendingUIRequests: [],
  };
  let source: WebEventSource | null = null;
  let generation = 0;
  let stopped = false;
  let cancelReconnect: (() => void) | null = null;
  let listeners = new Set<() => void>();
  let eventBuffer: WebEvent[] = [];
  let historyGeneration = new Map<string, number>();
  let sessionAliases = new Map<string, string>();
  let historyWatermarks = new Map<string, WebEvent[]>();
  let historyInFlight = new Set<string>();
  let inputAttempts = new Map<string, WebInput>();
  let cooperationInFlight = new Set<string>();
  let cooperationLive = new Map<string, Map<string, WebCooperationMessage>>();

  const publish = (next: WebClientState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const closeSource = () => {
    source?.close();
    source = null;
  };
  const scheduleReconnect = (captured: number) => {
    if (stopped || captured !== generation || cancelReconnect !== null) return;
    const timer = setTimeout(() => {
      cancelReconnect = null;
      connect();
    }, 250);
    cancelReconnect = () => clearTimeout(timer);
  };
  const resync = () => {
    if (stopped) return;
    generation++;
    closeSource();
    publish({ ...state, connection: "syncing" });
    connect();
  };
  const receiveEvent = (event: WebEvent) => {
    if (!state.snapshot) {
      eventBuffer.push(event);
      return;
    }
    if (event.epoch !== state.snapshot.epoch) {
      resync();
      return;
    }
    if (event.seq <= state.snapshot.seq) return;
    if (event.seq !== state.snapshot.seq + 1) {
      resync();
      return;
    }
    if (event.patch.kind === "entry" || event.patch.kind === "session") {
      for (const requestedId of historyInFlight) {
        const queue = historyWatermarks.get(requestedId) ?? [];
        queue.push(event);
        historyWatermarks.set(requestedId, queue);
      }
    }
    if (event.patch.kind === "cooperation") {
      const ownerId = state.cooperationOwnerId;
      if (!ownerId || event.patch.message.relatedOwnerIds.includes(ownerId)) {
        const key = cooperationKey(ownerId);
        if (cooperationInFlight.has(key)) {
          const messages = cooperationLive.get(key) ?? new Map<string, WebCooperationMessage>();
          messages.set(event.patch.message.id, event.patch.message);
          cooperationLive.set(key, messages);
        }
      }
    }
    const updated = withPatch(state, event.patch, sessionAliases);
    publish({
      ...updated,
      snapshot: updated.snapshot
        ? { ...mergeSnapshotReceipts(updated.snapshot, updated.receipts), seq: event.seq }
        : updated.snapshot,
    });
  };
  const receive = (message: ClientSSEMessage, captured: number) => {
    if (captured !== generation) return;
    if (message.type === "notification") {
      publish({ ...state, notification: message.data });
      return;
    }
    if (message.type === "event") {
      if (state.connection !== "connected") eventBuffer.push(message.data);
      else receiveEvent(message.data);
      return;
    }
    const nextSnapshot = message.data;
    const oldEpoch = state.snapshot?.epoch;
    const receipts = oldEpoch === nextSnapshot.epoch ? state.receipts : {};
    const snapshotWithReceipts = mergeSnapshotReceipts(nextSnapshot, receipts);
    publish({
      ...state,
      snapshot: snapshotWithReceipts,
      connection: "syncing",
      pendingUIRequests: nextSnapshot.pendingUIRequests,
      receipts,
      histories: oldEpoch === nextSnapshot.epoch ? state.histories : {},
    });
    if (oldEpoch !== nextSnapshot.epoch) {
      sessionAliases.clear();
      inputAttempts.clear();
      publish({ ...state, uncertainInputId: null, error: null });
    }
    for (const receipt of nextSnapshot.inputReceipts) {
      const merged = mergeReceipt(state.receipts, receipt);
      publish({
        ...state,
        receipts: merged,
        snapshot: state.snapshot ? mergeSnapshotReceipts(state.snapshot, merged) : null,
      });
    }
    const buffered = eventBuffer;
    eventBuffer = [];
    for (const event of buffered) {
      if (event.epoch === nextSnapshot.epoch && event.seq <= nextSnapshot.seq) continue;
      if (
        !state.snapshot ||
        event.epoch !== nextSnapshot.epoch ||
        event.seq !== state.snapshot.seq + 1
      ) {
        resync();
        return;
      }
      receiveEvent(event);
    }
    const syncGeneration = generation;
    const work: Promise<unknown>[] = [];
    if (state.activeSessionId) work.push(loadHistory(state.activeSessionId));
    work.push(loadCooperation(state.cooperationOwnerId ?? undefined));
    void Promise.allSettled(work).then(() => {
      if (syncGeneration !== generation || stopped) return;
      const pending = eventBuffer;
      eventBuffer = [];
      publish({ ...state, connection: "connected", error: null });
      for (const event of pending) {
        if (event.epoch !== state.snapshot?.epoch || event.seq !== state.snapshot.seq + 1) {
          resync();
          return;
        }
        receiveEvent(event);
      }
    });
  };
  function connect(): void {
    if (stopped) return;
    const captured = generation;
    eventBuffer = [];
    publish({ ...state, connection: "syncing", error: null });
    try {
      const es = makeEventSource(api.eventsUrl());
      source = es;
      es.onopen = () => {
        if (captured === generation) publish({ ...state, connection: "syncing" });
      };
      es.onmessage = (event) => {
        const message = parseSSEMessage(event.type || "message", event.data);
        if (message) receive(message, captured);
      };
      for (const type of ["snapshot", "event", "notification"]) {
        es.addEventListener(type, ((event: MessageEvent<string>) => {
          const message = parseSSEMessage(type, event.data);
          if (message) receive(message, captured);
        }) as EventListener);
      }
      es.onerror = () => {
        if (captured !== generation) return;
        publish({ ...state, connection: "syncing" });
        closeSource();
        scheduleReconnect(captured);
      };
    } catch (error) {
      publish({ ...state, connection: "error", error: String(error) });
      scheduleReconnect(captured);
    }
  }
  async function loadHistory(sessionId: string, beforeEntryId?: string): Promise<void> {
    const requestGeneration = generation;
    const pageGeneration = (historyGeneration.get(sessionId) ?? 0) + 1;
    historyGeneration.set(sessionId, pageGeneration);
    const startSeq = state.snapshot?.seq ?? 0;
    historyWatermarks.set(sessionId, []);
    historyInFlight.add(sessionId);
    const previous = state.histories[sessionId];
    publish({
      ...state,
      histories: {
        ...state.histories,
        [sessionId]: { data: previous?.data ?? null, loading: true, error: null },
      },
    });
    try {
      const page = await api.history(sessionId, beforeEntryId);
      if (requestGeneration !== generation || pageGeneration !== historyGeneration.get(sessionId)) {
        if (historyGeneration.get(sessionId) === pageGeneration) historyInFlight.delete(sessionId);
        return;
      }
      sessionAliases.set(sessionId, page.sessionId);
      const events = [
        ...(historyWatermarks.get(sessionId) ?? []),
        ...(historyWatermarks.get(page.sessionId) ?? []),
      ]
        .filter(
          (event, index, all) =>
            event.seq > startSeq &&
            all.findIndex((candidate) => candidate.seq === event.seq) === index,
        )
        .filter((event) => {
          if (event.patch.kind === "entry") return event.patch.sessionId === page.sessionId;
          if (event.patch.kind === "session")
            return event.patch.session.sessionId === page.sessionId;
          return false;
        })
        .sort((a, b) => a.seq - b.seq);
      let merged = mergeHistory(previous?.data ?? null, page, Boolean(beforeEntryId));
      const currentHistory = state.histories[sessionId]?.data;
      const latestSessionEvent = events
        .filter(
          (event): event is WebEvent & { patch: Extract<WebPatch, { kind: "session" }> } =>
            event.patch.kind === "session" && event.patch.session.sessionId === page.sessionId,
        )
        .at(-1);
      if (!latestSessionEvent && currentHistory) {
        merged = {
          ...merged,
          stream: currentHistory.stream,
          activeTools: currentHistory.activeTools,
        };
      }
      for (const event of events) {
        if (event.patch.kind === "entry" && event.patch.sessionId === page.sessionId) {
          merged = { ...merged, entries: mergeEntries(merged.entries, [event.patch.entry]) };
        } else if (
          event.patch.kind === "session" &&
          event.patch.session.sessionId === page.sessionId
        ) {
          merged = {
            ...merged,
            stream: event.patch.session.stream,
            activeTools: event.patch.session.activeTools,
          };
        }
      }
      publish({
        ...state,
        histories: {
          ...state.histories,
          [sessionId]: { data: merged, loading: false, error: null },
        },
      });
      if (historyGeneration.get(sessionId) === pageGeneration) historyInFlight.delete(sessionId);
    } catch (error) {
      if (requestGeneration !== generation || pageGeneration !== historyGeneration.get(sessionId)) {
        if (historyGeneration.get(sessionId) === pageGeneration) historyInFlight.delete(sessionId);
        return;
      }
      publish({
        ...state,
        histories: {
          ...state.histories,
          [sessionId]: { data: previous?.data ?? null, loading: false, error: String(error) },
        },
      });
      if (historyGeneration.get(sessionId) === pageGeneration) historyInFlight.delete(sessionId);
    }
  }
  async function loadCooperation(ownerId?: string, before?: string): Promise<void> {
    const requestGeneration = generation;
    const requestOwner = ownerId ?? null;
    const requestKey = cooperationKey(requestOwner);
    if (requestOwner !== state.cooperationOwnerId) {
      publish({ ...state, cooperationOwnerId: requestOwner, cooperation: null });
    }
    cooperationInFlight.add(requestKey);
    cooperationLive.set(requestKey, new Map());
    try {
      const page = await api.cooperation(ownerId, before);
      if (requestGeneration !== generation) return;
      if (requestOwner !== (state.cooperationOwnerId ?? null)) return;
      const current = state.cooperation;
      const items = current
        ? [
            ...page.items,
            ...current.items.filter((item) => !page.items.some((next) => next.id === item.id)),
          ]
        : [...page.items];
      for (const message of cooperationLive.get(requestKey)?.values() ?? []) {
        const index = items.findIndex((item) => item.id === message.id);
        if (index < 0) items.push(message);
        else items[index] = message;
      }
      if (current) {
        for (const item of current.items) {
          if (!items.some((candidate) => candidate.id === item.id)) items.push(item);
        }
      }
      publish({
        ...state,
        cooperationOwnerId: requestOwner,
        cooperation: {
          ...page,
          items: [...new Map(items.map((item) => [item.id, item])).values()].sort(
            (a, b) => a.ts - b.ts,
          ),
        },
      });
    } catch (error) {
      if (requestGeneration === generation) publish({ ...state, error: String(error) });
    } finally {
      cooperationInFlight.delete(requestKey);
      cooperationLive.delete(requestKey);
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (source) return;
      stopped = false;
      generation++;
      connect();
    },
    stop() {
      stopped = true;
      generation++;
      closeSource();
      cancelReconnect?.();
      cancelReconnect = null;
      publish({ ...state, connection: "disconnected" });
    },
    setActiveSession(sessionId) {
      if (!sessionId) return;
      publish({ ...state, activeSessionId: sessionId });
      if (state.connection === "connected" || state.connection === "syncing")
        void loadHistory(sessionId);
    },
    setDraft(draft) {
      publish({ ...state, draft });
    },
    setInputBehavior(inputBehavior) {
      publish({ ...state, inputBehavior });
    },
    loadHistory,
    loadCooperation,
    async submitInput(text = state.draft, behavior = state.inputBehavior) {
      if (state.connection !== "connected" || !state.snapshot)
        throw new Error("Browser is syncing; input is unavailable");
      const input: WebInput = {
        epoch: state.snapshot.epoch,
        clientInputId: crypto.randomUUID(),
        text,
        behavior,
      };
      const requestGeneration = generation;
      inputAttempts.set(input.clientInputId, input);
      publish({ ...state, uncertainInputId: input.clientInputId });
      try {
        const receipt = await api.submit(input);
        if (requestGeneration !== generation || state.snapshot?.epoch !== input.epoch)
          return receipt;
        const latestReceipts = mergeReceipt(state.receipts, receipt);
        publish({
          ...state,
          receipts: latestReceipts,
          snapshot: state.snapshot ? mergeSnapshotReceipts(state.snapshot, latestReceipts) : null,
          uncertainInputId:
            state.uncertainInputId === input.clientInputId ? null : state.uncertainInputId,
          draft: text === state.draft ? "" : state.draft,
          error: null,
        });
        return receipt;
      } catch (error) {
        if (requestGeneration === generation && state.snapshot?.epoch === input.epoch) {
          publish({ ...state, error: error instanceof Error ? error.message : String(error) });
        }
        throw error;
      }
    },
    async retryInput(clientInputId) {
      const input = inputAttempts.get(clientInputId);
      if (!input) return null;
      if (!state.snapshot || state.snapshot.epoch !== input.epoch)
        throw new Error("Input belongs to an earlier runtime epoch");
      const requestGeneration = generation;
      try {
        const receipt = await api.receipt(clientInputId, input.epoch);
        if (requestGeneration !== generation || state.snapshot?.epoch !== input.epoch) return null;
        if (receipt) {
          const latestReceipts = mergeReceipt(state.receipts, receipt);
          publish({
            ...state,
            receipts: latestReceipts,
            snapshot: state.snapshot ? mergeSnapshotReceipts(state.snapshot, latestReceipts) : null,
            uncertainInputId:
              state.uncertainInputId === clientInputId ? null : state.uncertainInputId,
            draft: state.draft === input.text ? "" : state.draft,
            error: null,
          });
          return receipt;
        }
        const submitted = await api.submit(input);
        if (requestGeneration !== generation || state.snapshot?.epoch !== input.epoch)
          return submitted;
        const latestReceipts = mergeReceipt(state.receipts, submitted);
        publish({
          ...state,
          receipts: latestReceipts,
          snapshot: state.snapshot ? mergeSnapshotReceipts(state.snapshot, latestReceipts) : null,
          uncertainInputId:
            state.uncertainInputId === clientInputId ? null : state.uncertainInputId,
          draft: state.draft === input.text ? "" : state.draft,
          error: null,
        });
        return submitted;
      } catch (error) {
        if (requestGeneration === generation && state.snapshot?.epoch === input.epoch) {
          publish({ ...state, error: error instanceof Error ? error.message : String(error) });
        }
        throw error;
      }
    },
    async respond(requestId, response) {
      if (state.connection !== "connected" || !state.snapshot)
        throw new Error("Browser is syncing; responses are unavailable");
      await api.respond(requestId, state.snapshot.epoch, response);
    },
    async abortMain() {
      if (state.connection !== "connected" || !state.snapshot)
        throw new Error("Browser is syncing; abort is unavailable");
      await api.abort(state.snapshot.epoch);
    },
  };
}
