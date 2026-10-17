import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { OwnerCoordinator } from "./owners";
import { ProjectStore } from "./project";
import { projectExtension } from "./extension";
import { validateSessionWorkspace } from "./sessions";
import type { RuntimeHost } from "./contracts";
import mainPrompt from "./prompts/main.md" with { type: "text" };

export const MAIN_TOOLS = ["read", "write", "edit", "spawn_owner"];

export interface MainSessionDependencies {
  model?: Model;
  modelRegistry?: ModelRegistry;
  authStorage?: AuthStorage;
  settingsOverrides?: Record<string, unknown>;
  enableLsp?: boolean;
}

export async function createMainSession(
  store: ProjectStore,
  owners: OwnerCoordinator,
  host: RuntimeHost,
  dependencies: MainSessionDependencies = {},
): Promise<CreateAgentSessionResult> {
  const manager = store.manifest
    ? await SessionManager.open(store.manifest.mainSessionFile, store.paths.sessions, undefined, {
        initialCwd: store.paths.main,
        throwIfMissing: true,
      })
    : SessionManager.create(store.paths.main, store.paths.sessions);
  try {
    if (store.manifest) {
      await validateSessionWorkspace(manager, store.paths.main, [store.paths.shared]);
    }
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
    const sessionSettings = settings.overlay({
      ...dependencies.settingsOverrides,
      "memory.backend": "off",
      "autolearn.enabled": false,
      "tools.xdev": false,
      "astEdit.enabled": false,
      "compaction.experimentalContextManagement": false,
      "advisor.enabled": false,
      "task.maxRecursionDepth": 2,
      "task.isolation.enabled": false,
    });
    const options: CreateAgentSessionOptions = {
      cwd: store.paths.main,
      additionalDirectories: [store.paths.shared],
      sessionManager: manager,
      settings: sessionSettings,
      hasUI: host.kind !== "headless",
      interactivePrompts: host.kind !== "headless",
      allowSessionModelFallback: host.kind === "tui",
      ...(dependencies.enableLsp === undefined ? {} : { enableLsp: dependencies.enableLsp }),
      ...(dependencies.model ? { model: dependencies.model } : {}),
      ...(dependencies.modelRegistry ? { modelRegistry: dependencies.modelRegistry } : {}),
      ...(dependencies.authStorage ? { authStorage: dependencies.authStorage } : {}),
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
    };
    const result = await createAgentSession(options);
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

export function logMainSessionFailure(error: unknown): void {
  logger.error("Main session initialization failed", { error: String(error) });
}
