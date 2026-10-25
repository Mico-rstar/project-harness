import type {
  WebCooperationPage,
  WebEvent,
  WebHistory,
  WebInput,
  WebNotification,
  WebReceipt,
  WebSnapshot,
  WebUIResponse,
} from "../contracts";

export class WebAPIError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "WebAPIError";
    this.code = code;
    this.status = status;
  }
}

export interface WebAPI {
  eventsUrl(): string;
  history(sessionId: string, beforeEntryId?: string, limit?: number): Promise<WebHistory>;
  cooperation(ownerId?: string, before?: string, limit?: number): Promise<WebCooperationPage>;
  submit(input: WebInput): Promise<WebReceipt>;
  receipt(clientInputId: string, epoch: string): Promise<WebReceipt | null>;
  respond(requestId: string, epoch: string, response: WebUIResponse): Promise<void>;
  abort(epoch: string): Promise<void>;
}

export function createWebAPI(baseUrl = ""): WebAPI {
  const root = baseUrl.replace(/\/$/, "");
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${root}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      let code = `http_${response.status}`;
      let message = response.statusText || "Request failed";
      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string } };
        code = body.error?.code ?? code;
        message = body.error?.message ?? message;
      } catch {
        // Keep the HTTP status message when the response is not the API error shape.
      }
      throw new WebAPIError(code, message, response.status);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  function json(body: unknown): RequestInit {
    return {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }
  function query(params: Record<string, string | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) search.set(key, value);
    const value = search.toString();
    return value ? `?${value}` : "";
  }
  return {
    eventsUrl: () => `${root}/api/events`,
    history: (id, before, limit) =>
      request(
        `/api/sessions/${encodeURIComponent(id)}/history${query({ beforeEntryId: before, limit: limit === undefined ? undefined : String(limit) })}`,
      ),
    cooperation: (ownerId, before, limit) =>
      request(
        `/api/cooperation${query({ ownerId, before, limit: limit === undefined ? undefined : String(limit) })}`,
      ),
    submit: (input) => request("/api/input", json(input)),
    receipt: async (id, epoch) => {
      try {
        return await request(`/api/inputs/${encodeURIComponent(id)}${query({ epoch })}`);
      } catch (error) {
        if (error instanceof WebAPIError && error.status === 404) return null;
        throw error;
      }
    },
    respond: (id, epoch, response) =>
      request(`/api/ui-requests/${encodeURIComponent(id)}/respond`, json({ epoch, response })),
    abort: (epoch) => request("/api/main/abort", json({ epoch })),
  };
}

export type ClientSSEMessage =
  | { type: "snapshot"; data: WebSnapshot }
  | { type: "event"; data: WebEvent }
  | { type: "notification"; data: WebNotification };

export function parseSSEMessage(type: string, data: string): ClientSSEMessage | null {
  try {
    const value: unknown = JSON.parse(data);
    if (type === "snapshot") return { type, data: value as WebSnapshot };
    if (type === "event") return { type, data: value as WebEvent };
    if (type === "notification") return { type, data: value as WebNotification };
    return null;
  } catch {
    return null;
  }
}
