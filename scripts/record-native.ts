import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { nativeAddonStatus } from "@oh-my-pi/pi-natives/loader-state";
import { nativeInputHash, recordNativeProvenance, type OmpPin } from "./native-provenance";

const harnessRoot = path.resolve(import.meta.dir, "..");
const pin = (await Bun.file(path.join(harnessRoot, "omp.lock.json")).json()) as OmpPin;
const ompRoot = vcs
  .git(path.dirname(fileURLToPath(import.meta.resolve("@oh-my-pi/pi-natives"))))
  ?.primaryRoot();
if (!ompRoot) throw new Error("Cannot locate the linked omp Git checkout");
if ((await nativeInputHash(ompRoot)) !== pin.nativeInputHash)
  throw new Error("Native inputs do not match omp.lock.json");
if (process.argv.includes("--record-only")) {
  const addon = nativeAddonStatus();
  if (!addon) throw new Error("No native addon is loaded after the successful build");
  if (addon.stale)
    throw new Error(`Loaded native addon version ${addon.version ?? "(unknown)"} is stale`);
  const repo = vcs.requireGit(ompRoot);
  if (await repo.isDirty())
    throw new Error("Cannot record native provenance from a dirty checkout");
  const head = await repo.headSha();
  if (head !== pin.commit)
    throw new Error(`Loaded omp checkout ${head ?? "(no HEAD)"} does not match pin ${pin.commit}`);
  const record = await recordNativeProvenance(ompRoot, addon.path, pin);
  process.stdout.write(`Recorded native provenance: ${record.addonSha256}\n`);
} else {
  const build = await $`bun run build:native`.cwd(ompRoot).quiet().nothrow();
  if (build.exitCode !== 0)
    throw new Error(`bun run build:native failed: ${build.stderr.toString()}`);
  const child = Bun.spawn(["bun", import.meta.path, "--record-only"], {
    cwd: harnessRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Native provenance recording failed (${exitCode})`);
}
