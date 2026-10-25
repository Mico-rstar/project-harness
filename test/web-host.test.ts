import { describe, expect, test } from "bun:test";
import type {
  HarnessRuntime,
  RuntimeEvent,
  RuntimeNotification,
  RuntimeSnapshot,
} from "../src/runtime";
import { createWebHost, type RuntimeFactory, type WebHostDependencies } from "../src/web";

function runtimeStub(onClose: () => void): HarnessRuntime {
  const snapshot = {
    epoch: "epoch",
    seq: 0,
    mainSessionId: "main",
    project: { name: "demo", repoRoot: "/repo" },
    owners: [],
    agents: [],
    sessions: [],
    cooperation: [],
    pendingUIRequests: [],
    inputReceipts: [],
    health: { degraded: false, issues: [] },
    closing: false,
  } satisfies RuntimeSnapshot;
  return {
    mainSessionId: "main",
    snapshot: () => snapshot,
    observe: (_listener: (event: RuntimeEvent) => void) => ({
      snapshot,
      unsubscribe: () => {},
    }),
    readSession: async () => {
      throw new Error("unused");
    },
    readCooperation: async () => {
      throw new Error("unused");
    },
    submitMainInput: async () => {
      throw new Error("unused");
    },
    getInputReceipt: () => undefined,
    respondToUIRequest: () => false,
    abortMainTurn: () => {},
    close: async () => onClose(),
  };
}

const launchOptions = { repo: "/repo", project: "demo", resume: false };

describe("Web host lifecycle", () => {
  test("buffers startup notifications and closes server and runtime once", async () => {
    let hostNotify: ((notification: RuntimeNotification) => void) | undefined;
    let runtimeCloses = 0;
    let serverCloses = 0;
    const notifications: RuntimeNotification[] = [];
    const runtimeFactory: RuntimeFactory = async (_options, host) => {
      hostNotify = host.onNotify;
      host.onNotify({ message: "starting", level: "info" });
      return runtimeStub(() => {
        runtimeCloses += 1;
      });
    };
    const dependencies: WebHostDependencies = {
      runtimeFactory,
      serverFactory: () => ({
        url: "http://127.0.0.1:4173",
        notify: (notification) => notifications.push(notification),
        close: async () => {
          serverCloses += 1;
        },
      }),
    };
    const host = await createWebHost(launchOptions, {}, dependencies);
    expect(notifications).toEqual([{ message: "starting", level: "info" }]);
    hostNotify?.({ message: "ready", level: "info" });
    expect(notifications.map(({ message }) => message)).toEqual(["starting", "ready"]);
    await Promise.all([host.close(), host.close()]);
    expect(serverCloses).toBe(1);
    expect(runtimeCloses).toBe(1);
  });

  test("closes a created runtime when server startup fails", async () => {
    let runtimeCloses = 0;
    await expect(
      createWebHost(
        launchOptions,
        {},
        {
          runtimeFactory: async () =>
            runtimeStub(() => {
              runtimeCloses += 1;
            }),
          serverFactory: () => {
            throw new Error("port is occupied");
          },
        },
      ),
    ).rejects.toThrow("port is occupied");
    expect(runtimeCloses).toBe(1);
  });
});
