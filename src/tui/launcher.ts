import {
  promptStandaloneText,
  selectStandaloneItem,
} from "@oh-my-pi/pi-tui/apps/standalone-picker";
import { type ProjectListing, validateSlug } from "../runtime/project";
import {
  resolveLaunchOptions as resolveSharedLaunchOptions,
  type LaunchFlags,
  type ProjectChooser,
} from "../launch";

export { slugifyProjectName, type LaunchFlags, type ProjectChooser } from "../launch";

export async function promptForProjectName(repoRoot: string): Promise<string> {
  let title = `Project name for ${repoRoot} (lowercase slug, Enter to confirm):`;
  for (;;) {
    const answer = await promptStandaloneText(title);
    if (answer === null) throw new Error("A project name is required to start");
    try {
      return validateSlug(answer, "project");
    } catch (error) {
      title = `${error instanceof Error ? error.message : String(error)}\nProject name:`;
    }
  }
}

export const chooseProjectInteractively: ProjectChooser = async (projects) => {
  const value = await selectStandaloneItem(
    "This repository has multiple harness projects:",
    projects.map((listing) => ({
      value: listing.projectName,
      label: listing.projectName,
      description:
        listing.modifiedAt > 0 ? new Date(listing.modifiedAt).toLocaleString() : undefined,
    })),
  );
  if (value === null) return null;
  return projects.find((listing) => listing.projectName === value) ?? null;
};

export async function resolveLaunchOptions(
  flags: LaunchFlags,
  cwd: string,
  dataHome?: string,
  chooseProject: ProjectChooser = chooseProjectInteractively,
) {
  return resolveSharedLaunchOptions(flags, cwd, dataHome, chooseProject, promptForProjectName);
}
