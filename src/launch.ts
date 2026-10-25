import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { type ProjectListing, listProjects, validateSlug } from "./runtime/project";
import { type RepoBootstrap, type RepoReady, ensureRepoReady } from "./runtime/repo-setup";
import type { LaunchOptions } from "./runtime/contracts";

/** Raw CLI flags before cwd-based defaults are applied. */
export interface LaunchFlags {
  repo?: string;
  project?: string;
  resume: boolean;
}

/** Resolves which project to open when one repository owns several. */
export type ProjectChooser = (projects: ProjectListing[]) => Promise<ProjectListing | null>;
export type ProjectNamePrompt = (repoRoot: string) => Promise<string>;

/**
 * Lowercase-slug candidate for a project name. Returns an empty string when
 * the input carries no slug material at all, which callers must treat as
 * "ask the user".
 */
export function slugifyProjectName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/**
 * Resolve the repository to bind, making it launch-ready on the way:
 * an explicit --repo always adopts its directory (init + empty initial commit
 * as needed), a bare launch only adopts a directory that is a Git repository
 * or completely empty, and every launch gives an unborn HEAD an initial
 * commit so owners can branch later.
 */
async function resolveRepoRoot(flags: LaunchFlags, cwd: string): Promise<RepoReady> {
  if (flags.repo !== undefined) {
    return ensureRepoReady(path.resolve(flags.repo), { initIfMissing: true });
  }
  if (vcs.git(cwd)) {
    return ensureRepoReady(cwd, { initIfMissing: false });
  }
  const entries = await fs.readdir(cwd);
  if (entries.length > 0) {
    throw new Error(
      `Not inside a Git repository: ${cwd}. Start inside a repository checkout or pass --repo <path>.`,
    );
  }
  return ensureRepoReady(cwd, { initIfMissing: true });
}

/**
 * Resolve CLI flags against the current directory and known projects.
 * A bare launch adopts the surrounding Git repository; an existing project
 * for that repository resumes instead of erroring; the project name defaults
 * to the repository directory name.
 */
export async function resolveLaunchOptions(
  flags: LaunchFlags,
  cwd: string,
  dataHome?: string,
  chooseProject?: ProjectChooser,
  askProjectName?: ProjectNamePrompt,
): Promise<LaunchOptions> {
  const ready = await resolveRepoRoot(flags, cwd);
  const repo = ready.root;
  const bootstrap: RepoBootstrap = ready.bootstrap;
  const forRepo = (await listProjects(dataHome)).filter((listing) => listing.repoRoot === repo);
  if (flags.project === undefined) {
    if (forRepo.length === 1) {
      return { repo, project: forRepo[0].projectName, resume: true, bootstrap };
    }
    if (forRepo.length > 1) {
      if (!chooseProject) {
        throw new Error(
          `This repository has multiple harness projects (${forRepo.map((item) => item.projectName).join(", ")}); pass --project <slug>.`,
        );
      }
      const chosen = await chooseProject(forRepo);
      if (!chosen) throw new Error("No project selected");
      return { repo, project: chosen.projectName, resume: true, bootstrap };
    }
    const derived = slugifyProjectName(path.basename(repo));
    if (derived.length === 0 && !askProjectName) {
      throw new Error(`Cannot derive a project slug from ${repo}; pass --project <slug>.`);
    }
    return {
      repo,
      project: derived.length > 0 ? derived : validateSlug(await askProjectName!(repo), "project"),
      resume: flags.resume,
      bootstrap,
    };
  }
  const project = validateSlug(flags.project!, "project");
  const existing = forRepo.some((listing) => listing.projectName === project);
  return { repo, project, resume: flags.resume || existing, bootstrap };
}
