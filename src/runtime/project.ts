import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeArtifact } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import {
  type FileLockHandle,
  isEexist,
  isEnoent,
  logger,
  tryAcquireFileLock,
} from "@oh-my-pi/pi-utils";

/**
 * One workspace root an owner works in. Inherited entries (`checkout`
 * undefined) resolve to an existing directory used in place; checkout entries
 * record a Git worktree cut from `repo ?? manifest.repoRoot` on branch
 * `checkout`, with `baseSha` capturing the commit it was created or attached
 * at.
 */
export interface WorkspaceEntry {
  path: string;
  repo?: string;
  checkout?: string;
  baseSha?: string;
}

export interface OwnerBinding {
  id: string;
  title: string;
  /** Primary workspace path (entries[0].path); the owner session cwd. */
  worktree: string;
  entries: WorkspaceEntry[];
  sharedDir: string;
  sessionFile: string;
}

export interface ProjectManifest {
  projectName: string;
  /** Project root: the canonical Git root for Git projects, the adopted directory otherwise. */
  repoRoot: string;
  /** Present only when repoRoot is a Git repository. */
  commonDir?: string;
  mainSessionFile: string;
  owners: OwnerBinding[];
}

export interface ProjectPaths {
  root: string;
  manifest: string;
  main: string;
  shared: string;
  worktrees: string;
  sessions: string;
}

export interface OpenProjectOptions {
  repo: string;
  project: string;
  resume: boolean;
  /** Parent of project-harness/, defaults to ~/.local/share. */
  dataHome?: string;
}

export interface OwnerPaths {
  worktree: string;
  sharedDir: string;
  branch: string;
}

export function validateSlug(value: string, label: string): string {
  if (value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(
      `${label} must be a lowercase slug of 1–64 characters using letters, digits and single hyphens`,
    );
  }
  if (/owner/i.test(label) && value === "main") {
    throw new Error(`${label} cannot use the reserved identity "main"`);
  }
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Invalid project manifest: ${key} must be a nonempty string`);
  }
  return field;
}

function optionalStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Invalid project manifest: ${key} must be a nonempty string when present`);
  }
  return field;
}

const BASE_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function parseWorkspaceEntry(value: unknown, ownerId: string): WorkspaceEntry {
  const row = object(value, `owner ${ownerId} workspace entry`);
  const entryPath = stringField(row, "path");
  const checkout = optionalStringField(row, "checkout");
  const baseSha = optionalStringField(row, "baseSha");
  const repo = optionalStringField(row, "repo");
  if (checkout === undefined) {
    if (baseSha !== undefined || repo !== undefined) {
      throw new Error(
        `Invalid owner ${ownerId}: workspace entries without checkout must not record repo or baseSha`,
      );
    }
    return { path: entryPath };
  }
  if (baseSha === undefined || !BASE_SHA_PATTERN.test(baseSha)) {
    throw new Error(`Invalid owner ${ownerId}: checkout entries require a Git commit SHA baseSha`);
  }
  return { path: entryPath, checkout, baseSha, ...(repo === undefined ? {} : { repo }) };
}

function parseOwner(value: unknown): OwnerBinding {
  const row = object(value, "owner binding");
  const id = validateSlug(stringField(row, "id"), "ownerId");
  const title = stringField(row, "title");
  if (title.trim().length === 0 || title.length > 200) {
    throw new Error(`Invalid owner ${id}: title must contain 1–200 characters`);
  }
  const worktree = stringField(row, "worktree");
  const sharedDir = stringField(row, "sharedDir");
  const sessionFile = stringField(row, "sessionFile");
  const legacyBranch = optionalStringField(row, "branch");
  const legacyBaseSha = optionalStringField(row, "baseSha");
  let entries: WorkspaceEntry[];
  if (row.entries !== undefined) {
    if (legacyBranch !== undefined || legacyBaseSha !== undefined) {
      throw new Error(
        `Invalid owner ${id}: entries and legacy branch/baseSha are mutually exclusive`,
      );
    }
    if (!Array.isArray(row.entries) || row.entries.length === 0) {
      throw new Error(`Invalid owner ${id}: entries must be a nonempty array`);
    }
    entries = row.entries.map((entry) => parseWorkspaceEntry(entry, id));
  } else if (legacyBranch !== undefined || legacyBaseSha !== undefined) {
    if (legacyBranch === undefined || legacyBaseSha === undefined) {
      throw new Error(`Invalid owner ${id}: branch and baseSha must be recorded together`);
    }
    if (!BASE_SHA_PATTERN.test(legacyBaseSha)) {
      throw new Error(`Invalid owner ${id}: baseSha must be a Git commit SHA`);
    }
    entries = [{ path: worktree, checkout: legacyBranch, baseSha: legacyBaseSha }];
  } else {
    entries = [{ path: worktree }];
  }
  if (entries[0]!.path !== worktree) {
    throw new Error(`Invalid owner ${id}: worktree must mirror the first workspace entry path`);
  }
  return { id, title, worktree, entries, sharedDir, sessionFile };
}

function parseManifest(value: unknown): ProjectManifest {
  const row = object(value, "project manifest");
  if (!Array.isArray(row.owners))
    throw new Error("Invalid project manifest: owners must be an array");
  const owners = row.owners.map(parseOwner);
  if (new Set(owners.map((owner) => owner.id)).size !== owners.length) {
    throw new Error("Invalid project manifest: duplicate owner identities");
  }
  return {
    projectName: validateSlug(stringField(row, "projectName"), "project"),
    repoRoot: stringField(row, "repoRoot"),
    commonDir: optionalStringField(row, "commonDir"),
    mainSessionFile: stringField(row, "mainSessionFile"),
    owners,
  };
}

async function requireDirectory(directory: string, label: string): Promise<void> {
  const stat = await fs.stat(directory).catch((error) => {
    if (isEnoent(error)) throw new Error(`${label} directory is missing: ${directory}`);
    throw error;
  });
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${directory}`);
  if ((await fs.realpath(directory)) !== directory) {
    throw new Error(`${label} directory resolves outside its recorded path: ${directory}`);
  }
}

async function requireSession(file: string, label: string): Promise<void> {
  const stat = await fs.stat(file).catch((error) => {
    if (isEnoent(error)) throw new Error(`${label} session file is missing: ${file}`);
    throw error;
  });
  if (!stat.isFile() || stat.size === 0)
    throw new Error(`${label} session file is empty or not a file: ${file}`);
  if ((await fs.realpath(file)) !== file)
    throw new Error(`${label} session file has an unexpected real path: ${file}`);
}

async function initializeIndex(file: string): Promise<void> {
  try {
    const handle = await fs.open(file, "wx");
    await handle.close();
  } catch (error) {
    if (isEexist(error)) return;
    throw error;
  }
}

/** A project discovered on disk, for pickers and cwd-based resume. */
export interface ProjectListing {
  /** Project data root containing project.json. */
  root: string;
  projectName: string;
  repoRoot: string;
  mainSessionFile: string;
  /** Main session file mtime, falling back to the manifest mtime. */
  modifiedAt: number;
}

async function newestMtime(files: string[]): Promise<number> {
  for (const file of files) {
    const stat = await fs.stat(file).catch((error) => {
      if (isEnoent(error)) return undefined;
      throw error;
    });
    if (stat) return stat.mtimeMs;
  }
  return 0;
}

/**
 * Enumerate known projects under the data home (default ~/.local/share),
 * newest first. Unreadable or invalid entries are skipped with a warning so
 * one damaged project cannot hide the rest.
 */
export async function listProjects(dataHome?: string): Promise<ProjectListing[]> {
  const home = path.resolve(dataHome ?? path.join(os.homedir(), ".local", "share"));
  const registry = path.join(home, "project-harness");
  const hashes = await fs.readdir(registry).catch((error) => {
    if (isEnoent(error)) return [] as string[];
    throw error;
  });
  const listing: ProjectListing[] = [];
  for (const hash of hashes) {
    const hashDir = path.join(registry, hash);
    const stat = await fs.stat(hashDir).catch((error) => {
      if (isEnoent(error)) return undefined;
      throw error;
    });
    if (!stat?.isDirectory()) continue;
    const names = await fs.readdir(hashDir).catch((error) => {
      if (isEnoent(error)) return [] as string[];
      throw error;
    });
    for (const name of names) {
      const root = path.join(hashDir, name);
      const manifestFile = path.join(root, "project.json");
      let saved: unknown;
      try {
        saved = await Bun.file(manifestFile).json();
      } catch (error) {
        if (!isEnoent(error)) {
          logger.warn("Skipping unreadable project manifest", {
            file: manifestFile,
            error: String(error),
          });
        }
        continue;
      }
      try {
        const manifest = parseManifest(saved);
        listing.push({
          root,
          projectName: manifest.projectName,
          repoRoot: manifest.repoRoot,
          mainSessionFile: manifest.mainSessionFile,
          modifiedAt: await newestMtime([manifest.mainSessionFile, manifestFile]),
        });
      } catch (error) {
        logger.warn("Skipping invalid project manifest", {
          file: manifestFile,
          error: String(error),
        });
      }
    }
  }
  return listing.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** A process lease plus the minimum persisted project/session bindings. */
export class ProjectStore {
  readonly paths: ProjectPaths;
  /** Project root: the canonical Git root for Git projects, the adopted directory otherwise. */
  readonly repoRoot: string;
  /** Present only when repoRoot is a Git repository. */
  readonly commonDir: string | undefined;
  readonly projectName: string;
  readonly #lease: FileLockHandle;
  #manifest: ProjectManifest | undefined;
  #updates: Promise<void> = Promise.resolve();
  #released = false;

  constructor(
    paths: ProjectPaths,
    repoRoot: string,
    commonDir: string | undefined,
    projectName: string,
    lease: FileLockHandle,
  ) {
    this.paths = paths;
    this.repoRoot = repoRoot;
    this.commonDir = commonDir;
    this.projectName = projectName;
    this.#lease = lease;
  }

  get manifest(): ProjectManifest | undefined {
    return this.#manifest ? structuredClone(this.#manifest) : undefined;
  }

  static async open(options: OpenProjectOptions): Promise<ProjectStore> {
    const projectName = validateSlug(options.project, "project");
    const resolved = path.resolve(options.repo);
    const sourceRepo = vcs.git(resolved);
    let repoRoot: string;
    let commonDir: string | undefined;
    if (sourceRepo) {
      repoRoot = await fs.realpath(sourceRepo.primaryRoot());
      commonDir = await fs.realpath(vcs.requireGit(repoRoot).info().commonDir);
    } else {
      const stat = await fs.stat(resolved).catch((error) => {
        if (isEnoent(error)) return undefined;
        throw error;
      });
      if (!stat?.isDirectory()) {
        throw new Error(`Project root does not exist or is not a directory: ${resolved}`);
      }
      // Adoption never rewrites the directory; realpath keeps the data key stable.
      repoRoot = await fs.realpath(resolved);
    }
    const repoHash = new Bun.CryptoHasher("sha256").update(repoRoot).digest("hex").slice(0, 16);
    const dataHome = path.resolve(options.dataHome ?? path.join(os.homedir(), ".local", "share"));
    const root = path.join(dataHome, "project-harness", repoHash, projectName);
    await fs.mkdir(root, { recursive: true });
    const canonicalRoot = await fs.realpath(root);
    const paths: ProjectPaths = {
      root: canonicalRoot,
      manifest: path.join(canonicalRoot, "project.json"),
      main: path.join(canonicalRoot, "main"),
      shared: path.join(canonicalRoot, "shared"),
      worktrees: path.join(canonicalRoot, "worktrees"),
      sessions: path.join(canonicalRoot, "sessions"),
    };
    const lease = tryAcquireFileLock(paths.manifest);
    if (!lease) throw new Error(`Project "${projectName}" is already running: ${paths.root}`);
    const store = new ProjectStore(paths, repoRoot, commonDir, projectName, lease);
    try {
      let saved: unknown;
      try {
        saved = await Bun.file(paths.manifest).json();
      } catch (error) {
        if (!isEnoent(error))
          throw new Error(`Cannot read project manifest ${paths.manifest}`, { cause: error });
      }
      if (saved !== undefined) {
        if (!options.resume)
          throw new Error(`Project "${projectName}" already exists; use --resume`);
        store.#manifest = parseManifest(saved);
        store.#validateManifest();
        await store.validateOwners();
      } else {
        if (options.resume)
          throw new Error(`Project "${projectName}" has no manifest to resume: ${paths.manifest}`);
        for (const directory of [paths.worktrees, paths.sessions]) {
          let entries: string[] = [];
          try {
            entries = await fs.readdir(directory);
          } catch (error) {
            if (!isEnoent(error)) throw error;
          }
          if (entries.length > 0) {
            throw new Error(
              `Unbound project resources exist in ${directory}; inspect them before creating the project`,
            );
          }
        }
        await Promise.all(
          [
            paths.main,
            paths.shared,
            paths.worktrees,
            paths.sessions,
            path.join(paths.main, "memory"),
            path.join(paths.main, "wiki"),
            path.join(paths.main, "tmp"),
          ].map((directory) => fs.mkdir(directory, { recursive: true })),
        );
        await Promise.all([
          initializeIndex(path.join(paths.main, "memory", "MEMORY.md")),
          initializeIndex(path.join(paths.main, "wiki", "README.md")),
        ]);
      }
      return store;
    } catch (error) {
      store.release();
      throw error;
    }
  }

  ownerPaths(id: string): OwnerPaths {
    validateSlug(id, "ownerId");
    return {
      worktree: path.join(this.paths.worktrees, id),
      sharedDir: path.join(this.paths.shared, id),
      branch: `project-agent/${this.projectName}/${id}`,
    };
  }

  getOwner(id: string): OwnerBinding | undefined {
    const owner = this.#manifest?.owners.find((binding) => binding.id === id);
    return owner ? { ...owner } : undefined;
  }

  #validateManifest(): void {
    const manifest = this.#manifest;
    if (!manifest) throw new Error("Project has not been initialized");
    if (manifest.projectName !== this.projectName || manifest.repoRoot !== this.repoRoot) {
      throw new Error("Project manifest belongs to a different project root or Git repository");
    }
    if ((manifest.commonDir ?? undefined) !== this.commonDir) {
      throw new Error(
        "Project Git binding changed: the project root is no longer (or newly is) a Git repository",
      );
    }
    this.#validateMainPath(manifest.mainSessionFile);
    for (const binding of manifest.owners)
      this.#validateBindingPaths(binding, manifest.mainSessionFile);
  }

  #validateMainPath(file: string): void {
    if (
      path.dirname(file) !== this.paths.sessions ||
      !file.endsWith(".jsonl") ||
      path.basename(file) === ".jsonl"
    ) {
      throw new Error(
        `Main session file must be a JSONL file directly inside ${this.paths.sessions}`,
      );
    }
  }

  #validateBindingPaths(binding: OwnerBinding, mainSessionFile: string): void {
    const expected = this.ownerPaths(binding.id);
    const sessionFile = path.join(mainSessionFile.slice(0, -6), `${binding.id}.jsonl`);
    if (
      binding.worktree !== binding.entries[0]!.path ||
      binding.sharedDir !== expected.sharedDir ||
      binding.sessionFile !== sessionFile
    ) {
      throw new Error(`Owner "${binding.id}" paths differ from its project binding`);
    }
  }

  async #validateOwner(binding: OwnerBinding): Promise<void> {
    await requireDirectory(binding.worktree, `Owner "${binding.id}" workspace`);
    await requireDirectory(binding.sharedDir, `Owner "${binding.id}" shared`);
    await requireSession(binding.sessionFile, `Owner "${binding.id}"`);
    for (const entry of binding.entries) {
      if (entry.checkout === undefined) {
        await requireDirectory(entry.path, `Owner "${binding.id}" workspace entry`);
        continue;
      }
      if (entry.repo === undefined && this.commonDir === undefined) {
        throw new Error(
          `Owner "${binding.id}" checkout entry records no repository and the project root is not a Git repository`,
        );
      }
      const baseRepoPath = entry.repo ?? this.repoRoot;
      const ownerRepo = vcs.requireGit(entry.path);
      const baseRepo = vcs.requireGit(baseRepoPath);
      if (
        (await fs.realpath(ownerRepo.info().repoRoot)) !== entry.path ||
        (await fs.realpath(ownerRepo.info().commonDir)) !==
          (await fs.realpath(baseRepo.info().commonDir))
      ) {
        throw new Error(
          `Owner "${binding.id}" workspace entry ${entry.path} belongs to a different Git repository`,
        );
      }
      const registered = (await baseRepo.worktrees()).find(
        (worktree) => path.resolve(worktree.path) === entry.path,
      );
      const registeredBranch = registered?.branch?.replace(/^refs\/heads\//, "");
      if (!registered || registered.detached || registeredBranch !== entry.checkout) {
        throw new Error(
          `Owner "${binding.id}" workspace entry ${entry.path} is not registered on branch ${entry.checkout}`,
        );
      }
      if ((await ownerRepo.currentBranch()) !== entry.checkout) {
        throw new Error(
          `Owner "${binding.id}" workspace entry ${entry.path} is no longer on branch ${entry.checkout}`,
        );
      }
      if (entry.baseSha === undefined || !(await ownerRepo.resolveRef(entry.baseSha))) {
        throw new Error(
          `Owner "${binding.id}" workspace entry ${entry.path} base commit is missing: ${entry.baseSha}`,
        );
      }
    }
  }

  async validateOwners(): Promise<void> {
    this.#validateManifest();
    const manifest = this.#manifest;
    if (!manifest) throw new Error("Project has not been initialized");
    await requireDirectory(this.paths.main, "Main workspace");
    await requireDirectory(this.paths.shared, "Shared workspace");
    await requireSession(manifest.mainSessionFile, "Main");
    for (const owner of manifest.owners) await this.#validateOwner(owner);
  }

  #enqueue(update: () => Promise<void>): Promise<void> {
    const result = this.#updates.then(async () => {
      if (this.#released) throw new Error("Project lease has been released");
      await update();
    });
    this.#updates = result.catch(() => {});
    return result;
  }

  initialize(mainSessionFile: string): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#manifest) throw new Error("Project manifest is already initialized");
      this.#validateMainPath(mainSessionFile);
      await requireSession(mainSessionFile, "Main");
      try {
        await fs.lstat(this.paths.manifest);
        throw new Error(`Project manifest appeared during initialization: ${this.paths.manifest}`);
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      const manifest: ProjectManifest = {
        projectName: this.projectName,
        repoRoot: this.repoRoot,
        ...(this.commonDir === undefined ? {} : { commonDir: this.commonDir }),
        mainSessionFile,
        owners: [],
      };
      await writeArtifact(this.paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
      this.#manifest = manifest;
    });
  }

  async addOwner(binding: OwnerBinding): Promise<void> {
    const parsed = parseOwner(binding);
    return this.#enqueue(async () => {
      const manifest = this.#manifest;
      if (!manifest) throw new Error("Project must be initialized before adding owners");
      if (manifest.owners.some((owner) => owner.id === parsed.id)) {
        throw new Error(`Owner "${parsed.id}" is already bound to this project`);
      }
      this.#validateBindingPaths(parsed, manifest.mainSessionFile);
      await this.#assertEntriesUnoccupied(parsed);
      await this.#validateOwner(parsed);
      const next = { ...manifest, owners: [...manifest.owners, parsed] };
      await writeArtifact(this.paths.manifest, `${JSON.stringify(next, null, 2)}\n`);
      this.#manifest = next;
    });
  }

  /**
   * Workspace entries are exclusive across owners and never land on
   * harness-managed directories. This is a resource-conflict guard, not a
   * path sandbox: entries may point anywhere on disk.
   */
  async #assertEntriesUnoccupied(binding: OwnerBinding): Promise<void> {
    const reserved = new Set(
      await Promise.all([this.paths.main, this.paths.shared].map((dir) => fs.realpath(dir))),
    );
    const occupied = new Set<string>();
    for (const owner of this.#manifest?.owners ?? []) {
      for (const entry of owner.entries) occupied.add(await fs.realpath(entry.path));
    }
    for (const entry of binding.entries) {
      const resolved = await fs.realpath(entry.path);
      if (reserved.has(resolved)) {
        throw new Error(`Workspace entry is reserved by project-harness: ${entry.path}`);
      }
      if (occupied.has(resolved)) {
        throw new Error(
          `Owner "${binding.id}" workspace entry is already occupied by another owner: ${entry.path}`,
        );
      }
    }
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#lease.release();
  }
}
