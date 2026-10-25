import type { Server } from "bun";
import { logger } from "@oh-my-pi/pi-utils";
import type { HarnessRuntime, RuntimeNotification, RuntimeUIResponse } from "../runtime/contracts";
import type { WebError } from "./contracts";
import { projectEvent, projectHistory, projectReceipt, projectSnapshot } from "./projection";
import page from "./client/index.html";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SSE_BYTES = 2 * 1024 * 1024;

export interface WebServerOptions {
  port?: number;
  development?: boolean;
}
export interface WebServer {
  url: string;
  close(): Promise<void>;
  notify(notification: RuntimeNotification): void;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "invalid_request", "Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RequestError(400, "invalid_request", `${name} must be a nonempty string`);
  }
  return value;
}

function limit(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new RequestError(400, "invalid_request", "limit must be an integer from 1 to 500");
  }
  return value;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    throw new RequestError(415, "invalid_content_type", "Expected application/json");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "invalid_request", "Expected a JSON body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RequestError(413, "body_too_large", "Request body exceeds 1 MiB");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return object(JSON.parse(new TextDecoder().decode(Buffer.concat(chunks, total))));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, "invalid_request", "Invalid JSON");
  }
}

function uiResponse(value: unknown): RuntimeUIResponse {
  const input = object(value);
  if (input.kind === "confirm") {
    if (typeof input.value !== "boolean")
      throw new RequestError(400, "invalid_request", "confirm requires a boolean");
    return { kind: "confirm", value: input.value };
  }
  if (input.kind === "select" || input.kind === "input" || input.kind === "editor") {
    if (input.value !== undefined && typeof input.value !== "string") {
      throw new RequestError(400, "invalid_request", "response value must be a string or absent");
    }
    return { kind: input.kind, value: input.value };
  }
  throw new RequestError(400, "invalid_request", "Unknown UI response kind");
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function mappedError(error: unknown): Response {
  if (error instanceof RequestError)
    return json(
      { error: { code: error.code, message: error.message } } satisfies WebError,
      error.status,
    );
  const message = error instanceof Error ? error.message : String(error);
  const mapping: [RegExp, number, string][] = [
    [/^(Input|UI response) belongs to a stale runtime epoch$/, 409, "stale_epoch"],
    [/^Unknown (session|entry cursor|ownerId):/i, 404, "not_found"],
    [/^Session history is unavailable:/, 503, "history_unavailable"],
    [/^UI request does not exist or has expired$/, 409, "request_unavailable"],
    [
      /^UI response type does not match request$|^Invalid select response$|^Unsupported UI response$/,
      400,
      "invalid_request",
    ],
    [
      /^Input ID reused with different content$|^clientInputId reused with different input$/,
      409,
      "input_conflict",
    ],
    [/^Runtime is (closed|closing)$/, 503, "runtime_closed"],
    [/^Input receipt capacity reached$/, 503, "input_capacity"],
    [
      /^clientInputId and text are required$|^Invalid cooperation cursor$|^Session page limit must be an integer from 1 to 500$/,
      400,
      "invalid_request",
    ],
  ];
  for (const [pattern, status, code] of mapping) {
    if (pattern.test(message)) return json({ error: { code, message } } satisfies WebError, status);
  }
  logger.error("Web request failed", { error: message });
  return json(
    { error: { code: "internal_error", message: "请求失败，请查看服务日志" } } satisfies WebError,
    500,
  );
}

export function createWebServer(
  runtime: HarnessRuntime,
  options: WebServerOptions = {},
): WebServer {
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const connections = new Set<{
    send: (event: string, value: unknown, id?: string) => void;
    close: () => void;
  }>();
  let server: Server<undefined>;

  function events(request: Request): Response {
    let dispose = () => {};
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          const encoder = new TextEncoder();
          let done = false;
          let unsubscribe = () => {};
          let heartbeat: Timer | undefined;
          const close = () => {
            if (done) return;
            done = true;
            unsubscribe();
            if (heartbeat) clearInterval(heartbeat);
            request.signal.removeEventListener("abort", close);
            connections.delete(connection);
            try {
              controller.close();
            } catch {
              /* already cancelled */
            }
          };
          const send = (event: string, value: unknown, id?: string) => {
            if (done) return;
            const data = encoder.encode(
              `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`,
            );
            if ((controller.desiredSize ?? 0) < data.byteLength) {
              close();
              return;
            }
            controller.enqueue(data);
          };
          const connection = { send, close };
          dispose = close;
          connections.add(connection);
          try {
            const observation = runtime.observe((event) => {
              try {
                send(
                  "event",
                  projectEvent(event, runtime.snapshot()),
                  `${event.epoch}:${event.seq}`,
                );
              } catch (error) {
                logger.warn("Web event projection failed", { error: String(error) });
                close();
              }
            });
            unsubscribe = observation.unsubscribe;
            send(
              "snapshot",
              projectSnapshot(observation.snapshot),
              `${observation.snapshot.epoch}:${observation.snapshot.seq}`,
            );
            if (done) {
              unsubscribe();
              return;
            }
            request.signal.addEventListener("abort", close, { once: true });
            if (request.signal.aborted) {
              close();
              return;
            }
            heartbeat = setInterval(() => send("heartbeat", { time: Date.now() }), 15_000);
            heartbeat.unref();
          } catch (error) {
            close();
            logger.warn("Web observation unavailable", { error: String(error) });
          }
        },
        cancel() {
          dispose();
        },
      },
      { highWaterMark: MAX_SSE_BYTES, size: (chunk) => chunk?.byteLength ?? 0 },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  async function api(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${server.port}`;
      if (request.headers.get("host") !== `127.0.0.1:${server.port}`) {
        throw new RequestError(403, "invalid_host", "Unexpected request host");
      }
      if (request.headers.has("origin") && request.headers.get("origin") !== origin) {
        throw new RequestError(403, "invalid_origin", "Cross-origin requests are not allowed");
      }
      if (request.method === "POST" && request.headers.get("origin") !== origin) {
        throw new RequestError(
          403,
          "invalid_origin",
          "Write requests require the local page origin",
        );
      }
      if (closing) throw new RequestError(503, "runtime_closed", "Web host is closing");
      let parts: string[];
      try {
        parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      } catch {
        throw new RequestError(400, "invalid_request", "Invalid URL encoding");
      }
      if (request.method === "GET") {
        if (url.pathname === "/api/events") return events(request);
        if (parts.length === 4 && parts[1] === "sessions" && parts[3] === "history") {
          return json(
            projectHistory(
              await runtime.readSession(parts[2], {
                beforeEntryId: url.searchParams.get("beforeEntryId") ?? undefined,
                limit: limit(url),
              }),
            ),
          );
        }
        if (url.pathname === "/api/cooperation") {
          return json(
            await runtime.readCooperation({
              ownerId: url.searchParams.get("ownerId") ?? undefined,
              before: url.searchParams.get("before") ?? undefined,
              limit: limit(url),
            }),
          );
        }
        if (parts.length === 3 && parts[1] === "inputs") {
          const receipt = runtime.getInputReceipt({
            epoch: string(url.searchParams.get("epoch"), "epoch"),
            clientInputId: parts[2],
          });
          return json(receipt ? projectReceipt(receipt) : null);
        }
      }
      if (request.method === "POST") {
        const input = await body(request);
        const epoch = string(input.epoch, "epoch");
        if (epoch !== runtime.snapshot().epoch)
          throw new RequestError(
            409,
            "stale_epoch",
            "Runtime epoch changed; reconnect before sending",
          );
        if (url.pathname === "/api/input") {
          if (
            input.behavior !== undefined &&
            input.behavior !== "followUp" &&
            input.behavior !== "steer"
          ) {
            throw new RequestError(400, "invalid_request", "Unknown input behavior");
          }
          return json(
            projectReceipt(
              await runtime.submitMainInput({
                epoch,
                clientInputId: string(input.clientInputId, "clientInputId"),
                text: string(input.text, "text"),
                behavior: input.behavior ?? "followUp",
              }),
            ),
          );
        }
        if (parts.length === 4 && parts[1] === "ui-requests" && parts[3] === "respond") {
          runtime.respondToUIRequest({
            epoch,
            requestId: parts[2],
            response: uiResponse(input.response),
          });
          return json({ ok: true });
        }
        if (url.pathname === "/api/main/abort") {
          runtime.abortMainTurn();
          return json({ ok: true });
        }
      }
      throw new RequestError(404, "not_found", "Unknown API route");
    } catch (error) {
      return mappedError(error);
    }
  }

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 4173,
    // SSE remains open while the project is idle; heartbeats are not user input.
    idleTimeout: 0,
    development: options.development ? { hmr: true, console: false } : false,
    routes: { "/": page, "/api/*": api },
    fetch: () =>
      json({ error: { code: "not_found", message: "Not found" } } satisfies WebError, 404),
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    notify(notification) {
      for (const connection of connections) connection.send("notification", notification);
    },
    close() {
      closePromise ??= (async () => {
        closing = true;
        for (const connection of connections) connection.close();
        await server.stop(true);
      })();
      return closePromise;
    },
  };
}
