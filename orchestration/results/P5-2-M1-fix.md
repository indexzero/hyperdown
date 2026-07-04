# P5-2 — M1 fix: SetBody quadratic conflict fan-out

Status: DONE. Commit `7222bf0` on `6/harness`
("fix(core): M1 — null-base SetBody no longer conflicts; base-keyed rev
index kills the O(R^2) rescan"). No push, no PR.

## What was done

Finding M1 named two independent costs rooted in `opSetBody`'s
full-revision rescan; both are fixed exactly per the sketch.

### 1. Base-keyed revision index (kills the universal O(R²))

New bookkeeping family `revbybase/<s>/<base>/<rev>`
(`packages/core/lib/keyspace.js`, `revByBase`/`revByBasePrefix`).
Same-base concurrency is now found by a prefix scan of the incoming
revision's own base — O(matches) — instead of scanning every
`n/<s>/rev/*` row (was `apply.js:826-834`). Maintained at all three
revision-writing/removing sites in `packages/core/lib/apply.js`:

- `opSetBody` — puts `revbybase/<s>/<base>/<rh>` when creating a
  revision with a non-null base;
- `opResolveConflict` — the merged revision (base = `keep`) is indexed
  like any other;
- `opPruneRevisions` — deletes the pruned revision's index row, keeping
  the index exactly derivable from `n/<s>/rev/*`.

Bookkeeping-family treatment (documented in code comments in
keyspace.js and apply.js, like `seen/`): the I2/I3 view hash is a
full-range scan (`packages/store/lib/hash.js`, `MemView.hash()`), so the
index is **included in the view hash** automatically and its writes are a
pure function of the linearized log (rebuild equality holds — S7/I3
green below). Materialize and export scan only `n/`, `ctx/` and
`idx/spo/` (`packages/faces/lib/state.js:61,116`, `turtle.js:76`), so the
family is **excluded from materialize/export** with no code change.

### 2. Bounded conflict fan-out (kills the N-choose-2 flag blowup)

Implemented the sketch's null-base rule: a null base is "no base
cited". Independent null-base creations are LWW on the head pointer and
raise **no mutual `flag/conflict`**; `flag/conflict` is reserved for two
revisions citing the same **non-null** base. §6 semantics are kept for
true same-base concurrency: both revisions retained (I4), head set
deterministically (LWW under linearization, unchanged), exactly one
conflict flag per pair, cleared only by `ResolveConflict`.

Deviation from a literal §6 reading recorded in `DEVIATIONS.md`
("§6 a null `base` is 'no base cited', never a shared base").

Bounding-rule notes (vs. the sketch's alternatives):

- Cross-writer supersession among null-base creations is still surfaced
  — the existing §5.4 `flag/clobber` branch in `opSetBody` now fires for
  them (it was previously suppressed because every null-base pair was
  "conflicted"). O(1) flags per op, linear total, nothing silent (I4).
- I did **not** adopt the "conflict only against the current head"
  variant or a per-subject flag cap: §6 says same-base concurrency MUST
  write `flag/conflict`, and S4 asserts exactly one flag for a true
  pair. Pairwise flags for same-non-null-base siblings remain, found in
  O(matches); creating k same-base siblings requires deliberately citing
  an existing revision hash k times (a non-null base that doesn't resolve
  rejects as `garbage-base`), so the accidental/ingest-loop pathology
  (null base) is gone and the remaining fan-out is bounded by real,
  intentional concurrency on one revision.

### Consequential fixture updates (old semantics were baked in)

- `test/i07-flag-lifecycle.test.js` — the two conflict fixtures now cite
  a real shared seed revision (`base: r0`) instead of relying on
  null-as-shared-base; assertions unchanged (persist-until-resolve,
  ClearFlag rejected, ResolveConflict-with-text merge). ResolveConflict
  flow green.
- `examples/recipe-book/index.js` — Basil posts a converged draft body
  in phase 1; the phase-2 concurrent rewrites by Basil and Dill both
  cite that draft, so the example still demonstrates a §6 conflict
  (narrative output unchanged: 1 clobber, 1 conflict, drained to 0).
  Committed `out/` regenerates **byte-identically** (git diff empty
  after `node examples/recipe-book`), so no out/ churn.
- `test/regressions/setbody-null-base-quadratic.test.js` — rewritten
  from "documents the pathological growth" to asserting the fixed bound
  (details below).

## Completion criteria — raw output tails

### 1. Updated setbody regression (new bound, ~linear time, 400-op case ≪ 1s)

`node --test test/regressions/setbody-null-base-quadratic.test.js`:

```
✔ null-base SetBody raises no mutual conflicts and applies in ~linear time (43.479959ms)
✔ chained SetBody (base = head) no longer pays an O(R) scan per op (344.700334ms)
✔ cross-writer null-base supersession is surfaced via §5.4 clobber, not §6 conflict (0.955292ms)
✔ true same-non-null-base concurrency still yields exactly one conflict flag (§6) (0.887167ms)
ℹ tests 4
ℹ pass 4
ℹ fail 0
ℹ duration_ms 451.597959
```

The first test folds 10/40/80 **and 400** null-base ops asserting
0 conflict flags, all revisions retained, head = last revision, and
`assert.ok(ms < 1000)` on the measured 400-op apply time (actual: the
whole 10+40+80+400 sequence completes in ~43 ms; was ~23.5 s for the
400-op case alone). The chained test asserts 400 base=head ops < 1 s
(actual ~345 ms, dominated by MemView's sort-per-scan test double, not
apply's algorithm). Before the fix the growth was 45/780/N-choose-2.

### 2. `pnpm test` — 111/111 (I3/I8 unaffected, ResolveConflict green)

```
ℹ tests 111
ℹ suites 0
ℹ pass 111
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 12638.608708
```

(Baseline before the change was also 111/111; the recipe-book I9 test
regenerates the committed out/ byte-identically with the new example.)

### 3. `pnpm test:regressions` — all pass

```
✔ cross-writer null-base supersession is surfaced via §5.4 clobber, not §6 conflict (1.077791ms)
✔ true same-non-null-base concurrency still yields exactly one conflict flag (§6) (0.941959ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ duration_ms 6457.111541
```

### 4. `pnpm test:harness:clean` — full matrix green

```
✔ S9: idx/* and bl/* exactly derivable from n/* under churn (I8) (3826.18ms)
...
✔ S10: seeded fuzz x3 (convergence + I8 after every heal) (9792.118834ms)
✔ smoke: two-process convergence through the fault proxy (1109.836458ms)
ℹ tests 17
ℹ suites 0
ℹ pass 17
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 66965.309417
```

S4 (body-conflict — the criterion's named scenario) rerun standalone for
an explicit line (it uses a non-null shared base, i.e. the preserved §6
path):

```
[harness] run=s04-47815-mr5x0c8n seed=2438226679 profile=clean
✔ S4: concurrent same-base SetBody keeps both revisions + one conflict flag (I4) (1840.257209ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

Also green in the matrix: S7 SIGKILL/rebuild-from-scratch equality (I3
with the new index in the hashed range) and S10 fuzz, whose workload
includes null-base `set-body` ops.

## Files changed (commit 7222bf0)

- `packages/core/lib/apply.js` — opSetBody conflict loop replaced;
  index maintenance in opSetBody / opResolveConflict / opPruneRevisions
- `packages/core/lib/keyspace.js` — `revByBase`, `revByBasePrefix`
- `test/regressions/setbody-null-base-quadratic.test.js` — fixed-bound
  assertions
- `test/i07-flag-lifecycle.test.js` — conflict fixtures cite a real base
- `examples/recipe-book/index.js` — §6 conflict cites a converged draft
  (out/ byte-identical)
- `DEVIATIONS.md` — §6 null-base entry
