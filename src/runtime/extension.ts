import { type ExtensionFactory, z } from "@oh-my-pi/pi-coding-agent";
import { type OwnerCoordinator } from "./owners";

/**
 * Shown when the user tries to leave the Main session. The harness binds
 * owner worktrees, shared directories and resume validation to this exact
 * session, so switching, forking or starting a fresh one would orphan them.
 */
const SESSION_SWITCH_NOTICE =
  "Session switching is disabled: the Main session is bound to this project by project-harness.";

/** Builtin slash commands whose handlers end in a session switch, fork or tree move. */
const BLOCKED_SESSION_COMMANDS = new Set(["resume", "new", "fork", "tree"]);

export function projectExtension(owners: OwnerCoordinator): ExtensionFactory {
  const parameters = z.object({ ownerId: z.string(), title: z.string() });
  return (pi) => {
    pi.registerTool({
      name: "spawn_owner",
      label: "Start owner",
      description:
        "Create a persistent requirement owner in its own code worktree. Write its confirmed requirement.md in the shared directory first. Returns immediately after launch.",
      parameters,
      loadMode: "essential",
      approval: "exec",
      async execute(_callId, args, signal) {
        try {
          const parsed = parameters.parse(args);
          const receipt = await owners.spawn(parsed.ownerId, parsed.title, signal);
          return { content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: String(error) }], isError: true };
        }
      },
    });
    // Intercept the slash entries before the native picker opens, so users get
    // an explanation instead of a selector whose selection silently does nothing.
    pi.on("input", async (event, ctx) => {
      if (!event.text.startsWith("/")) return undefined;
      const name = event.text.slice(1).split(/\s+/, 1)[0] ?? "";
      if (!BLOCKED_SESSION_COMMANDS.has(name)) return undefined;
      ctx.ui.notify(SESSION_SWITCH_NOTICE, "warning");
      return { handled: true };
    });
    // Safety net for every other path (custom keybindings, transcript toolbar):
    // cancel with feedback instead of a silent no-op.
    pi.on("session_before_switch", async (_event, ctx) => {
      ctx.ui.notify(SESSION_SWITCH_NOTICE, "warning");
      return { cancel: true };
    });
    pi.on("session_before_branch", async (_event, ctx) => {
      ctx.ui.notify(SESSION_SWITCH_NOTICE, "warning");
      return { cancel: true };
    });
    pi.on("session_shutdown", async () => {
      await owners.dispose();
    });
  };
}
