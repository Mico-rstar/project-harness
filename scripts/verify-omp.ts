import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { nativeAddonStatus } from "@oh-my-pi/pi-natives/loader-state";
import {
  hashFile,
  nativeInputHash,
  nativeProvenancePath,
  validateNativeProvenance,
  type OmpPin,
} from "./native-provenance";

const harnessRoot = path.resolve(import.meta.dir, "..");
export function validatePin(value: unknown): OmpPin {
  if (typeof value !== "object" || value === null)
    throw new Error("omp.lock.json has an invalid schema or value");
  const pin = value as Partial<OmpPin>;
  if (
    pin.schemaVersion !== 1 ||
    typeof pin.repository !== "string" ||
    !pin.repository.startsWith("https://") ||
    typeof pin.commit !== "string" ||
    !/^[0-9a-f]{40,64}$/i.test(pin.commit) ||
    typeof pin.upstreamCommit !== "string" ||
    !/^[0-9a-f]{40,64}$/i.test(pin.upstreamCommit) ||
    typeof pin.bunVersion !== "string" ||
    typeof pin.nativeInputHash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(pin.nativeInputHash)
  ) {
    throw new Error("omp.lock.json has an invalid schema or value");
  }
  return pin as OmpPin;
}

export function assertPackageCheckouts(roots: Array<{ name: string; root: string }>): string {
  const first = roots[0];
  if (!first) throw new Error("No linked OMP packages were resolved");
  if (roots.some((item) => item.root !== first.root))
    throw new Error("OMP packages resolve from different checkouts");
  return first.root;
}

export function assertPinnedCommit(
  commit: string | null | undefined,
  pin: OmpPin,
): asserts commit is string {
  if (commit !== pin.commit)
    throw new Error(`OMP HEAD ${commit ?? "(no HEAD)"} does not match pin ${pin.commit}`);
}

const packages = [
  "@oh-my-pi/pi-coding-agent",
  "@oh-my-pi/pi-natives",
  "@oh-my-pi/pi-tui",
  "@oh-my-pi/pi-utils",
  "@oh-my-pi/pi-ai",
  "@oh-my-pi/pi-catalog",
];

export interface VerifyOmpOptions {
  harnessRoot: string;
  pin?: unknown;
  packageEntries?: Array<{ name: string; entry: string }>;
  nativeAddon?: { path: string; version: string | null; stale: boolean } | null;
}

export async function verifyOmp(options: VerifyOmpOptions): Promise<void> {
  const { harnessRoot } = options;
  const pin = validatePin(
    options.pin ?? (await Bun.file(path.join(harnessRoot, "omp.lock.json")).json()),
  );
  if (Bun.version !== pin.bunVersion)
    throw new Error(`Bun ${Bun.version} does not match pinned ${pin.bunVersion}`);

  async function findPackageRoot(entry: string, expectedName: string): Promise<string> {
    let directory = path.dirname(entry);
    for (;;) {
      const manifest = path.join(directory, "package.json");
      try {
        const info = (await Bun.file(manifest).json()) as { name?: string };
        if (info.name === expectedName) return directory;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const parent = path.dirname(directory);
      if (parent === directory)
        throw new Error(`Could not locate package root for ${expectedName}`);
      directory = parent;
    }
  }
  const entries =
    options.packageEntries ??
    packages.map((name) => ({
      name,
      entry: fileURLToPath(import.meta.resolve(name)),
    }));
  const roots = await Promise.all(
    entries.map(async ({ name, entry: inputEntry }) => {
      const entry = await fs.realpath(inputEntry);
      const packageRoot = await findPackageRoot(entry, name);
      const repo = vcs.git(packageRoot);
      if (!repo) throw new Error(`${name} is not linked from a Git checkout`);
      return { name, entry, root: await fs.realpath(repo.primaryRoot()) };
    }),
  );
  const root = assertPackageCheckouts(roots);
  const repo = vcs.requireGit(root);
  const commit = await repo.headSha();
  assertPinnedCommit(commit, pin);
  if (await repo.isDirty()) throw new Error("OMP checkout has tracked or untracked changes");
  const remote = await repo.remoteUrl("origin");
  let remoteUrl: URL;
  try {
    remoteUrl = new URL(pin.repository);
  } catch {
    throw new Error("Pinned OMP repository must be a valid HTTPS URL");
  }
  if (remoteUrl.protocol !== "https:" || remote !== pin.repository) {
    throw new Error(`OMP origin ${remote ?? "(missing)"} does not match pinned HTTPS repository`);
  }

  const computedInputHash = await nativeInputHash(root);
  if (computedInputHash !== pin.nativeInputHash)
    throw new Error("Native build inputs do not match omp.lock.json");
  const addon = options.nativeAddon === undefined ? nativeAddonStatus() : options.nativeAddon;
  if (!addon) throw new Error("No native addon is loaded");
  if (addon.stale)
    throw new Error(`Loaded native addon version ${addon.version ?? "(unknown)"} is stale`);
  const provenancePath = nativeProvenancePath(root);
  const provenance = validateNativeProvenance(await Bun.file(provenancePath).json(), {
    pin,
    addonPath: addon.path,
    platform: process.platform,
    arch: process.arch,
  });
  if (!(await repo.resolveRef(provenance.commit))) {
    throw new Error(
      `Native provenance source commit ${provenance.commit} is not present in this checkout`,
    );
  }
  if ((await hashFile(addon.path)) !== provenance.addonSha256)
    throw new Error("Loaded native addon hash does not match provenance");
  if (!(await fs.stat(addon.path)).isFile())
    throw new Error("Loaded native addon path is not a file");
  return;
}

if (import.meta.main) {
  await verifyOmp({ harnessRoot });
  process.stdout.write("OMP pin verified.\n");
}
