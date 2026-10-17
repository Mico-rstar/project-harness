import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import { VERSION } from "@oh-my-pi/pi-utils";
import type { LaunchOptions } from "./launcher";
import { startMainSession } from "./runtime";
import { runtimeSession } from "./runtime-internals";
import { MAIN_TOOLS } from "./main-session";

export async function runHarness(options: LaunchOptions): Promise<void> {
  const runtime = await startMainSession(options, { kind: "tui" });
  const main = runtimeSession(runtime);
  try {
    const mode = new InteractiveMode(
      main.session,
      VERSION,
      undefined,
      main.setToolUIContext,
      main.lspServers,
      main.mcpManager,
      main.eventBus,
      undefined,
      main.subagentEventBus,
    );
    await mode.init({
      autoStartCollab: false,
      suppressWelcomeIntro: options.resume,
      clearInitialTerminalHistory: true,
    });
    await main.session.setActiveToolsByName(MAIN_TOOLS);
    const active = main.session.getActiveToolNames();
    if (active.length !== MAIN_TOOLS.length || MAIN_TOOLS.some((name) => !active.includes(name))) {
      throw new Error(`Unexpected Main tools: ${active.join(", ")}`);
    }
    await mode.renderInitialMessages({ preserveExistingChat: true });
    void main.startBackgroundModelDiscovery?.().catch(() => {});
    while (true) {
      const input = await mode.getUserInput();
      await submitInteractiveInput(mode, main.session, input);
    }
  } finally {
    await runtime.close();
  }
}
