import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  nativeInputHash,
  validateNativeProvenance,
  type OmpPin,
} from "../scripts/native-provenance";
import { assertPackageCheckouts, assertPinnedCommit, validatePin } from "../scripts/verify-omp";

describe("nativeInputHash", () => {
  test("changes when Rust/build inputs change and ignores the built addon", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-native-hash-"));
    try {
      await fs.mkdir(path.join(root, "crates/pi-natives"), { recursive: true });
      await fs.mkdir(path.join(root, "packages/natives/native"), { recursive: true });
      await fs.mkdir(path.join(root, "packages/natives/src"), { recursive: true });
      await fs.mkdir(path.join(root, "packages/natives/scripts"), { recursive: true });
      await fs.mkdir(path.join(root, ".cargo"), { recursive: true });
      for (const [file, value] of Object.entries({
        "Cargo.toml": "workspace",
        "Cargo.lock": "lock-v1",
        "rust-toolchain.toml": "stable",
        ".cargo/config.toml": "config",
        "scripts/bazel-natives.ts": "build",
        "packages/natives/package.json": "{}",
        "packages/natives/native/index.js": "loader",
        "crates/pi-natives/src.rs": "native-v1",
      })) {
        const target = path.join(root, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await Bun.write(target, value);
      }
      const initial = await nativeInputHash(root);
      await Bun.write(path.join(root, "packages/natives/native/addon.node"), "binary-v1");
      expect(await nativeInputHash(root)).toBe(initial);
      await Bun.write(path.join(root, "crates/pi-natives/src.rs"), "native-v2");
      expect(await nativeInputHash(root)).not.toBe(initial);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("validateNativeProvenance", () => {
  test("accepts a prior build when its native inputs and artifact still match", () => {
    const pin: OmpPin = {
      schemaVersion: 1,
      repository: "https://github.com/Mico-rstar/oh-my-pi.git",
      commit: "b".repeat(40),
      upstreamCommit: "a".repeat(40),
      bunVersion: "1.4.3",
      nativeInputHash: "c".repeat(64),
    };
    const record = {
      schemaVersion: 1,
      repository: pin.repository,
      commit: "d".repeat(40),
      nativeInputHash: pin.nativeInputHash,
      rustToolchain: 'channel = "stable"',
      platform: "darwin",
      arch: "arm64",
      addonPath: "/tmp/pi_natives.node",
      addonSha256: "e".repeat(64),
    };
    expect(
      validateNativeProvenance(record, {
        pin,
        addonPath: record.addonPath,
        platform: record.platform,
        arch: record.arch,
      }).commit,
    ).toBe(record.commit);
    expect(() =>
      validateNativeProvenance(
        { ...record, nativeInputHash: "f".repeat(64) },
        {
          pin,
          addonPath: record.addonPath,
          platform: record.platform,
          arch: record.arch,
        },
      ),
    ).toThrow("does not match");
  });
});

describe("OMP pin and checkout validation", () => {
  test("rejects an incorrect SHA and package links from separate checkouts", () => {
    const pin = validatePin({
      schemaVersion: 1,
      repository: "https://github.com/example/oh-my-pi.git",
      commit: "b".repeat(40),
      upstreamCommit: "a".repeat(40),
      bunVersion: Bun.version,
      nativeInputHash: "c".repeat(64),
    });
    expect(() => assertPinnedCommit("d".repeat(40), pin)).toThrow("does not match");
    expect(() =>
      assertPackageCheckouts([
        { name: "@oh-my-pi/pi-utils", root: "/tmp/omp-one" },
        { name: "@oh-my-pi/pi-tui", root: "/tmp/omp-two" },
      ]),
    ).toThrow("different checkouts");
    expect(() =>
      validatePin({
        schemaVersion: 1,
        repository: "file:///tmp/fork",
        commit: "b".repeat(40),
        upstreamCommit: "a".repeat(40),
        bunVersion: Bun.version,
        nativeInputHash: "c".repeat(64),
      }),
    ).toThrow("invalid schema");
  });
});
