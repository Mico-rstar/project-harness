import * as path from "node:path";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { logger, postmortem, prompt } from "@oh-my-pi/pi-utils";
import { CooperationLog } from "./cooperation-log";
import recoveryPrompt from "./prompts/recovery.md" with { type: "text" };
import startupPrompt from "./prompts/startup.md" with { type: "text" };
import { bindRuntimeSession, unbindRuntimeSession } from "./runtime-internals";
import type { MainSessionDependencies } from "./main-session";
import type {
  HarnessRuntime,
  InputReceipt,
  MainInput,
  RuntimeEvent,
  RuntimeHost,
  RuntimeSnapshot,
  RuntimeUIRequest,
  RuntimeUIResponse,
  SessionSnapshot,
  UIRequestResponse,
} from "./contracts";
import { createMainSession, MAIN_TOOLS } from "./main-session";
import { OwnerCoordinator } from "./owners";
import { ProjectStore } from "./project";
import type { LaunchOptions } from "./contracts";
import type { OpenProjectOptions } from "./project";
import {
  TASK_SUBAGENT_EVENT_CHANNEL,
  type SubagentEventPayload,
} from "@oh-my-pi/pi-coding-agent/task/types";
import { createRuntimeUIContext, type PendingUI } from "./runtime-ui";

const INPUT_TTL_MS = 60 * 60 * 1000;
export type { MainSessionDependencies } from "./main-session";
const MAX_INPUTS = 4096;

function sameImages(left: MainInput["images"], right: MainInput["images"]): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

export async function startMainSession(
  options: LaunchOptions & Pick<OpenProjectOptions, "dataHome">,
  host: RuntimeHost,
  dependencies: MainSessionDependencies = {},
): Promise<HarnessRuntime> {
  const store = await ProjectStore.open(options);
  const owners = new OwnerCoordinator(store);
  let main: CreateAgentSessionResult | undefined;
  let closed = false;
  let closing = false;
  let seq = 0;
  const epoch = crypto.randomUUID();
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const sessions = new Map<
    string,
    {
      session: AgentSession;
      manager: SessionManager;
      ownerId?: string;
      error?: string;
      activeExecutions: Map<
        string,
        { toolCallId: string; toolName: string; args?: unknown; partialResult?: unknown }
      >;
      activeAssistantMessage?: unknown;
    }
  >();
  const pendingUI = new Map<string, PendingUI>();
  const completedUI = new Map<string, RuntimeUIResponse>();
  const inputs = new Map<string, InputReceipt>();
  let inputAdmissionQueue: Promise<void> = Promise.resolve();
  let cooperationEvents: RuntimeSnapshot["cooperation"] = [];
  let healthIssues: string[] = [];
  let cooperation: CooperationLog | undefined;
  const unsubs: (() => void)[] = [];
  const sessionPersistenceUnsubs = new Map<string, () => void>();
  const previousEntryCallbacks = new Map<string, SessionManager["onEntryAppended"]>();
  const registryHistory = new Map<
    string,
    { sessionFile: string | null; ownerId?: string; parentSessionId?: string }
  >();
  let cleanupPromise: Promise<void> | undefined;
  let unregisterPostmortem: (() => void) | undefined;
  let runtimeHandle: HarnessRuntime | undefined;
  const emit = (event: Omit<RuntimeEvent, "epoch" | "seq">): void => {
    const full: RuntimeEvent = structuredClone({ ...event, epoch, seq: ++seq });
    for (const listener of listeners) {
      try {
        listener(structuredClone(full));
      } catch (error) {
        logger.warn("Runtime observer failed", { error: String(error) });
      }
    }
  };
  const installSession = (session: AgentSession, ownerId?: string): void => {
    const manager = session.sessionManager;
    const id = manager.getSessionId();
    const installed = sessions.get(id);
    if (installed) {
      if (ownerId) installed.ownerId = ownerId;
      return;
    }
    const activeExecutions = new Map<
      string,
      {
        toolCallId: string;
        toolName: string;
        args?: unknown;
        partialResult?: unknown;
      }
    >();
    sessions.set(id, { session, manager, ownerId, activeExecutions });
    const previous = manager.onEntryAppended;
    previousEntryCallbacks.set(id, previous);
    manager.onEntryAppended = (entry) => {
      previous?.(entry);
      emit({ type: "session_entry", sessionId: id, ownerId, payload: entry });
    };
    const unsubscribePersistence = manager.onPersistenceError((error) => {
      const known = sessions.get(id);
      if (known) known.error = error.message;
      emit({ type: "session_persistence_error", sessionId: id, ownerId, payload: error.message });
    });
    sessionPersistenceUnsubs.set(id, unsubscribePersistence);
    unsubs.push(unsubscribePersistence);
    unsubs.push(
      session.subscribe((event) => {
        if (
          (event.type === "message_start" || event.type === "message_update") &&
          event.message.role === "assistant"
        ) {
          const current = sessions.get(id);
          if (current) current.activeAssistantMessage = structuredClone(event.message);
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          const current = sessions.get(id);
          if (current) current.activeAssistantMessage = undefined;
        }
        if (event.type === "tool_execution_start")
          activeExecutions.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: structuredClone(event.args),
          });
        else if (event.type === "tool_execution_update") {
          const current = activeExecutions.get(event.toolCallId);
          if (current)
            activeExecutions.set(event.toolCallId, {
              ...current,
              partialResult: structuredClone(event.partialResult),
            });
        } else if (event.type === "tool_execution_end") activeExecutions.delete(event.toolCallId);
        emit({ type: "session_event", sessionId: id, ownerId, payload: structuredClone(event) });
      }),
    );
    unsubs.push(
      session.subscribeRunState((state) =>
        emit({
          type: "session_event",
          sessionId: id,
          ownerId,
          payload: { type: "run_state", state },
        }),
      ),
    );
  };
  const sessionSnapshots = (): SessionSnapshot[] =>
    [...sessions.entries()].map(([sessionId, item]) => ({
      sessionId,
      ...(item.ownerId ? { ownerId: item.ownerId } : {}),
      active: true,
      isStreaming: item.session.isStreaming,
      ...(item.activeAssistantMessage === undefined
        ? {}
        : { activeAssistantMessage: structuredClone(item.activeAssistantMessage) }),
      activeTools: structuredClone([...item.activeExecutions.values()]),
      entryCount: item.manager.getEntries().length,
      ...(item.error ? { error: item.error } : {}),
    }));
  const snapshot = (): RuntimeSnapshot => {
    const registry = AgentRegistry.global();
    return {
      epoch,
      seq,
      mainSessionId: main?.session.sessionManager.getSessionId() ?? "",
      project: { name: store.projectName, repoRoot: store.repoRoot },
      owners: structuredClone(store.manifest?.owners ?? []),
      agents: registry
        .list()
        .map(({ id, displayName, kind, parentId, status, sessionFile, activity }) => ({
          id,
          displayName,
          kind,
          ...(parentId ? { parentId } : {}),
          status,
          sessionFile,
          ...(activity ? { activity } : {}),
        })),
      sessions: structuredClone(sessionSnapshots()),
      cooperation: structuredClone(cooperationEvents),
      pendingUIRequests: structuredClone([...pendingUI.values()].map(({ request }) => request)),
      inputReceipts: structuredClone([...inputs.values()].map((receipt) => ({ ...receipt }))),
      health: {
        degraded: healthIssues.length > 0 || [...sessions.values()].some((item) => item.error),
        issues: [
          ...healthIssues,
          ...[...sessions.values()].flatMap((item) => (item.error ? [item.error] : [])),
        ],
      },
      closing,
    };
  };
  const failPending = (): void => {
    for (const [id, pending] of pendingUI) {
      clearTimeout(pending.timer);
      pending.resolve(undefined);
      pendingUI.delete(id);
      emit({ type: "ui_request", payload: { requestId: id, epoch, closed: true } });
    }
  };
  const close = (): Promise<void> => {
    closing = true;
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      failPending();
      unregisterPostmortem?.();
      unregisterPostmortem = undefined;
      try {
        main?.session.beginDispose();
        await main?.session.abort({ reason: "project shutdown" });
        await owners.dispose();
      } finally {
        try {
          await main?.session.dispose();
        } finally {
          await Promise.resolve();
          for (const unsubscribe of unsubs.splice(0)) unsubscribe();
          for (const [sessionId, item] of sessions) {
            item.manager.onEntryAppended = previousEntryCallbacks.get(sessionId);
            previousEntryCallbacks.delete(sessionId);
            sessionPersistenceUnsubs.delete(sessionId);
          }
          sessions.clear();
          registryHistory.clear();
          try {
            await cooperation?.close();
          } finally {
            if (runtimeHandle) unbindRuntimeSession(runtimeHandle);
            store.release();
            closed = true;
          }
        }
      }
    })();
    return cleanupPromise;
  };

  try {
    main = await createMainSession(store, owners, host, dependencies);
    installSession(main.session);
    const bus = IrcBus.global();
    const knownOwnerIds = (): string[] => store.manifest?.owners.map((owner) => owner.id) ?? [];
    cooperation = await CooperationLog.open({
      file: path.join(store.paths.root, "observations", "cooperation.jsonl"),
      knownOwnerIds: knownOwnerIds(),
      resolveOwnerIds(from, to) {
        const refs = AgentRegistry.global().list();
        const related = new Set<string>();
        const ownerIds = knownOwnerIds();
        for (const id of [from, to]) {
          if (ownerIds.includes(id)) related.add(id);
          let current = refs.find((ref) => ref.id === id);
          while (current) {
            if (ownerIds.includes(current.id)) related.add(current.id);
            const parentId = current?.parentId;
            current = parentId ? refs.find((ref) => ref.id === parentId) : undefined;
          }
        }
        return [...related];
      },
      onMessage(message) {
        const existing = cooperationEvents.findIndex((item) => item.id === message.id);
        if (existing < 0) cooperationEvents = [...cooperationEvents, message].slice(-100);
        else cooperationEvents[existing] = message;
        emit({ type: "cooperation_message", payload: message });
      },
      onHealth(health) {
        healthIssues = health.warnings;
        emit({ type: "health_changed", payload: health });
      },
    });
    unsubs.push(bus.observe((observation) => cooperation?.record(observation)));
    unsubs.push(
      AgentRegistry.global().onChange(({ type, ref }) => {
        if (
          ref.kind === "sub" &&
          ref.parentId &&
          knownOwnerIds().includes(ref.parentId) &&
          ref.sessionFile
        ) {
          const parent = ref.parentId ? AgentRegistry.global().get(ref.parentId) : undefined;
          const ownerId =
            ref.parentId && knownOwnerIds().includes(ref.parentId)
              ? ref.parentId
              : parent?.parentId && knownOwnerIds().includes(parent.parentId)
                ? parent.parentId
                : undefined;
          registryHistory.set(ref.id, {
            sessionFile: ref.sessionFile,
            ...(ownerId ? { ownerId } : {}),
            ...(ref.parentId ? { parentSessionId: ref.parentId } : {}),
          });
          if (ref.session) installSession(ref.session, ownerId);
        } else if (type === "removed" && ref.kind === "sub") {
          const ownerId = registryHistory.get(ref.id)?.ownerId;
          registryHistory.set(ref.id, {
            sessionFile: ref.sessionFile,
            ...(ownerId ? { ownerId } : {}),
            ...(ref.parentId ? { parentSessionId: ref.parentId } : {}),
          });
        }
        emit({
          type: "registry_changed",
          payload: {
            type,
            agent: {
              id: ref.id,
              displayName: ref.displayName,
              kind: ref.kind,
              ...(ref.parentId ? { parentId: ref.parentId } : {}),
              status: ref.status,
              sessionFile: ref.sessionFile,
              ...(ref.activity ? { activity: ref.activity } : {}),
            },
          },
        });
      }),
    );
    const eventBus = main.subagentEventBus ?? main.eventBus;
    const onSubagentEvent = (event: unknown): void => {
      const data = event as SubagentEventPayload;
      const ref = AgentRegistry.global().get(data.id);
      const parent = ref?.parentId ? AgentRegistry.global().get(ref.parentId) : undefined;
      const ownerId =
        ref?.parentId && knownOwnerIds().includes(ref.parentId)
          ? ref.parentId
          : parent?.parentId && knownOwnerIds().includes(parent.parentId)
            ? parent.parentId
            : undefined;
      if (ref?.sessionFile) {
        registryHistory.set(ref.id, {
          sessionFile: ref.sessionFile,
          ...(ownerId ? { ownerId } : {}),
          ...(ref.parentId ? { parentSessionId: ref.parentId } : {}),
        });
      }
      if (ref?.session) {
        installSession(ref.session, ownerId);
      }
      emit({ type: "subagent_event", payload: structuredClone(data) });
    };
    unsubs.push(eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, onSubagentEvent));
    for (const ref of AgentRegistry.global().list()) {
      if (ref.kind !== "sub" || !ref.sessionFile) continue;
      const parent = ref.parentId ? AgentRegistry.global().get(ref.parentId) : undefined;
      const ownerId =
        ref.parentId && store.manifest?.owners.some((owner) => owner.id === ref.parentId)
          ? ref.parentId
          : parent?.parentId && store.manifest?.owners.some((owner) => owner.id === parent.parentId)
            ? parent.parentId
            : undefined;
      registryHistory.set(ref.id, {
        sessionFile: ref.sessionFile,
        ...(ownerId ? { ownerId } : {}),
        ...(ref.parentId ? { parentSessionId: ref.parentId } : {}),
      });
      if (ref.session) installSession(ref.session, ownerId);
    }
    owners.setOnSessionReady((ownerId, result) => {
      cooperation?.setKnownOwnerIds(knownOwnerIds());
      installSession(result.session, ownerId);
    });
    owners.setOnSessionUnready((ownerId, result) => {
      const id = result.session.sessionManager.getSessionId();
      sessions.delete(id);
      result.session.sessionManager.onEntryAppended = previousEntryCallbacks.get(id);
      previousEntryCallbacks.delete(id);
      const unsubscribe = sessionPersistenceUnsubs.get(id);
      unsubscribe?.();
      sessionPersistenceUnsubs.delete(id);
      cooperation?.setKnownOwnerIds(knownOwnerIds());
      emit({ type: "health_changed", ownerId, payload: { sessionRemoved: id } });
    });
    const uiContext =
      host.kind === "events" ? createRuntimeUIContext(host, epoch, pendingUI, emit) : undefined;
    if (host.kind !== "tui") {
      await initializeExtensions(main.session, {
        mode: "rpc",
        ...(uiContext ? { uiContext } : {}),
        reportSendError: (_action, error) =>
          logger.warn("Extension send failed", { error: String(error) }),
        reportRuntimeError: (error) =>
          logger.warn("Extension runtime error", { error: String(error) }),
      });
    }
    if (uiContext) main.setToolUIContext(uiContext, true);
    if (host.kind === "tui") await main.session.setActiveToolsByName(MAIN_TOOLS);
    const actualTools = main.session.getActiveToolNames();
    if (
      actualTools.length !== MAIN_TOOLS.length ||
      MAIN_TOOLS.some((tool) => !actualTools.includes(tool))
    ) {
      throw new Error(`Unexpected Main tools: ${actualTools.join(", ")}`);
    }
    if (options.resume) {
      await owners.restore();
      await registerPersistedSubagents(
        AgentRegistry.global(),
        main.session.sessionManager.getSessionFile(),
      );
      for (const ref of AgentRegistry.global().list()) {
        if (ref.kind !== "sub" || !ref.sessionFile) continue;
        const sessionId = await readSessionHeaderId(ref.sessionFile);
        if (!sessionId) continue;
        const history = registryHistory.get(ref.id) ?? { sessionFile: ref.sessionFile };
        registryHistory.set(sessionId, history);
      }
    }
    await main.session.sendCustomMessage(
      {
        customType: "project-harness",
        content: prompt.render(options.resume ? recoveryPrompt : startupPrompt, {
          projectName: store.projectName,
          mainDirectory: store.paths.main,
          sharedDirectory: store.paths.shared,
          owners: store.manifest?.owners ?? [],
        }),
        display: true,
      },
      { triggerTurn: false },
    );
    if (!host || host.kind !== "tui") {
      void main
        .startBackgroundModelDiscovery?.()
        .catch((error) =>
          logger.warn("Background model discovery failed", { error: String(error) }),
        );
    }
    unregisterPostmortem = postmortem.register("project-harness-runtime", close);

    const runtime: HarnessRuntime = {
      get mainSessionId() {
        return main?.session.sessionManager.getSessionId() ?? "";
      },
      snapshot,
      observe(listener) {
        if (closed) throw new Error("Runtime is closed");
        listeners.add(listener);
        return { snapshot: snapshot(), unsubscribe: () => listeners.delete(listener) };
      },
      async readSession(sessionId, options = {}) {
        let item = sessions.get(sessionId);
        const agentRef = AgentRegistry.global().get(sessionId);
        if (!item && agentRef?.session) {
          item = sessions.get(agentRef.session.sessionManager.getSessionId());
          if (!item) {
            installSession(agentRef.session);
            item = sessions.get(agentRef.session.sessionManager.getSessionId());
          }
        }
        let manager: SessionManager | undefined = item?.manager;
        const history =
          registryHistory.get(sessionId) ??
          (agentRef?.sessionFile
            ? {
                sessionFile: agentRef.sessionFile,
                ...(agentRef.parentId ? { parentSessionId: agentRef.parentId } : {}),
              }
            : undefined);
        if (!manager && history?.sessionFile) {
          try {
            manager = await SessionManager.open(history.sessionFile, undefined, undefined, {
              throwIfMissing: true,
            });
          } catch {
            throw new Error(`Session history is unavailable: ${sessionId}`);
          }
        }
        if (!manager || (!item && !history)) throw new Error(`Unknown session: ${sessionId}`);
        if (history) registryHistory.set(manager.getSessionId(), history);
        const limit = options.limit ?? 200;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
          if (!item) await manager.close();
          throw new Error("Session page limit must be an integer from 1 to 500");
        }
        try {
          const entries = manager.getEntries();
          const beforeIndex = options.beforeEntryId
            ? entries.findIndex((entry) => entry.id === options.beforeEntryId)
            : entries.length;
          if (options.beforeEntryId && beforeIndex < 0)
            throw new Error(`Unknown entry cursor: ${options.beforeEntryId}`);
          const end = beforeIndex;
          const start = Math.max(0, end - limit);
          return {
            sessionId: manager.getSessionId(),
            ...((item?.ownerId ?? history?.ownerId)
              ? { ownerId: item?.ownerId ?? history?.ownerId }
              : {}),
            entries: structuredClone(entries.slice(start, end)),
            nextBeforeEntryId: start > 0 ? (entries[start]?.id ?? null) : null,
            stream:
              item?.activeAssistantMessage === undefined
                ? item?.session.isStreaming
                  ? { state: "streaming" }
                  : null
                : structuredClone(item.activeAssistantMessage),
            activeTools: structuredClone(item ? [...item.activeExecutions.values()] : []),
          };
        } finally {
          if (!item) await manager.close();
        }
      },
      readCooperation: (options) => cooperation!.read(options),
      async submitMainInput(input: MainInput): Promise<InputReceipt> {
        if (closing) throw new Error("Runtime is closing");
        if (input.epoch !== epoch) throw new Error("Input belongs to a stale runtime epoch");
        if (!input.clientInputId || !input.text.trim())
          throw new Error("clientInputId and text are required");
        const behavior = input.behavior ?? "followUp";
        const key = `${input.epoch}:${input.clientInputId}`;
        const existing = inputs.get(key);
        if (existing) {
          if (
            existing.text !== input.text ||
            existing.behavior !== behavior ||
            !sameImages(existing.images, input.images)
          )
            throw new Error("Input ID reused with different content");
          return structuredClone(existing);
        }
        for (const [storedKey, receipt] of inputs) {
          if (Date.now() - receipt.updatedAt > INPUT_TTL_MS && receipt.state !== "received")
            inputs.delete(storedKey);
        }
        if (inputs.size >= MAX_INPUTS) throw new Error("Input receipt capacity reached");
        const receipt: InputReceipt = {
          epoch,
          clientInputId: input.clientInputId,
          text: input.text,
          behavior,
          ...(input.images ? { images: structuredClone(input.images) } : {}),
          state: "received",
          receivedAt: Date.now(),
          updatedAt: Date.now(),
        };
        inputs.set(key, receipt);
        emit({ type: "input_receipt", payload: { ...receipt } });
        const admission = inputAdmissionQueue.then(async () => {
          try {
            if (closing) throw new Error("Runtime is closing");
            const result = await main!.session.extensionRunner?.emitInput(
              receipt.text,
              receipt.images,
              "rpc",
            );
            if (closing) throw new Error("Runtime is closing");
            if (result?.handled) receipt.state = "handled";
            else {
              const text = result?.text ?? receipt.text;
              const admitted = Promise.withResolvers<void>();
              const promptTurn = main!.session.prompt(text, {
                streamingBehavior: behavior,
                throwOnDrop: true,
                ...(result?.images
                  ? { images: result.images }
                  : receipt.images
                    ? { images: receipt.images }
                    : {}),
                onPromptAdmitted: () => {
                  receipt.state = "admitted";
                  receipt.updatedAt = Date.now();
                  emit({ type: "input_receipt", payload: { ...receipt } });
                  admitted.resolve();
                },
              });
              void promptTurn.then(
                () => {
                  admitted.resolve();
                  receipt.updatedAt = Date.now();
                  emit({ type: "input_receipt", payload: { ...receipt } });
                },
                (error: unknown) => {
                  admitted.resolve();
                  if (receipt.state === "received") {
                    receipt.state = "rejected";
                    receipt.error = String(error);
                  } else {
                    emit({
                      type: "session_event",
                      sessionId: main!.session.sessionManager.getSessionId(),
                      payload: {
                        type: "input_execution_error",
                        clientInputId: input.clientInputId,
                        error: String(error),
                      },
                    });
                  }
                  receipt.updatedAt = Date.now();
                  emit({ type: "input_receipt", payload: { ...receipt } });
                },
              );
              await admitted.promise;
            }
            receipt.updatedAt = Date.now();
            emit({ type: "input_receipt", payload: { ...receipt } });
          } catch (error) {
            if (receipt.state === "received") {
              receipt.state = "rejected";
              receipt.error = String(error);
            } else {
              emit({
                type: "session_event",
                sessionId: main!.session.sessionManager.getSessionId(),
                payload: {
                  type: "input_execution_error",
                  clientInputId: input.clientInputId,
                  error: String(error),
                },
              });
            }
            receipt.updatedAt = Date.now();
            emit({ type: "input_receipt", payload: { ...receipt } });
          }
        });
        inputAdmissionQueue = admission.then(
          () => {},
          () => {},
        );
        return structuredClone(receipt);
      },
      getInputReceipt(input) {
        if (input.epoch !== epoch) throw new Error("Input belongs to a stale runtime epoch");
        const receipt = inputs.get(`${input.epoch}:${input.clientInputId}`);
        return receipt
          ? { ...receipt, ...(receipt.images ? { images: structuredClone(receipt.images) } : {}) }
          : undefined;
      },
      respondToUIRequest(input: UIRequestResponse) {
        if (input.epoch !== epoch) throw new Error("UI response belongs to a stale runtime epoch");
        const pending = pendingUI.get(input.requestId);
        if (!pending) {
          const completed = completedUI.get(input.requestId);
          if (completed && JSON.stringify(completed) === JSON.stringify(input.response))
            return true;
          throw new Error("UI request does not exist or has expired");
        }
        const value = responseValue(pending.request, input.response);
        clearTimeout(pending.timer);
        pendingUI.delete(input.requestId);
        completedUI.set(input.requestId, structuredClone(input.response));
        while (completedUI.size > 256) completedUI.delete(completedUI.keys().next().value!);
        pending.resolve(value);
        emit({ type: "ui_request", payload: { requestId: input.requestId, epoch, closed: true } });
        return true;
      },
      abortMainTurn() {
        main?.session.abort({ reason: "host requested abort" });
      },
      close,
    };
    runtimeHandle = runtime;
    bindRuntimeSession(runtime, main);
    return runtime;
  } catch (error) {
    await close();
    throw error;
  }
}

function responseValue(
  request: RuntimeUIRequest,
  response: RuntimeUIResponse,
): string | boolean | undefined {
  if (request.kind !== response.kind) throw new Error("UI response type does not match request");
  if (request.kind === "confirm" && response.kind === "confirm") return response.value;
  if (request.kind === "select" && response.kind === "select") {
    if (response.value !== undefined && !request.options.includes(response.value))
      throw new Error("Invalid select response");
    return response.value;
  }
  if (request.kind === "input" && response.kind === "input") return response.value;
  if (request.kind === "editor" && response.kind === "editor") return response.value;
  throw new Error("Unsupported UI response");
}
