#!/usr/bin/env bun
import * as util from "node:util";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveLaunchOptions, type LaunchFlags } from "./tui/launcher";
import { runHarness } from "./tui";

export { runHarness } from "./tui";
export { MAIN_TOOLS } from "./runtime/main-session";

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
    process.stderr.write(`project: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
