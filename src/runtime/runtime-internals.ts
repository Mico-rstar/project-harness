import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { HarnessRuntime } from "./contracts";

const runtimeSessions = new WeakMap<HarnessRuntime, CreateAgentSessionResult>();

export function bindRuntimeSession(
  runtime: HarnessRuntime,
  session: CreateAgentSessionResult,
): void {
  runtimeSessions.set(runtime, session);
}

export function runtimeSession(runtime: HarnessRuntime): CreateAgentSessionResult {
  const session = runtimeSessions.get(runtime);
  if (!session) throw new Error("Runtime does not have an interactive session");
  return session;
}

export function unbindRuntimeSession(runtime: HarnessRuntime): void {
  runtimeSessions.delete(runtime);
}
