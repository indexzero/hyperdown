# OKF-P3 — @auto-okf/faces (T5) result report

**Status:** DONE. Branch `12/okf-faces` (off `11/okf-store`); PR
[#23](https://github.com/indexzero/hyperwiki2/pull/23) open, base
`11/okf-store`, **not merged**. Full repo suite **210/210 green** (191
existing + 19 new faces). Clean `pnpm install --frozen-lockfile`.

## What was built (SPEC §9)

`okf/faces` (`@auto-okf/faces`), on top of the unmodified
`@auto-okf/{core,store}` interfaces:

- **`lib/materialize.js`** — `materialize(vault, dir, opts)`: byte-deterministic
  OKF v0.1 bundle. One `.md` per live concept at its path; frontmatter §6
  order (`_id`, `_rev`, `type`, then canonically sorted); body = head
  revision; tombstones suppressed. Conflicted copies at deterministic
  `<path>.conflict-<hex8>` (§7, reserved + round-trippable, per-value hash
  extension). Derived per-directory `index.md` (OKF §6) and root `log.md`
  (OKF §7, projected from `log/` + op `at`). Atomic temp+fsync+rename,
  lexical+realpath containment, per-path locks. **N3**: emission-manifest
  reconciliation — never deletes/overwrites a file it did not
  materialize-and-track; human files left and surfaced as `pendingIngest`;
  `forceMirror` overrides.
- **`lib/ingest.js`** — `createIngestWatcher(vault, dir, opts)`: minimal-op
  emission. Per-key frontmatter diff (`SetField`/`AddTag`/`RemTag`), body
  diff citing the file `_rev`, §6 `_id` rules (rename→`SetPath`, missing→mint,
  unknown→adopt, copy detection), conflict-suffix strip, `DeleteConcept`
  behind a default-on confirmation guard. Links → apply's extractor →
  `wanted/`. `index.md`/`log.md` reserved.
- **`lib/wanted.js`** — `wanted(vault)`: ranked `[{path, count, referrers}]`
  from `wanted/` + `wantedrank/`.
- **`lib/view.js`** — pure view→model projection (+ `memViewReader` adapter).
- **`lib/yaml.js`** — hand-rolled canonical YAML emitter (I9); `yaml` package
  parse-only for ingest.
- **`lib/fsatomic.js`** — atomic writes, containment, per-path locks,
  `.okf-manifest.json`.
- **`README.md`** (usage-first) and **`index.js`** barrel.

## Invariants covered

| Invariant | Test |
| --- | --- |
| **I9** face determinism | identical bytes across two runs, a replicated peer, and a from-scratch rebuild |
| **I3** rebuild equivalence | reopened-from-disk view materializes identically |
| **I4** no silent loss | unresolved links → `wanted/` demand, ranked, not a flag |
| **N3** deletion is dangerous | hand-authored `.md` never deleted/overwritten (×2); conflict-copy delete is a no-op |
| §7 collisions | conflict-copy round-trip: loser materializes and re-ingests to a no-op |
| §9 ingest minimality | one field edit → exactly one op; one body edit → one `SetBody` citing `_rev` |
| §9 merge | rename + concurrent edit merges across the round-trip (partition/heal) |

## OKF conformance approach

`okf/test/okf-conformance.js` is an **independent** OKF v0.1 checker written
from scratch against the OKF spec, using the `yaml` package **parse-only** —
it never imports the faces emitter, so an emitter bug cannot mask itself. It
enforces the three OKF §9 rules: parseable frontmatter on every non-reserved
`.md`, a non-empty `type`, and OKF §6/§7 structure for `index.md`/`log.md`.
Every emitted bundle in the suite passes it.

## Test counts

- **19** new faces tests, all on **real** `@auto-okf/store` vaults (autobee +
  corestore on disk, no stubs): `faces-materialize.test.js` (8),
  `faces-ingest.test.js` (6), `faces-preservation.test.js` (5).
- Full repo suite: **210 pass / 0 fail** (`node --test "test/*.test.js"
  "okf/test/*.test.js"`), 191 pre-existing untouched.
- Scratch under `sslop/031/tmp/` (unique per run, handles closed, never
  deleted).

Raw tail:

```
ℹ tests 210
ℹ suites 0
ℹ pass 210
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 17516.966833
```

## Deviations (DEVIATIONS.md)

Per-value conflict-hash extension (order-independent); `flag/copydetect` not
emitted (no core op writes it; core imported unmodified); minted `_id`
write-back deferred to the next materialize (manifest coordination, no echo);
materialize path-safety violations reported in `report.unsafe`, never
view-written; conflicted-copy face deletion is a no-op (transient face).

## Scope notes

Compaction (§10 `compact` command) is out of the five assigned scope items;
its dependencies (`_id` adoption, conflict-copy round-trip, deterministic
conflict paths) are built and tested here. `core`/`store` internals,
`vault-ld/*`, `prompts/`, and other branches untouched; only this report was
added under `orchestration/`.
