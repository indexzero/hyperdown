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
pnpm test:okf-harness:clean          # every scenario, clean 0ms links
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
  node --test okf/harness/scenarios/merge-across-peers.test.js
```

## Environment

| var                  | meaning                                     | default |
| -------------------- | ------------------------------------------- | ------- |
| `HARNESS_PROFILE`    | `clean` \| `lossy` \| `partitioned`         | `clean` |
| `HARNESS_SEED`       | run seed (uint32); logged and replayable    | clock   |
| `HARNESS_FUZZ_ITERS` | `fuzz.test.js` iterations                   | `3`     |

Scratch lives under `sslop/036/tmp/<run>/<writer>/` — unique per run, never
`/tmp`, never deleted (handles are closed; files stay for post-mortem). Each
run also writes `harness.log` (fault schedule + convergence events).

## Scenario ↔ invariant map

| scenario file                | invariant | what it stimulates                                 |
| ---------------------------- | --------- | -------------------------------------------------- |
| `merge-across-peers.test.js` | I6        | concurrent same-key SetField; permutation replay   |
| `merge-across-peers.test.js` | I5        | tag OR-set add/remove race (SU-set); staletag      |
| `merge-across-peers.test.js` | I7/I8     | demand lifecycle: link + late create, both orders  |
| `merge-across-peers.test.js` | I4/I7     | same-base SetBody siblings; ResolveConflict drains |
| `merge-across-peers.test.js` | I6        | rename + concurrent edit merge (Kleppmann)         |
| `merge-across-peers.test.js` | I6        | concurrent rename; loser flag/clobber              |
| `merge-across-peers.test.js` | I8/I9     | two ids one path; conflict copy; byte-identical    |
| `revocation.test.js`         | I10       | revocation race under partition — the vault-ld     |
|                              |           | blocker; asserts convergence + replay-stability    |
| `generation.test.js`         | I11       | a generation (materialize, then import) under concurrency; fresh peer converge |
| `fuzz.test.js`               | I1/I2/I8  | seeded random schedules + independent coherence    |
|                              |           | + shrink to a committed regression                 |

All scenarios run at every profile; the profile only varies healed-link
quality (the partition schedule is the scenario's, not the link's).

## Architecture

- **`lib/writer.js`** — the writer process. Opens an `@auto-okf/store` Bundle,
  dials the fault hub for each replication link, and answers controller
  commands over fork IPC: `init`/`join`/`open`, `call` (any Bundle method —
  `createConcept`/`setField`/`addTag`/`remTag`/`setBody`/`setPath`/
  `deleteConcept`/`resolveConflict`/`addWriter`/`removeWriter`), `append`/
  `appendRaw` (raw bytes for poison-op tests), `hash` (snapshot view hash),
  `dump`, `link`/`unlink` (pause/resume replication), `materialize`/`ingest`/
  `wanted`/`generation` (faces, and a generation: materialize, then
  import). Crash = SIGKILL; restart = respawn on the same dir.
- **`lib/hub.js`** — the fault proxy, forked from vault-ld. Every
  replication byte between two processes passes through a per-direction pipe
  supporting seeded latency, jitter, byte-stalls, kill-mid-frame, and hard
  partition; all fault decisions come from a per-direction child of the run
  RNG and are logged. Unlike the vault-ld copy, a socket that waits for its
  partner buffers the bytes it sends and delivers them in order once the
  link pairs, and leaves the pending set if it ends or closes first.
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
  (writes `okf/harness/regressions/*.json`).
- **`lib/rng.js` / `lib/profiles.js` / `lib/setup.js`** — seeded PRNG, the
  three fault profiles, and cluster bring-up (genesis indexer + §8 in-log
  `AddWriter` onboarding).

## Notes

- **Late join to a populated vault**: the fresh joiner must *initiate* the
  replication link (harness side 0) — autobee backfills an already-populated
  vault to a new peer only when the joiner pulls. Setup-time joins work
  either way because links form before any data exists. See
  `scenarios/generation.test.js`.
- **Revocation (`scenarios/revocation.test.js`)**: the I10 guarantee is convergence + a replay-stable
  applied/rejected partition, not "every partitioned op rejects". C's
  partitioned ops are *concurrent* with the removal; one that linearizes
  before the removal has no `gov/removed` to check yet and lands. No
  `seqAtRemoval` bound applies to it: the §8 revocation check runs only at
  a position where `gov/removed/<key>` exists
  (`okf/core/lib/apply.js:399-403`). What must hold is that every peer
  agrees and C can author nothing once it has folded its own revocation.
