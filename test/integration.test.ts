import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, type MockContent } from "@oh-my-pi/pi-ai/providers/mock";
import type { Model } from "@oh-my-pi/pi-ai";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ProjectStore } from "../src/runtime/project";
import { OwnerCoordinator, workspaceRoots } from "../src/runtime/owners";
import { projectExtension } from "../src/runtime/extension";
import { MAIN_TOOLS } from "../src/runtime/main-session";
import { validateSessionWorkspace } from "../src/runtime/sessions";

function call(name: string, argumentsValue: Record<string, unknown>): MockContent {
  return { type: "toolCall", name, arguments: argumentsValue };
}

async function openMainSession(options: {
  store: ProjectStore;
  coordinator: OwnerCoordinator;
  registry: ModelRegistry;
  auth: AuthStorage;
  settings: Settings;
  model: Model;
  resuming: boolean;
}): Promise<CreateAgentSessionResult> {
  const { store, coordinator, registry, auth, settings, model, resuming } = options;
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

    const openMain = (resuming: boolean) =>
      openMainSession({ store, coordinator, registry, auth, settings, model, resuming });
    try {
      main = await openMain(false);
      const originalMainFile = main.session.sessionManager.getSessionFile();
      expect(await main.session.newSession()).toBe(false);
      expect(main.session.sessionManager.getSessionFile()).toBe(originalMainFile);
      // Session-leaving slash commands are consumed by the extension with an
      // explanation, before any native picker can open and trap the user.
      const resumeAttempt = await main.session.extensionRunner?.emitInput(
        "/resume",
        undefined,
        "rpc",
      );
      expect(resumeAttempt?.handled).toBe(true);
      const freshAttempt = await main.session.extensionRunner?.emitInput("/new", undefined, "rpc");
      expect(freshAttempt?.handled).toBe(true);
      const ordinaryAttempt = await main.session.extensionRunner?.emitInput(
        "/model",
        undefined,
        "rpc",
      );
      expect(ordinaryAttempt?.handled).not.toBe(true);
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
      expect(store.manifest?.owners.map((owner) => owner.id).sort()).toEqual([
        "owner-a",
        "owner-b",
      ]);
      for (const binding of store.manifest!.owners) {
        const owner = AgentRegistry.global().get(binding.id)!;
        expect(owner.status).toBe("idle");
        const { cwd, additional } = workspaceRoots(binding);
        await validateSessionWorkspace(owner.session!.sessionManager, cwd, additional);
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

  test("non-Git project roots inherit the root and honor explicit workspace entries", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "harness-workspaces-")),
    );
    const container = path.join(root, "container");
    await fs.mkdir(container);
    await Bun.write(path.join(container, "notes.md"), "container\n");
    const seedRepo = async (dir: string, file: string) => {
      await fs.mkdir(path.join(dir, ".git", "objects"), { recursive: true });
      await fs.mkdir(path.join(dir, ".git", "refs", "heads"), { recursive: true });
      await Bun.write(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
      await Bun.write(
        path.join(dir, ".git", "config"),
        "[core]\nrepositoryformatversion = 0\nbare = false\n[user]\nname = Harness\nemail = harness@example.test\n",
      );
      await Bun.write(path.join(dir, file), "original\n");
      const repo = vcs.requireGit(dir);
      await repo.stageFiles([file]);
      await repo.commitCreate("Fixture", {});
      return repo;
    };
    const a1 = path.join(container, "a1");
    const a2 = path.join(container, "a2");
    const repoA2 = await seedRepo(a2, "lib.txt");
    await seedRepo(a1, "lib.txt");
    const plainDir = path.join(root, "plain-dir");
    await fs.mkdir(plainDir);

    let store = await ProjectStore.open({
      repo: container,
      project: "multi",
      resume: false,
      dataHome: root,
    });
    let coordinator = new OwnerCoordinator(store);
    const auth = await AuthStorage.create(":memory:");
    auth.keys.setRuntime("harness-test", "test-key");
    const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
    const mock = createMockModel({
      provider: "harness-test",
      handler: () => ({ content: ["Idle."] }),
    });
    registry.registerProvider("harness-test", {
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test-key",
      api: "harness-script",
      streamSimple: (_model, context, options) => mock.stream(_model, context, options),
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
    const openMain = (resuming: boolean) =>
      openMainSession({ store, coordinator, registry, auth, settings, model, resuming });
    let main: CreateAgentSessionResult | undefined;
    try {
      main = await openMain(false);
      for (const id of ["req-root", "req-x", "req-attach", "req-y", "neg-1", "neg-2", "neg-3"]) {
        await Bun.write(path.join(store.paths.shared, id, "requirement.md"), `Do ${id}`);
      }
      const spawnTool = main.session.getToolByName("spawn_owner");
      if (!spawnTool) throw new Error("Main spawn_owner is unavailable");

      // Default spawn in a non-Git root inherits the project root itself.
      const defaultLaunch = await spawnTool.execute("spawn-default", {
        ownerId: "req-root",
        title: "Root work",
      });
      expect(defaultLaunch.isError).not.toBe(true);
      const defaultBinding = store.getOwner("req-root");
      expect(defaultBinding?.entries).toEqual([{ path: container }]);
      expect(defaultBinding?.worktree).toBe(container);
      const rootOwner = AgentRegistry.global().get("req-root");
      expect(rootOwner?.session?.sessionManager.getCwd()).toBe(container);

      // Mixed entries: inherit a1 in place, cut an a2 worktree on a new branch.
      const mixed = await spawnTool.execute("spawn-mixed", {
        ownerId: "req-x",
        title: "Cross repo",
        workspace: [{ from: a1 }, { from: a2, checkout: "feat-x" }],
      });
      expect(mixed.isError).not.toBe(true);
      const mixedBinding = store.getOwner("req-x");
      expect(mixedBinding?.worktree).toBe(a1);
      expect(mixedBinding?.entries[0]).toEqual({ path: a1 });
      const cut = mixedBinding?.entries[1];
      expect(cut?.checkout).toBe("feat-x");
      expect(cut?.repo).toBe(a2);
      expect(cut?.path).toBe(path.join(store.paths.worktrees, "req-x"));
      expect(await repoA2.currentBranch()).toBe("main");
      const mixedOwner = AgentRegistry.global().get("req-x");
      expect(mixedOwner?.session?.sessionManager.getCwd()).toBe(a1);
      expect(mixedOwner?.session?.sessionManager.getAdditionalDirectories()).toContain(cut?.path);

      // Negative contracts surface as tool errors Main can self-correct from.
      const relative = await spawnTool.execute("neg-relative", {
        ownerId: "neg-1",
        title: "N",
        workspace: "a1",
      });
      expect(relative.isError).toBe(true);
      expect(JSON.stringify(relative.content)).toContain("absolute path");
      const missing = await spawnTool.execute("neg-missing", {
        ownerId: "neg-2",
        title: "N",
        workspace: [{ from: path.join(root, "absent") }],
      });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing.content)).toContain("does not exist");
      const notGit = await spawnTool.execute("neg-git", {
        ownerId: "neg-3",
        title: "N",
        workspace: [{ from: plainDir, checkout: "feature" }],
      });
      expect(notGit.isError).toBe(true);
      expect(JSON.stringify(notGit.content)).toContain("not inside a Git repository");

      // Workspace entries are exclusive: the inherited root cannot host a second owner.
      await expect(coordinator.spawn("req-y", "Second root work")).rejects.toThrow(
        "already occupied",
      );

      // An explicit checkout of an existing branch attaches instead of failing.
      const attachBase = await repoA2.headSha();
      if (!attachBase) throw new Error("Fixture repository must have a commit");
      await repoA2.createBranch("feat-y", attachBase, false);
      await coordinator.spawn("req-attach", "Attach work", undefined, {
        entries: [{ from: a2, checkout: "feat-y" }],
      });
      const featYSha = await repoA2.resolveRef("refs/heads/feat-y");
      if (!featYSha) throw new Error("Fixture branch must resolve");
      const attachBinding = store.getOwner("req-attach");
      expect(attachBinding?.entries[0]?.checkout).toBe("feat-y");
      expect(attachBinding?.entries[0]?.baseSha).toBe(featYSha);
      expect(attachBinding?.worktree).toBe(path.join(store.paths.worktrees, "req-attach"));

      await coordinator.dispose();
      await main.session.dispose();
      store.release();
      store = await ProjectStore.open({
        repo: container,
        project: "multi",
        resume: true,
        dataHome: root,
      });
      coordinator = new OwnerCoordinator(store);
      main = await openMain(true);
      const callsBeforeResume = mock.calls.length;
      await coordinator.restore();
      expect(mock.calls.length).toBe(callsBeforeResume);
      expect(store.manifest?.owners.map((owner) => owner.id).sort()).toEqual([
        "req-attach",
        "req-root",
        "req-x",
      ]);
      for (const binding of store.manifest!.owners) {
        const owner = AgentRegistry.global().get(binding.id)!;
        expect(owner.status).toBe("idle");
        const { cwd, additional } = workspaceRoots(binding);
        await validateSessionWorkspace(owner.session!.sessionManager, cwd, additional);
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
