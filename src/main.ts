#!/usr/bin/env bun
import * as util from "node:util";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveLaunchOptions, type LaunchFlags } from "./launch";
import { chooseProjectInteractively, promptForProjectName } from "./tui/launcher";
import { runHarness } from "./tui";
import { runWebHarness } from "./web";

export { runHarness } from "./tui";
export { MAIN_TOOLS } from "./runtime/main-session";

export interface CliLaunchFlags extends LaunchFlags {
  web: boolean;
  port?: number;
}

export function parseLaunchOptions(args: string[]): CliLaunchFlags | undefined {
  const { values } = util.parseArgs({
    args,
    options: {
      repo: { type: "string" },
      project: { type: "string" },
      resume: { type: "boolean", default: false },
      web: { type: "boolean", default: false },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) return undefined;
  let port: number | undefined;
  if (values.port !== undefined) {
    if (!/^(0|[1-9]\d{0,4})$/.test(values.port)) {
      throw new Error("--port must be an integer from 0 to 65535");
    }
    port = Number(values.port);
    if (port > 65535) throw new Error("--port must be an integer from 0 to 65535");
    if (!values.web) throw new Error("--port can only be used with --web");
  }
  return {
    repo: values.repo,
    project: values.project,
    resume: values.resume ?? false,
    web: values.web ?? false,
    ...(port === undefined ? {} : { port }),
  };
}

if (import.meta.main) {
  try {
    const flags = parseLaunchOptions(process.argv.slice(2));
    if (!flags) {
      process.stdout.write(
        [
          "Usage: project [--repo <directory>] [--project <slug>] [--resume] [--web [--port <0..65535>]]",
          "",
          "Run bare inside any directory to create its harness project, or to resume",
          "it when one already exists. A Git repository binds as-is; a populated",
          "non-Git directory is adopted without touching it; an empty directory is",
          "given a Git repository. --repo always makes its directory a Git",
          "repository. The project name defaults to the directory name; pass",
          "--project to choose another.",
          "Use --web to start the local browser interface (default port 4173).",
          "",
        ].join("\n"),
      );
    } else {
      const options = await resolveLaunchOptions(
        flags,
        process.cwd(),
        undefined,
        async (projects) => {
          if (flags.web) {
            throw new Error(
              `This repository has multiple harness projects (${projects.map((item) => item.projectName).join(", ")}); pass --project <slug> when using --web.`,
            );
          }
          return chooseProjectInteractively(projects);
        },
        async (repo) => {
          if (flags.web) {
            throw new Error(
              `Cannot derive a project slug from ${repo}; pass --project <slug> when using --web.`,
            );
          }
          return promptForProjectName(repo);
        },
      );
      const actions = [
        ...(options.bootstrap?.initialized ? ["initialized Git repository"] : []),
        ...(options.bootstrap?.committed ? ["created empty initial commit"] : []),
      ];
      const suffix = actions.length > 0 ? ` (${actions.join(", ")})` : "";
      process.stdout.write(
        `${options.resume ? "Resuming" : "Creating"} project "${options.project}" for ${options.repo}${suffix}\n`,
      );
      if (flags.web) {
        await runWebHarness(options, {
          port: flags.port,
          development: Bun.env.PROJECT_WEB_DEVELOPMENT === "1",
        });
      } else await runHarness(options);
    }
  } catch (error) {
    logger.error("Project harness failed", { error: String(error) });
    process.stderr.write(`project: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
