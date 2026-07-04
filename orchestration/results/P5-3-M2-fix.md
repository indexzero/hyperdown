# P5-3 — M2 fix: store-level append admission control (opt-in backpressure)

Commit: `5ae8147` on `6/harness` — `fix(store): M2 — opt-in append
backpressure: own-fold + peer-ack admission gates`
(4 files: `packages/store/lib/vault.js`, `packages/store/README.md`,
`harness/soak/soak.js`, new `test/store-backpressure.test.js`).

## What was built

`vault.append` stays **fire-at-caller-rate by default** — the invariant
layer and all 111 pre-existing tests are untouched. Opt in per vault
(`new Vault(dir, { backpressure })`) or per op
(`append(type, payload, { backpressure })`, also threaded through every
content-op convenience; `true` == `{ maxInflight: 1, ackTimeout: 1500 }`,
per-op `false` overrides a vault config). With the option on, every append
passes two admission gates on one `maxInflight` watermark
(`vault.js` `_admit`, `_observeAck`, `_ackWait`):

1. **own fold** — once `maxInflight` own ops are outstanding beyond the last
   awaited fold, append awaits `update()` (full fold of the linearized DAG,
   remote ops included): no local append-vs-apply backlog.
2. **peer acknowledgment** — once `maxInflight` own ops are beyond the
   highest length of this writer's core that any *folded peer op's §3.2
   clock* has cited, append waits (bounded by `ackTimeout`) for fresh acks.
   A peer's op clock is proof of what that peer had linearized at its append,
   so this pins a fast writer to its peers' *demonstrated* fold rate.
   The gate arms only after a remote op folds (single-writer vaults never
   wait); on timeout the op is admitted anyway, so idle/silent/partitioned
   peers degrade a writer to ~`maxInflight` ops per `ackTimeout` instead of
   deadlocking it.

**Why gate 2 exists (measured, not theoretical):** the sketch's
local-fold-only throttle was implemented first and *failed the M2 repro* —
at `SOAK_SLEEP=80` with a per-op fold, the leader's own fold stays cheap
precisely because the drowning peers send little, so it still floods:
`w1=1483` vs `w0=293/w2=162` at t=210 s, then
`[soak] writer w1 op failed: [w1] call timed out after 120000ms`
(`sslop/020/soak-bp-80-mi1.log` — the exact M2 signature). The peer-ack
gate is what closes the loop.

The soak now exercises the option on its write path
(`{ backpressure: true }` per op; `SOAK_BACKPRESSURE=0` reproduces the
unthrottled M2 flood). The store README documents the option, both gates,
the degradation contract, and the sustainable-rate envelope (finding
numbers: unthrottled ~12 ops/s/writer floods 1,535/101/421 and stalls at
~4.5 min; fold-rate ~2.5 ops/s/writer sustains 30.5 min balanced at
3,235/3,601/3,736; ack-gated at attempted 12 ops/s self-paces to ~0.6–0.7
admitted ops/s/writer, balanced end to end).

## Completion criteria

### 1. New backpressure test green (`test/store-backpressure.test.js`)

Three tests: (a) 3 writers × 30 ops concurrent, watermark
`_nextSeq - _foldedSeq <= maxInflight` asserted after every op, all writers
complete, peer acks harvested, views converge; (b) ack gate degrades to
timeout admission when peers go silent (no deadlock); (c) opt-in contract —
default append never awaits a fold (spied `update()` count == 0),
vault-level config throttles, per-call `false` overrides.

```
✔ backpressure bounds in-flight ops and every writer progresses under concurrent load (M2) (1999.890375ms)
✔ ack gate degrades to timeout admission when peers go silent (no deadlock) (453.146291ms)
✔ backpressure is opt-in: default append never awaits the fold; vault config + per-call override (241.473375ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

### 2. Full suite green (111 + 3 new = 114)

```
ℹ tests 114
ℹ suites 0
ℹ pass 114
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 18854.100292
```

### 3. `SOAK_SLEEP=80` soak with backpressure, >= 5 min, balanced, no command timeout

Two independent 6-minute runs (`SOAK_SLEEP=80 SOAK_MINUTES=6`,
backpressure on by default). Load phase: full 6 minutes each, **no command
timeout**, per-writer op counts balanced within ~6% the whole way (compare
the unthrottled 1,535/101/421). Run 2 tail
(`sslop/020/soak-bp-80-ack2.log`; columns
elapsed_s,writer,rss_mb,heap_mb,fds,dir_kb,ops):

```
[soak] 240,w0,691.3,146.1,31,18112,178
[soak] 240,w1,648.5,90.8,27,66784,162
[soak] 240,w2,605.1,88.4,29,31372,173
[soak] 270,w0,694.4,144.7,31,23232,196
[soak] 270,w1,652.6,135.3,29,17000,180
[soak] 270,w2,605.3,121.2,29,34444,192
[soak] 300,w0,695.5,156.3,31,29376,215
[soak] 300,w1,653.3,151.2,29,25192,199
[soak] 300,w2,605.5,123.6,29,36492,210
[soak] 330,w0,696.0,119.5,31,36544,234
[soak] 330,w1,654.2,125.4,29,32360,218
[soak] 330,w2,605.6,98.4,29,38540,229
[soak] writes done (253/237/248); healing + final convergence check
```

Run 1 (`sslop/020/soak-bp-80-ack.log`): `writes done (245/243/246)`, same
shape (t=300: 207/205/208), survived the midpoint 20 s partition of w1 with
counts still balanced. RSS/heap/FDs bounded in both runs.

**Caveat found, root-caused as pre-existing:** in both runs the *post-load*
quiesce timed out after 300 s with `w0=w1` on one hash and `w2` on another.
Post-mortem (`sslop/020/diag*.log` + `diag-converge*.mjs`): reopening the
run dirs folds data that was already on disk but unfolded at quiesce time,
and directly pairing w0/w2 joins all three logs to a single hash in
seconds–minutes — **no determinism violation; a tail-delivery/ingestion
liveness stall**, distinct from M2's write-path flood. Control run
(`SOAK_BACKPRESSURE=0 SOAK_SLEEP=400`, i.e. the previously-proven rate with
**none of this change's code executing**, `sslop/020/soak-ctl-400-nobp.log`):
identical failure signature (`w0=w1=ccad3152…, w2=15bf106e…`, quiesce
timeout 300000 ms). The stall therefore pre-exists this change; flagged for
the re-review alongside the full 30-min soak re-run.

### 4. `pnpm test:harness:clean` matrix green

```
✔ S10: seeded fuzz x3 (convergence + I8 after every heal) (10329.373833ms)
✔ smoke: two-process convergence through the fault proxy (1108.713042ms)
ℹ tests 17
ℹ pass 17
ℹ fail 0
ℹ duration_ms 67420.832959
exit=0
```

## Notes for the re-reviewer

- Default-path cost: zero — ack tracking (`_observeAck`, one extra
  `decodeOp` per remote node) only activates after backpressure is first
  used on that vault.
- The admission bound is per awaited caller; concurrent in-process appends
  may overshoot by the concurrency degree (documented in code + README).
- Throughput under the option is intentionally ack-RTT/fold-rate bound
  (~0.6–0.7 ops/s/writer on the lossy profile at `maxInflight: 1`); raise
  `maxInflight` to trade divergence bound for throughput.
- Scratch artifacts (logs, diagnostics, raw runs) under `sslop/020/`; soak
  run dirs under `sslop/017/tmp/soak-*` were left for post-mortem per
  harness convention.
