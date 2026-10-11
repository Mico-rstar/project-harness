import { type ExtensionFactory, z } from "@oh-my-pi/pi-coding-agent";
import { type OwnerCoordinator } from "./owners";

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
    pi.on("session_before_switch", async () => ({ cancel: true }));
    pi.on("session_before_branch", async () => ({ cancel: true }));
    pi.on("session_shutdown", async () => {
      await owners.dispose();
    });
  };
}
