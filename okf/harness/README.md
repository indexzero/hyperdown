# auto-okf multi-process fault harness

This is the end-to-end fault harness for the auto-okf stack:
`@auto-okf/{core,store,faces}` on autobee and corestore.

- Every writer is a separate OS process with its own corestore directory.
- All replication between processes goes through a fault proxy that the
  controller owns. It never uses the public DHT.
- Each scenario makes its races by construction: partition, write
  concurrently, heal.
- You can replay every run from its seed.

The fault proxy, the controller, the convergence oracle, the permutation
replay, the seeded RNG and the fuzz engine come from the vault-ld harness
(`vault-ld/harness`). They do not depend on the op format. Only the op
vocabulary of the writer and the scenarios differ.

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

To run one run again, export its seed and its profile:

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

Scratch is under `sslop/036/tmp/<run>/<writer>/`. Each run has its own
directory, never under `/tmp`. The harness closes the handles and never
deletes the files, so you can examine them after a failure. Each run also
writes `harness.log`, which holds the fault schedule and the convergence
events.

## Scenario ↔ invariant map

| Scenario file | Invariant | What it stimulates |
| --- | --- | --- |
| `merge-across-peers.test.js` | I6 | concurrent same-key SetField; permutation replay |
| `merge-across-peers.test.js` | I5 | tag OR-set add/remove race (SU-set); staletag |
| `merge-across-peers.test.js` | I7/I8 | demand lifecycle: link + late create, both orders |
| `merge-across-peers.test.js` | I4/I7 | same-base SetBody siblings; ResolveConflict drains |
| `merge-across-peers.test.js` | I6 | rename + concurrent edit merge (Kleppmann) |
| `merge-across-peers.test.js` | I6 | concurrent rename; loser flag/clobber |
| `merge-across-peers.test.js` | I8/I9 | two ids one path; conflict copy; byte-identical |
| `revocation.test.js` | I10 | revocation race under partition; convergence and replay stability |
| `generation.test.js` | I11 | a generation (materialize, then import) under concurrency; fresh peer converge |
| `fuzz.test.js` | I1/I2/I8 | seeded random schedules; independent coherence; shrink to a committed regression |

Every scenario runs at every profile. The profile changes only the quality
of a healed link. The scenario sets the partition schedule.

## Architecture

- `lib/writer.js` is the writer process. It opens an `@auto-okf/store`
  Bundle and dials the fault hub for each replication link. It answers
  these controller commands over fork IPC:
  - `init`, `join`, `open`.
  - `call`, for any Bundle method: `createConcept`, `setField`, `addTag`,
    `remTag`, `setBody`, `setPath`, `deleteConcept`, `resolveConflict`,
    `addWriter`, `removeWriter`.
  - `append` and `appendRaw`, which take raw bytes for poison-op tests.
  - `hash`, the hash of a view snapshot, and `dump`.
  - `link` and `unlink`, which resume and pause replication.
  - `materialize`, `ingest`, `wanted` and `generation`. A generation is
    materialize, then import.

  A crash is a SIGKILL. A restart spawns the writer again on the same
  directory.
- `lib/hub.js` is the fault proxy. Every replication byte between two
  processes goes through one pipe per direction. A pipe supports seeded
  latency, jitter, byte stalls, a kill in the middle of a frame, and a
  hard partition. Each fault decision comes from a child of the run RNG
  for that direction, and the hub logs it. A socket that waits for its
  partner buffers the bytes it sends, and delivers them in order when the
  link pairs. If the socket ends or closes first, it leaves the pending
  set. The vault-ld copy of the hub does not do this.
- `lib/controller.js` spawns the writers and owns the hub. It provides
  these things:
  - Barriers, `partition`, `connectAll` and `disconnect`.
  - The convergence oracle, `quiesce`: equal hashes on two consecutive
    rounds, with a forced update between them.
  - `diffViews`, which compares two views key by key.
  - Permutation replay through `cloneUniverse`. It closes the writers,
    copies their cores, opens the copies and heals them in a different
    order. The keys are the same, so the hashes are directly comparable.
- `lib/coherence.js` is an independent implementation of the I8
  derivation of SPEC §11. It derives `path/`, `link/`, `bl/`, `wanted/`,
  `wantedrank/` and `revbybase/` from `c/`, with its own link extractor
  (SPEC §9). It imports nothing from `@auto-okf/*`, so it examines the
  code under test without calling it.
- `lib/fuzz.js` generates seeded schedules. They include malformed ops,
  oversized paths, unknown op types, garbage bases and adversarial `_id`
  mint attempts. It also holds `runSchedule`, the greedy `shrinkSchedule`,
  and `saveRegression`, which writes `okf/harness/regressions/*.json`.
- `lib/rng.js`, `lib/profiles.js` and `lib/setup.js` hold the seeded PRNG,
  the three fault profiles, and the cluster setup. The setup makes a
  genesis indexer and admits each writer with an in-log `AddWriter`
  (SPEC §8).

## Notes

- Late join to a populated vault: the new joiner must initiate the
  replication link (harness side 0). autobee sends an already-populated
  vault to a new peer only when the joiner pulls. A join at setup works
  from either side, because the links form before any data exists. See
  `scenarios/generation.test.js`.
- Revocation (`scenarios/revocation.test.js`): the I10 guarantee is
  convergence, and a partition of the ops into applied and rejected that
  is stable under replay. It is not "every partitioned op rejects". The
  ops that writer C appends in the partition are concurrent with the
  removal. One that linearizes before the removal lands, because no
  `gov/removed` record exists yet. No `seqAtRemoval` bound applies to it.
  The revocation check of SPEC §8 runs only at a position where
  `gov/removed/<key>` exists (`applyNode` in `okf/core/lib/apply.js`).
  Every peer must agree, and C must author nothing after it folds its own
  revocation.
