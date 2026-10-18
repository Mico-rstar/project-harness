import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ensureRepoReady } from "../src/runtime/repo-setup";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporary(name?: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "project-repo-setup-test-"));
  const root = await fs.realpath(dir);
  roots.push(root);
  if (!name) return root;
  const nested = path.join(root, name);
  await fs.mkdir(nested, { recursive: true });
  return nested;
}

/** An empty seeded Git repository, the same minimal shape the persistence tests use. */
async function seededUnbornRepo(): Promise<string> {
  const repo = await temporary("repo");
  await fs.mkdir(path.join(repo, ".git", "objects"), { recursive: true });
  await fs.mkdir(path.join(repo, ".git", "refs", "heads"), { recursive: true });
  await Bun.write(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await Bun.write(
    path.join(repo, ".git", "config"),
    "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
  );
  return repo;
}

async function configureIdentity(repo: string): Promise<void> {
  const native = vcs.requireGit(repo);
  await native.configSet("user.name", "Harness Test");
  await native.configSet("user.email", "harness-test@example.test");
}

describe("ensureRepoReady", () => {
  test("an empty directory is initialized and given an initial commit", async () => {
    const dir = await temporary("fresh");
    const ready = await ensureRepoReady(dir, { initIfMissing: true });
    expect(ready.bootstrap).toEqual({ initialized: true, committed: true });
    expect(ready.root).toBe(dir);
    const repo = vcs.requireGit(dir);
    expect(await repo.headSha()).toBeTruthy();
    expect(await repo.currentBranch()).toBeTruthy();
  });

  test("adopting a populated directory keeps user files untracked and unstaged", async () => {
    const dir = await temporary("workspace");
    await Bun.write(path.join(dir, "notes.txt"), "user content\n");
    const ready = await ensureRepoReady(dir, { initIfMissing: true });
    expect(ready.bootstrap).toEqual({ initialized: true, committed: true });
    const repo = vcs.requireGit(dir);
    const status = await repo.statusSummary();
    expect(status.staged).toBe(0);
    expect(status.untracked).toBe(1);
  });

  test("a non-git directory without adoption still fails with guidance", async () => {
    const dir = await temporary("plain");
    await Bun.write(path.join(dir, "keep.txt"), "x\n");
    await expect(ensureRepoReady(dir, { initIfMissing: false })).rejects.toThrow(
      "Not inside a Git repository",
    );
  });

  test("an unborn repository receives an empty initial commit", async () => {
    const repo = await seededUnbornRepo();
    await configureIdentity(repo);
    const ready = await ensureRepoReady(repo, { initIfMissing: false });
    expect(ready.bootstrap).toEqual({ initialized: false, committed: true });
    const native = vcs.requireGit(repo);
    expect(await native.headSha()).toBeTruthy();
    const status = await native.statusSummary();
    expect(status.staged).toBe(0);
    expect(status.untracked).toBe(0);
  });

  test("staged changes in an unborn repository are preserved and not committed", async () => {
    const repo = await seededUnbornRepo();
    await configureIdentity(repo);
    const native = vcs.requireGit(repo);
    await Bun.write(path.join(repo, "keep.txt"), "preserve me\n");
    await native.stageFiles(["keep.txt"]);

    await expect(ensureRepoReady(repo, { initIfMissing: false })).rejects.toThrow(
      "index already contains 1 staged change",
    );
    expect(await native.headSha()).toBeNull();
    expect(await Bun.file(path.join(repo, "keep.txt")).text()).toBe("preserve me\n");
    expect((await native.statusSummary()).staged).toBe(1);
  });

  test("missing repository identity fails with local configuration guidance", async () => {
    const repo = await seededUnbornRepo();
    const native = vcs.requireGit(repo);
    await native.configSet("user.name", "");
    await native.configSet("user.email", "");
    await expect(ensureRepoReady(repo, { initIfMissing: false })).rejects.toThrow(
      "Set user.name and user.email in this repository",
    );
    expect(await native.headSha()).toBeNull();
  });

  test("a repository with commits is left untouched", async () => {
    const dir = await temporary("committed");
    await ensureRepoReady(dir, { initIfMissing: true });
    const native = vcs.requireGit(dir);
    const before = await native.headSha();
    const ready = await ensureRepoReady(dir, { initIfMissing: true });
    expect(ready.bootstrap).toEqual({ initialized: false, committed: false });
    expect(await native.headSha()).toBe(before);
  });

  test("a missing directory is never created implicitly", async () => {
    const dir = await temporary();
    const missing = path.join(dir, "does-not-exist");
    await expect(ensureRepoReady(missing, { initIfMissing: true })).rejects.toThrow(
      "Repository path does not exist",
    );
    expect(await Bun.file(missing).exists()).toBe(false);
  });
});
