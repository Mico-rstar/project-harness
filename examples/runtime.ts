import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { HarnessRuntime } from "../src/runtime";
import { startMainSession } from "../src/runtime";

const provider = "project-harness-runtime-example";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-runtime-example-"));
let auth: AuthStorage | undefined;
let runtime: HarnessRuntime | undefined;
let unregisterProvider: (() => void) | undefined;
const events: Array<{ type: string; payload?: unknown }> = [];

async function waitForTurn(
  received: PromiseWithResolvers<"agent_end" | "timeout">,
  timeoutMs: number,
): Promise<"agent_end" | "timeout"> {
  const timer = setTimeout(() => received.resolve("timeout"), timeoutMs);
  try {
    return await received.promise;
  } finally {
    clearTimeout(timer);
  }
}

try {
  // Any populated directory can host a project; no Git repository required.
  // Owners default to inheriting this root and can bind specific checkouts
  // via spawn_owner workspace entries.
  const projectRoot = path.join(root, "plain-workspace");
  await fs.mkdir(projectRoot, { recursive: true });
  await Bun.write(path.join(projectRoot, "README.md"), "# Runtime example\n");
  const canonicalRoot = await fs.realpath(projectRoot);

  auth = await AuthStorage.create(":memory:");
  auth.keys.setRuntime(provider, "example-key");
  const modelRegistry = new ModelRegistry(auth, path.join(root, "models.yml"));
  const mock = createMockModel({
    provider,
    id: "deterministic-model",
    handler: { content: ["This example uses the headless project harness runtime."] },
  });
  modelRegistry.registerProvider(provider, {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "example-key",
    api: "project-harness-runtime-example-api",
    streamSimple: (model, context, options) => mock.stream(model, context, options),
    models: [
      {
        id: "deterministic-model",
        name: "Deterministic runtime example",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 2_048,
      },
    ],
  });
  unregisterProvider = () => modelRegistry.unregisterProvider(provider);
  const model = modelRegistry.find(provider, "deterministic-model");
  if (!model) throw new Error("Mock model registration failed");

  runtime = await startMainSession(
    { repo: canonicalRoot, project: "runtime-example", resume: false, dataHome: root },
    { kind: "headless" },
    {
      model,
      modelRegistry,
      authStorage: auth,
      enableLsp: false,
      settingsOverrides: { "tools.approvalMode": "yolo" },
    },
  );

  const turnEnded = Promise.withResolvers<"agent_end" | "timeout">();
  const observation = runtime.observe((event) => {
    events.push({
      type: event.type,
      ...(event.type === "session_event" ? { payload: event.payload } : {}),
    });
    if (
      event.type === "session_event" &&
      event.sessionId === runtime?.mainSessionId &&
      typeof event.payload === "object" &&
      event.payload !== null &&
      "type" in event.payload &&
      event.payload.type === "agent_end"
    ) {
      turnEnded.resolve("agent_end");
    }
  });
  const input = await runtime.submitMainInput({
    epoch: observation.snapshot.epoch,
    clientInputId: crypto.randomUUID(),
    text: "Explain your current responsibilities.",
  });
  const completion = await waitForTurn(turnEnded, 15_000);
  const receipt = runtime.getInputReceipt({
    epoch: observation.snapshot.epoch,
    clientInputId: input.clientInputId,
  });
  const transcript = await runtime.readSession(runtime.mainSessionId, { limit: 20 });
  process.stdout.write(
    `${JSON.stringify(
      {
        mainSessionId: runtime.mainSessionId,
        receipt,
        completion,
        assistantMessages: transcript.entries.filter((entry) => {
          if (!("message" in entry)) return false;
          return entry.message.role === "assistant";
        }),
        observedEventCount: events.length,
      },
      null,
      2,
    )}\n`,
  );
  observation.unsubscribe();
  if (completion !== "agent_end") process.exitCode = 1;
} finally {
  try {
    await runtime?.close();
  } finally {
    unregisterProvider?.();
    await auth?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
