# CODE-REVIEW.md — Adversarial review of Vault-LD-on-autobee (branch 6/harness)

Reviewer: Claude Code, acting as hostile reviewer + test engineer.
System under review: `packages/{core,store,faces,cli}` at G3 on branch
`6/harness`, substrate **autobee@1.0.10** (standalone hyperbee2 + hypercore 11;
autobase is forbidden and absent). Spec of record:
`prompts/01-implementation-spec-prompt.v5.md` (invariants I1..I10 §12,
acceptance §15). Ground adjustments per the supervisor's binding note
(autobase→autobee; replication piped between real processes through a fault
proxy; `sslop/017/tmp` scratch).

Prime directive honored: **no repro, no finding.** Every defect below ships
with a failing test committed under `test/regressions/` and/or a harness
scenario that reproduces it deterministically from a logged seed. Static
suspicions that did not reproduce are in the Unproven Concerns appendix.

---

## 1. Verdict

The core apply pipeline is genuinely deterministic and the convergence,
rebuild, OR-set, LWW, flag-lifecycle, index-coherence, and face-determinism
invariants (I1–I9) held under every fault profile I could construct —
clean, lossy (200ms ±150ms jitter, 5% stalls), and partitioned — across
real multi-process runs, permutation replay, seeded fuzz, crash/restart,
and an independent reimplementation of the I8 derivation. Keyspace
injection, poison ops, and the quiescence oracle all behaved correctly.
That is a strong result and the bulk of the design is sound.

**However, I10/I2 does not hold under the revocation race**, and this is a
**blocker** (a reproduced divergence of view hashes; the severity rule makes
any divergence under any seed a blocker). When a writer is removed while it
has a concurrent op in flight behind a partition, autobee's *positional*
`removeWriter` drops that op from the remover's linearization entirely,
while peers that already replicated the op linearize and apply it. The two
partitions never reconverge. This directly contradicts the spec's §8.3
design, which deliberately chose **clock-in-op, reject-in-apply** revocation
*over* positional revocation precisely so the applied/rejected partition
would be a pure function of op clocks and stay reorg-stable. The substrate's
positional removal defeats that design because the racing node never reaches
`apply` on the remover. See finding **B1**.

One **major** resource finding (**M1**): `opSetBody` rescans *every* prior
revision of the subject on each call, so any sustained `SetBody` on one
subject is O(R²) in apply cost; the null-base/concurrent case additionally
emits N-choose-2 conflict flags (quadratic view growth). A single writer can
stall every peer's apply. This is deterministic (not an I1/I2 violation) but
is an unbounded-resource / availability defect — it repeatedly killed the
soak (a single `SetBody` apply exceeded the 120 s command budget under
sustained multi-writer body load), so the leak soak had to exclude `SetBody`
to isolate the memory/FD/dir question from this apply-cost defect.

A second **major** finding (**M2**) surfaced from the soak: under sustained
concurrent multi-writer lossy load the system does not degrade gracefully —
one writer floods, the others stall folding it, and an op eventually exceeds
the 120 s budget. This is *not* a memory/FD leak (both are bounded); it is a
throughput/backpressure gap. Convergence still holds once writes stop.

Recommendation: **do not ship** until B1 is resolved. M1 and M2 should both be
addressed before any deployment that accepts sustained agent-authored writes.

---

## 2. Findings table

| ID | Severity | Invariant | Repro | Title |
|----|----------|-----------|-------|-------|
| B1 | **blocker** | I10, I2 | `test/regressions/revocation-race-divergence.test.js`; harness `S6` (`s06-revocation.test.js`, any seed) | Revocation race: removed writer's concurrent op diverges peers permanently |
| M1 | **major** | I4 (§6) / §3 backpressure | `test/regressions/setbody-null-base-quadratic.test.js`; killed the SetBody-heavy soak runs | `opSetBody` rescans all revisions → O(R²) apply per subject; null-base adds N-choose-2 conflict flags |
| M2 | **major** | §3 backpressure | `harness/soak/soak.js` at `SOAK_SLEEP<=80`; observed on every high-rate run | Concurrent multi-writer lossy load: one writer floods, others stall applying, an op times out >120s (no leak — RSS/FD bounded) |
| O1 | minor | I10 (§8.0 liveness) | harness `ADV4` (`adversarial.test.js`) | `host.removeable` is constant-true in autobee 1.0.10; sole-indexer self-removal bricks governance (still convergent) |

---

## 3. Findings detail

### B1 (blocker) — Revocation race diverges peers; violates I10 and I2

**Repro (deterministic, 100% over 3/3 and every harness run):**

- `node --test test/regressions/revocation-race-divergence.test.js` — asserts
  the invariant (peers converge) and **fails today**.
- Harness scenario S6: `HARNESS_PROFILE=clean node --test
  harness/scenarios/s06-revocation.test.js` (also fails at lossy and
  partitioned; seed is logged, e.g. seed=7).

**Construction:** A (genesis indexer) admits C, converges. Partition
{A} | {C}. C appends `SetField(agents/c/InFlight, …)` while partitioned.
A appends `RemoveWriter(C)` before that op replicates. Heal, drain.

**Observed:** peers do **not** converge.
- A: `seen/C = 1`, `n/agents/c/InFlight/base` absent, **no** `flag/rejected`
  for the op — A **never linearized it and never presented it to `apply`.**
- C (and any fresh peer that replayed both cores): `seen/C = 2`, the op
  **applied**, no rejection.
- Two independent view hashes, permanently. (Measured: `a=e33589ed…`,
  `c=e889a830…` on one run; different every run only because keys are random,
  the *divergence* is invariant.)

**Expected (spec §8.3, I10):** C's racing op is judged solely by its
op-embedded `clock` against `ctx/gov/removed/<C>`, uniformly on every peer:
either it causally precedes the revocation (accepted everywhere) or it does
not (rejected everywhere under `flag/rejected/<C>/<seq>` reason `revoked`).
Either way, one convergent view (I2). The spec is explicit that positional
revocation was *considered and rejected* for exactly this reason
(§8.3, final paragraph).

**Root cause (code):** revocation is delegated to the substrate's positional
mechanism instead of being resolved purely by core's clock rule.
- `packages/core/lib/apply.js:453-457` (`opRemoveWriter`) calls
  `host.removeWriter(op.key)`.
- `packages/store/lib/vault.js:475-477` (`HostAdapter.removeWriter`) forwards
  to autobee `host.removeWriter`.
- autobee `lib/system.js:47-53` records the removal at the writer's
  *current length as known to the remover* (`get(key,{unflushed:true})`,
  `length`), and its linearizer excludes that writer's nodes at/after that
  length. On A the recorded length precedes `InFlight`, so `InFlight` is
  never linearized on A; a peer that linearized `InFlight` before the
  `RemoveWriter` node keeps it. The concurrent node's linearization
  *membership* differs between peers, which core cannot repair because core's
  §8.3 reject only runs for nodes that **are** linearized.

Note: `DEVIATIONS.md` §13(d) asserts "the in-log clock rule still governs ops
that raced the revocation." **This harness disproves that claim** for ops
concurrent with the removal across a partition — the clock rule never runs on
the remover because the node is dropped below `apply`. This is one of the two
"UNVERIFIED/expected-target" items the supervisor asked to clear: it is now a
confirmed finding, not a cleared assumption.

**Proposed fix (sketch):** stop delegating revocation to the substrate's
positional removal and let core's already-implemented clock rule do all the
gating.
- In `apply.js opRemoveWriter`, keep writing `ctx/gov/removed/<W> = clock`
  (already done) but **do not** call `host.removeWriter`. Leave the writer
  admitted at the autobee level so *every* one of its nodes continues to
  linearize on every peer and is presented to `apply`, where the existing
  §8.3 check (`applyNode` lines 265-272, `clockDominatedBy`) accepts/rejects
  it deterministically by clock. This is exactly the spec's chosen design and
  makes the applied/rejected partition a pure function of op clocks again.
- Cost/trade-off: a revoked writer's core keeps replicating and growing (no
  substrate-level GC of its blocks). The spec already accepts unbounded
  retention as a design decision, so this is acceptable; if block-level GC is
  later wanted, it must be driven from the in-log removed-clock, not from
  autobee's positional state. Also lose autobee's "Not writable" self-teardown
  of the revoked instance — replace with an app-level guard that refuses local
  appends once `ctx/gov/removed/<self>` dominates the local clock.
- Validation: `test/regressions/revocation-race-divergence.test.js` and S6
  must go green (converge, with C's post-revocation op uniformly rejected
  `revoked` on all peers), and the existing I10 triple-replay unit test
  (§8.3 incremental/from-scratch/reorg) must stay green.

### M1 (major) — Null-base `SetBody` fan-out is quadratic

**Repro:** `node --test test/regressions/setbody-null-base-quadratic.test.js`
(passes today — it *documents* the pathological growth). Measured on a
MemView:

| null-base SetBody ops on one subject | `flag/conflict` rows | apply time |
|--------------------------------------|----------------------|-----------|
| 50 | 1,225 | 65 ms |
| 100 | 4,950 | 346 ms |
| 200 | 19,900 | 2.47 s |
| 400 | 79,800 | 23.5 s |

**Observed:** two independent cost problems in `opSetBody`, both rooted in the
same full-revision rescan:
- **Apply cost, universal.** Every `SetBody` scans the subject's entire
  `n/<s>/rev/*` set (`apply.js:826-834`) to find same-base concurrency, so R
  revisions cost O(R) per op and O(R²) per subject *regardless of base*.
  Measured on a chained (base=head, zero-conflict) sequence: 100 ops 24 ms,
  200 ops 66 ms, 400 ops 247 ms — total time growing ~quadratically. Under
  sustained multi-writer body load this compounds until a single apply
  exceeds the harness's 120 s command budget and the writer process is
  declared dead — which killed two soak runs before `SetBody` was excluded
  from the leak workload.
- **Flag blowup, null-base/concurrent.** §6 treats two revisions citing the
  same base as concurrency and writes `flag/conflict/<s>/<a>/<b>`; a null base
  counts as a shared base, so N null-base bodies on one subject yield
  N-choose-2 conflict rows (50→1,225; 100→4,950; 200→19,900; 400→79,800; the
  table below), on top of the O(R²) scan.

**Expected:** a single writer must not be able to explode every peer's view
and stall apply. Determinism (I1/I2) is *not* violated — every peer computes
the same explosion — so this is a resource/availability defect, mapped to the
assignment's §3 "backpressure and resource leaks" target ("unbounded revision
retention is a known design decision; unbounded memory is a bug"; here it is
unbounded *conflict-flag* state and apply time, quadratic in one subject's
edits).

**Root cause (code):** `apply.js opSetBody`, the conflict-detection loop at
lines 826-834 — a full `n/<s>/rev/*` scan on every op that pairwise-conflicts
against *every* prior same-base revision, with null treated as a shared base
and no cap. The scan is the apply-cost driver; the pairwise-flag write is the
flag-blowup driver.

**Proposed fix (sketch):** (1) replace the full-revision scan with an index
keyed by base (e.g. `revbybase/<s>/<base>/<rev>`) so same-base concurrency is
found in O(matches), not O(R) — removes the universal O(R²); (2) bound the
conflict fan-out: only pairwise-conflict the incoming revision against the
*current head* when bases match (O(1) flags), or treat a null base as "no base
cited" and raise no mutual conflict among independent null-base creations
(they are LWW on the head pointer), reserving `flag/conflict` for the
same-*non-null*-base case; optionally cap per-subject flags with an overflow
marker. All keep I4 (the head pointer and every revision are still retained
and observable — no silent loss) while bounding growth. Update the
regression's exact-count assertions to the new bound when fixed.

### M2 (major) — Throughput collapse under concurrent multi-writer lossy load

**Repro:** `SOAK_SLEEP=80 node harness/soak/soak.js` (or the default rate on
the initial soak). Observed on **every** high-rate run (3+ independent runs),
always the same shape.

**Observed:** with three writers each attempting ~12 ops/s of *bounded* O(1)
ops (setField/addMember — SetBody excluded, so this is not M1) over lossy
links, the op counts diverge wildly — one writer races ahead (e.g. w1=1535
ops at t=270s) while the other two, busy folding the flood, reach only
~100–420 ops. Then a `call` on the fast writer stalls and trips the 120 s
command timeout, killing the run at ~4.5 min. Isolating factor: a *single*
writer flooding a second peer is perfectly flat (measured 3 ms/op append,
~54 ms converge, constant from 200 to 1600 accumulated ops — no latency
growth), so this is not raw node-count apply cost — it is a **concurrency
feedback loop**: whichever writer gets ahead keeps its event loop free (little
to apply) and floods faster, while the peers drown applying and fall further
behind, until an op cannot complete within budget.

Crucially, **this is not a memory or FD leak** — across all runs RSS stayed
bounded (~700–920 MB), heap bounded (~90–212 MB), and open FDs bounded
(~25–45). The only unbounded growth is the on-disk Corestore directory
(append-only log + revisions), which the spec designates a known design
decision. So §3's "unbounded memory is a bug" is *satisfied*; the defect is
throughput/latency under load, not memory.

**Expected:** sustained multi-writer load should degrade gracefully (writers
throttle to fold-rate) rather than one writer starving the others into a
command-timeout stall.

**Root cause:** a fairness/backpressure gap between local append and apply.
`vault.append` (`store/lib/vault.js:323-332`) appends unconditionally at the
caller's rate; it never yields to or waits on the local fold, so a fast writer
can outrun every peer's apply. Under autobee, the peers' `update()` fold of the
growing concurrent DAG then dominates their event loop and delays their own
appends and IPC responses. There is no store-level admission control tying a
writer's append rate to the slowest peer's fold progress.

**Proposed fix (sketch):** add optional local backpressure — e.g. have
`append` (or a soak/production write path) await `updated()`/a bounded
in-flight-ops watermark before issuing the next op, so a writer self-throttles
to the fold rate instead of flooding. This is a store/client-layer concern
(the invariant layer is unaffected: peers stay converged *during* a
sustainable-rate run). Document the sustainable-rate envelope. The harness
demonstrates the fix direction: throttling to ~2.5 ops/s/writer with a per-op
`update()` eliminates the flooding feedback loop — all three writers stay
balanced (final op counts 3,235/3,601/3,736 vs 1,535/101/421 at the unthrottled
rate) and the soak sustains the full 30.5 min with no op timeouts (§6). The
separate post-load bulk catch-up of the accumulated backlog remains
throughput-limited (§6 caveat) and is the same underlying fold-rate ceiling.

### O1 (minor) — `host.removeable` is a constant `true`; last-indexer removal unguarded

**Repro:** harness `ADV4` (`adversarial.test.js`), passes but records the
outcome in the run's `NOTES.txt`: after a sole indexer removes itself, its
later writes error `"Not writable"`.

**Observed / resolves DEVIATIONS.md UNVERIFIED item (1):** autobee 1.0.10's
`host.removeable(key)` returns `true` unconditionally (confirmed in source and
by ADV4). The store's guard
`packages/store/lib/vault.js:483-485 (HostAdapter.removeable)` and core's
`apply.js:454` therefore provide **no** protection — removing the last indexer
is permitted. The vault stays *convergent* (both peers agree on one hash, reads
work), but becomes **ungovernable**: the ex-indexer is "Not writable" at the
autobee level, yet still recorded `indexer:true` in `ctx/gov/writer/<self>`
(`opRemoveWriter` writes `ctx/gov/removed` but never deletes the `govWriter`
record), so no one can issue further governance ops. No invariant is violated
(this is a liveness/robustness gap, not I-safety), hence minor.

**Proposed fix (sketch):** in `apply.js opRemoveWriter`, refuse (reject
`policy-governance`, or no-op with an audit flag) a `RemoveWriter` that would
drop the last confirmed indexer as counted from `ctx/gov` — the governance
authority core already owns — rather than trusting `host.removeable`. This is a
pure-view decision and stays deterministic.

---

## 4. Unproven concerns (static suspicions I could not turn into a failure)

1. **`JSON.stringify`-of-record feeding the view hash (I1/I2 fragility).**
   `store/lib/view.js` and `store/lib/hash.js` hash `JSON.stringify(value)`;
   apply builds records by mutating parsed objects, so cross-peer key-insertion
   order is identical *only because* converged peers execute the identical
   mutation sequence. I tried to break it with permutation replay (S1, S3, S5 —
   independently linearized universes) and seeded fuzz; hashes stayed
   bit-identical every time. It is empirically safe today but remains a latent
   trap: any future code path that constructs a logically-equal record via a
   different key-insertion order on different peers would silently diverge.
   Recommend switching the hash/value encoding to `canonical.stableStringify`
   (already present) to make it structural rather than insertion-ordered.

2. **Rate-limit partition above `signedLength` (I10 scoped clause).** The spec
   scopes rate-policy reorg-stability to "at or below `signedLength`". autobee
   has no separate signing pipeline (`signedLength === length`; DEVIATIONS.md
   §13(c)), so there is no substrate region where the rate partition may
   legitimately differ, and §11 quorum-signed snapshots are future work. I
   could not construct a rate-partition divergence (token buckets are pure
   functions of the linearized indexer-op count), and every fuzz/lossy run
   converged, but this clause is effectively untested against a real signing
   checkpoint because the substrate has none. Flag as a spec/substrate gap, not
   a defect.

3. **Optimistic hold-buffer under revocation interplay.** `opRemoveWriter`
   purges `n/hold/<W>` for a never-confirmed writer (apply.js:437-450). I
   exercised optimistic onboarding (store unit tests) and revocation (B1)
   separately but did not construct the *combined* race (optimistic writes in
   flight + revocation of the never-acked writer across a partition). Given B1's
   substrate-level linearization divergence, this combination is worth a
   dedicated scenario once B1 is fixed; I did not get a reproduction and do not
   claim one.

---

## 5. Harness deliverables

Everything below is committed on `6/harness` (atomic commits; not pushed).

### Harness (`/harness`, usage-first `harness/README.md`)
- **Real processes:** one `child_process.fork` writer per peer
  (`harness/lib/writer.js`), each with its own Corestore dir under
  `sslop/017/tmp/<run>/<writer>/` (never `/tmp`, never deleted; handles
  closed). Control channel over fork IPC: append/appendRaw (poison ops),
  arbitrary Vault `call`, `hash` (snapshot-view-hash = full ordered range
  scan), dump, link/unlink (pause/resume replication), materialize/
  exportTurtle/ingest, stats (RSS/FD), crash (SIGKILL), restart.
- **Fault proxy** (`harness/lib/hub.js`): every replication byte between two
  processes passes through a per-direction pipe with seeded latency, jitter,
  probabilistic stalls, kill-mid-frame, and hard partition. All fault
  decisions come from per-direction children of the run RNG and are logged.
  (Delivery uses absolute-time watermark scheduling so latency is *pipelined*,
  not serialized — the naive serial version compounded per-chunk delay into an
  unbounded backlog under sustained load, an artifact I found and fixed while
  bringing the soak up.)
- **Controller** (`harness/lib/controller.js`): spawns writers, owns the hub,
  barriers, partition/heal, the **convergence oracle** (`quiesce`: equal
  hashes on two consecutive rounds with a forced `update()` between — a wrong
  "synced" signal cannot make it vacuous, validated by ADV3), key-by-key
  `diffViews`, and **permutation replay** via `cloneUniverse` (close writers,
  copy cores, reopen copies, heal in a different order; same keys → directly
  comparable hashes). Seeds are logged; every run replays from `HARNESS_SEED`.
- **Independent I8 checker** (`harness/lib/coherence.js`): a from-scratch
  reimplementation of the idx/bl/fidx/…-from-n derivation, importing nothing
  from `@hyperwiki/core` — used by S9 and the fuzz so coherence is checked
  against an independent oracle, not the code under test.

### Scenario suite S1..S10 + adversarial (`harness/scenarios/`), wired to pnpm
`test:harness:clean` / `:lossy` / `:partitioned` / `:fuzz` / `:soak`, plus
`test:regressions`. Every scenario names the invariant it validates and runs
at all three fault profiles (clean on every push; lossy/partitioned nightly —
these are pnpm scripts, no external CI config needed per the ground note).

| scenario | invariant | result |
|----------|-----------|--------|
| S1 LWW arrival independence | I6 | pass (clean/lossy/partitioned) |
| S2 OR-set add/remove race + unobserved-tag remove | I5 | pass |
| S3 dangling→materialize takeover, both heal orders | I7 | pass |
| S4 concurrent same-base SetBody | I4 | pass |
| S5 policy-epoch reorder | I1 | pass |
| S6 revocation race | I10 | **FAILS → B1 (intended repro)** |
| S7 crash mid-apply + rebuild-from-scratch | I3 | pass |
| S8 face determinism + minimal ingest | I9 | pass |
| S9 index coherence under churn (independent checker) | I8 | pass |
| S10 seeded fuzz + shrink | I1/I2/I8 | pass (clean & partitioned sweeps) |
| ADV1 keyspace injection | §3 | pass |
| ADV2 poison op containment | I4/§3 | pass |
| ADV3 quiescence self-check | §3 | pass |
| ADV4 sole-indexer self-removal | §3 | pass → O1 |
| fuzz-shrink (machinery self-test) | — | pass |

S6 fails **by design**: it encodes the invariant B1 violates. Treat the
scenario suite as green except S6 until B1 is fixed.

### Fuzz (`harness/lib/fuzz.js`, `harness/scenarios/s10-fuzz.test.js`)
Seeded generation of random op schedules across 3–5 real writer processes,
including malformed raw ops, unknown msgids, garbage base hashes, oversized
subjects, and hostile subject names, with random partition schedules;
convergence + independent-I8 check after every heal. Greedy shrinker
(`shrinkSchedule`, self-tested by `fuzz-shrink.test.js`) and `saveRegression`
persist minimal repros to `test/regressions/*.json`. Clean and partitioned
sweeps found **no** new convergence/coherence divergence (one partitioned run
hit a bring-up timeout under machine load, reproduced-green standalone → a
harness-timing false positive, since hardened by raising the writable budget).

### Committed regression repros (`test/regressions/`)
- `revocation-race-divergence.test.js` — minimal 2-writer shrink of S6 (B1);
  fails until B1 is fixed.
- `setbody-null-base-quadratic.test.js` — bounds the M1 quadratic growth;
  passes as documentation, tighten to the fixed bound after M1 is resolved.

`pnpm test` (the library suite, 111 tests) stays green — regressions live in a
subdirectory the library glob does not match, and run via `pnpm
test:regressions`.

### 30+ minute lossy soak (`harness/soak/soak.js`)
32-minute sustained-write soak at the lossy profile with periodic
partitions/heals, sampling per-process RSS, heap, open FDs, and Corestore
directory size every 30 s to `<run>/soak.csv`. Measurements and the
leak verdict are in §6.

---

## 6. Backpressure / leak soak measurements

Run: `harness/soak/soak.js`, seed=170717, lossy profile (200ms ±150ms
jitter, 5% stalls), 3 real writer processes, **30.5 minutes of sustained
writes** (1,831 s), one midpoint partition/heal, bounded O(1) ops
(setField/addMember; SetBody excluded — M1), self-throttled to ~2.5
ops/s/writer to stay within fold budget (M2). 249 samples at 30 s cadence to
`<run>/soak.csv`. Final op counts w0/w1/w2 = 3,235 / 3,601 / 3,736.

| t (s) | RSS (MB) w0/w1/w2 | heap (MB) w0/w1/w2 | FD w0/w1/w2 | dir (MB) w0/w1/w2 | ops w0/w1/w2 |
|------:|-------------------|--------------------|-------------|-------------------|--------------|
| 0     | 84 / 86 / 85      | 17 / 20 / 18       | 25/25/25    | 0.3 / 0.3 / 0.3   | 0/1/1        |
| 300   | 838 / 821 / 828   | 154 / 108 / 132    | 39/33/39    | 116 / 87 / 125    | 470/571/495  |
| 600   | 803 / 793 / 802   | 182 / 153 / 178    | 46/38/46    | 301 / 247 / 286   | 918/1128/972 |
| 900   | 803 / 786 / 792   | 183 / 122 / 139    | 41/44/41    | 514 / 398 / 509   | 1365/1680/1446 |
| 1200  | 815 / 813 / 794   | 168 / 190 / 186    | 48/43/47    | 711 / 575 / 557   | 1900/2246/2134 |
| 1500  | 811 / 840 / 767   | 205 / 160 / 148    | 61/45/41    | 838 / 743 / 559   | 2518/2873/2859 |
| 1831  | 856 / 869 / 806   | 143 / 205 / 188    | 69/54/41    | 1077 / 928 / 578  | 3177/3545/3666 |

**Leak verdict — no memory or FD leak.**
- **RSS** bounded across the whole run: 84 MB at start (cold), ~800 MB steady
  state by 5 min, range 84–877 MB, **no upward trend** after warm-up.
- **Heap** bounded, 17–221 MB, oscillating with GC, no trend.
- **Open FDs** bounded and sub-linear in op count: 25 → 41–71 (w0, the peer
  that folded the most, peaked at 71). This is a modest climb consistent with
  RocksDB SST handles + replication streams, **not** a per-op leak (a leak
  would be thousands of FDs after ~3,500 ops).
- **Corestore directory** grows roughly linearly with applied ops
  (append-only log + never-pruned revisions) — the spec's documented
  unbounded-retention design decision, not a bug.

**Caveat (feeds M2).** After writes stopped, the final heal+quiesce did **not**
fully converge within the 300 s budget: w0 and w1 reached one identical hash
(`a7e8a1c4…`) while w2 was still folding its backlog (`852e3b72…`, and its dir
was ~500 MB *smaller* — strictly *behind*, i.e. less applied, not divergent
state). This is the M2 catch-up-throughput limit, not an I2 divergence
(divergence would show equal data volume with unequal hashes; here w2 simply
had not finished applying). At the throttled write rate the peers stayed
converged *during* the run (each `update()` kept views current); it is the
post-load bulk catch-up of ~10.5k accumulated ops that the 300 s window did
not cover.

---

## 7. Status of the two supervisor-flagged UNVERIFIED items

- **`host.removeable` exactness (DEVIATIONS.md UNVERIFIED #1):** RESOLVED as a
  finding — `removeable` is constant `true` in autobee 1.0.10; the last-indexer
  guard is a no-op (finding **O1**), and the substrate's positional
  `removeWriter` is the mechanism behind the **B1** blocker. DEVIATIONS.md
  §13(d)'s claim that "the in-log clock rule still governs ops that raced the
  revocation" is disproven by S6.
- **§3 review-prompt targets (DEVIATIONS.md UNVERIFIED #2 / assignment §3):**
  exercised against real autobee — purity (no wall clock / RNG / map-order /
  locale in the apply path; confirmed by grep and by permutation-replay hash
  equality), async discipline (every view mutation and internal async call is
  awaited — no floating promises), keyspace injection (ADV1), poison-op
  containment (ADV2), quiescence honesty (ADV3), and governance plumbing
  (S6/ADV4). All cleared except the two findings above.
