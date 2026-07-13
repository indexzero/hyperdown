# P5-1 — B1 fix (revocation race divergence, I2/I10)

Commit: `8ff981b` on `6/harness` —
`fix(core,store): B1 revocation race — decide revocation by the in-log §8.3 clock rule, never positional removal`
(7 files, atomic; no push, no AI footer.)

## What was changed

### Per the finding's sketch

1. **`packages/core/lib/apply.js` (`opRemoveWriter`)** — the
   `host.removeWriter` call (and its `removeable` guard) is gone. The op
   still records `ctx/gov/removed/<W> = clock`. The writer stays admitted at
   the substrate level, so every one of its nodes linearizes on every peer
   and is presented to `apply`, where the existing §8.3 check
   (`applyNode`/`clockDominatedBy`) accepts/rejects uniformly by clock.

2. **`packages/store/lib/vault.js`** — autobee's positional "Not writable"
   teardown is replaced by an app-level guard: `Vault.append` now refuses a
   local op with `VAULT_REVOKED` once `ctx/gov/removed/<self>` exists and
   the op's clock does not causally precede the recorded revocation (a
   default-clock append from a revoked writer is always refused; a
   caller-crafted clock is judged by core's exact §8.3 rule).
   `HostAdapter` no longer exposes `removeWriter`/`removeable`.

3. **`DEVIATIONS.md` §13(d)** — rewritten to the actual mechanism (in-log
   clock rule only; no positional removal; app-level append guard; clock
   self-entry, below). §13(b)'s stale `removeable` clause trimmed to match.

### Forced by the repro (deviations from the sketch, with why)

4. **Store clock self-entry (`packages/store/lib/vault.js clock(seq)`)** —
   the sketch alone did NOT make S6 pass: the racing op was *accepted* on
   every peer. Root cause: `clock()` was derived purely from DAG heads,
   which give the writer's length *before* the op being appended. The
   removal record (`removed[C] = n`, the length A had delivered) therefore
   *dominated* the racing op at seq `n` (self entry `n ≤ n`), and core's
   ≤-rule — whose convention is pinned by the I10 unit test, where an op's
   clock self entry counts the op itself — mis-judged an op the remover
   never saw as causally-before. Fix: the emitted §3.2 clock sets the
   writer's own entry to `seq + 1` (delivered length *including* this op).
   Sole clock consumers (§8.3 rule, `clockCovers` for writeafterdelete) are
   unaffected or strictly corrected. Core's `clockDominatedBy` is untouched.

5. **S6 exercises the reject arm by issuing the removal first
   (`harness/scenarios/s06-revocation.test.js`)** — the finding's
   validation note assumed the racing ops would be uniformly *rejected*.
   Empirically (autobee `lib/topo.js cmp`): concurrent nodes order by node
   timestamp, so ops appended before the removal in wall time linearize
   *before* the `RemoveWriter` node on every peer and are uniformly
   *applied* — they precede the in-log revocation point, which is the
   spec's literal §8.3 rule ("a **subsequent** op x … is rejected iff …")
   and satisfies B1's "accepted everywhere OR rejected everywhere; either
   way one convergent view (I2)". Rejection is deterministically reachable
   when the removal linearizes first, so S6 now issues `removeWriter`
   before C's partitioned writes (25 ms timestamp spacer); all of its
   original assertions (converge, no `n/` effect, both ops flagged
   `revoked`, pre-revocation op survives) then hold verbatim. The committed
   B1 repro keeps the original write-then-revoke ordering and covers the
   mirror (uniformly-applied) arm. Both arms are pure functions of the
   final linearized log — deterministic, convergent, reorg-stable.

6. **Tests that pinned the old substrate teardown updated to the new
   containment surface** (mechanism change, not weakening):
   - `test/store-writers.test.js`: b now *remains* autobee-writable after
     the in-log revocation; the zombie write is refused by the append guard
     (`assert.rejects(/VAULT_REVOKED/)`); a's view/hash unchanged (kept).
   - `harness/scenarios/adversarial.test.js` ADV4 (sole-indexer
     self-removal): the post-self-removal write is now refused at the store
     instead of silently appended; peers' hash provably unchanged. (The old
     title's "host.removeable exactness" framing is moot — the call no
     longer exists.)
   - `test/regressions/revocation-race-divergence.test.js`: stale
     "expected to FAIL"/teardown comments corrected; test body unchanged.

## Completion criteria — raw output tails

### 1. B1 repro PASSES

`node --test test/regressions/revocation-race-divergence.test.js`

```
✔ revocation race: peers converge after a removed writer's in-flight op (I2/I10) (6365.219375ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

(also re-run with the full `test/regressions/` dir after all edits: 2/2 pass)

### 2. S6 all three profiles PASS

`HARNESS_PROFILE=clean node --test harness/scenarios/s06-revocation.test.js`

```
[harness] run=s06-45032-mr5wb2n0 seed=2221499932 profile=clean
✔ S6: ops racing their revocation are contained to flag/ (I10) (2671.4695ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

`HARNESS_PROFILE=lossy …`

```
[harness] run=s06-45058-mr5wbaaf seed=2609089751 profile=lossy
✔ S6: ops racing their revocation are contained to flag/ (I10) (17202.466875ms)
ℹ pass 1
ℹ fail 0
```

`HARNESS_PROFILE=partitioned …`

```
[harness] run=s06-45079-mr5wbnms seed=2610352228 profile=partitioned
✔ S6: ops racing their revocation are contained to flag/ (I10) (2666.323666ms)
ℹ pass 1
ℹ fail 0
```

### 3. Full library suite green (incl. I10 triple-replay)

`pnpm test` (final run, after all edits)

```
ℹ tests 111
ℹ pass 111
ℹ fail 0
ℹ duration_ms 12805.699708
```

The I10 triple-replay unit test (`test/i10-governance.test.js`,
"triple replay — incremental, from-scratch, forced-reorg partitions
identical") is in this suite and passes; core's `clockDominatedBy` and its
pinned §8.3 semantics were not modified.

### 4. Full clean harness matrix PASSES

`pnpm test:harness:clean`

```
✔ S10: seeded fuzz x3 (convergence + I8 after every heal) (9712.499083ms)
[harness] run=smoke-45802-mr5wgkkq seed=2574209066 profile=clean
✔ smoke: two-process convergence through the fault proxy (1119.553709ms)
ℹ tests 17
ℹ pass 17
ℹ fail 0
ℹ duration_ms 66808.786167
```

(One intermediate matrix run failed only at ADV4, which pinned the removed
substrate-teardown surface; updated as described in item 6 — 17/17 after.)

## Debug evidence for deviation (4)

Instrumented run (scratch: `sslop/018/debug-b1.mjs`, sketch-only build,
pre-clock-fix): removal recorded `{A:3, C:1}`; C's racing op (seq 1)
carried heads-only clock with self entry ≤ 1 → dominated → applied on both
peers, `flag/rejected` empty, `seen/C = 2`, identical hashes — convergent
but the racing op was mis-accepted whenever it linearized after the
removal too. With the `seq + 1` self entry the same op carries `C:2 > 1`
→ uniformly `revoked` when linearized after the removal (S6 asserts this).

## Notes / residuals

- DEVIATIONS.md "UNVERIFIED (1)" (`host.removeable` exactness) is now moot
  — the call no longer exists — but that entry is outside the §13(d) scope
  I was given, so it was left untouched apart from §13(b)/(d) accuracy.
- Scratch artifacts under `sslop/018/` (debug script + test tmp dirs) left
  in place per the no-delete rule; `sslop/` is gitignored.
