import * as fs from "node:fs/promises";
import { $ } from "bun";
import type { VcsCommitOptions } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent } from "@oh-my-pi/pi-utils";

/** Side effects ensureRepoReady applied to the repository. */
export interface RepoBootstrap {
  initialized: boolean;
  committed: boolean;
}

export interface RepoReady {
  root: string;
  bootstrap: RepoBootstrap;
}

/**
 * Make the repository launch-ready: init Git when allowed and missing, and
 * give an unborn HEAD an empty initial commit so owner branches have a base.
 * Never stages user files; a repository that already has commits is untouched.
 */
export async function ensureRepoReady(
  dir: string,
  options: { initIfMissing: boolean },
): Promise<RepoReady> {
  const stat = await fs.stat(dir).catch((error) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  if (!stat?.isDirectory()) {
    throw new Error(`Repository path does not exist, create it first: ${dir}`);
  }
  const bootstrap: RepoBootstrap = { initialized: false, committed: false };
  let repo = vcs.git(dir);
  if (!repo) {
    if (!options.initIfMissing) {
      throw new Error(
        `Not inside a Git repository: ${dir}. Start inside a repository checkout or pass --repo <path>.`,
      );
    }
    // The native VCS layer has no init entry point; shell out once.
    await $`git init -q`.cwd(dir).quiet();
    repo = vcs.git(dir);
    if (!repo) throw new Error(`git init did not produce a repository: ${dir}`);
    bootstrap.initialized = true;
  }
  const root = await fs.realpath(repo.primaryRoot());
  if (!(await repo.headSha())) {
    const status = await repo.statusSummary();
    if (status.staged > 0) {
      throw new Error(
        `Cannot create the initial commit because the repository index already contains ${status.staged} staged change(s). Unstage them or create the initial commit yourself, then retry.`,
      );
    }
    const name = await repo.configGet("user.name");
    const email = await repo.configGet("user.email");
    if (!name || !email) {
      throw new Error(
        `Cannot create the initial commit because Git identity is not configured. Set user.name and user.email in this repository, then retry.`,
      );
    }
    const commitOptions: VcsCommitOptions = { allowEmpty: true };
    await repo.commitCreate("Initial commit", commitOptions);
    bootstrap.committed = true;
  }
  return { root, bootstrap };
}
