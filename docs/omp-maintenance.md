# Maintaining the omp dependency

`omp.lock.json` pins the full fork checkout, its upstream base, the Bun
version, and the content hash of native build inputs. Harness dependencies
remain Bun links because the SDK imports workspace packages directly. All six
links must resolve to one checkout.

## Reproduce the pinned checkout

1. Clone the repository URL recorded in `omp.lock.json` and check out its full
   `commit` SHA.
2. Run `bun install --frozen-lockfile` in the checkout using the pinned Bun
   version, then build the matching native addon with `bun run build:native`.
   Build before registering/linking packages: the native VCS package is loaded
   while the harness scripts start.
3. Register the six linked packages from that checkout: coding-agent, natives,
   tui, utils, ai, and catalog. Run `bun link` in each package directory, then
   `bun link @oh-my-pi/pi-coding-agent` (and the corresponding package names)
   from the harness directory.
4. Run `bun install --frozen-lockfile` in the harness.
5. Run `bun scripts/record-native.ts` in the harness. It rebuilds the native
   addon, starts a fresh Bun process to confirm the rebuilt artifact loads,
   then records its SHA256 and build provenance in the checkout's Git metadata
   directory. The record cannot be written before a successful build and load.
It records the source checkout SHA, native input hash, and artifact hash as
local provenance metadata. Verification confirms that the source SHA exists
and that the current inputs and loaded artifact match the record; it is
best-effort traceability, not a cryptographic proof that the source commit
produced the binary.
6. Run `bun run verify:omp`, `bun run check`, `bun test`, and
   `bun run test:integration`.

## Verify

`verify:omp` checks the exact Bun version, full Git SHA, clean checkout, origin
URL, real paths of all six links, native source input hash, and the loaded
native addon's recorded provenance and SHA256. Provenance identifies a source
commit present in the checkout and matching native inputs, but the local
record does not prove the historical build used that exact commit. A local
uncommitted development checkout can be used for ordinary harness work, but
cannot satisfy the pin verification.

## Fork branches and remotes

Keep these branch roles distinct:

| Branch | Role |
| --- | --- |
| `upstream/main` or a selected upstream tag | Read-only official reference |
| fork `main` | Initial upstream snapshot; not the routine maintenance target |
| fork `harness-runtime` | Validated SDK changes used by the harness |
| `topic/<change>` | One focused SDK change |
| `sync/<date>-<shortSha>` | Candidate that merges a selected upstream revision |
| harness `runtime-core` / upgrade branch | Harness runtime and reviewed pin updates |

Configure `upstream` to the official `can1357/oh-my-pi` repository and `origin`
to the fork URL stored in `omp.lock.json`. Confirm both URLs before syncing.
Public history advances through ordinary merge or fast-forward commits. Never
rebase or force-push shared maintenance branches. Keep inherited upstream
workflow files as `.yml.upstream`/`.yaml.upstream` so GitHub does not execute
them; the fork should have only its verify-only workflow enabled.

## Upgrade the fork

Choose and review a full upstream commit, sync it into the Mico-rstar fork, and
build/test the candidate checkout.

1. Read the current pin and both repository states. Select a full upstream
   commit and review changes to SDK sessions, IRC, task execution, settings,
   workers, session formats, native code, lockfiles, and workflows.
2. Create an isolated `sync/<date>-<shortSha>` worktree from
   `harness-runtime`, then merge the selected upstream commit. Resolve ordinary
   conflicts and keep inherited upstream workflows disabled.
3. Use a separate Bun link registry (`BUN_INSTALL` pointed at a temporary
   directory) for the candidate. Invoke Bun by its absolute executable path;
   do not replace `HOME` or the user's global omp installation. Frozen install
   the complete monorepo. If `nativeInputHash` changes, build the native addon
   from candidate sources before linking the six packages. Otherwise, reuse
   only a same-platform artifact whose recorded input and addon hashes verify.
4. Run the fork and harness verification described below, including integration
   and recovery tests on a copy of session data. Record candidate SHA, selected
   upstream SHA, toolchain, native provenance, and test results. A failed
   candidate does not change the stable branch, links, or pin.
5. After both repositories pass, push the validated omp candidate to `origin`
   first. Confirm that the full SHA is readable from the fork. Only then update
   the harness pin/compatibility notes, run `verify:omp` and harness tests, and
   push the harness candidate for review. Promotion/push authorization is
   specific to the upgrade at hand.
6. Stop processes using the old checkout before switching links or native
   artifacts. Confirm all six resolved paths point at the selected checkout.

The maintenance branch advances through public merge commits, never rewritten
history. Do not automatically fetch, checkout, install, link, or change
dependencies when launching the `project` command.

## Verification and CI

The fork verify-only workflow runs for pushes to `harness-runtime`, pull
requests targeting that branch, and manual verification. It uses a public
runner, exact Bun version, and read-only repository permission. It has no
release/publish credentials and runs no release or publish steps. The initial
supported native baseline is macOS arm64; Linux source builds in CI do not
claim support for every platform.

Fork CI checks include frozen installation, native source build,
`bun run --filter './packages/*' --sequential --if-present check:types`,
formatting/lint for changed SDK files, IRC/host contract
tests, and `bun run ci:test:smoke`. Initial baseline and upstream upgrades also
run `bun run check:ts` and `bun run ci:test:ts`; known upstream failures must
be recorded explicitly before a candidate can be called fully validated.
When Rust native inputs change, run
`CI=1 bun run check:rs` and `CI=1 bun run test:rs`; the CI setting ensures
committed Rust changes are not skipped by local dirty-worktree shortcuts.

Harness checks include `bun run verify:omp`, `bun run check`, `bun test`,
`bun run test:integration`, and a real PTY start/exit/recovery pass. Allow at
least 25 seconds for SDK initialization and manifest persistence before
stopping the process. Do not use `bun setup` as an upgrade check: it registers
a global CLI and does not provide the frozen install boundary.

Use an isolated session-data copy for recovery tests. Do not have fork CI
fetch a floating harness branch or rely on stale native artifacts from
unrelated CI runs.

Record verification results in the runtime or dependency-update PR and link
the relevant CI runs. Track unresolved failures in GitHub issues. On each
upgrade, compare existing failures explicitly and distinguish scoped CI
success from full-suite success.

## Rollback

Keep the previous known-good harness SHA, omp SHA, pin, lockfiles, toolchain,
and native input/artifact hashes. Before an upgrade, back up the project
manifest, sessions, artifacts, and observations. Native/session migrations
can rewrite persisted data, and older SDK code may not read the new format.

To roll back, stop the running process, restore the previous harness and omp
SHAs, pin, six links, and matching native artifact together. Do not hot-switch
dependencies or reset a user's worktree. If a migration has occurred, restore
the pre-upgrade backup to a separate path and verify it before opening it with
the old SDK; retain any records written after migration for later recovery.
Preserve public history through revert or follow-up commits; never force-push.
If the data change cannot be safely reversed, stop and resolve the data
recovery path before downgrading.

