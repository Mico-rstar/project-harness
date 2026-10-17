import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, type MockContent } from "@oh-my-pi/pi-ai/providers/mock";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { MAIN_TOOLS } from "../src/main-session";
import { runtimeSession } from "../src/runtime-internals";
import { startMainSession } from "../src/runtime";
import type { HarnessRuntime } from "../src/contracts";

function call(name: string, argumentsValue: Record<string, unknown>): MockContent {
  return { type: "toolCall", name, arguments: argumentsValue };
}

describe("production harness runtime", () => {
  test("runs two owners and nested task sessions, and restores histories without prompting", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "harness-runtime-")));
    const repoPath = path.join(root, "repo");
    await fs.mkdir(path.join(repoPath, ".git", "objects"), { recursive: true });
    await fs.mkdir(path.join(repoPath, ".git", "refs", "heads"), { recursive: true });
    await Bun.write(path.join(repoPath, ".git", "HEAD"), "ref: refs/heads/main\n");
    await Bun.write(
      path.join(repoPath, ".git", "config"),
      "[core]\nrepositoryformatversion = 0\nbare = false\n[user]\nname = Harness\nemail = harness@example.test\n",
    );
    await Bun.write(path.join(repoPath, "source.txt"), "base\n");
    const repo = vcs.requireGit(repoPath);
    await repo.stageFiles(["source.txt"]);
    await repo.commitCreate("Fixture", {});

    const auth = await AuthStorage.create(":memory:");
    auth.keys.setRuntime("runtime-test", "test-key");
    const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
    let calls = 0;
    const stageByOwner = new Map<string, number>();
    registry.registerProvider("runtime-test", {
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test-key",
      api: "runtime-script",
      streamSimple: (_model, _context, options) => {
        calls++;
        const system = JSON.stringify(_context.systemPrompt);
        const owner = system.includes("You are owner-one,")
          ? "owner-one"
          : system.includes("You are owner-two,")
            ? "owner-two"
            : "main";
        const stage = stageByOwner.get(owner) ?? 0;
        stageByOwner.set(owner, stage + 1);
        const shared = path.join(root, "project-harness", "shared", owner);
        const handler = () => {
          if (owner === "main") return { content: ["Main online."] };
          if (stage === 0)
            return {
              content: [
                call("write", {
                  path: path.join(shared, "plan.md"),
                  content: `Plan for ${owner}: update source.txt and verify the owner workspace.`,
                }),
              ],
            };
          if (stage === 1)
            return {
              content: [
                call("write", {
                  path: "agent://Main",
                  content: `${owner} plan is ready.`,
                }),
              ],
            };
          if (stage === 2) return { content: ["Waiting for approval."] };
          if (stage === 3)
            return {
              content: [
                call("task", {
                  agent: "task",
                  task: `Implement ${owner}`,
                  solutionSpace:
                    "Read requirement.md and update source.txt in the inherited worktree.",
                }),
              ],
            };
          return { content: [`${owner} complete.`] };
        };
        return createMockModel({ handler }).stream(_model, _context, options);
      },
      models: [
        {
          id: "runtime-model",
          name: "Runtime test",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 4096,
        },
      ],
    });
    const model = registry.find("runtime-test", "runtime-model");
    if (!model) throw new Error("Runtime fixture model is missing");
    const dependencies = { model, modelRegistry: registry, authStorage: auth, enableLsp: false };
    const launch = { repo: repoPath, project: "runtime", resume: false, dataHome: root };
    let runtime: HarnessRuntime | undefined;
    try {
      runtime = await startMainSession(launch, { kind: "headless" }, dependencies);
      expect(
        runtime
          .snapshot()
          .sessions.filter((session) => session.sessionId === runtime!.mainSessionId),
      ).toHaveLength(1);
      expect(runtime.snapshot().mainSessionId).toBe(runtime.mainSessionId);
      expect(calls).toBe(0);
      expect(runtimeSession(runtime).session.getActiveToolNames().sort()).toEqual(
        [...MAIN_TOOLS].sort(),
      );

      const main = runtimeSession(runtime);
      const sharedDirs = await findNamedDirectory(root, "shared");
      const sharedOwnerDirs = ["owner-one", "owner-two"].map((id) => path.join(sharedDirs, id));
      for (const directory of sharedOwnerDirs) {
        await fs.mkdir(directory, { recursive: true });
        await Bun.write(path.join(directory, "requirement.md"), "Implement an isolated change.");
      }
      const spawnTool = main.session.getToolByName("spawn_owner");
      if (!spawnTool) throw new Error("Production Main did not register spawn_owner");
      const seen: string[] = [];
      const subscription = runtime.observe((event) => {
        if (event.type === "session_entry" && event.ownerId === "owner-one")
          seen.push(event.sessionId ?? "");
      });
      const spawnA = await spawnTool.execute("runtime-spawn-a", {
        ownerId: "owner-one",
        title: "Owner one",
      });
      const spawnB = await spawnTool.execute("runtime-spawn-b", {
        ownerId: "owner-two",
        title: "Owner two",
      });
      expect(spawnA.isError).not.toBe(true);
      expect(spawnB.isError).not.toBe(true);
      await waitFor(() => ["owner-one", "owner-two"].every((id) => stageByOwner.get(id) === 3));
      const ownerRef = AgentRegistry.global().get("owner-one");
      expect(ownerRef?.session).toBeDefined();
      expect(
        (await runtime.readSession("owner-one")).entries.some((entry) => entry.type === "message"),
      ).toBe(true);
      const mainWrite = main.session.getToolByName("write");
      if (!mainWrite) throw new Error("Main write is unavailable");
      for (const id of ["owner-one", "owner-two"]) {
        const approval = await mainWrite.execute(`approve-${id}`, {
          path: `agent://${id}`,
          content: "Plan approved; implement now.",
        });
        expect(approval.isError).not.toBe(true);
      }
      await waitFor(() =>
        ["owner-one", "owner-two"].every((id) => (stageByOwner.get(id) ?? 0) >= 4),
      );
      await waitFor(() =>
        ["owner-one", "owner-two"].every((id) =>
          AgentRegistry.global()
            .list()
            .some((ref) => ref.parentId === id),
        ),
      );
      const childIds: string[] = [];
      const childSessionIds = new Map<string, string>();
      for (const id of ["owner-one", "owner-two"]) {
        const ownerSession = runtime.snapshot().sessions.find((session) => session.ownerId === id);
        expect(ownerSession).toBeDefined();
        const page = await runtime.readSession(ownerSession!.sessionId);
        expect(
          page.entries.some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "assistant" &&
              JSON.stringify(entry.message).includes(`Plan for ${id}`),
          ),
        ).toBe(true);
        const child = AgentRegistry.global()
          .list()
          .find((ref) => ref.parentId === id);
        expect(child).toBeDefined();
        childIds.push(child!.id);
        const childPage = await waitForValue(async () => {
          const page = await runtime!.readSession(child!.id);
          return page.entries.some((entry) => entry.type === "message") ? page : undefined;
        });
        childSessionIds.set(child!.id, childPage.sessionId);
        expect(
          childPage.entries.some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "assistant" &&
              JSON.stringify(entry.message).includes("complete"),
          ),
        ).toBe(true);
      }
      const ownerOneSessionId = runtime
        .snapshot()
        .sessions.find((session) => session.ownerId === "owner-one")!.sessionId;
      expect(seen).toContain(ownerOneSessionId);
      subscription.unsubscribe();

      await waitFor(() =>
        ["owner-one", "owner-two"].every((id) => AgentRegistry.global().get(id)?.status === "idle"),
      );
      const ownerEntryCounts = new Map(
        ["owner-one", "owner-two"].map((id) => [
          id,
          AgentRegistry.global().get(id)!.session!.sessionManager.getEntries().length,
        ]),
      );
      await runtime.close();
      for (const childId of childIds) AgentRegistry.global().unregister(childId);
      const ownerStagesAtClose = new Map(stageByOwner);
      runtime = await startMainSession(
        { ...launch, resume: true },
        { kind: "headless" },
        dependencies,
      );
      for (const childId of childIds) {
        const restoredBySessionId = await runtime.readSession(childSessionIds.get(childId)!);
        const page = await runtime.readSession(childId);
        expect(restoredBySessionId.entries).toEqual(page.entries);
        expect(page.sessionId).not.toBe(childId);
        expect(
          page.entries.some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "assistant" &&
              JSON.stringify(entry.message).includes("complete"),
          ),
        ).toBe(true);
        expect((await runtime.readSession(page.sessionId)).entries).toEqual(page.entries);
      }
      expect(
        runtime
          .snapshot()
          .owners.map((owner) => owner.id)
          .sort(),
      ).toEqual(["owner-one", "owner-two"]);
      expect(
        runtime
          .snapshot()
          .sessions.filter((session) => session.ownerId)
          .map((session) => session.ownerId)
          .sort(),
      ).toEqual(["owner-one", "owner-two"]);
      for (const id of ["owner-one", "owner-two"]) {
        expect(stageByOwner.get(id)).toBe(ownerStagesAtClose.get(id));
        const ownerSession = runtime.snapshot().sessions.find((session) => session.ownerId === id)!;
        const page = await runtime.readSession(ownerSession.sessionId);
        expect(page.entries.length).toBeGreaterThanOrEqual(ownerEntryCounts.get(id)!);
        expect(
          page.entries.some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "assistant" &&
              JSON.stringify(entry.message).includes(`Plan for ${id}`),
          ),
        ).toBe(true);
      }
    } finally {
      await runtime?.close();
      registry.unregisterProvider("runtime-test");
      await auth.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

async function findNamedDirectory(root: string, name: string): Promise<string> {
  const directories = [root];
  while (directories.length > 0) {
    const current = directories.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (entry.name === name) return child;
      directories.push(child);
    }
  }
  throw new Error(`Could not find ${name} directory`);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for runtime owner");
    await Bun.sleep(10);
  }
}

async function waitForValue<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (true) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for child session transcript");
    await Bun.sleep(10);
  }
}
