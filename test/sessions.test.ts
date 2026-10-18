import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { validateSessionWorkspace } from "../src/runtime/sessions";

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
  try {
    await Promise.all(managers.splice(0).map((manager) => manager.close()));
  } finally {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  }
});

interface Fixture {
  root: string;
  cwd: string;
  shared: string;
  file: string;
}

async function fixture(): Promise<Fixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "harness-session-test-")));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  const shared = path.join(root, "shared");
  await Promise.all([cwd, shared].map((directory) => fs.mkdir(directory)));
  const manager = SessionManager.create(cwd, path.join(root, "sessions"));
  managers.push(manager);
  await manager.addWorkspaceDirectory(shared);
  await manager.ensureOnDisk();
  const file = manager.getSessionFile();
  if (!file) throw new Error("Fixture session did not allocate a transcript");
  await manager.close();
  return { root, cwd, shared, file };
}

async function changeHeader(
  f: Fixture,
  update: (header: Record<string, unknown>) => void,
): Promise<void> {
  const entries = Bun.JSONL.parse(await Bun.file(f.file).text()) as Record<string, unknown>[];
  const header = entries.find((entry) => entry.type === "session");
  if (!header) throw new Error("Fixture transcript did not contain a session header");
  update(header);
  await Bun.write(f.file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

async function restore(f: Fixture): Promise<SessionManager> {
  const manager = await SessionManager.open(f.file, undefined, undefined, {
    initialCwd: f.cwd,
    suppressBreadcrumb: true,
    throwIfMissing: true,
  });
  managers.push(manager);
  return manager;
}

describe("Restored session workspace validation", () => {
  test("a deleted recorded workspace is rejected even when SDK restore falls back to the expected cwd", async () => {
    const f = await fixture();
    const deleted = path.join(f.root, "deleted-workspace");
    await changeHeader(f, (header) => {
      header.cwd = deleted;
    });
    const manager = await restore(f);

    expect(manager.getCwd()).toBe(f.cwd);
    expect(manager.getHeader()?.cwd).toBe(deleted);
    await expect(validateSessionWorkspace(manager, f.cwd, [f.shared])).rejects.toThrow();
  });

  test("a transcript without recorded cwd cannot adopt the launch workspace", async () => {
    const f = await fixture();
    await changeHeader(f, (header) => {
      delete header.cwd;
    });
    const manager = await restore(f);

    expect(manager.getCwd()).toBe(f.cwd);
    await expect(validateSessionWorkspace(manager, f.cwd, [f.shared])).rejects.toThrow();
  });

  test("a transcript belonging to another accessible workspace is rejected", async () => {
    const f = await fixture();
    const other = path.join(f.root, "other-workspace");
    await fs.mkdir(other);
    await changeHeader(f, (header) => {
      header.cwd = other;
    });
    const manager = await restore(f);

    expect(manager.getCwd()).toBe(other);
    await expect(validateSessionWorkspace(manager, f.cwd, [f.shared])).rejects.toThrow();
  });

  test("unexpected persisted additional roots are rejected before SDK construction can merge them", async () => {
    const f = await fixture();
    const unexpected = path.join(f.root, "another-owner-shared");
    await fs.mkdir(unexpected);
    await changeHeader(f, (header) => {
      header.additionalDirectories = [f.shared, unexpected];
    });
    const manager = await restore(f);

    expect(manager.getAdditionalDirectories()).toEqual([f.shared, unexpected]);
    await expect(validateSessionWorkspace(manager, f.cwd, [f.shared])).rejects.toThrow();
  });
});
