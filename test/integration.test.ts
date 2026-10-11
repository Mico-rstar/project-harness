import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, type MockContent } from "@oh-my-pi/pi-ai/providers/mock";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ProjectStore } from "../src/project";
import { OwnerCoordinator } from "../src/owners";
import { projectExtension } from "../src/extension";
import { MAIN_TOOLS } from "../src/main";
import { validateSessionWorkspace } from "../src/sessions";

function call(name: string, argumentsValue: Record<string, unknown>): MockContent {
  return { type: "toolCall", name, arguments: argumentsValue };
}

describe("SDK owner coordination", () => {
  test("two owners plan, exchange IRC, share native-task worktrees and resume without dispatch", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "harness-integration-")),
    );
    const repoPath = path.join(root, "repo");
    await fs.mkdir(path.join(repoPath, ".git", "objects"), { recursive: true });
    await fs.mkdir(path.join(repoPath, ".git", "refs", "heads"), { recursive: true });
    await Bun.write(path.join(repoPath, ".git", "HEAD"), "ref: refs/heads/main\n");
    await Bun.write(
      path.join(repoPath, ".git", "config"),
      "[core]\nrepositoryformatversion = 0\nbare = false\n[user]\nname = Harness\nemail = harness@example.test\n",
    );
    await Bun.write(path.join(repoPath, "source.txt"), "original\n");
    const repo = vcs.requireGit(repoPath);
    await repo.stageFiles(["source.txt"]);
    await repo.commitCreate("Fixture", {});

    let store = await ProjectStore.open({
      repo: repoPath,
      project: "demo",
      resume: false,
      dataHome: root,
    });
    let coordinator = new OwnerCoordinator(store);
    let main: CreateAgentSessionResult | undefined;
    const auth = await AuthStorage.create(":memory:");
    auth.keys.setRuntime("harness-test", "test-key");
    const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
    const stages = new Map<string, number>();
    const mock = createMockModel({
      provider: "harness-test",
      handler(context) {
        const system = JSON.stringify(context.systemPrompt);
        let key = "main";
        for (const id of ["owner-a", "owner-b"]) {
          if (system.includes(`You are ${id},`)) key = id;
        }
        const stage = stages.get(key) ?? 0;
        stages.set(key, stage + 1);
        if (key === "main") return { content: ["Main acknowledges."] };
        if (key !== "owner-a" && key !== "owner-b") throw new Error("Unexpected test role");
        const shared = path.join(store.paths.shared, key);
        if (stage === 0)
          return {
            content: [
              call("write", {
                path: path.join(shared, "plan.md"),
                content: `Plan for ${key}: update source.txt and verify isolation.`,
              }),
            ],
          };
        if (stage === 1)
          return {
            content: [
              call("write", {
                path: "agent://Main",
                content: `${key} plan is ready for review`,
              }),
            ],
          };
        if (stage === 2) return { content: ["Waiting for Main approval."] };
        if (stage === 3)
          return {
            content: [
              call("task", {
                agent: "task",
                task: `Implement ${key} now`,
                solutionSpace:
                  "Write source.txt in the inherited worktree and read the shared requirement.",
              }),
            ],
          };
        if (stage === 4)
          return {
            content: [
              call("write", {
                path: path.join(shared, "progress.md"),
                content: `${key}: native task completed; source.txt updated.`,
              }),
            ],
          };
        if (stage === 5)
          return {
            content: [
              call("write", {
                path: "agent://Main",
                content: `${key} implementation completed`,
              }),
            ],
          };
        return { content: ["Owner is idle."] };
      },
    });
    const childMock = createMockModel({
      handler(context) {
        const serialized = JSON.stringify(context);
        const id = serialized.includes("Implement owner-a") ? "owner-a" : "owner-b";
        const last = context.messages.at(-1);
        if (last?.role === "toolResult") {
          if (last.toolName === "write")
            return {
              content: [
                call("yield", {
                  type: "result",
                  data: { changed: "source.txt", owner: id },
                }),
              ],
            };
          return {
            content: [call("write", { path: "source.txt", content: `implemented ${id}\n` })],
          };
        }
        return {
          content: [
            call("read", {
              path: path.join(store.paths.shared, id, "requirement.md"),
            }),
          ],
        };
      },
    });
    registry.registerProvider("harness-test", {
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test-key",
      api: "harness-script",
      streamSimple: (_model, context, options) => {
        if (JSON.stringify(context.systemPrompt).includes("Persistent requirement owner")) {
          return mock.stream(_model, context, options);
        }
        if (JSON.stringify(context).includes("Implement owner-"))
          return childMock.stream(_model, context, options);
        return mock.stream(_model, context, options);
      },
      models: [
        {
          id: "test-model",
          name: "Harness test model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      ],
    });
    const model = registry.find("harness-test", "test-model");
    if (!model) throw new Error("Test provider did not register");
    const settings = Settings.isolated({
      "memory.backend": "off",
      "autolearn.enabled": false,
      "tools.xdev": false,
      "advisor.enabled": false,
      "task.isolation.enabled": false,
      "task.maxRecursionDepth": 2,
      "tools.approvalMode": "yolo",
      externalThinking: false,
    });

    async function openMain(resuming: boolean): Promise<CreateAgentSessionResult> {
      const manager = resuming
        ? await SessionManager.open(store.manifest!.mainSessionFile, undefined, undefined, {
            throwIfMissing: true,
          })
        : SessionManager.create(store.paths.main, store.paths.sessions);
      const result = await createAgentSession({
        cwd: store.paths.main,
        additionalDirectories: [store.paths.shared],
        sessionManager: manager,
        model,
        modelRegistry: registry,
        authStorage: auth,
        settings,
        bindProcessState: false,
        hasUI: false,
        enableMCP: false,
        enableLsp: false,
        disableExtensionDiscovery: true,
        extensions: [projectExtension(coordinator)],
        contextFiles: [],
        skills: [],
        rules: [],
        promptTemplates: [],
        slashCommands: [],
        toolNames: MAIN_TOOLS,
      });
      await result.session.setActiveToolsByName(MAIN_TOOLS);
      await manager.ensureOnDisk();
      if (!resuming) await store.initialize(manager.getSessionFile()!);
      coordinator.attachMain(result);
      return result;
    }
    try {
      main = await openMain(false);
      const originalMainFile = main.session.sessionManager.getSessionFile();
      expect(await main.session.newSession()).toBe(false);
      expect(main.session.sessionManager.getSessionFile()).toBe(originalMainFile);
      for (const id of ["owner-a", "owner-b"]) {
        await Bun.write(path.join(store.paths.shared, id, "requirement.md"), `Implement ${id}`);
      }
      const spawnTool = main.session.getToolByName("spawn_owner");
      if (!spawnTool) throw new Error("Main spawn_owner is unavailable");
      const [launchA] = await Promise.all([
        spawnTool.execute("spawn-a", { ownerId: "owner-a", title: "Requirement A" }),
        coordinator.spawn("owner-b", "Requirement B"),
      ]);
      expect(launchA.isError).not.toBe(true);
      const receipts = store.manifest!.owners;
      expect(receipts[0]!.worktree).not.toBe(receipts[1]!.worktree);
      await expect(coordinator.spawn("owner-a", "Requirement A")).resolves.toMatchObject({
        existing: true,
      });
      for (const id of ["owner-a", "owner-b"]) {
        await waitFor(
          async () => stages.get(id) === 3 && AgentRegistry.global().get(id)?.status === "idle",
        );
        expect(await Bun.file(path.join(store.paths.shared, id, "plan.md")).text()).toContain(
          `Plan for ${id}`,
        );
      }
      expect(
        main.session.messages.some((message) => JSON.stringify(message).includes("plan is ready")),
      ).toBe(true);
      expect(main.session.getActiveToolNames().sort()).toEqual([...MAIN_TOOLS].sort());
      const mainCallsBeforeApproval = mock.calls.length;
      for (const id of ["owner-a", "owner-b"]) {
        const write = main.session.getToolByName("write");
        if (!write) throw new Error("Main write is unavailable");
        const result = await write.execute(`approve-${id}`, {
          path: `agent://${id}`,
          content: "Plan accepted; implement now.",
        });
        expect(result.isError).not.toBe(true);
      }
      for (const id of ["owner-a", "owner-b"]) {
        await waitFor(
          async () =>
            (stages.get(id) ?? 0) >= 7 && AgentRegistry.global().get(id)?.status === "idle",
        );
        await waitFor(
          async () =>
            (await Bun.file(path.join(store.paths.worktrees, id, "source.txt")).text()) ===
            `implemented ${id}\n`,
        );
        const taskResults = AgentRegistry.global()
          .get(id)
          ?.session?.messages.filter(
            (message) => message.role === "toolResult" && message.toolName === "task",
          );
        expect(JSON.stringify(taskResults)).not.toContain('"isError":true');
        expect(await Bun.file(path.join(store.paths.worktrees, id, "source.txt")).text()).toBe(
          `implemented ${id}\n`,
        );
        const owner = AgentRegistry.global().get(id);
        expect(owner?.parentId).toBe("Main");
        expect(owner?.session?.getActiveToolNames()).not.toContain("spawn_owner");
        expect(
          AgentRegistry.global()
            .list()
            .some((ref) => ref.parentId === id),
        ).toBe(true);
        const read = main.session.getToolByName("read");
        if (!read) throw new Error("Main read is unavailable");
        const history = await read.execute(`history-${id}`, { path: `history://${id}` });
        expect(history.isError).not.toBe(true);
        expect(JSON.stringify(history.content)).toContain("Plan accepted; implement now.");
        expect(JSON.stringify(history.content)).toContain("→ task");
      }
      expect(mock.calls.length).toBeGreaterThan(mainCallsBeforeApproval);
      expect(await Bun.file(path.join(repoPath, "source.txt")).text()).toBe("original\n");
      const childIds = AgentRegistry.global()
        .list()
        .filter((ref) => ref.parentId === "owner-a" || ref.parentId === "owner-b")
        .map((ref) => ref.id);
      await expect(coordinator.spawn("owner-a", "Different requirement")).rejects.toThrow(
        "different title",
      );
      await expect(coordinator.spawn("../escape", "Invalid")).rejects.toThrow("slug");
      await expect(coordinator.spawn("owner-c", "Missing requirement")).rejects.toThrow();
      await coordinator.dispose();
      await main.session.dispose();
      store.release();
      store = await ProjectStore.open({
        repo: repoPath,
        project: "demo",
        resume: true,
        dataHome: root,
      });
      coordinator = new OwnerCoordinator(store);
      main = await openMain(true);
      const requestsBeforeResume = mock.calls.length;
      await coordinator.restore();
      expect(mock.calls.length).toBe(requestsBeforeResume);
			expect(store.manifest?.owners.map((owner) => owner.id).sort()).toEqual(["owner-a", "owner-b"]);
      for (const binding of store.manifest!.owners) {
        const owner = AgentRegistry.global().get(binding.id)!;
        expect(owner.status).toBe("idle");
        await validateSessionWorkspace(owner.session!.sessionManager, binding.worktree, [
          binding.sharedDir,
        ]);
        expect(
          owner.session!.messages.some((message) =>
            JSON.stringify(message).includes("implementation completed"),
          ),
        ).toBe(true);
      }
      const read = main.session.getToolByName("read");
      if (!read) throw new Error("Main read is unavailable after resume");
      for (const id of childIds) {
        const history = await read.execute(`restored-history-${id}`, { path: `history://${id}` });
        expect(history.isError).not.toBe(true);
        expect(JSON.stringify(history.content)).toContain("source.txt");
      }
    } finally {
      await coordinator.dispose();
      await main?.session.dispose();
      store.release();
      registry.unregisterProvider("harness-test");
      await auth.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for SDK coordination");
    await Bun.sleep(10);
  }
}
