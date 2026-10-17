#!/usr/bin/env bun
import * as util from "node:util";
import { createAgentSession, type CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import { logger, postmortem, prompt, VERSION } from "@oh-my-pi/pi-utils";
import { ProjectStore } from "./project";
import { OwnerCoordinator } from "./owners";
import { projectExtension } from "./extension";
import { validateSessionWorkspace } from "./sessions";
import { resolveLaunchOptions, type LaunchFlags, type LaunchOptions } from "./launcher";
import mainPrompt from "./prompts/main.md" with { type: "text" };
import startupPrompt from "./prompts/startup.md" with { type: "text" };
import recoveryPrompt from "./prompts/recovery.md" with { type: "text" };

export const MAIN_TOOLS = ["read", "write", "edit", "spawn_owner"];

export function parseLaunchOptions(args: string[]): LaunchFlags | undefined {
  const { values } = util.parseArgs({
    args,
    options: {
      repo: { type: "string" },
      project: { type: "string" },
      resume: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) return undefined;
  return { repo: values.repo, project: values.project, resume: values.resume ?? false };
}

export async function createMain(
  store: ProjectStore,
  owners: OwnerCoordinator,
): Promise<CreateAgentSessionResult> {
  const manager = store.manifest
    ? await SessionManager.open(store.manifest.mainSessionFile, store.paths.sessions, undefined, {
        initialCwd: store.paths.main,
        throwIfMissing: true,
      })
    : SessionManager.create(store.paths.main, store.paths.sessions);
  try {
    if (store.manifest)
      await validateSessionWorkspace(manager, store.paths.main, [store.paths.shared]);
    // InteractiveMode uses the native process-wide settings facade as well.
    const settings = await Settings.init({
      cwd: store.paths.main,
      overrides: {
        "memory.backend": "off",
        "autolearn.enabled": false,
        "tools.xdev": false,
        "astEdit.enabled": false,
        "compaction.experimentalContextManagement": false,
        "advisor.enabled": false,
        "task.maxRecursionDepth": 2,
        "task.isolation.enabled": false,
      },
    });
    const result = await createAgentSession({
      cwd: store.paths.main,
      additionalDirectories: [store.paths.shared],
      sessionManager: manager,
      settings,
      hasUI: true,
      enableIrc: true,
      enableMCP: false,
      disableExtensionDiscovery: true,
      preloadedExtensionPaths: [],
      preloadedCustomToolPaths: [],
      contextFiles: [],
      skills: [],
      rules: [],
      promptTemplates: [],
      slashCommands: [],
      toolNames: MAIN_TOOLS,
      extensions: [projectExtension(owners)],
      appendSystemPrompt: prompt.render(mainPrompt, {
        projectName: store.projectName,
        mainDirectory: store.paths.main,
        sharedDirectory: store.paths.shared,
      }),
    });
    try {
      await result.session.setActiveToolsByName(MAIN_TOOLS);
      await manager.ensureOnDisk();
      if (!store.manifest) {
        const file = manager.getSessionFile();
        if (!file) throw new Error("Main session file was not created");
        await store.initialize(file);
      }
      owners.attachMain(result);
      return result;
    } catch (error) {
      await result.session.dispose();
      throw error;
    }
  } catch (error) {
    await manager.close();
    throw error;
  }
}

export async function runHarness(options: LaunchOptions): Promise<void> {
  const store = await ProjectStore.open(options);
  const owners = new OwnerCoordinator(store);
  let main: CreateAgentSessionResult | undefined;
  let unregisterCleanup: (() => void) | undefined;
  let completeCleanup: Promise<void> | undefined;
  const cleanup = (): Promise<void> =>
    (completeCleanup ??= (async () => {
      let ownerError: unknown;
      try {
        try {
          await owners.dispose();
        } catch (error) {
          ownerError = error;
        }
        await main?.session.dispose();
        if (ownerError) throw ownerError;
      } finally {
        store.release();
      }
    })());
  try {
    main = await createMain(store, owners);
    if (options.resume) await owners.restore();
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
    // Register before TUI teardown: postmortem callbacks execute in reverse order.
    unregisterCleanup = postmortem.register("project-harness", cleanup);
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
    await mode.renderInitialMessages({ preserveExistingChat: true });
    void main.startBackgroundModelDiscovery?.().catch((error) => {
      logger.warn("Background model discovery failed", { error: String(error) });
    });
    while (true) {
      const input = await mode.getUserInput();
      await submitInteractiveInput(mode, main.session, input);
    }
  } finally {
    unregisterCleanup?.();
    await cleanup();
  }
}

if (import.meta.main) {
  try {
    const flags = parseLaunchOptions(process.argv.slice(2));
    if (!flags) {
      process.stdout.write(
        [
          "Usage: project [--repo <Git repository>] [--project <slug>] [--resume]",
          "",
          "Run bare inside a Git repository to create its harness project, or to",
          "resume it when one already exists. The project name defaults to the",
          "repository directory name; pass --project to choose another.",
          "",
        ].join("\n"),
      );
    } else {
      const options = await resolveLaunchOptions(flags, process.cwd());
      const actions = [
        ...(options.bootstrap?.initialized ? ["initialized Git repository"] : []),
        ...(options.bootstrap?.committed ? ["created empty initial commit"] : []),
      ];
      const suffix = actions.length > 0 ? ` (${actions.join(", ")})` : "";
      process.stdout.write(
        `${options.resume ? "Resuming" : "Creating"} project "${options.project}" for ${options.repo}${suffix}\n`,
      );
      await runHarness(options);
    }
  } catch (error) {
    logger.error("Project harness failed", { error: String(error) });
    process.stderr.write(
      `project: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
