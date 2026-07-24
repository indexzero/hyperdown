# OKF-P5 — @auto-okf/cli (T7)

**Branch:** `14/okf-cli` (off `13/okf-compact`) · **PR:** #25 (base
`13/okf-compact`, title "feat(okf): @auto-okf/cli (T7)") · **Status:** DONE,
DO NOT MERGE.

## Deliverable

`okf/cli` — the `@auto-okf/cli` package: binary `auto-okf`
(`okf/cli/bin/auto-okf.js` → `lib/run.js`), a thin veneer over
`@auto-okf/{core,store,faces}` per okf SPEC §13. No autobase, no
`@autovault-ld` imports; core/store/faces internals untouched.

Files:
- `okf/cli/package.json` — `@auto-okf/cli`, `bin.auto-okf`, workspace deps on
  core/store/faces + b4a.
- `okf/cli/bin/auto-okf.js` — entry; sets `process.exitCode`.
- `okf/cli/lib/run.js` — command dispatch + all 12 commands.
- `okf/cli/README.md` — usage-first (working example first, then install,
  per-command reference, exit codes, tests, Apache-2.0).
- `okf/test/cli.test.js` — 9 smoke tests spawning the real bin.

## Commands (SPEC §13)

init, join, add-writer `[--indexer]`, remove-writer, materialize
`[--force-mirror]`, ingest `[--confirm-deletes]`, watch
`[--swarm] [--confirm-deletes] [--debounce]`, wanted `[--json]`, flags
`[family] [--json]`, compact `[--force] [--face]`, resolve
`--keep [--supersede… --text]`, undelete. Top-level + per-command `--help`.
Exit codes: 0 success, 1 operational error, 2 usage. No daemon (watch is a
foreground watcher, SIGINT/SIGTERM clean shutdown).

## Verification

- `pnpm install` clean (lockfile only gains the `okf/cli` entry; no drift).
- Full repo suite green: **225 pass, 0 fail** (216 existing + 9 new CLI).

Raw tail (`pnpm test`):
```
ℹ tests 225
ℹ suites 0
ℹ pass 225
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 20639.034292
```

Test coverage (each asserts exit code + output): help/usage exit codes; init
pins + refuses re-init; unpinned-storage guidance; ingest a hand-authored
file → materialize round-trips `_id`/`_rev` (produces the bundle incl.
`index.md`/`log.md`); `wanted` lists an unresolved link (ranked);
add-writer/remove-writer round trip; `flags` lists a seeded conflict,
`compact` refuses on it and succeeds after `resolve`; `undelete` restores a
tombstone; `watch` ingests a foreground edit and exits on SIGINT. Scratch
under `sslop/034/tmp` (unique dirs, handles closed, never deleted).

## Assumptions

Posted as a PR comment (#25). Key ones: `compact <dir> <out-dir>` maps
`<out-dir>` to the fresh epoch vault with the hydrated face at `<out-dir>.face`
(`--face` overrides); no content-write command (content enters via
ingest/store API, so conflict/tombstone fixtures seed through `@auto-okf/store`
in-test); `materialize` exits non-zero on pending-ingest (N3); an unadmitted
peer's governance op fails with the store's `Not writable` (still exit 1);
conflicts seeded single-writer via the §5 unknown-base rule.
