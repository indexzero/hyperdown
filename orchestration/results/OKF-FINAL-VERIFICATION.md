# auto-okf — Independent FINAL Verification (SPEC-FINAL v1.2 §14)

**Verifier:** independent subagent, no prior context.
**Source:** clean clone of `git@github.com:indexzero/hyperwiki2.git` branch
`17/okf-review`, tip `ff6f193` ("docs(okf): T10 gate G4-PASS …").
**Clone path:** `/Users/cjr/Git/indexzero/hyperwiki2/sslop/038/clone`
**Toolchain:** pnpm 10.34.0, node v24.16.0 (engines require >=20).
**Date:** 2026-07-14.

All evidence below is raw command output produced by THIS verification run
against the clone — not repo docs.

---

## Step 1 — Clean clone
`git clone --branch 17/okf-review … clone` → succeeded.
HEAD `ff6f1935995d8cdcac7652f085b821c99476bd40`.

## Step 2 — pnpm install
```
Scope: all 13 workspace projects
Lockfile is up to date, resolution step is skipped
Packages: +106 … added 106, done
Done in 503ms using pnpm v10.34.0
```
Clean install, lockfile up to date, no build/postinstall errors.

## Step 3 — Full unit suite (`pnpm test`)
```
ℹ tests 234
ℹ pass 234
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 22820.5
```
**234 tests, 234 pass, 0 fail — matches the expected 234.**
This run covers `test/*`, `okf/test/*`, and both regression dirs, including
invariant tests i01–i08, i10, i11 (I9 = byte-identical regen, exercised by
the example + harness suites).

## Step 4 — Harness matrix, ALL profiles (okf harness)
Each profile ran `--test-concurrency=1` over `okf/harness/scenarios/*`.
Raw counts + process exits:

| Profile | tests | pass | fail | exit | divergent view hash |
|---|---|---|---|---|---|
| clean       | 12 | 12 | 0 | 0 | none |
| lossy       | 12 | 12 | 0 | 0 | none |
| partitioned | 12 | 12 | 0 | 0 | none |
| fuzz (`:fuzz`, HARNESS_FUZZ_ITERS=10) | 1 | 1 | 0 | 0 | none |

- Dedicated fuzz job ran **10 iterations** (`[fuzz] iter=` counted 10);
  partitioned profile additionally exercised the embedded fuzz scenario
  (3 iters). Scenarios present: s01-lww, s02-orset, s03-wanted, s04-body,
  s05-rename-edit, s06-rename-rename, s07-collision, s08-revocation,
  s09-epoch (+ fuzz + additional = 12 total).
- Grep across all four logs for `divergen|mismatch|not ok|Error|assert`
  returned **zero hits**. No divergent view hash under any seed.

## Step 5 — Three examples regenerate byte-identically + valid OKF
`node --test okf/test/example-{agent-session,slop-archive,vlurp-library}.test.js`:
```
✔ agent-session regenerates the committed out/ byte-identically (I9) and is OKF-conformant
✔ slop-archive regenerates the committed out/ byte-identically (I9) and is OKF-conformant
✔ vlurp-library regenerates the committed out/ byte-identically (I9), offline, OKF-conformant
ℹ tests 3  pass 3  fail 0
```
Spot-check of `agent-session/out` bundle (my own parse, not the emitter):
- `index.md` + `log.md` present at root (`existsSync` → true/true).
- YAML frontmatter parses on every `.md` (yaml package, parse-only; no throw).
- **6/6** content docs carry `_id` + `_rev` + `type`
  (e.g. `determinations/adopt-lru.md`: `_id`=75e825…, `_rev`=dfc268…,
  `type: determination`). Reserved `index.md`/`log.md` correctly carry no
  content frontmatter.

## Step 6 — Epoch cycle (I11)
`node --test okf/test/i11-roundtrip.test.js`:
```
✔ I11: an epoch cycle round-trips a non-trivial bundle (state + identity fidelity)
✔ I11 guardrail: compact refuses an undrained conflict without force, proceeds with it
✔ I11: a second epoch cycle (epoch chain of length 2) still round-trips
✔ I11: --force carries a path-collision conflict copy across the epoch (old path -> new path)
ℹ tests 4  pass 4  fail 0
```
A non-trivial bundle round-trips an epoch with byte + identity fidelity
(modulo `_rev` + regenerated `log.md`, per §14), including a drained
conflict-copy carried across the epoch.

## Step 7 — Independent OKF v0.1 conformance
`okf/test/okf-conformance.js` is a from-scratch, parse-only checker that does
NOT import the faces emitter/parser. Run directly against each materialized
bundle:
```
agent-session ok=true violations=0
slop-archive  ok=true violations=0
vlurp-library ok=true violations=0
```
**Zero conformance errors** on all three emitted bundles.

## Step 8 — wanted/ ranked demand index (flagship)
Ran flagship `okf/examples/agent-session/session.js` directly:
```
[all  ] the graph WANTS unwritten concepts: determinations/sharding (1 ref) (wanted/, §9 — never a flag)
```
An unwritten concept (`determinations/sharding`) appears in the ranked
`wanted/` demand index with its referrer count (1 ref). Implementation
`okf/faces/lib/wanted.js` ranks by referrer count via the `wantedrank/`
index (inv-count = MAX − count, ascending scan = most-wanted first),
tie-broken by path byte order — confirming ranking is by referrer count.

---

## SPEC-FINAL §14 acceptance — per-item verdict (my evidence)

| # | §14 acceptance item | Evidence | Verdict |
|---|---|---|---|
| 1 | I1..I11 each pass | Step 3: 234/234, incl. i01–i08/i10/i11 files; I9 via example+harness suites | PASS |
| 2 | Harness matrix green at clean/lossy/partitioned | Step 4: 12/12 × 3 profiles, exits 0, no divergence | PASS |
| 3 | Epoch cycle round-trips non-trivial bundle, identity+byte fidelity (mod `_rev`+`log.md`), incl. drained conflict | Step 6: i11 4/4, incl. force conflict-copy carry | PASS |
| 4 | All three examples run from committed scripts, regenerate committed out/ byte-identically | Step 5: 3/3 example tests | PASS |
| 5 | Every emitted bundle passes independent OKF v0.1 conformance (frontmatter parses, `type` present, reserved files per §6/§7) | Step 7: 0 violations × 3 bundles (independent checker) | PASS |
| 6 | `wanted/` ranks unwritten concepts by referrer count in flagship | Step 8: flagship emits `determinations/sharding (1 ref)`; wanted.js ranks by count | PASS |

Every §14 acceptance item is satisfied by first-hand evidence from the clone.

## VERDICT: FINAL-PASS
