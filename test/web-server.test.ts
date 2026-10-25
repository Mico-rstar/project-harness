import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import type {
  HarnessRuntime,
  InputReceipt,
  RuntimeEvent,
  RuntimeSnapshot,
  RuntimeUIResponse,
} from "../src/runtime/contracts";
import { createWebServer, type WebServer } from "../src/web/server";
import { createWebRuntimeFixture } from "./helpers/web-runtime";

const epoch = "epoch-test";

function snapshot(seq = 0): RuntimeSnapshot {
  return {
    epoch,
    seq,
    mainSessionId: "main",
    project: { name: "demo", repoRoot: "/repo" },
    owners: [],
    agents: [],
    sessions: [],
    cooperation: [],
    pendingUIRequests: [],
    inputReceipts: [],
    health: { degraded: false, issues: [] },
    closing: false,
  };
}

function fixture() {
  let current = snapshot();
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const receipts = new Map<string, InputReceipt>();
  const receivedResponses: RuntimeUIResponse[] = [];
  let submissions = 0;
  let unsubscriptions = 0;
  let aborted = 0;
  const runtime: HarnessRuntime = {
    mainSessionId: "main",
    snapshot: () => current,
    observe(listener) {
      listeners.add(listener);
      return {
        snapshot: current,
        unsubscribe: () => {
          listeners.delete(listener);
          unsubscriptions++;
        },
      };
    },
    async readSession(sessionId, options) {
      if (sessionId === "invalid-decoder") throw new Error("invalid internal decoder");
      if (sessionId !== "main") throw new Error(`Unknown session: ${sessionId}`);
      return {
        sessionId,
        entries: [],
        nextBeforeEntryId: options?.beforeEntryId ?? null,
        stream: null,
        activeTools: [],
      };
    },
    async readCooperation(options) {
      return {
        items: [],
        nextBefore: options?.before ?? null,
        coverage: { recordedSince: null, hasGaps: false, warnings: [] },
      };
    },
    async submitMainInput(input) {
      submissions++;
      const key = `${input.epoch}:${input.clientInputId}`;
      const existing = receipts.get(key);
      if (existing) {
        if (existing.text !== input.text)
          throw new Error("clientInputId reused with different input");
        return existing;
      }
      const now = Date.now();
      const receipt: InputReceipt = {
        ...input,
        behavior: input.behavior ?? "followUp",
        state: "received",
        receivedAt: now,
        updatedAt: now,
      };
      receipts.set(key, receipt);
      return receipt;
    },
    getInputReceipt(input) {
      if (input.epoch !== epoch) throw new Error("Input belongs to a stale runtime epoch");
      return receipts.get(`${input.epoch}:${input.clientInputId}`);
    },
    respondToUIRequest(input) {
      receivedResponses.push(input.response);
      return true;
    },
    abortMainTurn() {
      aborted++;
    },
    async close() {},
  };
  return {
    runtime,
    receivedResponses,
    submissions: () => submissions,
    unsubscriptions: () => unsubscriptions,
    aborted: () => aborted,
    emit(seq: number) {
      current = snapshot(seq);
      const event: RuntimeEvent = {
        epoch,
        seq,
        type: "health_changed",
        payload: { degraded: false, issues: [] },
      };
      for (const listener of listeners) listener(event);
    },
  };
}

const servers: WebServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function start() {
  const value = fixture();
  const server = createWebServer(value.runtime, { port: 0 });
  servers.push(server);
  return { ...value, server };
}

function localHeaders(server: WebServer, extra: Record<string, string> = {}) {
  return { host: new URL(server.url).host, ...extra };
}

async function post(
  server: WebServer,
  path: string,
  data: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: localHeaders(server, {
      origin: server.url,
      "content-type": "application/json",
      ...headers,
    }),
    body: typeof data === "string" ? data : JSON.stringify(data),
  });
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe("web server HTTP contracts", () => {
  test("restricts host and origin before accepting API requests", async () => {
    const { server } = await start();
    const badHost = await fetch(`${server.url}/api/cooperation`, {
      headers: { host: "attacker.test" },
    });
    expect(badHost.status).toBe(403);
    expect(await errorCode(badHost)).toBe("invalid_host");

    const badOrigin = await fetch(`${server.url}/api/cooperation`, {
      headers: localHeaders(server, { origin: "http://attacker.test" }),
    });
    expect(badOrigin.status).toBe(403);
    expect(await errorCode(badOrigin)).toBe("invalid_origin");
    const missingWriteOrigin = await fetch(`${server.url}/api/main/abort`, {
      method: "POST",
      headers: localHeaders(server, { "content-type": "application/json" }),
      body: "{}",
    });
    expect(missingWriteOrigin.status).toBe(403);
  });

  test("maps malformed JSON, wrong content type, oversized bodies and invalid limits", async () => {
    const { server } = await start();
    expect((await post(server, "/api/input", "not-json")).status).toBe(400);
    expect((await post(server, "/api/input", {}, { "content-type": "text/plain" })).status).toBe(
      415,
    );
    expect((await post(server, "/api/input", "x".repeat(1024 * 1024 + 1))).status).toBe(413);
    const badLimit = await fetch(`${server.url}/api/cooperation?limit=501`, {
      headers: localHeaders(server),
    });
    expect(badLimit.status).toBe(400);
    expect(await errorCode(badLimit)).toBe("invalid_request");
  });

  test("accepts a current input once, returns its receipt, and rejects conflicting ID reuse", async () => {
    const { server, submissions } = await start();
    const input = {
      epoch,
      clientInputId: "input-1",
      text: "Implement the agreed change",
      behavior: "followUp",
    };
    const first = await post(server, "/api/input", input);
    expect(first.status).toBe(200);
    const receipt = (await first.json()) as InputReceipt;
    expect(receipt.clientInputId).toBe("input-1");
    expect(receipt.text).toBe(input.text);
    expect(receipt.state).toBe("received");

    const duplicate = await post(server, "/api/input", input);
    expect(duplicate.status).toBe(200);
    expect(((await duplicate.json()) as InputReceipt).clientInputId).toBe("input-1");
    expect(submissions()).toBe(2);
    const conflict = await post(server, "/api/input", { ...input, text: "Different content" });
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("input_conflict");
    const history = await fetch(`${server.url}/api/inputs/input-1?epoch=${epoch}`, {
      headers: localHeaders(server),
    });
    expect(((await history.json()) as InputReceipt).text).toBe(input.text);
  });

  test("rejects stale epochs and adapts all four UI response kinds", async () => {
    const { server, receivedResponses } = await start();
    const stale = await post(server, "/api/input", { epoch: "old", clientInputId: "x", text: "x" });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe("stale_epoch");

    const responses: RuntimeUIResponse[] = [
      { kind: "select", value: "option-a" },
      { kind: "confirm", value: false },
      { kind: "input", value: "answer" },
      { kind: "editor", value: "edited text" },
    ];
    for (const [index, response] of responses.entries()) {
      const result = await post(server, `/api/ui-requests/request-${index}/respond`, {
        epoch,
        response,
      });
      expect(result.status).toBe(200);
    }
    expect(receivedResponses).toEqual(responses);
  });
});

describe("web server event stream", () => {
  test("sends an initial snapshot followed by sequenced events and unsubscribes on cancellation", async () => {
    const value = await start();
    const response = await fetch(`${value.server.url}/api/events`, {
      headers: localHeaders(value.server),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const initial = decoder.decode((await reader.read()).value);
    expect(initial).toContain("event: snapshot");
    expect(initial).toContain(`id: ${epoch}:0`);

    value.emit(1);
    const update = decoder.decode((await reader.read()).value);
    expect(update).toContain("event: event");
    expect(update).toContain(`id: ${epoch}:1`);
    await value.server.close();
    servers.splice(servers.indexOf(value.server), 1);
    await reader.read().catch(() => ({ done: true as const, value: undefined }));
    expect(value.unsubscriptions()).toBe(1);
  });

  test("closes active streams when the server closes", async () => {
    const value = await start();
    const response = await fetch(`${value.server.url}/api/events`, {
      headers: localHeaders(value.server),
    });
    const reader = response.body!.getReader();
    await reader.read();
    await value.server.close();
    servers.splice(servers.indexOf(value.server), 1);
    await reader.read().catch(() => ({ done: true as const, value: undefined }));
    expect(value.unsubscriptions()).toBe(1);
  });
});

test("serves a real runtime input receipt without calling an external model", async () => {
  const real = await createWebRuntimeFixture({ content: ["Fixture response."] });
  const server = createWebServer(real.runtime, { port: 0 });
  try {
    const initial = real.runtime.snapshot();
    const response = await post(server, "/api/input", {
      epoch: initial.epoch,
      clientInputId: "real-runtime-input",
      text: "A real runtime boundary check",
      behavior: "followUp",
    });
    expect(response.status).toBe(200);
    const receipt = (await response.json()) as InputReceipt;
    expect(receipt.clientInputId).toBe("real-runtime-input");
    expect(["received", "admitted", "handled"]).toContain(receipt.state);

    const deadline = Date.now() + 10_000;
    while (real.mock.calls.length === 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(real.mock.calls.length).toBe(1);
    const history = await fetch(`${server.url}/api/sessions/${initial.mainSessionId}/history`, {
      headers: localHeaders(server),
    });
    expect(history.status).toBe(200);
    expect(real.mock.calls[0]?.context.messages.length).toBeGreaterThan(0);
  } finally {
    await server.close();
    await real.cleanup();
  }
});

test("completes a real gated tool after its UI approval is answered over HTTP", async () => {
  const ownerId = `web-approval-${crypto.randomUUID().slice(0, 8)}`;
  const real = await createWebRuntimeFixture(
    (context) => {
      if (context.messages.some((message) => message.role === "toolResult")) {
        return { content: ["Owner launch completed."] };
      }
      return {
        content: [
          {
            type: "toolCall",
            name: "spawn_owner",
            arguments: { ownerId, title: "HTTP approval path" },
          },
        ],
      };
    },
    { kind: "events", onUIRequest: () => {} },
    { "tools.approval.spawn_owner": "prompt" },
  );
  const server = createWebServer(real.runtime, { port: 0 });
  try {
    const repoHash = new Bun.CryptoHasher("sha256").update(real.repo).digest("hex").slice(0, 16);
    await Bun.write(
      path.join(
        real.root,
        "project-harness",
        repoHash,
        "web-test",
        "shared",
        ownerId,
        "requirement.md",
      ),
      "Create an owner to verify HTTP mediated approval.",
    );
    const epochAtStart = real.runtime.snapshot().epoch;
    const submitted = await post(server, "/api/input", {
      epoch: epochAtStart,
      clientInputId: "approval-through-http",
      text: "Start the approved owner",
    });
    expect(submitted.status).toBe(200);

    const deadline = Date.now() + 10_000;
    let request = real.runtime.snapshot().pendingUIRequests.find((item) => item.kind === "select");
    while (!request && Date.now() < deadline) {
      await Bun.sleep(5);
      request = real.runtime.snapshot().pendingUIRequests.find((item) => item.kind === "select");
    }
    expect(request?.kind).toBe("select");
    if (!request || request.kind !== "select")
      throw new Error("Runtime did not request tool approval");

    const approved = await post(server, `/api/ui-requests/${request.requestId}/respond`, {
      epoch: request.epoch,
      response: { kind: "select", value: "Approve" },
    });
    expect(approved.status).toBe(200);

    const ownerDeadline = Date.now() + 15_000;
    while (
      !real.runtime.snapshot().owners.some((owner) => owner.id === ownerId) &&
      Date.now() < ownerDeadline
    ) {
      await Bun.sleep(10);
    }
    expect(real.runtime.snapshot().owners.map((owner) => owner.id)).toContain(ownerId);
  } finally {
    await server.close();
    await real.cleanup();
  }
}, 30_000);

test("returns safe errors for unknown sessions and old-epoch receipt reads", async () => {
  const value = await start();
  const unknownSession = await fetch(`${value.server.url}/api/sessions/unknown-session/history`, {
    headers: localHeaders(value.server),
  });
  expect(unknownSession.status).toBe(404);
  const unknownSessionBody = await unknownSession.text();
  expect(unknownSessionBody).not.toContain("/repo");
  expect(unknownSessionBody).not.toContain("project-harness");

  const decoderFailure = await fetch(`${value.server.url}/api/sessions/invalid-decoder/history`, {
    headers: localHeaders(value.server),
  });
  expect(decoderFailure.status).toBe(500);
  const decoderBody = await decoderFailure.text();
  expect(JSON.parse(decoderBody).error.code).toBe("internal_error");
  expect(decoderBody).not.toContain("invalid internal decoder");
  expect(decoderBody).not.toContain("/repo");

  const oldReceipt = await fetch(`${value.server.url}/api/inputs/missing?epoch=old-epoch`, {
    headers: localHeaders(value.server),
  });
  expect(oldReceipt.status).toBe(409);
  const oldReceiptBody = await oldReceipt.text();
  expect(JSON.parse(oldReceiptBody).error.code).toBe("stale_epoch");
  expect(oldReceiptBody).not.toContain("/repo");
  expect(oldReceiptBody).not.toContain("project-harness");
});
