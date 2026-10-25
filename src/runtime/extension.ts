import { type ExtensionFactory, z } from "@oh-my-pi/pi-coding-agent";
import { type OwnerCoordinator, type OwnerWorkspaceRequest } from "./owners";

/**
 * Shown when the user tries to leave the Main session. The harness binds
 * owner workspaces, shared directories and resume validation to this exact
 * session, so switching, forking or starting a fresh one would orphan them.
 */
const SESSION_SWITCH_NOTICE =
  "Session switching is disabled: the Main session is bound to this project by project-harness.";

/** Builtin slash commands whose handlers end in a session switch, fork or tree move. */
const BLOCKED_SESSION_COMMANDS = new Set(["resume", "new", "fork", "tree"]);

const workspaceEntrySchema = z.object({
  from: z.string(),
  checkout: z.string().optional(),
});

export function projectExtension(owners: OwnerCoordinator): ExtensionFactory {
  const parameters = z.object({
    ownerId: z.string(),
    title: z.string(),
    workspace: z.union([z.string(), z.array(workspaceEntrySchema)]).optional(),
  });
  return (pi) => {
    pi.registerTool({
      name: "spawn_owner",
      label: "Start owner",
      description:
        "Create a persistent requirement owner. Write its confirmed requirement.md in the shared directory first. " +
        "Workspace: omit `workspace` to let the harness assign one (a dedicated Git worktree on an auto branch in " +
        "Git projects; the project root itself otherwise). Pass `workspace` as an absolute directory path or a list " +
        "of `{from, checkout?}` entries to bind specific checkouts: entries without `checkout` are used in place, " +
        "entries with `checkout` cut (or attach to) a Git worktree on that branch. The first entry becomes the " +
        "owner's main workspace; the rest are additional roots. The receipt reports every resolved workspace path " +
        "and branch. Returns immediately after launch.",
      parameters,
      loadMode: "essential",
      approval: "exec",
      async execute(_callId, args, signal) {
        try {
          const parsed = parameters.parse(args);
          let workspace: string | OwnerWorkspaceRequest | undefined;
          if (typeof parsed.workspace === "string") workspace = parsed.workspace;
          else if (parsed.workspace !== undefined) workspace = { entries: parsed.workspace };
          const receipt = await owners.spawn(parsed.ownerId, parsed.title, signal, workspace);
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
