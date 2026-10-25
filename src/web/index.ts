import {
  startMainSession,
  type HarnessRuntime,
  type LaunchOptions,
  type RuntimeNotification,
  type RuntimeUIRequest,
} from "../runtime";
import type { MainSessionDependencies } from "../runtime/main-session";
import { createWebServer, type WebServer, type WebServerOptions } from "./server";

export type WebHostOptions = WebServerOptions;

export type RuntimeFactory = (
  options: LaunchOptions,
  host: {
    kind: "events";
    onUIRequest: (request: RuntimeUIRequest) => void;
    onNotify: (notification: RuntimeNotification) => void;
  },
  dependencies?: MainSessionDependencies,
) => Promise<HarnessRuntime>;

export interface WebHost {
  url: string;
  close(): Promise<void>;
}

export interface WebHostDependencies {
  runtimeFactory?: RuntimeFactory;
  serverFactory?: (runtime: HarnessRuntime, options: WebHostOptions) => WebServer;
  runtimeDependencies?: MainSessionDependencies;
}

/**
 * Create the event runtime and HTTP transport as one owned lifecycle. The
 * server closes only its transport; this host also closes the runtime.
 */
export async function createWebHost(
  options: LaunchOptions,
  webOptions: WebHostOptions = {},
  dependencies: WebHostDependencies = {},
): Promise<WebHost> {
  let server: WebServer | undefined;
  const pendingNotifications: RuntimeNotification[] = [];
  const runtimeFactory = dependencies.runtimeFactory ?? startMainSession;
  const runtime = await runtimeFactory(
    options,
    {
      kind: "events",
      onUIRequest: () => {},
      onNotify: (notification) => {
        if (server) server.notify(notification);
        else pendingNotifications.push(notification);
      },
    },
    dependencies.runtimeDependencies,
  );
  try {
    server = (dependencies.serverFactory ?? createWebServer)(runtime, webOptions);
    for (const notification of pendingNotifications.splice(0)) server.notify(notification);
  } catch (error) {
    await runtime.close();
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    url: server.url,
    close() {
      closePromise ??= (async () => {
        try {
          await server?.close();
        } finally {
          await runtime.close();
        }
      })();
      return closePromise;
    },
  };
}

/** Run the Web host until SIGINT/SIGTERM, then release server and runtime. */
export async function runWebHarness(
  options: LaunchOptions,
  webOptions: WebHostOptions = {},
): Promise<void> {
  const host = await createWebHost(options, webOptions);
  process.stdout.write(`Web interface listening at ${host.url}\n`);
  let closePromise: Promise<void> | undefined;
  const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
  const close = (): Promise<void> => (closePromise ??= host.close().finally(finish));
  const onSignal = (): void => {
    void close().catch((error: unknown) => {
      process.stderr.write(`project: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await finished;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await close();
  }
}

export * from "./server";
