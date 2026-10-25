import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { HarnessRuntime, RuntimeHost } from "../../src/runtime";
import { startMainSession } from "../../src/runtime";
import { ensureRepoReady } from "../../src/runtime/repo-setup";

const provider = "harness-web-server-test";

export interface WebRuntimeFixture {
  root: string;
  repo: string;
  auth: AuthStorage;
  registry: ModelRegistry;
  model: Model;
  mock: MockModel;
  runtime: HarnessRuntime;
  cleanup: () => Promise<void>;
}

/** Starts an isolated, network-free Main runtime for HTTP and browser checks. */
export async function createWebRuntimeFixture(
  handler: MockHandler = { content: ["Done."] },
  host: RuntimeHost = { kind: "events", onUIRequest: () => {} },
  settingsOverrides: Record<string, unknown> = {},
): Promise<WebRuntimeFixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "harness-web-runtime-")));
  let auth: AuthStorage | undefined;
  let registry: ModelRegistry | undefined;
  let runtime: HarnessRuntime | undefined;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await runtime?.close();
    } finally {
      AgentRegistry.global().unregister("Main");
      registry?.unregisterProvider(provider);
      await auth?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  };
  try {
    const repoDir = path.join(root, "repo");
    await fs.mkdir(path.join(repoDir, ".git", "objects"), { recursive: true });
    await fs.mkdir(path.join(repoDir, ".git", "refs", "heads"), { recursive: true });
    await Bun.write(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    await Bun.write(
      path.join(repoDir, ".git", "config"),
      "[core]\nrepositoryformatversion = 0\nbare = false\n",
    );
    const native = vcs.requireGit(repoDir);
    await native.configSet("user.name", "Harness Test");
    await native.configSet("user.email", "harness-test@example.test");
    const ready = await ensureRepoReady(repoDir, { initIfMissing: true });

    auth = await AuthStorage.create(":memory:");
    auth.keys.setRuntime(provider, "test-key");
    registry = new ModelRegistry(auth, path.join(root, "models.yml"));
    const mock = createMockModel({ provider, id: "test-model", handler });
    registry.registerProvider(provider, {
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test-key",
      api: "harness-web-server-test-api",
      streamSimple: (model, context, options) => mock.stream(model, context, options),
      models: [
        {
          id: "test-model",
          name: "Harness web server test model",
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
    runtime = await startMainSession(
      { repo: ready.root, project: "web-test", resume: false, dataHome: root },
      host,
      {
        model,
        modelRegistry: registry,
        authStorage: auth,
        enableLsp: false,
        settingsOverrides: { "tools.approvalMode": "yolo", ...settingsOverrides },
      },
    );
    return { root, repo: ready.root, auth, registry, model, mock, runtime, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
