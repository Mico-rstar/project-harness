import { afterEach, describe, expect, test } from "bun:test";
import type {
  WebCooperationPage,
  WebEvent,
  WebHistory,
  WebInput,
  WebReceipt,
  WebSnapshot,
} from "../src/web/contracts";
import { createWebStore, type WebEventSource, type WebStore } from "../src/web/client/store";
import type { WebAPI } from "../src/web/client/api";

class FakeEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as (event: MessageEvent<string>) => void);
    this.listeners.set(type, listeners);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    const event = { type, data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const snapshot = (seq = 0, epoch = "epoch-a"): WebSnapshot => ({
  epoch,
  seq,
  mainSessionId: "main-session",
  project: { name: "demo", repoRoot: "/repo" },
  owners: [],
  agents: [],
  sessions: [],
  cooperation: [],
  pendingUIRequests: [],
  inputReceipts: [],
  health: { degraded: false, issues: [] },
  closing: false,
});

const history = (entries: WebHistory["entries"] = []): WebHistory => ({
  sessionId: "main-session",
  entries,
  ownerId: undefined,
  nextBeforeEntryId: null,
  stream: null,
  activeTools: [],
});

function api(overrides: Partial<WebAPI> = {}): WebAPI {
  return {
    eventsUrl: () => "/api/events",
    history: async () => history(),
    cooperation: async (): Promise<WebCooperationPage> => ({
      items: [],
      nextBefore: null,
      coverage: { recordedSince: null, hasGaps: false, warnings: [] },
    }),
    submit: async (input: WebInput): Promise<WebReceipt> => ({
      ...input,
      state: "admitted",
      receivedAt: 1,
      updatedAt: 1,
    }),
    receipt: async () => null,
    respond: async () => {},
    abort: async () => {},
    ...overrides,
  };
}

describe("web client store synchronization", () => {
  const stores: WebStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.stop();
  });

  test("ignores duplicate events and reconnects on a sequence gap", async () => {
    const sources: FakeEventSource[] = [];
    const store = createWebStore({
      api: api(),
      eventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as WebEventSource;
      },
    });
    stores.push(store);
    store.start();
    const source = sources[0];
    source.emit("snapshot", snapshot());
    await Bun.sleep(0);
    expect(store.getSnapshot().connection).toBe("connected");

    const noop: WebEvent = { epoch: "epoch-a", seq: 1, patch: { kind: "noop" } };
    source.emit("event", noop);
    source.emit("event", noop);
    expect(store.getSnapshot().snapshot?.seq).toBe(1);
    expect(sources).toHaveLength(1);

    source.emit("event", { epoch: "epoch-a", seq: 3, patch: { kind: "noop" } } satisfies WebEvent);
    expect(source.closed).toBe(true);
    expect(sources).toHaveLength(2);
    expect(store.getSnapshot().connection).toBe("syncing");
  });

  test("merges live entries that arrive while history is loading without duplicates", async () => {
    const historyDeferred = Promise.withResolvers<WebHistory>();
    const sources: FakeEventSource[] = [];
    const store = createWebStore({
      api: api({ history: () => historyDeferred.promise }),
      eventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as WebEventSource;
      },
    });
    stores.push(store);
    store.start();
    sources[0].emit("snapshot", snapshot());
    await Bun.sleep(0);
    store.setActiveSession("main-session");
    const entry = {
      id: "entry-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      role: "assistant" as const,
      blocks: [{ type: "text" as const, text: "hello" }],
    };
    sources[0].emit("event", {
      epoch: "epoch-a",
      seq: 1,
      patch: { kind: "entry", sessionId: "main-session", entry },
    } satisfies WebEvent);
    historyDeferred.resolve(history([entry]));
    await Bun.sleep(0);
    expect(store.getSnapshot().histories["main-session"]?.data?.entries).toEqual([entry]);
  });

  test("rechecks the receipt before retrying an uncertain input", async () => {
    const sources: FakeEventSource[] = [];
    let posts = 0;
    const testApi = api({
      submit: async (input) => {
        posts++;
        return { ...input, state: "admitted", receivedAt: 1, updatedAt: 1 };
      },
      receipt: async (id, epoch) => ({
        epoch,
        clientInputId: id,
        text: "hello",
        behavior: "followUp",
        state: "admitted",
        receivedAt: 1,
        updatedAt: 1,
      }),
    });
    const store = createWebStore({
      api: testApi,
      eventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as WebEventSource;
      },
    });
    stores.push(store);
    store.start();
    sources[0].emit("snapshot", snapshot());
    await Bun.sleep(0);
    // Keep the generated id opaque in the test while proving the retry path never posts twice.
    store.setDraft("hello");
    await store.submitInput();
    const id = Object.keys(store.getSnapshot().receipts)[0];
    const receipt = await store.retryInput(id);
    expect(receipt?.state).toBe("admitted");
    expect(posts).toBe(1);
  });

  test("buffers synchronization events until history recovery finishes, then applies them in sequence", async () => {
    const historyDeferred = Promise.withResolvers<WebHistory>();
    const cooperationDeferred = Promise.withResolvers<WebCooperationPage>();
    const sources: FakeEventSource[] = [];
    const store = createWebStore({
      api: api({
        history: () => historyDeferred.promise,
        cooperation: () => cooperationDeferred.promise,
      }),
      eventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as WebEventSource;
      },
    });
    stores.push(store);
    store.start();
    sources[0].emit("snapshot", snapshot());
    store.setActiveSession("main-session");
    sources[0].emit("event", {
      epoch: "epoch-a",
      seq: 1,
      patch: {
        kind: "receipt",
        receipt: {
          epoch: "epoch-a",
          clientInputId: "r1",
          text: "x",
          behavior: "followUp",
          state: "admitted",
          receivedAt: 1,
          updatedAt: 1,
        },
      },
    } satisfies WebEvent);
    sources[0].emit("event", {
      epoch: "epoch-a",
      seq: 2,
      patch: { kind: "noop" },
    } satisfies WebEvent);
    expect(store.getSnapshot().snapshot?.seq).toBe(0);

    historyDeferred.resolve(history());
    cooperationDeferred.resolve({
      items: [],
      nextBefore: null,
      coverage: { recordedSince: null, hasGaps: false, warnings: [] },
    });
    await Bun.sleep(0);
    expect(store.getSnapshot().connection).toBe("connected");
    expect(store.getSnapshot().snapshot?.seq).toBe(2);
    expect(store.getSnapshot().receipts.r1?.state).toBe("admitted");
  });

  test("routes canonical session patches through an owner alias and clears the completed stream", async () => {
    const sources: FakeEventSource[] = [];
    const store = createWebStore({
      api: api({
        history: async () => ({
          ...history(),
          sessionId: "canonical-owner-session",
          ownerId: "owner-1",
        }),
      }),
      eventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as WebEventSource;
      },
    });
    stores.push(store);
    store.start();
    sources[0].emit("snapshot", snapshot());
    await Bun.sleep(0);
    store.setActiveSession("owner-1");
    await Bun.sleep(0);
    sources[0].emit("event", {
      epoch: "epoch-a",
      seq: 1,
      patch: {
        kind: "session",
        session: {
          sessionId: "canonical-owner-session",
          ownerId: "owner-1",
          active: true,
          isStreaming: true,
          stream: {
            id: "stream",
            timestamp: "2026-01-01T00:00:00.000Z",
            role: "assistant",
            blocks: [{ type: "text", text: "draft" }],
          },
          activeTools: [{ toolCallId: "tool-1", toolName: "inspect" }],
        },
      },
    } satisfies WebEvent);
    expect(store.getSnapshot().histories["owner-1"]?.data?.stream?.blocks).toHaveLength(1);
    expect(store.getSnapshot().histories["owner-1"]?.data?.activeTools).toHaveLength(1);
    expect(store.getSnapshot().snapshot?.sessions[0]?.isStreaming).toBe(true);

    sources[0].emit("event", {
      epoch: "epoch-a",
      seq: 2,
      patch: {
        kind: "entry",
        sessionId: "canonical-owner-session",
        entry: {
          id: "entry-1",
          timestamp: "2026-01-01T00:00:01.000Z",
          role: "assistant",
          blocks: [{ type: "text", text: "final" }],
        },
      },
    } satisfies WebEvent);
    expect(store.getSnapshot().histories["owner-1"]?.data?.stream).toBeNull();
  });

  test("late history pagination does not replace newer stream and active tool state", async () => {
    const historyDeferred = Promise.withResolvers<WebHistory>();
    const sources: FakeEventSource[] = [];
    const store = createWebStore({
      api: api({ history: () => historyDeferred.promise }),
      eventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as WebEventSource;
      },
    });
    stores.push(store);
    store.start();
    sources[0].emit("snapshot", snapshot());
    await Bun.sleep(0);
    store.setActiveSession("main-session");
    sources[0].emit("event", {
      epoch: "epoch-a",
      seq: 1,
      patch: {
        kind: "session",
        session: {
          sessionId: "main-session",
          active: true,
          isStreaming: true,
          stream: {
            id: "stream",
            timestamp: "2026-01-01T00:00:00.000Z",
            role: "assistant",
            blocks: [{ type: "text", text: "new" }],
          },
          activeTools: [{ toolCallId: "tool-new", toolName: "run" }],
        },
      },
    } satisfies WebEvent);
    historyDeferred.resolve(history());
    await Bun.sleep(0);
    expect(store.getSnapshot().histories["main-session"]?.data?.stream?.blocks[0]).toEqual({
      type: "text",
      text: "new",
    });
    expect(store.getSnapshot().histories["main-session"]?.data?.activeTools[0]?.toolCallId).toBe(
      "tool-new",
    );
  });

  test("a history page with a null stream does not revive an old stream", async () => {
    const historyDeferred = Promise.withResolvers<WebHistory>();
    const sources: FakeEventSource[] = [];
    let historyCalls = 0;
    const store = createWebStore({
      api: api({
        history: () => {
          historyCalls++;
          if (historyCalls === 1)
            return Promise.resolve({
              ...history(),
              stream: {
                id: "stream",
                timestamp: "2026-01-01T00:00:00.000Z",
                role: "assistant",
                blocks: [{ type: "text", text: "stale" }],
              },
            });
          return historyDeferred.promise;
        },
      }),
      eventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as WebEventSource;
      },
    });
    stores.push(store);
    store.start();
    sources[0].emit("snapshot", snapshot());
    await Bun.sleep(0);
    store.setActiveSession("main-session");
    await Bun.sleep(0);
    expect(store.getSnapshot().histories["main-session"]?.data?.stream).not.toBeNull();
    const paging = store.loadHistory("main-session", "entry-older");
    sources[0].emit("event", {
      epoch: "epoch-a",
      seq: 1,
      patch: {
        kind: "session",
        session: {
          sessionId: "main-session",
          active: false,
          isStreaming: false,
          stream: null,
          activeTools: [],
        },
      },
    } satisfies WebEvent);
    historyDeferred.resolve({ ...history(), stream: null });
    await paging;
    expect(store.getSnapshot().histories["main-session"]?.data?.stream).toBeNull();
  });

  test("preserves the selected cooperation scope across reconnect", async () => {
    const sources: FakeEventSource[] = [];
    const scopes: Array<string | undefined> = [];
    const store = createWebStore({
      api: api({
        cooperation: async (ownerId) => {
          scopes.push(ownerId);
          return {
            items: [],
            nextBefore: null,
            coverage: { recordedSince: null, hasGaps: false, warnings: [] },
          };
        },
      }),
      eventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as WebEventSource;
      },
    });
    stores.push(store);
    store.start();
    sources[0].emit("snapshot", snapshot());
    await Bun.sleep(0);
    await store.loadCooperation("owner-1");
    sources[0].onerror?.();
    await Bun.sleep(300);
    expect(sources).toHaveLength(2);
    sources[1].emit("snapshot", snapshot());
    await Bun.sleep(0);
    expect(scopes.at(-1)).toBe("owner-1");
    expect(store.getSnapshot().cooperationOwnerId).toBe("owner-1");
  });

  test("keeps failed input text and retries with the same ID and payload", async () => {
    const sources: FakeEventSource[] = [];
    const posted: WebInput[] = [];
    let failFirst = true;
    const store = createWebStore({
      api: api({
        submit: async (input) => {
          posted.push(input);
          if (failFirst) {
            failFirst = false;
            throw new Error("connection lost");
          }
          return { ...input, state: "admitted", receivedAt: 1, updatedAt: 2 };
        },
        receipt: async () => null,
      }),
      eventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as WebEventSource;
      },
    });
    stores.push(store);
    store.start();
    sources[0].emit("snapshot", snapshot());
    await Bun.sleep(0);
    store.setDraft("first message");
    await expect(store.submitInput("first message", "steer")).rejects.toThrow("connection lost");
    const clientInputId = store.getSnapshot().uncertainInputId;
    expect(store.getSnapshot().draft).toBe("first message");
    store.setDraft("edited draft");
    const receipt = await store.retryInput(clientInputId!);
    expect(receipt?.state).toBe("admitted");
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual(posted[0]);
    expect(store.getSnapshot().draft).toBe("edited draft");
    expect(store.getSnapshot().uncertainInputId).toBeNull();
  });

  test("preserves session patch state while advancing the event sequence", async () => {
    const sources: FakeEventSource[] = [];
    const store = createWebStore({
      api: api(),
      eventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as WebEventSource;
      },
    });
    stores.push(store);
    store.start();
    sources[0].emit("snapshot", snapshot());
    await Bun.sleep(0);
    sources[0].emit("event", {
      epoch: "epoch-a",
      seq: 1,
      patch: {
        kind: "session",
        session: {
          sessionId: "main-session",
          active: true,
          isStreaming: true,
          stream: {
            id: "stream",
            timestamp: "2026-01-01T00:00:00.000Z",
            role: "assistant",
            blocks: [{ type: "text", text: "working" }],
          },
          activeTools: [],
        },
      },
    } satisfies WebEvent);
    expect(store.getSnapshot().snapshot?.sessions[0]?.isStreaming).toBe(true);
    expect(store.getSnapshot().snapshot?.seq).toBe(1);
  });

  test("keeps a handled SSE receipt over a late admitted HTTP response", async () => {
    const submitDeferred = Promise.withResolvers<WebReceipt>();
    const sources: FakeEventSource[] = [];
    let sentInput: WebInput | null = null;
    const store = createWebStore({
      api: api({
        submit: (input) => {
          sentInput = input;
          return submitDeferred.promise;
        },
      }),
      eventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as WebEventSource;
      },
    });
    stores.push(store);
    store.start();
    sources[0].emit("snapshot", snapshot());
    await Bun.sleep(0);
    const pending = store.submitInput("hello");
    if (sentInput === null) throw new Error("submit did not start");
    const input: WebInput = sentInput;
    const handled: WebReceipt = { ...input, state: "handled", receivedAt: 1, updatedAt: 3 };
    sources[0].emit("event", {
      epoch: "epoch-a",
      seq: 1,
      patch: { kind: "receipt", receipt: handled },
    } satisfies WebEvent);
    submitDeferred.resolve({ ...input, state: "admitted", receivedAt: 1, updatedAt: 2 });
    await pending;
    expect(store.getSnapshot().receipts[input.clientInputId]?.state).toBe("handled");
    expect(
      store
        .getSnapshot()
        .snapshot?.inputReceipts.find((receipt) => receipt.clientInputId === input.clientInputId)
        ?.state,
    ).toBe("handled");
  });

  test("hydrates receipt state patch into both receipt indexes", async () => {
    const sources: FakeEventSource[] = [];
    const store = createWebStore({
      api: api(),
      eventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as WebEventSource;
      },
    });
    stores.push(store);
    store.start();
    sources[0].emit("snapshot", snapshot());
    await Bun.sleep(0);
    const receipt: WebReceipt = {
      epoch: "epoch-a",
      clientInputId: "from-state",
      text: "hello",
      behavior: "followUp",
      state: "handled",
      receivedAt: 1,
      updatedAt: 2,
    };
    const next = { ...snapshot(1), inputReceipts: [receipt] };
    sources[0].emit("event", {
      epoch: "epoch-a",
      seq: 1,
      patch: { kind: "state", snapshot: next },
    } satisfies WebEvent);
    expect(store.getSnapshot().receipts["from-state"]?.state).toBe("handled");
    expect(store.getSnapshot().snapshot?.inputReceipts[0]?.state).toBe("handled");
  });

  test("keeps IRC messages and delivery updates received while a page request is pending", async () => {
    const pageDeferred = Promise.withResolvers<WebCooperationPage>();
    let cooperationCalls = 0;
    const sources: FakeEventSource[] = [];
    const store = createWebStore({
      api: api({
        cooperation: () => {
          cooperationCalls++;
          if (cooperationCalls === 1) {
            return Promise.resolve({
              items: [],
              nextBefore: null,
              coverage: { recordedSince: null, hasGaps: false, warnings: [] },
            });
          }
          return pageDeferred.promise;
        },
      }),
      eventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as WebEventSource;
      },
    });
    stores.push(store);
    store.start();
    sources[0].emit("snapshot", snapshot());
    await Bun.sleep(0);
    await Bun.sleep(0);
    const loading = store.loadCooperation();
    const liveMessage = {
      id: "irc-1",
      operationId: "op-1",
      from: "Main",
      to: "owner-1",
      body: "Working",
      ts: 10,
      relatedOwnerIds: ["owner-1"],
      delivery: { outcome: "queued" },
    };
    sources[0].emit("event", {
      epoch: "epoch-a",
      seq: 1,
      patch: { kind: "cooperation", message: liveMessage },
    } satisfies WebEvent);
    sources[0].emit("event", {
      epoch: "epoch-a",
      seq: 2,
      patch: {
        kind: "cooperation",
        message: { ...liveMessage, delivery: { outcome: "delivered" } },
      },
    } satisfies WebEvent);
    pageDeferred.resolve({
      items: [],
      nextBefore: null,
      coverage: { recordedSince: null, hasGaps: false, warnings: [] },
    });
    await loading;
    expect(store.getSnapshot().cooperation?.items).toEqual([
      { ...liveMessage, delivery: { outcome: "delivered" } },
    ]);
  });

  test("can start a stopped store again", async () => {
    const sources: FakeEventSource[] = [];
    const store = createWebStore({
      api: api(),
      eventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as WebEventSource;
      },
    });
    stores.push(store);
    store.start();
    store.stop();
    let notified = 0;
    store.subscribe(() => notified++);
    store.start();
    expect(sources).toHaveLength(2);
    sources[1].emit("snapshot", snapshot());
    await Bun.sleep(0);
    expect(store.getSnapshot().connection).toBe("connected");
    expect(notified).toBeGreaterThan(0);
  });

  test("clears stale uncertain input on epoch change without discarding its draft", async () => {
    const sources: FakeEventSource[] = [];
    const store = createWebStore({
      api: api({
        submit: async () => {
          throw new Error("offline");
        },
      }),
      eventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as WebEventSource;
      },
    });
    stores.push(store);
    store.start();
    sources[0].emit("snapshot", snapshot());
    await Bun.sleep(0);
    store.setDraft("retry me");
    await expect(store.submitInput()).rejects.toThrow("offline");
    expect(store.getSnapshot().uncertainInputId).not.toBeNull();

    sources[0].onerror?.();
    await Bun.sleep(300);
    sources[1].emit("snapshot", snapshot(0, "epoch-b"));
    await Bun.sleep(0);
    expect(store.getSnapshot().uncertainInputId).toBeNull();
    expect(store.getSnapshot().draft).toBe("retry me");
    await expect(store.retryInput("old-id")).resolves.toBeNull();
  });
});
