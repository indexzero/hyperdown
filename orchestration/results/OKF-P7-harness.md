# OKF-P7 — multi-process fault harness + scenario matrix (T9)

**Branch:** `16/okf-harness` (off `15/okf-examples`)
**Scope:** `okf/harness/` — retarget the vault-ld fault-injection harness to
auto-okf and run the okf scenario matrix at three fault profiles + fuzz.

## Headline: NO DIVERGENCE FOUND — determinism holds under every seed and profile

Across the full matrix at **clean / lossy / partitioned** and a
**10-iteration seeded fuzz** (3–7 writers, malformed ops, oversized paths,
unknown op types, garbage bases, adversarial `_id` mint attempts, random
partitions), **every peer converged to a bit-identical view hash after every
heal, and the independent I8 coherence check passed after every heal.** No
blocker, no committed regression repro. In particular **S8 (the revocation
race that was the vault-ld blocker B1) converges and is replay-stable** —
auto-okf's causal, in-band, never-positional revocation (`host.removeWriter`
never called) does not reproduce the vault-ld divergence.

## Matrix results (each scenario × profile: PASS + seed)

Node 20+/24, `--test-concurrency=1`, one OS process per writer, replication
piped through the fault proxy. Every scenario partitions → writes
concurrently → heals → asserts convergence + coherence.

### clean (0ms links) — 12/12 PASS

```
✔ S1  s01-lww             concurrent same-key SetField → 1 winner + flag/clobber; permutation replay
✔ S2  s02-orset           SU-set: concurrent add beats remove-of-unobserved; staletag audit
✔ S3  s03-wanted          link + late create → wanted/ clears; both heal orders (permutation replay)
✔ S4  s04-body-conflict   same-base siblings retained, 1 flag/conflict; ResolveConflict drains
✔ S5  s05-rename-edit     rename + concurrent edit merge — edit follows the concept, no ghost
✔ S6  s06-rename-rename   concurrent rename → linearization winner; loser flag/clobber; replay
✔ S7  s07-path-collision  two ids one path → conflict copy + byte-identical faces across peers
✔ S8  s08-revocation      revocation race → converge + replay-stable applied/rejected partition
✔ S9  s09-epoch           epoch cycle → identity/state preserved; fresh peer converges identically
✔ S10 s10-fuzz x3         convergence + independent I8 after every heal
✔ smoke                   two writers converge through the proxy + coherence
✔ fuzz-shrink             shrink → minimal repro → saveRegression round-trip (in-proc)
ℹ tests 12  ℹ pass 12  ℹ fail 0
```

### lossy (200ms ±150ms jitter, 5% stalls) — 12/12 PASS

```
✔ S1..S10 + smoke + fuzz-shrink  (quiesce budget ×4; S10 fuzz ~60s)
ℹ tests 12  ℹ pass 12  ℹ fail 0
```

### partitioned (write-during-partition, heal-after) — 12/12 PASS

```
✔ S1..S10 + smoke + fuzz-shrink
ℹ tests 12  ℹ pass 12  ℹ fail 0
```

### fuzz (dedicated 10-iteration run, reproducible `HARNESS_SEED=1`) — PASS

```
[fuzz] iter=0 seed=1          writers=3
[fuzz] iter=1 seed=2654435770 writers=7
[fuzz] iter=2 seed=1013904243 writers=6
[fuzz] iter=3 seed=3668340012 writers=6
[fuzz] iter=4 seed=2027808485 writers=4
[fuzz] iter=5 seed=387276958  writers=3
[fuzz] iter=6 seed=3041712727 writers=3
[fuzz] iter=7 seed=1401181200 writers=7
[fuzz] iter=8 seed=4055616969 writers=6
[fuzz] iter=9 seed=2415085442 writers=5
ℹ tests 1  ℹ pass 1  ℹ fail 0     (0 divergences, 0 coherence violations)
```

Seeds are clock-derived per run and logged on each scenario's
`[harness] run=… seed=… profile=…` line; export `HARNESS_SEED` +
`HARNESS_PROFILE` to replay. Representative clean-profile seeds observed:
S1=89510426, S4=88598895, S8=92080638, S9=90247500.

## Regression suite

`pnpm test` (the existing repo suite): **228 tests, 228 pass, 0 fail** —
unchanged. The harness lives outside that glob (`okf/harness/scenarios/*`)
and adds no load to it. `okf/test/regressions/` is empty of real repros (none
were produced — determinism held); the `fuzz-shrink` test proves the
shrink→`saveRegression` pipeline end to end in-process.

## What was reused vs. written fresh

- **Reused verbatim (format-blind):** `hub.js` (fault proxy: latency, jitter,
  byte-stalls, kill-mid-frame, partition), `rng.js` (seeded mulberry32),
  `profiles.js` (clean/lossy/partitioned).
- **Adapted:** `controller.js` (barriers, partition/heal, `quiesce` oracle,
  `cloneUniverse` permutation replay — only the scratch path `sslop/036/` and
  the writer path changed), `setup.js` (auto-okf §8 in-log AddWriter
  onboarding).
- **Written fresh for auto-okf:** `writer.js` (auto-okf op vocabulary over a
  real `@auto-okf/store` Vault + `@auto-okf/faces`), `coherence.js`
  (independent I8 derivation + §9 link extraction — imports nothing from
  `@auto-okf/*`), `fuzz.js` (auto-okf op schedules), and all ten scenarios.

## Findings / notes (not blockers)

1. **Late join to a populated vault requires the joiner to initiate.** A
   fresh peer joining an already-populated vault only backfills when it is the
   *initiator* side of the replication stream (autobee/hypercore pull
   semantics). Setup-time joins work either way because links form before any
   data exists. S9 connects the fresh epoch peer as the initiator. This is a
   harness usage detail, not a store defect (verified: in-process direct-pipe
   join to a compacted vault converges identically).

2. **Revocation semantics (S8) — the I10 guarantee is agreement, not
   universal rejection.** A revoked writer's partitioned ops are *concurrent*
   with the removal. An op that linearizes *before* the removal has no
   `gov/removed` to check yet and lands (bounded by the §8 `seqAtRemoval`
   window); the seq cross-check rejects only ops linearizing after it. What
   holds on every peer — and is what the vault-ld blocker violated — is
   convergence, an **identical applied/rejected partition** (replay-stable),
   and that C can author nothing once it folds its own revocation
   (`VAULT_REVOKED`). S8 asserts exactly these. It is not weakened to pass:
   asserting "every late op rejects" would be asserting a false property.

## Assumptions

Posted as a PR comment; summarized here:

- The three fault profiles vary only healed-link quality; every scenario
  stimulates its race by an *explicit* partition/heal (matching the vault-ld
  design), so `partitioned` and `clean` exercise the same scenario logic with
  identical link quality and `lossy` adds latency/stalls to the healed links.
- The independent coherence checker constrains fuzz body text to a simple,
  unambiguous link vocabulary (plain text + `[l](/path)` inline links) so the
  reimplemented §9 extractor and the code under test agree on extraction; the
  adversarial surface (malformed/oversized/unknown/garbage/`_id`-mint) is
  exercised through dedicated op kinds, not through body-text ambiguity.
- Fuzz schedules reference concepts by *symbolic subject* (resolved to minted
  `_id`s at runtime) because writer keypairs are random per run; a saved repro
  replays the same op-interleaving pattern, not identical `_id`s.
- Scratch under `sslop/036/tmp/<run>/<writer>/`, unique per run, handles
  closed, never deleted, never `/tmp`.
