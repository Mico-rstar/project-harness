import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { resolveLaunchOptions as resolveSharedLaunchOptions } from "../src/launch";
import { listProjects, ProjectStore } from "../src/runtime/project";
import {
  resolveLaunchOptions,
  slugifyProjectName,
  type LaunchFlags,
  type ProjectChooser,
} from "../src/tui/launcher";

const roots: string[] = [];
const stores: ProjectStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.release();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "project-launcher-test-"));
  const root = await fs.realpath(dir);
  roots.push(root);
  return root;
}

interface Fixture {
  repo: string;
  dataHome: string;
}

/** Same minimal Git repository seed as the persistence tests. */
async function gitFixture(): Promise<Fixture> {
  const root = await temporary();
  const repo = path.join(root, "repo");
  await fs.mkdir(path.join(repo, ".git", "objects"), { recursive: true });
  await fs.mkdir(path.join(repo, ".git", "refs", "heads"), { recursive: true });
  await Bun.write(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await Bun.write(
    path.join(repo, ".git", "config"),
    "[core]\n\trepositoryformatversion = 0\n\tbare = false\n[user]\n\tname = Harness Test\n\temail = harness@example.test\n",
  );
  await Bun.write(path.join(repo, "code.txt"), "initial code\n");
  const git = vcs.requireGit(repo);
  await git.stageFiles(["code.txt"]);
  await git.commitCreate("Initial fixture", {});
  return { repo, dataHome: path.join(root, "data") };
}

interface SeedOptions {
  sessionModifiedAt?: Date;
}

async function seedProject(
  dataHome: string,
  repoRoot: string,
  name: string,
  options: SeedOptions = {},
): Promise<string> {
  const root = path.join(dataHome, "project-harness", "0".repeat(16), name);
  const sessions = path.join(root, "sessions");
  const session = path.join(sessions, "main.jsonl");
  await fs.mkdir(sessions, { recursive: true });
  await Bun.write(session, '{"type":"session"}\n');
  const manifest = {
    projectName: name,
    repoRoot,
    commonDir: path.join(repoRoot, ".git"),
    mainSessionFile: session,
    owners: [],
  };
  await Bun.write(path.join(root, "project.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (options.sessionModifiedAt) {
    const stamp = options.sessionModifiedAt;
    await fs.utimes(session, stamp, stamp);
  }
  return root;
}

function chooserPicking(name: string | null): { chooser: ProjectChooser; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    chooser: async (projects) => {
      calls.push(projects.map((listing) => listing.projectName));
      if (name === null) return null;
      return projects.find((listing) => listing.projectName === name) ?? null;
    },
  };
}

describe("project name slugification", () => {
  test("mixed-case and punctuation names collapse into one slug", () => {
    expect(slugifyProjectName("My App")).toBe("my-app");
    expect(slugifyProjectName("  Hello_World.v2 ")).toBe("hello-world-v2");
    expect(slugifyProjectName("omp")).toBe("omp");
  });

  test("names without slug material fall back to asking, and 64 is the cap", () => {
    expect(slugifyProjectName("我的项目")).toBe("");
    expect(slugifyProjectName("---")).toBe("");
    expect(slugifyProjectName("a".repeat(70))).toBe("a".repeat(64));
    expect(slugifyProjectName(`x${"-".repeat(70)}`)).toBe("x");
  });
});

describe("listProjects enumeration", () => {
  test("lists valid manifests newest first and skips damaged entries", async () => {
    const root = await temporary();
    const repo = path.join(root, "repo");
    const dataHome = path.join(root, "data");
    const old = await seedProject(dataHome, repo, "alpha", {
      sessionModifiedAt: new Date(Date.now() - 60_000),
    });
    const fresh = await seedProject(dataHome, repo, "beta");
    await Bun.write(path.join(dataHome, "project-harness", "0".repeat(16), "broken.jsonl"), "x");
    await Bun.write(
      path.join(dataHome, "project-harness", "0".repeat(16), "invalid", "project.json"),
      '{"projectName": 42}',
    );
    await Bun.write(
      path.join(dataHome, "project-harness", "0".repeat(16), "damaged", "project.json"),
      "{not json",
    );

    const listing = await listProjects(dataHome);
    expect(listing.map((entry) => entry.projectName)).toEqual(["beta", "alpha"]);
    expect(listing[0]?.root).toBe(fresh);
    expect(listing[1]?.root).toBe(old);
    expect(listing[1]?.repoRoot).toBe(repo);
    expect(listing[1]?.mainSessionFile).toBe(path.join(old, "sessions", "main.jsonl"));
  });

  test("a missing data home enumerates as empty", async () => {
    const root = await temporary();
    expect(await listProjects(path.join(root, "absent"))).toEqual([]);
  });
});

describe("launch option resolution", () => {
  test("a bare launch in a fresh repository adopts it with the directory name", async () => {
    const f = await gitFixture();
    const neverChooser: ProjectChooser = async () => {
      throw new Error("chooser must not run for a single candidate");
    };
    const options = await resolveLaunchOptions({ resume: false }, f.repo, f.dataHome, neverChooser);
    expect(options).toEqual({
      repo: f.repo,
      project: "repo",
      resume: false,
      bootstrap: { initialized: false, committed: false },
    });
  });

  test("an existing project for the repository resumes without --resume, by repo not name", async () => {
    const f = await gitFixture();
    const store = await ProjectStore.open({ ...f, project: "demo", resume: false });
    stores.push(store);
    const session = path.join(store.paths.sessions, "main.jsonl");
    await Bun.write(session, '{"type":"session"}\n');
    await store.initialize(session);
    store.release();

    // Directory basename is "repo"; the bound project is "demo" and still wins.
    const bare = await resolveLaunchOptions({ resume: false }, f.repo, f.dataHome);
    expect(bare).toEqual({
      repo: f.repo,
      project: "demo",
      resume: true,
      bootstrap: { initialized: false, committed: false },
    });

    const explicit: LaunchFlags = { project: "demo", resume: false };
    expect(await resolveLaunchOptions(explicit, f.repo, f.dataHome)).toEqual({
      repo: f.repo,
      project: "demo",
      resume: true,
      bootstrap: { initialized: false, committed: false },
    });

    const other: LaunchFlags = { project: "other", resume: false };
    expect(await resolveLaunchOptions(other, f.repo, f.dataHome)).toEqual({
      repo: f.repo,
      project: "other",
      resume: false,
      bootstrap: { initialized: false, committed: false },
    });
  });

  test("several projects for one repository are resolved through the picker", async () => {
    const f = await gitFixture();
    for (const name of ["demo", "beta"]) {
      const store = await ProjectStore.open({ ...f, project: name, resume: false });
      stores.push(store);
      const session = path.join(store.paths.sessions, "main.jsonl");
      await Bun.write(session, '{"type":"session"}\n');
      await store.initialize(session);
      store.release();
    }

    const picked = chooserPicking("beta");
    const options = await resolveSharedLaunchOptions(
      { resume: false },
      f.repo,
      f.dataHome,
      picked.chooser,
    );
    expect(options).toEqual({
      repo: f.repo,
      project: "beta",
      resume: true,
      bootstrap: { initialized: false, committed: false },
    });
    expect(picked.calls).toEqual([["beta", "demo"]]);

    const cancelled = chooserPicking(null);
    await expect(
      resolveLaunchOptions({ resume: false }, f.repo, f.dataHome, cancelled.chooser),
    ).rejects.toThrow("No project selected");
    expect(cancelled.calls).toHaveLength(1);
  });

  test("launches outside a Git repository fail with guidance in the message", async () => {
    const f = await gitFixture();
    const outside = path.join(path.dirname(f.repo), "plain");
    await fs.mkdir(outside, { recursive: true });
    await Bun.write(path.join(outside, "keep.txt"), "x\n");
    await expect(resolveLaunchOptions({ resume: false }, outside, f.dataHome)).rejects.toThrow(
      "Not inside a Git repository",
    );
    const missing = path.join(path.dirname(f.repo), "absent");
    await expect(
      resolveLaunchOptions({ repo: missing, resume: false }, f.repo, f.dataHome),
    ).rejects.toThrow("Repository path does not exist");
  });

  test("a bare launch in an empty directory adopts and bootstraps it", async () => {
    const root = await temporary();
    const empty = path.join(root, "brand-new-app");
    await fs.mkdir(empty, { recursive: true });
    const options = await resolveLaunchOptions({ resume: false }, empty, path.join(root, "data"));
    expect(options.repo).toBe(empty);
    expect(options.project).toBe("brand-new-app");
    expect(options.bootstrap).toEqual({ initialized: true, committed: true });
    expect(await vcs.requireGit(empty).headSha()).toBeTruthy();
  });

  test("shared launch resolution asks its host for a name when the directory has no slug", async () => {
    const root = await temporary();
    const directory = path.join(root, "東京");
    await fs.mkdir(directory);
    let promptedFor = "";
    const options = await resolveSharedLaunchOptions(
      { resume: false },
      directory,
      path.join(root, "data"),
      async () => null,
      async (repoRoot) => {
        promptedFor = repoRoot;
        return "web-project";
      },
    );
    expect(promptedFor).toBe(directory);
    expect(options.project).toBe("web-project");
  });

  test("shared launch resolution lets a noninteractive host reject implicit project selection", async () => {
    const f = await gitFixture();
    for (const name of ["demo", "beta"]) {
      const store = await ProjectStore.open({ ...f, project: name, resume: false });
      stores.push(store);
      const session = path.join(store.paths.sessions, "main.jsonl");
      await Bun.write(session, '{"type":"session"}\n');
      await store.initialize(session);
      store.release();
    }
    await expect(
      resolveSharedLaunchOptions(
        { resume: false },
        f.repo,
        f.dataHome,
        async () => {
          throw new Error("pass --project <slug> when using --web");
        },
        async () => "unused",
      ),
    ).rejects.toThrow("pass --project <slug> when using --web");
  });

  test("an explicit --repo adopts a populated non-git directory", async () => {
    const f = await gitFixture();
    const populated = path.join(path.dirname(f.repo), "adopted");
    await fs.mkdir(populated, { recursive: true });
    await Bun.write(path.join(populated, "draft.md"), "user content\n");
    const options = await resolveLaunchOptions(
      { repo: populated, resume: false },
      f.repo,
      f.dataHome,
    );
    expect(options.repo).toBe(populated);
    expect(options.bootstrap).toEqual({ initialized: true, committed: true });
    const status = await vcs.requireGit(populated).statusSummary();
    expect(status.staged).toBe(0);
    expect(status.untracked).toBe(1);
  });
});
