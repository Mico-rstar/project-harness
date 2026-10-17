import {
  type ExtensionUIContext,
  type ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { theme, type Theme } from "@oh-my-pi/pi-tui/theme";
import type { RuntimeEvent, RuntimeHost, RuntimeUIRequest } from "./contracts";

export interface PendingUI {
  request: RuntimeUIRequest;
  resolve: (value: string | boolean | undefined) => void;
  timer: Timer;
}

export function createRuntimeUIContext(
  host: Extract<RuntimeHost, { kind: "events" }>,
  epoch: string,
  pending: Map<string, PendingUI>,
  emit: (event: Omit<RuntimeEvent, "epoch" | "seq">) => void,
): ExtensionUIContext {
  const request = <T extends RuntimeUIRequest>(
    shape: Omit<T, "epoch" | "requestId" | "expiresAt">,
    timeoutMs?: number,
  ): Promise<string | boolean | undefined> => {
    const requestId = crypto.randomUUID();
    const timeout = Math.min(timeoutMs ?? Number.POSITIVE_INFINITY, host.uiTimeoutMs ?? 120_000);
    const expiresAt = Date.now() + timeout;
    const data = { ...shape, epoch, requestId, expiresAt } as T;
    const deferred = Promise.withResolvers<string | boolean | undefined>();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      deferred.resolve(undefined);
      emit({ type: "ui_request", payload: { requestId, epoch, closed: true, reason: "timeout" } });
    }, timeout);
    pending.set(requestId, { request: data, resolve: deferred.resolve, timer });
    emit({ type: "ui_request", payload: data });
    try {
      host.onUIRequest(structuredClone(data));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(requestId);
      deferred.resolve(undefined);
      emit({
        type: "ui_request",
        payload: { requestId, epoch, closed: true, reason: "host_error", error: String(error) },
      });
    }
    return deferred.promise;
  };
  const notify = (message: string, level: "info" | "warning" | "error" = "info"): void => {
    emit({ type: "health_changed", payload: { notification: message, level } });
    try {
      host.onNotify?.({ message, level });
    } catch {
      // Host notification failures must not interrupt the SDK turn.
    }
  };
  return {
    timeoutStartsOnPresentation: false,
    select: (title, options, dialogOptions) =>
      request<Extract<RuntimeUIRequest, { kind: "select" }>>(
        {
          kind: "select",
          title,
          options: options.map((option: ExtensionUISelectItem) =>
            typeof option === "string" ? option : option.label,
          ),
        },
        dialogOptions?.timeout,
      ).then((value) => (typeof value === "string" ? value : undefined)),
    confirm: (title, message, dialogOptions) =>
      request<Extract<RuntimeUIRequest, { kind: "confirm" }>>(
        {
          kind: "confirm",
          title,
          message,
        },
        dialogOptions?.timeout,
      ).then((value) => value === true),
    input: (title, placeholder, dialogOptions) =>
      request<Extract<RuntimeUIRequest, { kind: "input" }>>(
        {
          kind: "input",
          title,
          ...(placeholder === undefined ? {} : { placeholder }),
        },
        dialogOptions?.timeout,
      ).then((value) => (typeof value === "string" ? value : undefined)),
    editor: (title, prefill, dialogOptions) =>
      request<Extract<RuntimeUIRequest, { kind: "editor" }>>(
        {
          kind: "editor",
          title,
          prefill: prefill ?? "",
        },
        dialogOptions?.timeout,
      ).then((value) => (typeof value === "string" ? value : undefined)),
    notify,
    onTerminalInput: () => () => {},
    setStatus: (key, text) => emit({ type: "health_changed", payload: { status: { key, text } } }),
    setWorkingMessage: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async <T>(): Promise<T> => {
      throw new Error("Custom UI components are unavailable in event mode");
    },
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    get theme(): Theme {
      return theme;
    },
    getAllThemes: async () => [],
    getTheme: async () => undefined,
    setTheme: async () => ({
      success: false,
      error: "Theme changes are unavailable in event mode",
    }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
    setEditorComponent: () => {},
  };
}
