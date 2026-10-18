import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { type OwnerBinding, ProjectStore, validateSlug } from "../src/runtime/project";

const roots: string[] = [];
const stores: ProjectStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.release();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface Fixture {
  repo: string;
  dataHome: string;
}

async function fixture(): Promise<Fixture> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "project-harness-test-"));
  const root = await fs.realpath(temporary);
  roots.push(root);
  const repo = path.join(root, "repo");
  // Native VCS has no init entry point. Seed the empty repository format,
  // then exercise all Git changes through its public operations.
  await fs.mkdir(path.join(repo, ".git", "objects"), { recursive: true });
  await fs.mkdir(path.join(repo, ".git", "refs", "heads"), { recursive: true });
  await Bun.write(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await Bun.write(
    path.join(repo, ".git", "config"),
    "[core]\n\trepositoryformatversion = 0\n\tbare = false\n[user]\n\tname = Harness Test\n\temail = harness@example.test\n",
  );
  await Bun.write(path.join(repo, "code.txt"), "initial code\n");
  const native = vcs.requireGit(repo);
  await native.stageFiles(["code.txt"]);
  await native.commitCreate("Initial fixture", {});
  return { repo, dataHome: path.join(root, "data") };
}

async function open(f: Fixture, resume = false, project = "demo"): Promise<ProjectStore> {
  const store = await ProjectStore.open({ ...f, project, resume });
  stores.push(store);
  return store;
}

async function initialize(store: ProjectStore): Promise<string> {
  const session = path.join(store.paths.sessions, "main-session.jsonl");
  await Bun.write(session, '{"type":"session","id":"main-test"}\n');
  await store.initialize(session);
  return session;
}

async function owner(store: ProjectStore, id: string): Promise<OwnerBinding> {
  const manifest = store.manifest;
  if (!manifest) throw new Error("Fixture must initialize Main first");
  const locations = store.ownerPaths(id);
  const native = vcs.requireGit(store.repoRoot);
  const baseSha = await native.headSha();
  if (!baseSha) throw new Error("Fixture repository must have a commit");
  await native.createBranch(locations.branch, baseSha, false);
  await native.worktreeAdd(locations.worktree, locations.branch, {
    detach: false,
    clone: false,
    keepChanges: false,
  });
  await fs.mkdir(locations.sharedDir, { recursive: true });
  const sessionFile = path.join(manifest.mainSessionFile.slice(0, -6), `${id}.jsonl`);
  await Bun.write(sessionFile, `{"type":"session","id":"${id}"}\n`);
  return { id, title: `Work for ${id}`, ...locations, baseSha, sessionFile };
}

describe("ProjectStore persistence contracts", () => {
  test("unsafe slugs cannot escape directories or impersonate Main", () => {
    for (const value of [
      "",
      "../bad",
      "a/b",
      "a\\b",
      "HasCaps",
      "-bad",
      "bad-",
      "two--hyphens",
      "a".repeat(65),
    ]) {
      expect(() => validateSlug(value, "ownerId")).toThrow();
    }
    expect(() => validateSlug("main", "ownerId")).toThrow("reserved identity");
    // A project name does not participate in registry identities.
    expect(validateSlug("main", "project")).toBe("main");
  });

  test("resume is explicit and concurrent project processes cannot claim the same bindings", async () => {
    const f = await fixture();
    await expect(open(f, true)).rejects.toThrow("no manifest to resume");
    const store = await open(f);
    await expect(open(f)).rejects.toThrow("already running");
    await initialize(store);
    store.release();
    store.release();
    await expect(open(f)).rejects.toThrow("use --resume");
    const resumed = await open(f, true);
    expect(resumed.manifest?.mainSessionFile).toBe(
      path.join(store.paths.sessions, "main-session.jsonl"),
    );
  });

  test("nested and linked repo paths find the same project without replacing memory or wiki", async () => {
    const f = await fixture();
    const store = await open(f);
    await initialize(store);
    const binding = await owner(store, "owner-a");
    await store.addOwner(binding);
    const memory = path.join(store.paths.main, "memory", "MEMORY.md");
    const wiki = path.join(store.paths.main, "wiki", "README.md");
    await Bun.write(memory, "- Existing decision\n");
    await Bun.write(wiki, "- Existing design\n");
    await fs.mkdir(path.join(f.repo, "nested"));
    store.release();
    const nested = await open({ ...f, repo: path.join(f.repo, "nested") }, true);
    expect(nested.paths.root).toBe(store.paths.root);
    nested.release();
    const linked = await open({ ...f, repo: binding.worktree }, true);
    expect(linked.repoRoot).toBe(store.repoRoot);
    expect(linked.paths.root).toBe(store.paths.root);
    expect(await Bun.file(memory).text()).toBe("- Existing decision\n");
    expect(await Bun.file(wiki).text()).toBe("- Existing design\n");
  });

  test("concurrent owner updates survive restart with dirty files and new commits intact", async () => {
    const f = await fixture();
    const store = await open(f);
    await initialize(store);
    const a = await owner(store, "owner-a");
    const b = await owner(store, "owner-b");
    await Promise.all([store.addOwner(a), store.addOwner(b)]);
    const native = vcs.requireGit(a.worktree);
    await Bun.write(path.join(a.worktree, "code.txt"), "owner committed code\n");
    await native.stageFiles(["code.txt"]);
    await native.commitCreate("Owner progress", {});
    await Bun.write(path.join(a.worktree, "code.txt"), "owner dirty code\n");
    await Bun.write(path.join(b.sharedDir, "progress.md"), "Review underway\n");
    store.release();
    const resumed = await open(f, true);
    expect(resumed.manifest?.owners.map((binding) => binding.id)).toEqual(["owner-a", "owner-b"]);
    expect(resumed.getOwner("owner-a")?.baseSha).toBe(a.baseSha);
    expect(await vcs.requireGit(a.worktree).headSha()).not.toBe(a.baseSha);
    expect(await Bun.file(path.join(a.worktree, "code.txt")).text()).toBe("owner dirty code\n");
    expect(await Bun.file(path.join(b.sharedDir, "progress.md")).text()).toBe("Review underway\n");
  });

  test("missing owner transcripts fail resume and remain missing", async () => {
    const f = await fixture();
    const store = await open(f);
    await initialize(store);
    const binding = await owner(store, "owner-a");
    await store.addOwner(binding);
    store.release();
    await fs.rm(binding.sessionFile);
    await expect(open(f, true)).rejects.toThrow('Owner "owner-a" session file is missing');
    expect(await Bun.file(binding.sessionFile).exists()).toBe(false);
    // Failed validation releases its lease so the user can retry after repair.
    await Bun.write(binding.sessionFile, '{"type":"session","id":"owner-a"}\n');
    const repaired = await open(f, true);
    expect(repaired.getOwner("owner-a")?.sessionFile).toBe(binding.sessionFile);
  });

  test("changed owner branches fail resume without altering the checkout", async () => {
    const f = await fixture();
    const store = await open(f);
    await initialize(store);
    const binding = await owner(store, "owner-a");
    await store.addOwner(binding);
    store.release();
    const native = vcs.requireGit(binding.worktree);
    await native.checkoutNewBranch("manual-owner-branch");
    await expect(open(f, true)).rejects.toThrow("not registered on branch");
    expect(await native.currentBranch()).toBe("manual-owner-branch");
  });

  test("wrong binding paths and duplicate owner IDs cannot corrupt a valid manifest", async () => {
    const f = await fixture();
    const store = await open(f);
    await initialize(store);
    const binding = await owner(store, "owner-a");
    await expect(store.addOwner({ ...binding, sharedDir: store.paths.shared })).rejects.toThrow(
      "paths or branch",
    );
    await store.addOwner(binding);
    await expect(store.addOwner(binding)).rejects.toThrow("already bound");
    expect(store.manifest?.owners).toEqual([binding]);
    const disk = await Bun.file(store.paths.manifest).json();
    expect(disk.owners).toEqual([binding]);
  });

  test("invalid persisted repository and session paths are rejected before sessions are opened", async () => {
    const f = await fixture();
    const store = await open(f);
    await initialize(store);
    const manifest = store.manifest;
    if (!manifest) throw new Error("Expected persisted project");
    store.release();
    await Bun.write(
      store.paths.manifest,
      JSON.stringify({ ...manifest, repoRoot: path.dirname(f.repo) }),
    );
    await expect(open(f, true)).rejects.toThrow("different project or Git repository");
    await Bun.write(
      store.paths.manifest,
      JSON.stringify({ ...manifest, mainSessionFile: "/tmp/other.jsonl" }),
    );
    await expect(open(f, true)).rejects.toThrow("directly inside");
  });

  test("unbound session artifacts prevent creation and existing indexes are preserved", async () => {
    const f = await fixture();
    const store = await open(f);
    const memory = path.join(store.paths.main, "memory", "MEMORY.md");
    await Bun.write(memory, "- User-authored index\n");
    const orphan = path.join(store.paths.sessions, "orphan.jsonl");
    await Bun.write(orphan, '{"type":"session"}\n');
    store.release();
    await expect(open(f)).rejects.toThrow("Unbound project resources");
    expect(await Bun.file(orphan).text()).toBe('{"type":"session"}\n');
    await fs.rm(orphan);
    const retried = await open(f);
    expect(await Bun.file(path.join(retried.paths.main, "memory", "MEMORY.md")).text()).toBe(
      "- User-authored index\n",
    );
  });
});
