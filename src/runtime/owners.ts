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
import { type OwnerBinding, type OwnerPaths, type WorkspaceEntry, ProjectStore, validateSlug } from "./project";
import { validateSessionWorkspace } from "./sessions";

interface LiveOwner {
  result: CreateAgentSessionResult;
  unsubscribe: () => void;
  turn?: Promise<boolean>;
}

/** One requested workspace root. `checkout` cuts a worktree from the Git repository containing `from`. */
export interface OwnerWorkspaceEntry {
  from: string;
  checkout?: string;
}

export interface OwnerWorkspaceRequest {
  entries: OwnerWorkspaceEntry[];
}

/** Internal request entry carrying whether the checkout branch was harness-generated. */
interface WorkspaceRequestEntry extends OwnerWorkspaceEntry {
  autoBranch?: boolean;
}

async function ensureAbsent(target: string): Promise<void> {
  try {
    await fs.lstat(target);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  throw new Error(`Unbound resource already exists; inspect it before retrying: ${target}`);
}

/** Session cwd plus additional directories, derived identically for creation and restore. */
export function workspaceRoots(binding: OwnerBinding): { cwd: string; additional: string[] } {
  return {
    cwd: binding.worktree,
    additional: [binding.sharedDir, ...binding.entries.slice(1).map((entry) => entry.path)],
  };
}

export interface SpawnReceipt extends OwnerBinding {
  existing: boolean;
  history: string;
}

export type OwnerSessionReady = (ownerId: string, live: CreateAgentSessionResult) => void;
export type OwnerSessionUnready = (ownerId: string, live: CreateAgentSessionResult) => void;

export class OwnerCoordinator {
  #store: ProjectStore;
  #main: CreateAgentSessionResult | undefined;
  #owners = new Map<string, LiveOwner>();
  #queue: Promise<unknown> = Promise.resolve();
  #closing = false;
  #creationAbort = new AbortController();
  #cleanup: Promise<void> | undefined;
  #onSessionReady: OwnerSessionReady | undefined;
  #onSessionUnready: OwnerSessionUnready | undefined;

  constructor(store: ProjectStore) {
    this.#store = store;
  }

  attachMain(main: CreateAgentSessionResult): void {
    this.#main = main;
  }

  setOnSessionReady(callback: OwnerSessionReady | undefined): void {
    this.#onSessionReady = callback;
  }

  setOnSessionUnready(callback: OwnerSessionUnready | undefined): void {
    this.#onSessionUnready = callback;
  }

  async restore(): Promise<void> {
    await this.#store.validateOwners();
    for (const binding of this.#store.manifest?.owners ?? []) {
      const live = await this.#createSession(binding, true);
      this.#onSessionReady?.(binding.id, live.result);
      this.#owners.set(binding.id, live);
    }
  }

  spawn(
    ownerId: string,
    title: string,
    signal?: AbortSignal,
    workspace?: string | OwnerWorkspaceRequest,
  ): Promise<SpawnReceipt> {
    if (this.#closing) return Promise.reject(new Error("Project is shutting down"));
    const creationSignal = signal
      ? AbortSignal.any([signal, this.#creationAbort.signal])
      : this.#creationAbort.signal;
    const operation = this.#queue.then(() =>
      this.#spawn(ownerId, title, creationSignal, workspace),
    );
    this.#queue = operation.catch(() => {});
    return operation;
  }

  /**
   * Normalize the workspace request. Omitted workspaces default to one entry:
   * a harness-managed worktree on the auto branch in Git projects, or the
   * project root inherited in place otherwise. A bare string is a single
   * inherited entry.
   */
  #normalizeWorkspaceRequest(
    workspace: string | OwnerWorkspaceRequest | undefined,
    ownerId: string,
  ): WorkspaceRequestEntry[] {
    if (workspace === undefined) {
      const ownerPaths = this.#store.ownerPaths(ownerId);
      if (this.#store.commonDir !== undefined) {
        return [{ from: this.#store.repoRoot, checkout: ownerPaths.branch, autoBranch: true }];
      }
      return [{ from: this.#store.repoRoot }];
    }
    if (typeof workspace === "string") return [{ from: workspace }];
    if (workspace.entries.length === 0) {
      throw new Error("workspace must contain at least one entry");
    }
    return workspace.entries;
  }

  /**
   * Resolve each requested entry to a concrete workspace path. Inherited
   * entries reuse the directory in place; checkout entries cut (or attach to)
   * a Git worktree under the project data area.
   */
  async #resolveWorkspaceEntries(
    ownerId: string,
    request: WorkspaceRequestEntry[],
    ownerPaths: OwnerPaths,
    signal?: AbortSignal,
  ): Promise<WorkspaceEntry[]> {
    const entries: WorkspaceEntry[] = [];
    let checkoutCount = 0;
    for (const requested of request) {
      if (!path.isAbsolute(requested.from)) {
        throw new Error(`workspace from must be an absolute path: ${requested.from}`);
      }
      const from = await fs.realpath(requested.from).catch((error) => {
        if (isEnoent(error)) throw new Error(`workspace directory does not exist: ${requested.from}`);
        throw error;
      });
      if (!(await fs.stat(from)).isDirectory()) {
        throw new Error(`workspace is not a directory: ${requested.from}`);
      }
      if (requested.checkout === undefined) {
        entries.push({ path: from });
        continue;
      }
      checkoutCount += 1;
      const worktreePath =
        checkoutCount === 1
          ? ownerPaths.worktree
          : path.join(this.#store.paths.worktrees, `${ownerId}-${checkoutCount}`);
      await ensureAbsent(worktreePath);
      const repo = vcs.git(from);
      if (!repo) {
        throw new Error(`workspace checkout entry is not inside a Git repository: ${from}`);
      }
      const repoRoot = await fs.realpath(repo.primaryRoot());
      const branchExists = await repo.refExists(`refs/heads/${requested.checkout}`, signal);
      if (branchExists && requested.autoBranch) {
        throw new Error(
          `Branch already exists: ${requested.checkout}. Inspect it before retrying or pass an explicit workspace checkout.`,
        );
      }
      const baseSha = branchExists
        ? await repo.resolveRef(`refs/heads/${requested.checkout}`)
        : await repo.headSha(signal);
      if (!baseSha) {
        throw new Error("Repository needs an initial commit before owners can be created");
      }
      if (!branchExists) await repo.createBranch(requested.checkout, baseSha, false, signal);
      await repo.worktreeAdd(
        worktreePath,
        requested.checkout,
        {
          detach: false,
          clone: false,
          keepChanges: false,
        },
        signal,
      );
      entries.push({ path: worktreePath, repo: repoRoot, checkout: requested.checkout, baseSha });
    }
    return entries;
  }

  async #spawn(
    ownerId: string,
    title: string,
    signal?: AbortSignal,
    workspace?: string | OwnerWorkspaceRequest,
  ): Promise<SpawnReceipt> {
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
    await ensureAbsent(sessionFile);
    const request = this.#normalizeWorkspaceRequest(workspace, ownerId);
    let binding: OwnerBinding | undefined;
    let live: LiveOwner | undefined;
    let bound = false;
    try {
      const entries = await this.#resolveWorkspaceEntries(ownerId, request, ownerPaths, signal);
      binding = {
        id: ownerId,
        title,
        worktree: entries[0]!.path,
        entries,
        sharedDir: ownerPaths.sharedDir,
        sessionFile,
      };
      signal?.throwIfAborted();
      live = await this.#createSession(binding, false);
      signal?.throwIfAborted();
      if (this.#closing) throw new Error("Project is shutting down");
      await this.#store.addOwner(binding);
      bound = true;
      this.#owners.set(ownerId, live);
      this.#onSessionReady?.(ownerId, live.result);
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
        this.#onSessionUnready?.(ownerId, live.result);
        live.unsubscribe();
        await live.result.session.dispose();
      }
      const preserved = binding
        ? `workspace ${binding.entries
            .map((entry) => (entry.checkout ? `${entry.path} (branch ${entry.checkout})` : entry.path))
            .join(", ")}, session ${sessionFile}`
        : `session ${sessionFile}`;
      throw new Error(
        `Could not start ${ownerId}: ${error instanceof Error ? error.message : String(error)}. ` +
          `Resources are preserved: ${preserved}`,
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
    const { cwd, additional } = workspaceRoots(binding);
    const manager = await SessionManager.open(binding.sessionFile, undefined, undefined, {
      initialCwd: cwd,
      parentSession: mainManager.getSessionFile() ?? undefined,
      suppressBreadcrumb: true,
      throwIfMissing: resuming,
    });
    try {
      if (resuming) {
        await validateSessionWorkspace(manager, cwd, additional);
        if (manager.getHeader()?.parentSession !== mainManager.getSessionFile()) {
          throw new Error(`Owner ${binding.id} is attached to a different parent session`);
        }
      }
      const artifactManager = mainManager.getArtifactManager();
      if (!artifactManager) throw new Error("Main artifact manager is unavailable");
      manager.adoptArtifactManager(artifactManager);
      const result = await createAgentSession({
        cwd,
        additionalDirectories: additional,
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
        body: `Harness: owner initial turn failed: ${String(error)}. Session and workspace are retained; inspect history://${ownerId} before retrying.`,
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
