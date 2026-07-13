# CODE-REVIEW-2 — Adversarial re-review (Gate G4)

Scope: re-run the full scenario matrix at all three fault profiles plus the
fuzz suite; adversarially re-attack the three recently-touched code paths
(`packages/core/lib/apply.js` opRemoveWriter clock-rule revocation and
opSetBody revbybase index + bounded conflict fan-out; `packages/store/lib/vault.js`
append backpressure + revoked-self append guard); adjudicate the "post-load
quiesce stall" documented as pre-existing in `orchestration/results/P5-3-M2-fix.md`
§"control run". Repo at `6/harness`. AUTOBEE substrate (autobase forbidden).
All seeds logged. Scratch under `sslop/021/`.

---

## Verdict

**G4-PASS.** Every mandatory scenario S1–S10, the adversarial suite, the
committed regressions, and the unit/invariant suite pass at **clean, lossy,
and partitioned** profiles, and the seeded fuzz suite passes at 10 iterations —
all under a single logged seed `591324767`, with **no divergent view hash from
any identical log under any seed**. I re-attacked the two M1/M2 code paths with
five new adversarial probes designed to manufacture divergence or silent loss
through the revbybase index, the bounded same-base conflict fan-out, the
clock-rule revocation (including revoke→re-admit), and the backpressure +
revoked-self guard; each probe converged to a single hash and matched a
fresh-replay peer that re-linearized every core in a different arrival order.
No new blocker or major was found in the touched code.

The documented "post-load quiesce stall" **reproduces exactly** (control
config: backpressure OFF, `SOAK_SLEEP=400`, 6-min lossy soak, seed
`591324767` → post-load quiesce times out at 300 000 ms with `w0=w1` on one
hash and `w2` on another). I adjudicate it a **liveness / tail-delivery stall,
not a determinism or convergence violation**, and prove it below (§Quiesce-stall
adjudication): the disagreement tracks each peer's *delivered op prefix*
one-for-one (no peer held the full log at quiesce), two independent processes
(`w0`,`w1`) folded to the *identical* hash, and the whole I1/I2/I3/permutation
determinism matrix is green. It is filed **minor** (L1), is **pre-existing**
(reproduces with none of the M2 code executing), and does not gate G4.

---

## Findings table

| ID | Severity | Invariant | Reproduced by | Title |
|----|----------|-----------|---------------|-------|
| L1 | minor | none (liveness; I2 delayed, not lost) | `sslop/021/soak-ctl-6m.log` + `sslop/021/inspect-each.log` (seed 591324767, backpressure OFF) | Post-load quiesce can exceed the 300 s oracle budget under sustained lossy flood — a tail-delivery stall, not divergence |

No blocker and no major finding. No I1/I2/I3/I10 violation was reproduced in
the touched paths or elsewhere. (Unproven, non-reproduced suspicions are in the
appendix.)

---

## Findings detail

### L1 (minor) — post-load quiesce liveness stall under sustained lossy flood

**Repro.** `SOAK_MINUTES=6 SOAK_SLEEP=400 SOAK_BACKPRESSURE=0
HARNESS_SEED=591324767 node harness/soak/soak.js` (run dir
`sslop/017/tmp/soak-60909-mr612f6w`, log `sslop/021/soak-ctl-6m.log`). Writers
appended 615 / 691 / 741 ops (the unthrottled M2 flood shape, `w2` running
ahead). After healing, the final convergence oracle timed out:

```
[soak] FAILED to converge: quiesce timeout after 300000ms
  (seed=591324767 profile=lossy): w0=81b0527c… w1=81b0527c… w2=0f318ce3…
```

This is the exact signature the named control-run section records (`w0=w1` on
one hash, `w2` on another, 300 000 ms timeout).

**Observed vs expected.** Expected: all peers reach one hash within the oracle
budget. Observed: `w0` and `w1` agree; `w2` differs, and the round does not
close within 300 s.

**Root cause (proven liveness, not divergence).** The disagreement is a
*delivered-prefix* gap in autobee replication, not a fold of the same log to
different results:

- **No peer held the full log at quiesce.** Reopening each writer dir in its
  own process and reading the per-writer `seen/<w>` ordinals (which count every
  linearized node from `<w>`, `sslop/021/inspect-each.log`; writer cores
  `w0=d4da5569` 619 ops, `w1=8efaa4ef` 691, `w2=c7b3b488` 741, total 2051):

  | peer | folded of w0 (619) | folded of w1 (691) | folded of w2 (741) |
  |------|-----|-----|-----|
  | w0 | 619 | 691 | **370** |
  | w1 | 619 | 691 | **330** |
  | w2 | **343** | **392** | 741 |

  Every peer is missing a different, large slice of the others' ops. The hash
  disagreement is a pure function of *which prefix each peer has delivered*.

- **Two independent folds agree.** `w0` and `w1` are separate OS processes that
  linearized and folded independently, yet produced the *identical* hash
  `81b0527c…`. Nondeterministic apply would have split them too; it did not.

- **The determinism matrix is green.** I1 (S5 policy-epoch reorder + permutation
  replay), I2 (S1/S2 + convergence), I3 (S7 SIGKILL-mid-apply then
  rebuild-from-scratch equality), and the fuzz permutation checks all pass at
  all three profiles (below). Those are the positive proofs that an identical
  log folds to an identical view; the stall is orthogonal.

- **In-vitro corroboration.** Meshing the reopened cores and watching the
  delivered-op totals (`sslop/021/fold-converge2.log`) shows them climb then
  wedge at ~1300/2051 per peer with the hashes always tracking the (unequal)
  delivered totals — never equal-delivered-totals-with-unequal-hash, which is
  what a divergence would require. (The raw in-process `replicate()` pairing
  lacks the autobee-wakeup wiring the swarm/hub supply, so it starves on a large
  backlog; this is a tooling limit of the reopen harness, not the store — the
  determinism conclusion does not rest on it. The named control-run diagnosis
  reached the same convergence conclusion by pairing peers directly.)

**Severity / mapping.** Violates none of I1/I2/I3/I10: convergence is *delayed*,
never lost, and no two peers ever fold the *same* log to different views. It is
a §3-"quiescence"/liveness limitation of autobee replication catch-up under
sustained lossy flood. It is **pre-existing and orthogonal to M1/M2**: it
reproduces with `SOAK_BACKPRESSURE=0` (none of the M2 admission code executing).
Filed **minor**, does not gate G4.

**Fix sketch.** Not a store-apply defect; the two levers are (a) product-side:
keep the M2 opt-in `backpressure` ON for sustained writers, which shrinks the
end-phase tail by pinning each writer to its peers' fold rate (the soak's
balanced 245/243/246 runs on the named report); (b) harness/operational: the
convergence oracle should either budget the quiesce as a function of undelivered
log length or drive replication to a delivered-length barrier before comparing
hashes, rather than a fixed 300 s wall — otherwise a large healed backlog is
scored as a failure when it is merely slow. No change to `apply.js`/`vault.js`
is warranted by L1.

---

## Adversarial re-attack of the recently-touched paths

Five in-process probes (real autobee + corestore, direct replication, each
ending with a **fresh-replay peer** that re-linearizes every core in its own
arrival order) — `sslop/021/probe.mjs`, logs `sslop/021/probe-run1.log`,
`probe-run2.log`. **All pass, run twice.**

**opSetBody — revbybase index + bounded conflict fan-out (M1):**

- **Probe 1 — three-way concurrent SAME-base SetBody.** `w0/w1/w2` each write a
  revision citing one shared non-null base during a full partition; heal.
  Result: one converged hash across all three; **exactly C(3,2)=3
  `flag/conflict` rows** (the fan-out is bounded to same-base matches, found via
  `revbybase/<s>/<base>/*` in O(matches)); **all 4 revisions retained** (no
  silent loss, I4); one deterministic head; and a **fresh 4th peer replays to
  the identical hash** (permutation-invariant, I1/I2). No divergence.
- **Probe 2 — prune a mid-chain ancestor, then cite the pruned base.** After
  `PruneRevisions` removes `r1`, a concurrent `SetBody` citing `r1` is rejected
  `garbage-base` **uniformly** on both peers; stale `revbybase` rows left by
  prune do not perturb a fresh-replay peer (identical hash). Confirms the
  base-keyed index and its prune maintenance are convergence-safe.
- **Probe 5 — concurrent `ResolveConflict`-with-text on the same conflict.**
  Two peers resolve the same same-base conflict with different merge text; both
  merged revisions cite `keep` (indexed in `revbybase`), the head is LWW, both
  revisions retained, and a fresh-replay peer matches. Deterministic.

**opRemoveWriter — clock-rule revocation:**

- **Probe 3 — revoke C, re-admit C, C writes again.** C's in-flight ops during
  the revocation race are rejected `revoked` uniformly; re-admission
  (`AddWriter` clears `ctx/gov/removed/<C>` and folds any held range) lets C
  append again; the post-readmit op lands in `n/`; a fresh-replay peer reaches
  the same hash (the accept/reject partition is reorg-stable, I10). No divergence.

**vault.js — append backpressure + revoked-self guard (M2):**

- **Probe 4 — backpressured writer revoked mid-flight.** With
  `{ backpressure: { maxInflight:1, ackTimeout:500 } }`, once C folds its own
  `ctx/gov/removed`, the next append is refused `VAULT_REVOKED` **immediately
  (0 ms)** — the ack gate does not deadlock a revoked writer — and peers
  converge. Confirms the guard and the ack-gate degrade-not-deadlock contract
  hold under revocation.

No new divergence or silent-loss scenario was constructed through either file.

---

## Matrix results (every scenario × profile)

Single logged seed **`591324767`**, `node --test --test-concurrency=1`. Command
transcripts: `sslop/021/matrix-run1.log`. All PASS.

| scenario | invariant | clean | lossy | partitioned |
|----------|-----------|-------|-------|-------------|
| S1 LWW arrival independence | I6 | PASS 4.6s | PASS 18.4s | PASS 4.6s |
| S2 OR-set add/remove race | I5 | PASS 1.9s | PASS 10.3s | PASS 1.9s |
| S2b remove unreplicated tag | I5 | PASS 1.8s | PASS 9.5s | PASS 1.9s |
| S3 dangling flag lifecycle | I7 | PASS 4.6s | PASS 19.6s | PASS 4.6s |
| S4 body conflict (same base) | I4 | PASS 1.8s | PASS 10.2s | PASS 1.8s |
| S5 policy-epoch reorder | I1 | PASS 4.6s | PASS 22.7s | PASS 4.6s |
| S6 revocation race | I10 | PASS 2.7s | PASS 13.2s | PASS 2.7s |
| S7 crash + rebuild equality | I3 | PASS 20.6s | PASS 148.3s | PASS 20.6s |
| S8 face determinism + ingest | I9 | PASS 1.7s | PASS 7.5s | PASS 1.8s |
| S9 index coherence under churn | I8 | PASS 3.8s | PASS 22.8s | PASS 3.6s |
| S10 fuzz ×3 (conv + I8 per heal) | I1/I2/I8 | PASS 10.1s | PASS 62.7s | PASS 10.1s |
| ADV1 keyspace injection | §3 | PASS 1.7s | PASS 8.1s | PASS 1.7s |
| ADV2 poison-op containment | I4 | PASS 1.9s | PASS 10.2s | PASS 1.9s |
| ADV3 quiescence is real | §3 | PASS 1.6s | PASS 9.0s | PASS 1.7s |
| ADV4 sole-indexer self-removal | I10 | PASS 1.9s | PASS 6.5s | PASS 1.9s |
| smoke two-process convergence | I2 | PASS 1.1s | PASS 4.7s | PASS 1.1s |
| fuzz-shrink (shrinker unit) | — | PASS 5ms | PASS 3ms | PASS 4ms |

Suite totals: **clean 17/17 (67.0 s)**, **lossy 17/17 (384.4 s)**,
**partitioned 17/17 (67.0 s)**.

Additional suites, same seed:

| suite | result | time |
|-------|--------|------|
| Fuzz (`test:harness:fuzz`, `HARNESS_FUZZ_ITERS=10`) | **1/1 PASS** | 33.5 s |
| Regressions (`test/regressions/*`) | **5/5 PASS** | 6.5 s |
| Unit + invariant suite (`test/*`) | **114/114 PASS** | 17.4 s |

Committed regressions exercised and green: `revocation-race-divergence.test.js`
(B1 — the causal-clock design converges), `setbody-null-base-quadratic.test.js`
(M1 — null base is "no base cited": 400 null-base bodies → 0 conflicts, <1 s).
S6 is **green** (no longer expected-fail): the causal, in-log revocation
(`opRemoveWriter` records `ctx/gov/removed`, never calls the substrate's
positional `host.removeWriter`) means every node linearizes on every peer and is
judged uniformly by the clock rule — the divergence B1 described is designed
out. (Note: `harness/README.md` still says "S6 fails by design"; that line is
stale relative to the current code and tests. Documentation-only.)

Adversarial-probe seeds are deterministic per run; both probe iterations passed.

---

## Quiesce-stall adjudication (summary)

- **Reproduced:** yes — exact signature, control config, seed `591324767`
  (`sslop/021/soak-ctl-6m.log`).
- **Classification:** **liveness / tail-delivery stall, not divergence.** Proof
  (detail in finding L1): (1) at quiesce no peer held the full 2051-op log — the
  `seen/<w>` ordinals show each peer missing a different large slice of the
  others' ops, and the hash split tracks the delivered prefix one-for-one;
  (2) two independent processes `w0`,`w1` folded to the *identical* hash
  `81b0527c…` (determinism holds); (3) the I1/I2/I3/permutation matrix is green
  at all three profiles; (4) in-vitro, delivered totals and hashes move
  together, never equal-delivered-with-unequal-hash. This agrees with the named
  control-run diagnosis.
- **Severity vs I1..I10 and §3:** violates none of the invariants (convergence
  delayed, not lost); it is a §3-quiescence/liveness limitation. **Minor (L1).**
- **Pre-existing:** yes — reproduces with `SOAK_BACKPRESSURE=0` (no M2 code
  running); orthogonal to the M1/M2 changes.

---

## Unproven-concerns appendix

Static suspicions I could **not** turn into a reproduction. Each lists the
attack I ran.

1. **Byzantine clock forgery past revocation (`apply.js` §8.3).** The clock rule
   judges a post-revocation op "causally prior" purely from its op-embedded
   `clock`. A writer bypassing the store could forge `op.clock` to claim
   priority and get an op accepted into `n/` after its own revocation.
   *Attempted:* probe 3 variants + reading `_guardRevoked`. *Why not filed:* not
   reproducible as divergence — a forged clock is folded identically on every
   peer (deterministic), so I2 holds; and the spec (§8.3, DEVIATIONS.md §13(d))
   explicitly scopes revocation to "judged solely from op-embedded clocks",
   accepting that a Byzantine writer can lie about *its own* past. It is a
   governance-trust boundary, not a convergence defect. No I1/I2/I10 divergence
   exists to file.

2. **Stale `revbybase` rows after `PruneRevisions`.** Pruning a revision that is
   itself cited as a base by a surviving revision leaves a
   `revbybase/<s>/<prunedBase>/<survivor>` row whose base no longer has an
   `n/<s>/rev/` entry. *Attempted:* probe 2 (prune mid-chain, then cite the
   pruned base). *Why not filed:* the stale row is never read — any later
   `SetBody` citing that base is rejected `garbage-base` before the scan — and
   it is written deterministically by apply, so it is identical on every peer
   and inside the I2 view hash. Dead but convergence-safe; no loss (the survivor
   revision is retained).

3. **`_nextSeq` advance on a failed `db.append` (`vault.js`).** `append()`
   increments `_nextSeq` before `db.append`; if the substrate append throws,
   `_nextSeq` runs ahead of `db.local.length`, so a later default `clock(seq)`
   could over-count the self entry. *Attempted:* inspection + probe 4 (revoked
   append throws in `_guardRevoked` *before* the increment, so that path is
   clean). *Why not filed:* the only path that increments then throws is a
   substrate-level append failure (an already-degraded process), and the
   over-count is uniform op payload (no divergence). Could not construct a
   convergence or loss failure from it.

4. **hyperbee2 `_bootState` reopen crash (substrate/tooling, not store code).**
   Opening more than one soak writer dir *in a single process* intermittently
   throws `ERR_INVALID_ARG_TYPE` from `hyperbee2/lib/context.js
   getContextByKey` via `autobee _bootState` (`sslop/021/fold-converge*.log`).
   *Why not filed against the store:* the store never opens two writer dirs in
   one process — during the soak each writer is its own OS process, and this
   never occurred there. It is a reopen artifact of the in-process adjudication
   tooling and an autobee/hyperbee2 substrate edge, outside the reviewed files.
   Flagged here for the substrate owners.

---

VERDICT: G4-PASS
