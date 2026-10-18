import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

export interface OmpPin {
  schemaVersion: 1;
  repository: string;
  commit: string;
  upstreamCommit: string;
  bunVersion: string;
  nativeInputHash: string;
}

export interface NativeProvenance {
  schemaVersion: 1;
  repository: string;
  commit: string;
  nativeInputHash: string;
  rustToolchain: string;
  platform: string;
  arch: string;
  addonPath: string;
  addonSha256: string;
}

export function nativeProvenancePath(root: string): string {
  const repo = vcs.requireGit(root);
  return path.join(repo.info().gitDir, `omp-native-${process.platform}-${process.arch}.json`);
}

const NATIVE_INPUTS = [
  "Cargo.toml",
  "Cargo.lock",
  "bun.lock",
  "rust-toolchain.toml",
  "rustfmt.toml",
  ".cargo",
  ".bazelrc",
  ".bazelversion",
  ".bazelignore",
  "BUILD.bazel",
  "MODULE.bazel",
  "MODULE.bazel.lock",
  "WORKSPACE.bazel",
  "bazel",
  "scripts",
  "crates",
  "packages/natives/BUILD.bazel",
  "packages/natives/scripts",
  "packages/natives/src",
  "packages/natives/native",
  "packages/natives/package.json",
];

const EXCLUDED_DIRS = new Set(["target", "bazel-out", "node_modules", ".git", "npm"]);
const GENERATED_NATIVE_FILES = new Set([
  "packages/natives/native/index.js",
  "packages/natives/native/index.d.ts",
]);

export async function hashFile(filePath: string): Promise<string> {
  return new Bun.CryptoHasher("sha256")
    .update(new Uint8Array(await Bun.file(filePath).arrayBuffer()))
    .digest("hex");
}

async function collectFiles(root: string, relative: string): Promise<string[]> {
  const absolute = path.join(root, relative);
  const info = await fs.stat(absolute).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return [];
  if (info.isFile()) return [relative];
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => !EXCLUDED_DIRS.has(entry.name))
      .map((entry) => collectFiles(root, path.join(relative, entry.name))),
  );
  return nested.flat();
}

export async function nativeInputHash(root: string): Promise<string> {
  const fileNames = (await Promise.all(NATIVE_INPUTS.map((entry) => collectFiles(root, entry))))
    .flat()
    .filter(
      (file) =>
        !file.endsWith(".node") && !file.endsWith(".dylib") && !GENERATED_NATIVE_FILES.has(file),
    )
    .sort();
  const hash = new Bun.CryptoHasher("sha256");
  for (const file of fileNames) {
    hash
      .update(file)
      .update("\0")
      .update(new Uint8Array(await Bun.file(path.join(root, file)).arrayBuffer()))
      .update("\0");
  }
  return hash.digest("hex");
}

export function validateNativeProvenance(
  value: unknown,
  expected: { pin: OmpPin; addonPath: string; platform: string; arch: string },
): NativeProvenance {
  if (typeof value !== "object" || value === null)
    throw new Error("Native provenance must be an object");
  const record = value as Partial<NativeProvenance>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.repository !== "string" ||
    typeof record.commit !== "string" ||
    !/^[0-9a-f]{40,64}$/i.test(record.commit) ||
    typeof record.nativeInputHash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(record.nativeInputHash) ||
    typeof record.rustToolchain !== "string" ||
    typeof record.platform !== "string" ||
    typeof record.arch !== "string" ||
    typeof record.addonPath !== "string" ||
    typeof record.addonSha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(record.addonSha256)
  ) {
    throw new Error("Native provenance has an invalid schema");
  }
  if (
    record.repository !== expected.pin.repository ||
    record.nativeInputHash !== expected.pin.nativeInputHash ||
    record.platform !== expected.platform ||
    record.arch !== expected.arch ||
    path.resolve(record.addonPath) !== path.resolve(expected.addonPath)
  ) {
    throw new Error("Native provenance does not match this pin and loaded addon");
  }
  return record as NativeProvenance;
}

export async function recordNativeProvenance(
  root: string,
  addonPath: string,
  pin: OmpPin,
): Promise<NativeProvenance> {
  const provenance: NativeProvenance = {
    schemaVersion: 1,
    repository: pin.repository,
    commit: pin.commit,
    nativeInputHash: pin.nativeInputHash,
    rustToolchain: (await Bun.file(path.join(root, "rust-toolchain.toml")).text()).trim(),
    platform: process.platform,
    arch: process.arch,
    addonPath: path.resolve(addonPath),
    addonSha256: await hashFile(addonPath),
  };
  const outputPath = nativeProvenancePath(root);
  await Bun.write(outputPath, `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}
