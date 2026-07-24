# auto-okf multi-process fault harness

Real-process, fault-injecting end-to-end harness for the **auto-okf** stack
(`@auto-okf/{core,store,faces}` on autobee + corestore). Every writer is a
separate OS process with its own corestore directory; replication between
processes is piped through a controller-owned **fault proxy** (never public
DHT infra). Races are stimulated by construction (partition, write
concurrently, heal), and every run is replayable from its seed.

This is the vault-ld harness (`/harness`) retargeted to auto-okf: the
fault proxy, controller, convergence oracle, permutation replay, seeded RNG
and fuzz+shrink engine are format-blind and reused wholesale — only the
writer op vocabulary and the scenarios change.

## Quick start

```sh
pnpm test:okf-harness:clean          # S1..S10, clean 0ms links
pnpm test:okf-harness:lossy          # 200ms ±150ms jitter, 5% stalls
pnpm test:okf-harness:partitioned    # write-during-partition, heal-after
pnpm test:okf-harness:fuzz           # seeded fuzz (HARNESS_FUZZ_ITERS iters)
```

Every run logs a replay line:

```
[harness] run=<id> seed=<seed> profile=<profile>
```

Reproduce a specific run by exporting its seed and profile:

```sh
HARNESS_SEED=7 HARNESS_PROFILE=partitioned \
  node --test okf/harness/scenarios/s01-lww.test.js
```

## Environment

| var                  | meaning                                     | default |
| -------------------- | ------------------------------------------- | ------- |
| `HARNESS_PROFILE`    | `clean` \| `lossy` \| `partitioned`         | `clean` |
| `HARNESS_SEED`       | run seed (uint32); logged and replayable    | clock   |
| `HARNESS_FUZZ_ITERS` | S10 fuzz iterations                         | `3`     |

Scratch lives under `sslop/036/tmp/<run>/<writer>/` — unique per run, never
`/tmp`, never deleted (handles are closed; files stay for post-mortem). Each
run also writes `harness.log` (fault schedule + convergence events).

## Scenario ↔ invariant map

| scenario                | invariant | what it stimulates                                 |
| ----------------------- | --------- | -------------------------------------------------- |
| S1 `s01-lww`            | I6        | concurrent same-key SetField; permutation replay   |
| S2 `s02-orset`          | I5        | tag OR-set add/remove race (SU-set); staletag      |
| S3 `s03-wanted`         | I7/I8     | demand lifecycle: link + late create, both orders  |
| S4 `s04-body-conflict`  | I4/I7     | same-base SetBody siblings; ResolveConflict drains |
| S5 `s05-rename-edit`    | I6        | rename + concurrent edit merge (Kleppmann)         |
| S6 `s06-rename-rename`  | I6        | concurrent rename; loser flag/clobber              |
| S7 `s07-path-collision` | I8/I9     | two ids one path; conflict copy; byte-identical    |
| S8 `s08-revocation`     | I10       | revocation race under partition — the vault-ld     |
|                         |           | blocker; asserts convergence + replay-stability    |
| S9 `s09-epoch`          | I11       | epoch cycle under concurrency; fresh peer converge |
| S10 `s10-fuzz`          | I1/I2/I8  | seeded random schedules + independent coherence    |
|                         |           | + shrink to a committed regression                 |

All scenarios run at every profile; the profile only varies healed-link
quality (the partition schedule is the scenario's, not the link's).

## Architecture

- **`lib/writer.js`** — the writer process. Opens an `@auto-okf/store` Vault,
  dials the fault hub for each replication link, and answers controller
  commands over fork IPC: `init`/`join`/`open`, `call` (any Vault method —
  `createConcept`/`setField`/`addTag`/`remTag`/`setBody`/`setPath`/
  `deleteConcept`/`resolveConflict`/`addWriter`/`removeWriter`), `append`/
  `appendRaw` (raw bytes for poison-op tests), `hash` (snapshot view hash),
  `dump`, `link`/`unlink` (pause/resume replication), `materialize`/`ingest`/
  `wanted`/`compact` (faces + epoch cycle). Crash = SIGKILL; restart =
  respawn on the same dir.
- **`lib/hub.js`** — the fault proxy (verbatim from vault-ld). Every
  replication byte between two processes passes through a per-direction pipe
  supporting seeded latency, jitter, byte-stalls, kill-mid-frame, and hard
  partition; all fault decisions come from a per-direction child of the run
  RNG and are logged.
- **`lib/controller.js`** — spawns writers, owns the hub, provides barriers,
  `partition`/`connectAll`/`disconnect`, the **convergence oracle**
  (`quiesce`: equal hashes on two consecutive rounds with a forced update
  between), key-by-key `diffViews`, and **permutation replay** via
  `cloneUniverse` (close writers, copy their cores, reopen the copies, heal
  in a different order — same keys, directly comparable hashes).
- **`lib/coherence.js`** — an *independent* reimplementation of the §11 I8
  derivation (`path/`, `link/`, `bl/`, `wanted/`, `wantedrank/`,
  `revbybase/` from `c/`, incl. a reimplemented §9 link extractor). Imports
  nothing from `@auto-okf/*` — it checks the code under test without calling
  it.
- **`lib/fuzz.js`** — seeded schedule generation (incl. malformed ops,
  oversized paths, unknown op types, garbage bases, adversarial `_id` mint
  attempts), `runSchedule`, greedy `shrinkSchedule`, and `saveRegression`
  (writes `okf/test/regressions/*.json`).
- **`lib/rng.js` / `lib/profiles.js` / `lib/setup.js`** — seeded PRNG, the
  three fault profiles, and cluster bring-up (genesis indexer + §8 in-log
  `AddWriter` onboarding).

## Notes

- **Late join to a populated vault**: the fresh joiner must *initiate* the
  replication link (harness side 0) — autobee backfills an already-populated
  vault to a new peer only when the joiner pulls. Setup-time joins work
  either way because links form before any data exists. See S9.
- **Revocation (S8)**: the I10 guarantee is convergence + a replay-stable
  applied/rejected partition, not "every partitioned op rejects". C's
  partitioned ops are *concurrent* with the removal; one that linearizes
  before the removal has no `gov/removed` to check yet and lands (bounded by
  the §8 `seqAtRemoval` window). What must hold is that every peer agrees and
  C can author nothing once it has folded its own revocation.
