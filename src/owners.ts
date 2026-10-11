import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createAgentSession, type CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON } from "@oh-my-pi/pi-coding-agent/async";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import ownerPrompt from "./prompts/owner.md" with { type: "text" };
import assignmentPrompt from "./prompts/assignment.md" with { type: "text" };
import { type OwnerBinding, ProjectStore, validateSlug } from "./project";
import { validateSessionWorkspace } from "./sessions";

interface LiveOwner {
  result: CreateAgentSessionResult;
  unsubscribe: () => void;
  turn?: Promise<boolean>;
}

export interface SpawnReceipt extends OwnerBinding {
  existing: boolean;
  history: string;
}

export class OwnerCoordinator {
  #store: ProjectStore;
  #main: CreateAgentSessionResult | undefined;
  #owners = new Map<string, LiveOwner>();
  #queue: Promise<unknown> = Promise.resolve();
  #closing = false;
  #creationAbort = new AbortController();
  #cleanup: Promise<void> | undefined;

  constructor(store: ProjectStore) {
    this.#store = store;
  }

  attachMain(main: CreateAgentSessionResult): void {
    this.#main = main;
  }

  async restore(): Promise<void> {
    await this.#store.validateOwners();
    for (const binding of this.#store.manifest?.owners ?? []) {
      const live = await this.#createSession(binding, true);
      this.#owners.set(binding.id, live);
    }
  }

  spawn(ownerId: string, title: string, signal?: AbortSignal): Promise<SpawnReceipt> {
    if (this.#closing) return Promise.reject(new Error("Project is shutting down"));
    const creationSignal = signal
      ? AbortSignal.any([signal, this.#creationAbort.signal])
      : this.#creationAbort.signal;
    const operation = this.#queue.then(() => this.#spawn(ownerId, title, creationSignal));
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async #spawn(ownerId: string, title: string, signal?: AbortSignal): Promise<SpawnReceipt> {
    if (this.#closing) throw new Error("Project is shutting down");
    signal?.throwIfAborted();
    validateSlug(ownerId, "ownerId");
    if (ownerId === "main") throw new Error("ownerId 'main' is reserved");
    if (!title.trim() || title.length > 200) throw new Error("title must contain 1–200 characters");
    const existing = this.#store.getOwner(ownerId);
    if (existing) {
      if (existing.title !== title)
        throw new Error(`Owner ${ownerId} already has a different title`);
      if (!this.#owners.has(ownerId))
        throw new Error(`Owner ${ownerId} has no live session; restart with --resume`);
      return { ...existing, existing: true, history: `history://${ownerId}` };
    }
    if (AgentRegistry.global().get(ownerId))
      throw new Error(`Agent identity ${ownerId} is already occupied`);
    const main = this.#requireMain();
    const artifactsDir = main.session.sessionManager.getArtifactsDir();
    if (!artifactsDir) throw new Error("Main has no persistent artifact directory");
    const ownerPaths = this.#store.ownerPaths(ownerId);
    const requirement = path.join(ownerPaths.sharedDir, "requirement.md");
    if (!(await Bun.file(requirement).text()).trim())
      throw new Error(`Requirement is empty: ${requirement}`);
    const sessionFile = path.join(artifactsDir, `${ownerId}.jsonl`);
    for (const target of [ownerPaths.worktree, sessionFile]) {
      try {
        await fs.lstat(target);
      } catch (error) {
        if (isEnoent(error)) continue;
        throw error;
      }
      throw new Error(`Unbound resource already exists; inspect it before retrying: ${target}`);
    }
    const repo = vcs.requireGit(this.#store.repoRoot);
    if (await repo.refExists(`refs/heads/${ownerPaths.branch}`, signal)) {
      throw new Error(`Branch already exists: ${ownerPaths.branch}`);
    }
    const baseSha = await repo.headSha(signal);
    if (!baseSha)
      throw new Error("Repository needs an initial commit before owners can be created");
    const binding: OwnerBinding = { id: ownerId, title, ...ownerPaths, baseSha, sessionFile };
    let live: LiveOwner | undefined;
    let bound = false;
    try {
      await repo.createBranch(binding.branch, baseSha, false, signal);
      await repo.worktreeAdd(
        binding.worktree,
        binding.branch,
        {
          detach: false,
          clone: false,
          keepChanges: false,
        },
        signal,
      );
      signal?.throwIfAborted();
      live = await this.#createSession(binding, false);
      signal?.throwIfAborted();
      if (this.#closing) throw new Error("Project is shutting down");
      await this.#store.addOwner(binding);
      bound = true;
      this.#owners.set(ownerId, live);
      const turn = live.result.session.prompt(
        prompt.render(assignmentPrompt, {
          title,
          sharedDirectory: binding.sharedDir,
        }),
      );
      live.turn = turn;
      void turn.catch((error) => this.#reportFailure(ownerId, error));
      return { ...binding, existing: false, history: `history://${ownerId}` };
    } catch (error) {
      if (live && !bound) {
        live.unsubscribe();
        await live.result.session.dispose();
      }
      throw new Error(
        `Could not start ${ownerId}: ${error instanceof Error ? error.message : String(error)}. ` +
          `Resources are preserved: branch ${binding.branch}, worktree ${binding.worktree}, session ${sessionFile}`,
        { cause: error },
      );
    }
  }

  #requireMain(): CreateAgentSessionResult {
    if (!this.#main) throw new Error("Main session is not attached");
    return this.#main;
  }

  async #createSession(binding: OwnerBinding, resuming: boolean): Promise<LiveOwner> {
    const main = this.#requireMain();
    const mainManager = main.session.sessionManager;
    const manager = await SessionManager.open(binding.sessionFile, undefined, undefined, {
      initialCwd: binding.worktree,
      parentSession: mainManager.getSessionFile() ?? undefined,
      suppressBreadcrumb: true,
      throwIfMissing: resuming,
    });
    try {
      if (resuming) {
        await validateSessionWorkspace(manager, binding.worktree, [binding.sharedDir]);
        if (manager.getHeader()?.parentSession !== mainManager.getSessionFile()) {
          throw new Error(`Owner ${binding.id} is attached to a different parent session`);
        }
      }
      const artifactManager = mainManager.getArtifactManager();
      if (!artifactManager) throw new Error("Main artifact manager is unavailable");
      manager.adoptArtifactManager(artifactManager);
      const result = await createAgentSession({
        cwd: binding.worktree,
        additionalDirectories: [binding.sharedDir],
        sessionManager: manager,
        settings: createSubagentSettings(main.session.settings, {
          "task.isolation.enabled": false,
          "task.maxRecursionDepth": 2,
        }),
        authStorage: main.session.modelRegistry.authStorage,
        modelRegistry: main.session.modelRegistry,
        model: main.session.model,
        thinkingLevel: main.session.thinkingLevel,
        credentialSourceSessionId: mainManager.getSessionId(),
        agentId: binding.id,
        agentDisplayName: binding.title,
        parentAgentId: "Main",
        parentTaskPrefix: binding.id,
        taskDepth: 1,
        bindProcessState: false,
        enableIrc: true,
        enableMCP: false,
        hasUI: false,
        disableExtensionDiscovery: true,
        preloadedExtensionPaths: [],
        preloadedCustomToolPaths: [],
        subagentEventBus: main.subagentEventBus,
        appendSystemPrompt: prompt.render(ownerPrompt, {
          ownerId: binding.id,
          title: binding.title,
          worktree: binding.worktree,
          sharedDirectory: binding.sharedDir,
        }),
      });
      try {
        await manager.ensureOnDisk();
        const registry = AgentRegistry.global();
        const unsubscribe = registry.syncSessionStatus(binding.id, result.session);
        registry.setStatus(binding.id, "idle", result.session);
        return { result, unsubscribe };
      } catch (error) {
        await result.session.dispose();
        throw error;
      }
    } catch (error) {
      await manager.close();
      throw error;
    }
  }

  async #reportFailure(ownerId: string, error: unknown): Promise<void> {
    logger.error("Owner initial turn failed", { ownerId, error: String(error) });
    if (this.#closing) return;
    try {
      await IrcBus.global().send({
        from: ownerId,
        to: "Main",
        body: `Harness: owner initial turn failed: ${String(error)}. Session and worktree are retained; inspect history://${ownerId} before retrying.`,
      });
    } catch (deliveryError) {
      logger.warn("Owner failure notification failed", { ownerId, error: String(deliveryError) });
    }
  }

  dispose(): Promise<void> {
    this.#closing = true;
    this.#creationAbort.abort(ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
    this.#cleanup ??= this.#dispose();
    return this.#cleanup;
  }

  async #dispose(): Promise<void> {
    this.#main?.session.asyncJobManager?.cancelAll(undefined, ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
    const aborts = [...this.#owners.values()].map((owner) => {
      owner.result.session.beginDispose();
      return owner.result.session.abort({ reason: "project shutdown" });
    });
    await Promise.allSettled(aborts);
    await this.#queue;
    const owners = [...this.#owners.values()];
    for (const owner of owners) owner.result.session.beginDispose();
    await Promise.allSettled(
      owners.map((owner) => owner.result.session.abort({ reason: "project shutdown" })),
    );
    const settled = await Promise.allSettled(owners.map((owner) => owner.result.session.dispose()));
    for (const owner of owners) owner.unsubscribe();
    this.#owners.clear();
    const failure = settled.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
