# AutoVault-LD adversarial E2E harness

Real-process, fault-injecting end-to-end harness for the Vault-LD-on-autobee
store. Every writer is a separate OS process with its own Corestore
directory; replication between processes is piped through a controller-owned
**fault proxy** (never public DHT infra). Races are stimulated by
construction (partition, write concurrently, heal), and every run is
replayable from its seed.

## Quick start

```sh
pnpm test:harness:clean          # S1..S10 + adversarial, clean links
pnpm test:harness:lossy          # 200ms ±150ms jitter, 5% stalls
pnpm test:harness:partitioned    # write-during-partition, heal-after
pnpm test:harness:fuzz           # seeded fuzz (HARNESS_FUZZ_ITERS iters)
pnpm test:harness:soak           # 32-min lossy backpressure/leak soak
pnpm test:regressions            # committed shrunk repros
```

Every run logs a replay line:

```
[harness] run=<id> seed=<seed> profile=<profile>
```

Reproduce a specific run by exporting its seed and profile:

```sh
HARNESS_SEED=7 HARNESS_PROFILE=partitioned node --test vault-ld/harness/scenarios/s01-lww.test.js
```

## Environment

| var                  | meaning                                           | default |
| -------------------- | ------------------------------------------------- | ------- |
| `HARNESS_PROFILE`    | `clean` \| `lossy` \| `partitioned`               | `clean` |
| `HARNESS_SEED`       | run seed (uint32); logged and replayable          | clock   |
| `HARNESS_FUZZ_ITERS` | S10 fuzz iterations                               | `3`     |
| `SOAK_MINUTES`       | soak duration                                     | `32`    |

Scratch lives under `sslop/017/tmp/<run>/<writer>/` — unique per run, never
`/tmp`, never deleted (handles are closed; files stay for post-mortem). Each
run also writes `harness.log` (fault schedule + convergence events),
`NOTES.txt`, and — for the soak — `soak.csv`.

## Architecture

- **`lib/writer.js`** — the writer process. Opens a `Vault`, dials the fault
  hub for each replication link, and answers controller commands over fork
  IPC: `init`/`join`/`open`, `append`/`appendRaw` (raw bytes for poison-op
  tests), `call` (any Vault method, Buffers marshalled as `{__hex}`),
  `hash` (snapshot-view-hash: full ordered range scan), `dump`, `link`/
  `unlink` (pause/resume replication), `materialize`/`exportTurtle`/`ingest`
  (faces), `stats` (RSS/FD), `errors`, `close`, `exit`. Crash = SIGKILL from
  the controller; restart = respawn on the same dir.
- **`lib/hub.js`** — the fault proxy. Every replication byte between two
  processes passes through a per-direction pipe supporting seeded latency,
  jitter, probabilistic byte-stalls, kill-mid-frame, and hard partition. All
  fault decisions come from a per-direction child of the run RNG and are
  logged.
- **`lib/controller.js`** — spawns writers, owns the hub, provides barriers,
  `partition`/`connectAll`/`disconnect`, the **convergence oracle**
  (`quiesce`: equal hashes on two consecutive rounds with a forced update
  between — a wrong "synced" signal cannot make it vacuous), key-by-key
  `diffViews`, and **permutation replay** via `cloneUniverse` (close writers,
  copy their cores, reopen the copies, heal in a different order — same keys,
  directly comparable hashes).
- **`lib/coherence.js`** — an *independent* reimplementation of the I8
  derivation (idx/bl/fidx/…-from-n/), used to check index coherence without
  calling the code under test.
- **`lib/fuzz.js`** — seeded schedule generation, `runSchedule`, greedy
  `shrinkSchedule`, and `saveRegression` (writes `test/regressions/*.json`).
- **`lib/rng.js` / `lib/profiles.js` / `lib/setup.js`** — seeded PRNG, the
  three fault profiles, and cluster bring-up.

## Scenario ↔ invariant map

| scenario            | invariant | what it stimulates                              |
| ------------------- | --------- | ----------------------------------------------- |
| S1 `s01-lww`        | I6        | concurrent same-scalar; permutation replay      |
| S2 `s02-orset`      | I5        | add/remove race; unobserved-tag remove          |
| S3 `s03-dangling`   | I7        | dangling→materialize takeover, both heal orders |
| S4 `s04-body-*`     | I4        | concurrent same-base SetBody, one conflict flag |
| S5 `s05-context-*`   | I1        | DefineTerm kind flip vs field writes            |
| S6 `s06-revocation` | I10       | ops racing their revocation — **fails, B1**     |
| S7 `s07-crash-*`    | I3        | SIGKILL mid-apply; rebuild-from-scratch equality|
| S8 `s08-faces`      | I9        | cross-peer byte-identical faces; minimal ingest |
| S9 `s09-coherence`  | I8        | churn + independent coherence checker           |
| S10 `s10-fuzz`      | I1/I2/I8  | seeded random schedules + shrink                |
| `adversarial`       | §3        | keyspace injection, poison op, quiescence,      |
|                     |           | sole-indexer self-removal                       |

**S6 fails by design**: it encodes the I2/I10 invariant that the revocation
race violates (blocker B1). Its committed minimal repro is
`test/regressions/revocation-race-divergence.test.js`. Treat the harness
scenario suite as green *except* S6 until B1 is fixed.
