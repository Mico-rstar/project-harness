# Runtime baseline verification

Verified locally on macOS arm64 with Bun 1.4.3.

## Revisions

- Official omp base: `3f000c524cf82279f804ffd7526280cc9a5f25fe`.
- Fork candidate: `cd6e35d1f9fab094e853899df8698cf3a51eff21`.
- Harness launch/recovery baseline: `fb7c72e72996b693302d73c63cb2eec43210314c`.
- Runtime and dependency changes are on harness branch `runtime-core`.

The candidate passes the focused runtime/IRC checks below. It is **not a
fully passing upstream baseline**: the full omp suite and root lint gate have
the recorded failures below. Future upgrades must retain this distinction.

## Passing local checks

- Harness `bun run check`, full `bun test`, and `bun run test:integration`.
- `bun run example:runtime`: finite, headless production runtime with a
  deterministic provider, input receipts, and explicit close.
- `bun run verify:omp`: exact source pin, clean omp checkout, six linked
  packages from one checkout, native input hash, and loaded addon provenance.
- omp workspace package `check:types` scripts.
- Changed omp IRC surface lint and format checks.
- omp IRC and bridge tests: 27 passed.
- omp CLI/worker smoke via `bun run ci:test:smoke`.
- Real PTY start and recovery: each ran for at least 28 seconds, displayed
  the native TUI, and exited 143 on SIGTERM. The same Main JSONL binding
  survived recovery and the project lock could be acquired afterward.

The runtime tests use the production session factory and real SDK
sessions/tools with deterministic model responses. They cover two owners,
nested task execution, first-turn observation, idle recovery without model
dispatch, and child history recovered after removing its in-memory registry
entry. Input tests cover quick receipts, duplicate IDs, changed payloads,
blocked session switching, and tool approval/denial/timeout. Cooperation-log
tests cover replay, damaged data, bounded queues, failed writes, and gaps.
These checks do not establish collaboration quality with a live model.

## Matching native build

The addon was built from the pinned checkout using Rust
`nightly-2026-08-12`, CMake 4.4.4, and Ninja 1.13.2.

- Native input hash:
  `839f2afe3a218ad0e1d5fab0718caa75f6c8b91bcc35429cdc4cc9f901bd1ce4`.
- Loaded addon SHA256:
  `d00c6b5b789bbbe263f81abf412030e37cf876ec53d7970409bca5fdc06b32b4`.
- Loader reports package/addon version 18.6.2 and `stale: false`.

Build provenance is stored in local Git metadata, not committed binaries.
The local Apple Foundation Models binding was stubbed because the required
Swift/macOS SDK was unavailable; that optional provider was not verified.

## Full omp gate limitations

`bun run ci:test:ts` completed 197 command groups: 191 passed and 6 failed.
The failing groups exercise source outside this fork's changed IRC surface:

| Group | Observed failure |
| --- | --- |
| `packages/ai` | TextJudge YAML exact spacing differs (`labels:` versus `labels: `); also reproduced in a focused run |
| queued user policy | Two assertions about interrupted, already-dequeued steer/follow-up messages; also reproduced in a focused run |
| eval/process-entry and Python | Computer worker fixture times out with native addons disabled; Python prelude schema inference assertion fails |
| BTW controller | History-sheet expectations fail |
| skillshare pack | File-count/path-length limit case exceeds its deadline |
| computer-call renderer | Expected error text omits the supported `desktop.display(id)` receiver |

Root `bun run check:ts` stops at an existing `prefer-const` violation for
`unregisterDisposal` in `packages/coding-agent/src/tools/computer.ts`.
Package type checks and the changed IRC lint/format checks pass separately.
The verify-only fork workflow runs those scoped checks and does not imply
the full upstream gates are green.

No Rust source changed. The matching native source build and native tests
included in the TypeScript suite passed; the complete Rust test gate was
not run for this IRC-only patch.
