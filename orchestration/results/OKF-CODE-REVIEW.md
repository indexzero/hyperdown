# OKF-CODE-REVIEW — T10 adversarial code review + remediation

**Reviewer role:** hostile reviewer / test engineer, did not write the code.
**Branch:** `17/okf-review` (off `16/okf-harness`). **Bar:** SPEC-FINAL v1.2
`okf/SPEC.md` §11 invariants I1..I11. **Method:** harness-grounded — every
claimed defect ships a failing repro (PRIME DIRECTIVE: no repro, no finding);
static suspicions live in the unproven/measured appendix.

## Verdict

Two real defects were found, both with deterministic repros, both FIXED and
regression-guarded: a **BLOCKER** poison-op that halted every peer's fold
(§3/I1/I10), and a **MAJOR** identity-capture in the ingest watcher (§6 P1).
Both fixes hold across the full S1–S10 matrix at clean/lossy/partitioned, a
40-iteration seeded fuzz, and the complete `pnpm test` suite (120 okf unit
tests + regressions). **No divergent view hash was produced under any seed in
any controlled test** — the invariant suite, the S1–S10 matrix at all three
fault profiles, and fuzz×40 all converge, and permutation-replay hashes are
identical. Of the 7 spec residual minors P1–P7, six are handled in code (P1
was reachable and is now fixed) and one (P7) is a genuine minor gap, filed as
issue #28.

The 22-minute sustained multi-writer lossy soak surfaced **one open MAJOR
concern (C1)**: memory grew monotonically (no plateau) to ~3.1 GB RSS /
~1.0 GB heap on the two merge-heavy writers, and the run **did not converge
within the 5-minute heal window** — the third peer's replication link starved
under the flood (it appended all 685 of its own ops but received only ~36 MB
of the ~56 MB of peer blocks) and fell too far behind to catch up. Crucially
this is **liveness, not a determinism divergence**: the two caught-up peers
produced byte-identical views (`6d92…`), so apply is a pure function of its
folded prefix; the lagging peer merely folded a smaller prefix, and CRDT
determinism guarantees it reaches the same hash once it receives the blocks.
FDs stayed bounded (~33) throughout; no process crashed/OOMed. This is an
M2-class resource/liveness interaction (the vault-ld sibling sustains the
identical soak config; okf's far heavier per-op view keyspace amplifies it
past in-window convergence). It is substrate/harness-entangled and I could
not isolate a deterministic per-op okf repro, so per PRIME DIRECTIVE it is a
named open concern for substrate-level follow-up, **not a proven blocker**.

**VERDICT: G4-PASS with C1 named** — the two proven code defects are fixed and
green; no determinism divergence exists under any seed; C1 is an unresolved
resource/liveness measurement (no isolated repro, no determinism violation)
that the supervisor should weigh before shipping under sustained-flood load.

## Findings table

| id | severity | invariant | repro | title |
| -- | -------- | --------- | ----- | ----- |
| F1 | **BLOCKER** | §3, I1, I10 | `okf/test/regressions/poison-apply.test.js` (+ `sslop/037/poison-setfield.mjs`) | Poison `SetField` typed-literal throws out of apply → every peer's fold halts permanently |
| F2 | **MAJOR** | §6 (P1), I11 | `okf/test/regressions/squat-mint-ingest.test.js` (+ `sslop/037/squat-mint-id2.mjs`) | Ingest trusts the op tag as the mint id → a squatter captures an ingested file's fields |
| C1 | **MAJOR (open)** | §3 backpressure / liveness | soak CSV (below) — not an isolated per-op repro | sustained lossy soak: RSS grows to ~3.1 GB (no plateau) on merge-heavy writers and the run does not converge in the 5-min heal window (one peer's replication starves). Liveness, not determinism (healthy peers byte-identical). Substrate-entangled; supervisor to weigh |
| P7 | minor | §9 | static (issue #28) | ingest strips only one `.conflict-<hex>` suffix; a human double-suffix file is permanently pending-ingest |

## Findings detail

### F1 — Poison `SetField` halts every peer (BLOCKER)

**Repro (deterministic, no substrate):** `node sslop/037/poison-setfield.mjs`
— a `create-concept` then `set-field { key:'count', value:{ value:'abc',
datatype:'xsd:integer' } }`.

**Observed (pre-fix):** apply throws `TypeError: not an integer lexical: abc`
straight out of the apply function.
**Expected:** the op is contained per-op (`flag/rejected`), apply never
throws (§3: "Undecodable/oversize ops are rejected … apply MUST NOT throw";
I1 determinism; I10 "every node must keep linearizing on every peer").

**Root cause:** `SetField.value` is wire type **`json`**
(`okf/core/schema/build.js:65`), so an op can legally carry a typed literal
`{ value, datatype }`. `okf/core/lib/apply.js` `opSetField` called
`canonicalArray(op.value)` with no guard; `canonicalArray → canonicalValue →
canonicalLexical` routes `xsd:integer` / `xsd:decimal` / `xsd:dateTime` /
`xsd:date` through the strict `canonicalInteger` / `canonicalDecimal` /
`canonicalDateTime` converters (`okf/core/lib/canonical.js`), which **throw**
on a bad lexical. The top-level apply loop had **no per-node try/catch**, so
the throw propagated through autobee's `_apply` and halted the fold — and
since the op is durably in the log, every I3 rebuild re-threw forever. This
is reachable through the ordinary `vault.setField(id, key, value)` API — no
raw-bytes crafting needed.

**Fix (`b57b54f`, `okf/core/lib/apply.js`):** (1) `opSetField` wraps
`canonicalArray(op.value)` and rejects a non-canonicalizable value as
`bad-value`; (2) the apply loop wraps every node in a last-resort
containment net that discards the partial tx and records a deterministic
rejection (`seen/` + `ord/` + `flag/rejected` reason `apply-error`) — so no
future/unknown throw can ever halt a peer. Both paths are pure over the
linearized prefix; the regression asserts batched vs. per-node apply produce
an identical view hash (I1/I2). `SetField.value` is the only arbitrary-JSON
field in the wire schema (every other op field is `string`/string-array), so
`opSetField` is the only reachable throw site; the net covers the rest.

### F2 — Ingest identity-capture via a squatted mint id (MAJOR)

**Repro (real store + ingest):**
`okf/test/regressions/squat-mint-ingest.test.js`; the underlying
store-contract fact is shown by `node sslop/037/squat-mint-id2.mjs`
("BUG … : CONFIRMED").

**Observed (pre-fix):** when a squatter pre-adopts writer E's future mint id
`Ekey‖0` **before E is admitted** (allowed — E is not yet a known writer, so
§6 `mint-collision-risk` does not fire), E's first mint hits the §6
squat-proof fallback and the genuine concept gets a `SHA-256` id, while
`c/Ekey‖0` remains the squatter's concept. The store's `createConcept`
returns `{ seq, tag: makeTag(local.key, seq) }` = `Ekey‖0`, and the ingest
watcher's `_create` used that tag as the concept id for its follow-on
frontmatter/body diffs — so a minted file's `title`/body ops were written
onto the **squatter's** concept (identity capture / silent misrouting);
the genuine concept was orphaned with no fields.

**Expected:** §6/§9 P1 — "the assigned id is knowable only after the create
applies … and MUST be read from the view", never computed or assumed from
the op tag.

**Root cause:** `okf/faces/lib/ingest.js` `_create`:
`conceptId = id !== undefined ? id : res && res.tag`. The squat-fallback
branch of `opCreateConcept` is genuinely reachable (the committed
`adversarial.test.js` "squat on an UNKNOWN future writer" exercises it), so
`res.tag !== <minted id>` is a real state.

**Fix (`5987841`, `okf/faces/lib/ingest.js`):** `_create` resolves the minted
id from the view via new `_resolveMintedId(tag, path)` — common no-squat case
is O(1) (`cMeta(tag).created === tag → tag`); on a squat it finds the genuine
concept by `path/<path>` (whose `meta.created === tag`) or a `c/` scan. Never
trusts the op tag for identity. Regression confirmed RED before / GREEN after.

### C1 — Soak: unbounded-looking memory + in-window non-convergence (MAJOR, open)

See the soak table. Two findings from the single 22-min run:

1. **Memory did not plateau.** RSS on the two merge-heavy writers (w0 kept
   writing through the midpoint partition, w1 was the isolated peer) climbed
   monotonically 85 MB → ~3.1 GB, heap 18 MB → ~1.0 GB, with no plateau by
   end. The third peer (w2) stayed flat at ~1.65 GB **because it had stalled
   receiving peer blocks** (see 2), i.e. its low memory is a symptom of the
   stall, not a healthy steady state. Higher and less-bounded than the
   vault-ld baseline (~0.7–0.9 GB, which the prior review measured as
   bounded/plateauing on the *same* substrate under the *same* soak config).

2. **The run did not converge in the 5-min heal window.** At final quiesce
   `w0 == w1` (identical `6d92…`) but `w2` was on a different hash (`09bf…`).
   Diagnosis: w2 appended all 685 of its own ops normally, but its corestore
   dir stopped growing ~t=1000 s at ~36 MB while w0/w1 reached ~56 MB — w2's
   **replication link starved** under the sustained lossy flood and it never
   received the peers' later blocks, so at heal it was ~20 MB (hundreds of
   ops) behind and could not catch up within 300 s.

**Why this is NOT a determinism/I2 divergence:** the two caught-up peers are
byte-identical, so apply is a pure function of the folded prefix; w2 folded a
smaller prefix. CRDT determinism (proven by w0==w1, by the S1–S10 matrix at
all profiles, and by fuzz×40) guarantees w2 reaches `6d92…` once it receives
the blocks. This is an **M2-class liveness/backpressure interaction** under
sustained flood, amplified by okf's far larger per-op view keyspace
(`link/ bl/ wanted/ wantedrank/ revbybase/ pcl/ flag/ …`) and by the `tags`
OR-set retaining one `els` token **per add** (a re-add-heavy workload grows
that one view value O(adds) — standard OR-set token retention, materialized
output stays deduped).

**Why it is filed as a concern, not a fixed defect:** it is an emergent
sustained-load phenomenon entangled with autobee/corestore and the harness
fault-hub; I could not isolate a deterministic per-op okf repro, and PRIME
DIRECTIVE forbids a "fix" without one. Recommended follow-up: (a) profile
whether the RSS growth is autobee's in-memory DAG (substrate) or a store-side
retention; (b) investigate the fault-hub/replication starvation of one link
under 20-min flood (harness vs. product); (c) consider coalescing OR-set
re-adds of an already-present value under the same causal token. The
supervisor should weigh C1 before declaring the stack production-ready under
sustained multi-writer flood.

## Attack-target sweep (the 9 targets)

1. **apply purity (I1):** static grep of `core/lib` + `faces/lib` — no
   `Date.now`/`Math.random`/`hrtime` in the apply path (the three `Date`
   hits are informational-`at` in `compact.js`, `xsd:dateTime` literal
   canonicalization, and `materialize` date headings — none feed merge).
   Every Map in apply is sorted before iteration or key-independent;
   `strictlyPrecedes` iterates clocks only for a boolean. Permutation-replay
   (regression + harness `replayHash`) yields identical hashes. **Clean.**
2. **_id squat/adoption (N1/P1):** the squat-fallback and
   `mint-collision-risk` grammar are sound (adversarial.test.js). The one
   reachable hole was the ingest consumer trusting the op tag — **F2, fixed.**
3. **Deletion safety (N3):** re-audited `materialize.js` beyond codex's F2/F6
   — reserved-face overwrite (by design), tombstone/rename removal, conflict
   copy vs human file, TOCTOU precondition, untracked-file surfacing — all
   preserve or surface human bytes. **No new hole found.**
4. **Append-only (§8):** no prune/compaction op exists in the wire contract;
   `appendOnly` is init-pinned vault metadata (store-metadata test
   "appendOnly is immutable" passes). No op reduces the log. **Holds.**
5. **Governance/revocation (I10):** `forged-clock` is checked **before** the
   revocation gate, so a revoked writer cannot dodge revocation with a forged
   clock; `seqAtRemoval` + strict-precedence bound the in-flight window;
   zero-indexer removal is rejected; non-indexer governance ops reject
   `policy-governance`. S8 + i10 + adversarial pass at all profiles. **Holds.**
6. **wanted/flag boundary, conflict-copy round-trip, path containment,
   keyspace injection:** `keyspace.esc` escapes `%`/`/`; adversarial.test.js
   "hostile strings cannot escape their key family" + fuzz `weird-path`
   (`../escape`, `/abs`, `x/index`, `p.conflict-deadbeef`) + oversized-path
   all contained. **Holds.**
7. **Poison op:** decode-fail/oversize already contained; the mid-apply
   **throw** path was the gap — **F1, fixed.**
8. **Byte-determinism of faces (I9):** S7 (conflict copy byte-identity) + I9
   unit tests + fuzz convergence across peers — no divergence under any seed.
   **Holds.**
9. **Soak:** run in full (22 min, not shortened) — RSS grows to ~3 GB with
   no plateau and the run fails to converge in-window (a peer's replication
   starves). FDs bounded, no crash, no determinism divergence. **C1 (open).**

## Soak measurements (22 min, 3 writers, lossy, seed 4242, backpressure on)

`node okf/harness/soak/soak.js` (new, okf-targeted; O(1)-per-op workload =
LWW `setField` + capped OR-set `addTag`, no `SetBody` so the M1 O(R²) rescan
does not confound the leak measurement). CSV:
`sslop/036/tmp/soak-90701-mrk7xd0y/soak.csv`.

Midpoint partition (w1 isolated 20 s) at ~t=660 s; write phase ended
~t=1320 s (695/694/694 ops appended).

| t (s) | w0 RSS MB | w0 heap MB | w2 RSS MB | FDs | w0 dir KB | w2 dir KB |
| ----- | --------- | ---------- | --------- | --- | --------- | --------- |
| 0     | 85        | 18         | 85        | 33  | 220       | 220       |
| 181   | 332       | 116        | 316       | 33  | 9 308     | ~9 300    |
| 303   | 694       | 239        | 624       | 33  | 15 452    | 13 404    |
| 515   | 1 666     | 535        | 1 593     | 33  | 26 716    | 22 620    |
| 848   | 1 715     | 497        | 1 628     | 33  | 41 056    | 30 816    |
| 1000  | 2 017     | 638        | 1 632     | 33  | 46 176    | 32 864    |
| 1213  | 2 765     | 922        | 1 640     | 33  | 53 352    | 34 920    |
| 1303  | 3 127     | 1 022      | 1 665     | 33  | 56 424    | 35 944    |

- **RSS (w0/w1): monotone growth, no plateau** — 85 MB → 3.1 GB / 2.85 GB by
  end (heap 18 MB → ~1.0 GB). The momentary flattening ~t=515–848 s was the
  partition window, not a true plateau; growth resumed post-heal.
- **w2: flat ~1.63 GB from ~t=515 s** — but its dir also flatlines ~t=1000 s
  (32–36 MB while w0 reaches 56 MB): w2 stopped receiving peer blocks (the
  replication stall), so its flat memory reflects a stalled fold, not health.
- **FDs: flat at ~31–33** the entire run — **no descriptor leak.**
- **dir: grows linearly** — the append-only op log (§8), the one
  unbounded-**disk** growth the spec explicitly accepts.
- **Final heal + convergence: FAILED in-window** — quiesce timed out after
  300 s with `w0 == w1 == 6d92…` but `w2 == 09bf…` (w2 behind, not divergent;
  see C1). No process crashed.

## P1–P7 disposition (spec residual minors, OKF-SPEC-REVIEW-3)

| P | status | evidence |
| - | ------ | -------- |
| P1 | **FIXED** (was reachable) | ingest resolves mint id from view — F2, `5987841`, regression |
| P2 | handled / acceptable | one deterministic `flag/squat/<tag-id>/<tag>`; single-impl, identical on every peer, matches frozen §6 singular wording |
| P3 | handled | `opCreateConcept` rejects absent/empty `type` as `empty-type` (`apply.js`) |
| P4 | handled (minor residual) | ingest `_diffLww` returns `[]` for removed/empty-array `type`; explicit `type: ""` empty-string still emits a doomed op (availability-only, noted in #28) |
| P5 | handled | `compact.js` + `ingest.scan` walk files byte-lexicographically; `--force` map computed from the post-ingest view |
| P6 | handled | `mintCollisionRisk` parses the suffix with the minimal-hex mint grammar; non-minimal passes |
| P7 | **NOT handled → filed** | ingest strips a single `.conflict-<hex>`; double-suffix human file → permanent pending-ingest — issue #28 (minor, availability-only) |

## Unproven / static concerns (no repro — not findings)

- **Store `createConcept` return contract:** the store returns the op tag as
  the "mint id" for *all* callers; F2 fixed the one reachable consumer
  (ingest), but any *future* direct-API caller that assumes `tag === _id`
  across a squat would misroute. The store docstring should be corrected to
  say the tag is the opId and identity must be read from the view (P1). Not a
  live defect (no other consumer trusts it today), so no repro — recorded.
- **`type: ""` empty-string ingest** (P4 residual): a doomed `SetField` per
  watcher pass; availability-only, recoverable; noted in #28.
- **Materialize `takenRel` silent skip** (codex F7): defensive guard for a
  §7-unreachable two-concepts-one-rel state; deterministic, observability
  wart only.

## Test evidence

- `pnpm test` → **234 pass / 0 fail** (228 baseline + 6 new regressions);
  `pnpm test:okf` → 120 pass / 0 fail.
- S1–S10 matrix: **clean 12/12, lossy 12/12, partitioned 12/12** (all post-fix);
  seeded fuzz **×40 clean** pass; independent I8 coherence green after every
  heal; permutation-replay hashes identical. **No divergent hash under any
  seed.**
- Regressions added: `okf/test/regressions/poison-apply.test.js`,
  `okf/test/regressions/squat-mint-ingest.test.js` (both confirmed RED
  pre-fix, GREEN post-fix); wired into `pnpm test` / `test:okf` globs.

## VERDICT: G4-PASS (open concern C1 — soak liveness/memory under sustained flood; no determinism blocker open)
