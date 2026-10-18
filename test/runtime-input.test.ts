import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import {
  createMockModel,
  type MockContent,
  type MockHandler,
  type MockModel,
} from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { HarnessRuntime, RuntimeEvent, RuntimeHost, RuntimeUIRequest } from "../src/runtime";
import { startMainSession } from "../src/runtime";
import { ensureRepoReady } from "../src/runtime/repo-setup";

const roots: string[] = [];
const provider = "harness-runtime-input-test";

interface Fixture {
  root: string;
  repo: string;
  auth: AuthStorage;
  registry: ModelRegistry;
  model: Model;
  mock: MockModel;
  unregisterProvider: () => void;
}

async function fixture(handler: MockHandler = { content: ["Done."] }): Promise<Fixture> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "harness-runtime-input-")),
  );
  roots.push(root);
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(path.join(repo, ".git", "objects"), { recursive: true });
  await fs.mkdir(path.join(repo, ".git", "refs", "heads"), { recursive: true });
  await Bun.write(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await Bun.write(
    path.join(repo, ".git", "config"),
    "[core]\nrepositoryformatversion = 0\nbare = false\n",
  );
  const native = vcs.requireGit(repo);
  await native.configSet("user.name", "Harness Test");
  await native.configSet("user.email", "harness-test@example.test");
  const ready = await ensureRepoReady(repo, { initIfMissing: true });

  const auth = await AuthStorage.create(":memory:");
  auth.keys.setRuntime(provider, "test-key");
  const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
  const mock = createMockModel({ provider, id: "test-model", handler });
  registry.registerProvider(provider, {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "test-key",
    api: "harness-runtime-input-test-api",
    streamSimple: (model, context, options) => mock.stream(model, context, options),
    models: [
      {
        id: "test-model",
        name: "Harness runtime input test model",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    ],
  });
  const model = registry.find(provider, "test-model");
  if (!model) throw new Error("Test model did not register");
  return {
    root,
    repo: ready.root,
    auth,
    registry,
    model,
    mock,
    unregisterProvider: () => registry.unregisterProvider(provider),
  };
}

function launchOptions(f: Fixture) {
  return { repo: f.repo, project: "runtime-test", resume: false, dataHome: f.root };
}

function dependencies(f: Fixture, settingsOverrides: Record<string, unknown> = {}) {
  return {
    model: f.model,
    modelRegistry: f.registry,
    authStorage: f.auth,
    enableLsp: false,
    settingsOverrides: {
      "tools.approvalMode": "yolo",
      ...settingsOverrides,
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime input state");
    await Bun.sleep(5);
  }
}

async function closeFixture(f: Fixture, runtime?: HarnessRuntime, ownerId?: string): Promise<void> {
  try {
    await runtime?.close();
  } finally {
    if (ownerId) AgentRegistry.global().unregister(ownerId);
    AgentRegistry.global().unregister("Main");
    f.unregisterProvider();
    await f.auth.close();
  }
}

async function runApprovalCase(answer: "Approve" | "Deny" | "timeout"): Promise<{
  events: RuntimeEvent[];
  request: RuntimeUIRequest;
  runtime: HarnessRuntime;
  f: Fixture;
  ownerId: string;
  calls: number;
  toolResultContext: string;
}> {
  const ownerId = `approval-${crypto.randomUUID().slice(0, 8)}`;
  let approvalCalls = 0;
  const f = await fixture((context) => {
    approvalCalls++;
    if (approvalCalls === 1) {
      return {
        content: [
          {
            type: "toolCall",
            name: "spawn_owner",
            arguments: { ownerId, title: "Approval check" },
          } satisfies MockContent,
        ],
      };
    }
    return { content: [JSON.stringify(context.messages)] };
  });
  const requests: RuntimeUIRequest[] = [];
  const events: RuntimeEvent[] = [];
  const mock = f.mock;
  const host: RuntimeHost = {
    kind: "events",
    uiTimeoutMs: answer === "timeout" ? 40 : 2_000,
    onUIRequest: (request) => requests.push(request),
  };
  const runtime = await startMainSession(
    launchOptions(f),
    host,
    dependencies(f, { "tools.approval.spawn_owner": "prompt" }),
  );
  await fs.mkdir(path.join(f.root, "project-harness"), { recursive: true });
  const repoHash = new Bun.CryptoHasher("sha256").update(f.repo).digest("hex").slice(0, 16);
  await fs.mkdir(
    path.join(f.root, "project-harness", repoHash, "runtime-test", "shared", ownerId),
    { recursive: true },
  );
  await Bun.write(
    path.join(
      f.root,
      "project-harness",
      repoHash,
      "runtime-test",
      "shared",
      ownerId,
      "requirement.md",
    ),
    "Exercise tool approval behavior.",
  );
  const eventsHost: RuntimeHost = host;
  if (eventsHost.kind !== "events") throw new Error("Test requires events host");
  const previousOnUIRequest = eventsHost.onUIRequest;
  eventsHost.onUIRequest = (request) => {
    requests.push(request);
    previousOnUIRequest(request);
  };
  const observed = runtime.observe((event) => events.push(event));
  await runtime.submitMainInput({
    epoch: observed.snapshot.epoch,
    clientInputId: `approval-${answer}`,
    text: "Please launch the approval check.",
  });
  const inputKey = { epoch: observed.snapshot.epoch, clientInputId: `approval-${answer}` };
  try {
    await waitFor(
      () =>
        requests.some((request) => request.kind === "select") ||
        runtime.snapshot().pendingUIRequests.some((request) => request.kind === "select") ||
        runtime.getInputReceipt(inputKey)?.state === "rejected",
      5_000,
    );
  } catch (error) {
    throw new Error(
      `No approval request: receipt=${JSON.stringify(runtime.getInputReceipt(inputKey))}, ` +
        `mockCalls=${mock.calls.length}, events=${JSON.stringify(
          events.map((event) => ({
            type: event.type,
            payload:
              event.type === "session_event"
                ? event.payload
                : event.type === "input_receipt"
                  ? event.payload
                  : undefined,
          })),
        )}`,
      { cause: error },
    );
  }
  const request =
    requests.find((candidate) => candidate.kind === "select") ??
    runtime.snapshot().pendingUIRequests.find((candidate) => candidate.kind === "select");
  if (!request) {
    throw new Error(
      `Expected a tool approval request, receipt=${JSON.stringify(runtime.getInputReceipt(inputKey))}, calls=${mock.calls.length}`,
    );
  }
  if (answer !== "timeout") {
    if (request.kind !== "select") throw new Error("Expected a select approval request");
    const selectRequest = request;
    runtime.respondToUIRequest({
      epoch: selectRequest.epoch,
      requestId: selectRequest.requestId,
      response: { kind: "select", value: answer },
    });
  }
  await waitFor(() => mock.calls.length >= 2);
  const toolResultContext = JSON.stringify(mock.calls[1]?.context.messages ?? []);
  observed.unsubscribe();
  return { events, request, runtime, f, ownerId, calls: mock.calls.length, toolResultContext };
}

describe("runtime input and UI lifecycle", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  test("deduplicates admitted inputs, returns receipts promptly, and rejects changed content", async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    const mock = createMockModel({
      provider,
      handler: async () => {
        await gate.promise;
        return { content: ["Input completed."] };
      },
    });
    f.registry.registerProvider(provider, {
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test-key",
      api: "harness-runtime-input-test-api",
      streamSimple: (model, context, options) => mock.stream(model, context, options),
      models: [
        {
          id: "test-model",
          name: "Harness runtime input test model",
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      ],
    });
    const runtime = await startMainSession(launchOptions(f), { kind: "headless" }, dependencies(f));
    const events: RuntimeEvent[] = [];
    const observed = runtime.observe((event) => events.push(event));
    try {
      const input = {
        epoch: observed.snapshot.epoch,
        clientInputId: "same-input",
        text: "Keep the request admitted while the model is still running.",
        images: [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }],
      };
      const first = await runtime.submitMainInput(input);
      const duplicate = await runtime.submitMainInput(input);
      expect(first.state).toBe("received");
      expect(duplicate.clientInputId).toBe(first.clientInputId);
      await waitFor(() => runtime.getInputReceipt(input)?.state === "admitted");
      expect(runtime.getInputReceipt(input)?.state).toBe("admitted");
      expect(mock.calls).toHaveLength(0);
      expect(
        events.filter(
          (event) =>
            event.type === "input_receipt" &&
            (event.payload as { clientInputId?: string }).clientInputId === "same-input" &&
            (event.payload as { state?: string }).state === "received",
        ),
      ).toHaveLength(1);
      await expect(
        runtime.submitMainInput({
          ...input,
          images: [{ type: "image", data: "d29ybGQ=", mimeType: "image/png" }],
        }),
      ).rejects.toThrow("different content");
      expect(runtime.getInputReceipt(input)?.state).toBe("admitted");
      gate.resolve();
      await waitFor(() => mock.calls.length === 1);
    } finally {
      gate.resolve();
      observed.unsubscribe();
      await closeFixture(f, runtime);
    }
  });

  test("reports blocked session switching as handled without sending it to the model", async () => {
    const f = await fixture();
    const mock = createMockModel({ provider, handler: { content: ["Unexpected model call."] } });
    f.registry.registerProvider(provider, {
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test-key",
      api: "harness-runtime-input-test-api",
      streamSimple: (model, context, options) => mock.stream(model, context, options),
      models: [
        {
          id: "test-model",
          name: "Harness runtime input test model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      ],
    });
    const notifications: string[] = [];
    const runtime = await startMainSession(
      launchOptions(f),
      {
        kind: "events",
        onUIRequest: () => {},
        onNotify: (notice) => notifications.push(notice.message),
      },
      dependencies(f),
    );
    const observation = runtime.observe(() => {});
    try {
      const receipt = await runtime.submitMainInput({
        epoch: observation.snapshot.epoch,
        clientInputId: "blocked-resume",
        text: "/resume",
      });
      await waitFor(
        () =>
          runtime.getInputReceipt({
            epoch: observation.snapshot.epoch,
            clientInputId: "blocked-resume",
          })?.state === "handled",
      );
      expect(receipt.state).toBe("received");
      expect(
        runtime.getInputReceipt({
          epoch: observation.snapshot.epoch,
          clientInputId: "blocked-resume",
        })?.state,
      ).toBe("handled");
      expect(mock.calls).toHaveLength(0);
      expect(
        notifications.some((message) => message.includes("Session switching is disabled")),
      ).toBe(true);
    } finally {
      observation.unsubscribe();
      await closeFixture(f, runtime);
    }
  });

  test("event UI approval runs a gated tool and denial blocks it", async () => {
    const approved = await runApprovalCase("Approve");
    try {
      expect(approved.request.kind).toBe("select");
      expect(approved.calls).toBeGreaterThanOrEqual(2);
      expect(approved.runtime.snapshot().owners.map((owner) => owner.id)).toContain(
        approved.ownerId,
      );
    } finally {
      await closeFixture(approved.f, approved.runtime, approved.ownerId);
    }

    const denied = await runApprovalCase("Deny");
    try {
      expect(denied.request.kind).toBe("select");
      expect(denied.calls).toBeGreaterThanOrEqual(2);
      expect(denied.toolResultContext).toContain("denied by user");
      expect(denied.toolResultContext).not.toContain("Could not start");
      expect(denied.runtime.snapshot().owners).toHaveLength(0);
    } finally {
      await closeFixture(denied.f, denied.runtime);
    }
  }, 60_000);

  test("event UI timeout resolves approval as a denial", async () => {
    const result = await runApprovalCase("timeout");
    try {
      expect(result.request.kind).toBe("select");
      expect(result.calls).toBeGreaterThanOrEqual(2);
      expect(result.toolResultContext).toContain("denied by user");
      expect(result.runtime.snapshot().owners).toHaveLength(0);
    } finally {
      await closeFixture(result.f, result.runtime);
    }
  }, 30_000);
});
