# Adversarial Closure Review: auto-okf SPEC.md (v1.2) — Round 3 (final)

Reviewed: `/Users/cjr/Git/indexzero/hyperwiki2/okf/SPEC.md` (v1.2, 2026-07-13)
Against: `/Users/cjr/Git/indexzero/0x/slop/intent/autokf.intent.md` (confirmed
intent); `~/Git/GoogleCloudPlatform/knowledge-catalog/okf/SPEC.md` (OKF v0.1,
read in full); the round-2 findings in
`orchestration/results/OKF-SPEC-REVIEW-2.md`. Reviewer has no authoring
history with this artifact. This is the final permitted round (ceiling 3);
the verdict below is the buildability decision.

## Verdict

All five round-2 majors are closed, and closed with mechanisms that survive
attack — including N1, where the author declined the reviewer-adjacent
literal fix and substituted a squat-proof fallback mint. I attacked that
substitution hardest (contract item 4) and conclude it is not only adequate
but *correct where the literal fix was wrong*: no adoption-side rejection
rule can distinguish a pre-admission squat from a legitimate dead-epoch
adoption, so mint time is the only sound place to defuse squatting, and the
fallback mint defuses it completely at the apply layer (full analysis in
its own section below). All fourteen round-2 minors are closed, most with
the proposed text adopted verbatim and correctly cross-referenced (I checked
each against its v1.2 anchor, not just the changelog). The regression grep
over the five v1.2 mechanisms found **no new majors and no
section-vs-section contradictions** — a material improvement over round 2,
where the fixes themselves minted four majors. It found seven new minors:
one residual of N1 that lives at the client/ingest layer rather than in
apply (P1), one false universal claim in §5's empty-type text (P3), one
availability deadlock in the ingest↔empty-type interaction (P4), and four
pin-the-encoding/pin-the-order items of the same species as round 2's
n-series. None makes an invariant unachievable, none contradicts the
intent, and each has one-to-three-sentence proposed text. Under the stated
severity bar (blocker = invariant unachievable or intent contradicted),
there are zero blockers and zero open majors. The spec is buildable.

## Closure Table

| ID  | Status | Evidence (v1.2) |
|-----|--------|-----------------|
| N1  | **CLOSED** | §6 "Squats cannot block mints": minting create whose tag-id is occupied mints `SHA-256(writerKey ‖ seq ‖ k)` (encodings pinned: raw 32-byte key, u64 LE seq, u64 LE k), smallest `k >= 1` unseen, permanent `flag/squat/<squatted-id>/<tag>`; `duplicate-id` narrowed to adoption only; `squat` in the §4 family list and permanent-lifecycle list. Judged sound — see the dedicated section. Residual at the client layer only: P1 (minor) |
| N2  | **CLOSED** | §10 step 3: fresh keypairs MUST, "a writer keypair MUST NOT recur across epochs", corestore keys namespaced by epoch, `init` MUST enforce via per-epoch namespace recorded in vault metadata; §6 back-reference ("Epoch-cycle adoption never trips this rule…"). Degradation check: even a post-ingest re-admission of an old keypair (operator violating the MUST after adoption completed) no longer deadlocks creation — the writer's colliding mints fall back per §6. I11 achievable under the MUST |
| N3  | **CLOSED** | §9 manifest-gated reconciliation: peer-local (path, content-hash) emission manifest outside the view; removal candidates only manifest-tracked, not-produced-this-run, bytes-still-matching files; differing or unentried `.md` never deleted **or overwritten** — pending-ingest, nonzero exit, `--force-mirror` operator escape; containment honored; watcher classifies these deletions as materialize-authored. Fail-safe under crash (stale manifest ⇒ files become unknown ⇒ never deleted) and under first-run-in-populated-dir. I9 explicitly re-scoped to the emitted set |
| N4  | **CLOSED** | §5 `type` bullet: apply-time rejection of `SetField` on `type` with empty array or sole empty string (`empty-type`); "`type: unknown` remains a materialize-only defensive fallback for corrupt state and **writes nothing to the view** (§7)"; create-seeds-register + `meta.type` bookkeeping (n4) folded in. The materialize-time view write is gone. Residuals: the "unreachable through accepted ops" claim is false for `CreateConcept` (P3), and the ingest interaction deadlocks (P4) — both minor |
| N5  | **CLOSED** | §9 conflict-copy awareness: `\.conflict-[0-9a-f]{8,}$` files ingest at the suffix-stripped path; known `_id` at stripped path ⇒ no `SetPath`; unknown `_id` (epoch cycle) ⇒ `CreateConcept` at stripped path, collision re-manifests under §7, loser re-flags and re-materializes; §7 carries the explicit non-tripping note; §10 `--force` enumeration now describes an implementable flow. Residual: enumeration/ingest order unpinned (P5), double-suffix human files (P7) — minor |
| n1  | CLOSED | §7: reservation is `\.conflict-[0-9a-f]{8,}$` "(any terminal hex run of 8 or more)"; occupied fallback extends the same way, occupation only possible by another conflicted copy, "the reservation covering every extension length" |
| n2  | CLOSED | §5: no-head flag key `flag/conflict/<id>/-/<new>`; concept "materializes bodyless until `ResolveConflict`"; unknown-base rule subsumes same-base siblings (one flag per revision vs head position, none pairwise) |
| n3  | CLOSED | §6: "seq is minimal lowercase hex, no leading zeros, `0` for seq 0"; adopted id exactly equal to a 64-hex writer key rejected `mint-collision-risk` (empty seq suffix) |
| n4  | CLOSED | §5: `CreateConcept.type` seeds `c/<id>/f/type` at the create's linearized position; `c/<id>/meta.type` is a bookkeeping copy never read by materialize |
| n5  | CLOSED | §4 lifecycle + §7: `pathcollision` clears whenever the loser's claim ceases to collide — own `SetPath`, or competing holder vacating by rename, deletion, or its own collision loss; recompute tied to §9's late-binding events; I7 wording now consistent |
| n6  | CLOSED | §4: `revbybase/<id>/<base>/<rev>` is "a true top-level bookkeeping family, trivially co-derived from `c/<id>/rev/`"; in the bookkeeping list; I8 no longer circular |
| n7  | CLOSED | I4 flag list includes `optimistic`. (Checked the complement: `squat`/`copydetect`/`undelete` are correctly absent — no op *effect* disappears in those cases, so I4 does not owe them) |
| n8  | CLOSED | §4: inv-count = (MAX − count) as 16-digit zero-padded decimal, MAX = 10^16 − 1 |
| n9  | CLOSED | `flag/staletag/<id>/<value>/<tag>` (§5); `flag/clobber/<id>/path/<tag>` with the field-named-`path` disambiguation note (§7); `flag/copydetect/<new-id>/<original-id>` (§9), both new families in the §4 list and the permanent set |
| n10 | CLOSED | §8: "Buckets start full (at ceiling) at admission and at first hold — the accept/reject partition is pinned" |
| n11 | CLOSED | §14: "modulo the `_rev` frontmatter lines **and the regenerated `log.md`** (both necessarily re-derive in the new epoch)" |
| n12 | CLOSED | §7: casefold loser retains `path/<exact path>`, links resolve into `bl/`, emitted link expected broken on disk, OKF §5.3 citation, alternative explicitly rejected ("chosen over demotion to `wanted/`") — one option picked, as demanded |
| n13 | CLOSED | §5: empty LWW state "materializes as the key omitted from frontmatter" |
| n14 | CLOSED | §9: "shape pinned: one `# Update Log` title, then `## YYYY-MM-DD` UTC date headings" |

## The N1 Judgment (contract item 4)

**The question.** Round 2's exploit: admitted adversary Q pre-squats, via
adopting `CreateConcept`s, the predictable mint ids (`Xkey‖seq`) of a
writer X who is not yet admitted or whose optimistic ops sit unacked in
`hold/` — v1.1's `mint-collision-risk` covered only current/former
writers, so the squats landed, and X's later creates died `duplicate-id`
with Q positioned to harvest X's follow-up ops. The author declined the
literal fix ("reject cross-writer mint-shaped creates") and instead made
minting unsquattable: an occupied tag-id falls back to
`SHA-256(writerKey ‖ seq ‖ k)`, smallest unseen `k >= 1`, plus a permanent
`flag/squat`. I judged both halves independently.

**Was declining the literal fix correct? Yes.** I attempted to construct a
working adoption-side rejection rule and every variant fails on the spec's
own flows: (a) reject any adopted id whose 64-hex prefix ≠ the issuer's
key — kills §10 epoch adoption outright, because *every* predecessor-epoch
id is mint-shaped under a key that (per §10's own key-freshness MUST) is
cross-writer in the new vault; I11 becomes unachievable by construction.
(b) Reject only when the prefix matches a *known* writer — that is
exactly v1.1's rule, which N1 defeated, because a pre-admission key and a
dead-epoch key are **indistinguishable at adoption time**; the information
needed to tell them apart (X's future admission) does not exist yet.
(c) Gate adoption on trusted issuers — launders through ingest, since
adoption ops are legitimately generated by the watcher from any dropped
file carrying an unknown `_id` (round 2 itself conceded this). Conclusion:
the adoption door must stay open, so the mint must be made squat-proof.
The author's diagnosis is independently confirmed.

**Does the fallback close the exploit? Yes, at the apply layer, on both
arms.**

- *Blocking arm (DoS):* dead. A genuine mint always succeeds within
  (#occupied candidates + 1) probes. Q can also pre-compute and squat the
  fallback chain (`SHA-256(Xkey‖n‖1)`, `‖2`, … are all public-input
  hashes, 64 hex, adoptable), but each squat costs Q one rate-limited,
  policy-checked, permanently-`flag/squat`-audited op and only pushes X to
  `k+1`; §6 states the economics exactly ("a squatter must spend one op
  per candidate and always loses"). The loop is deterministic (pure
  function of view state at the linearized position — I1 safe),
  terminating, and its flags are in the I2 hash.
- *Capture arm:* dead in apply. X's create no longer collides into Q's
  concept or gets rejected; it lands under the fallback id at X's chosen
  path. Q owns only its own squat concept, which captures nothing.
- *Does it merely move the problem?* Mostly no — with one genuine residue,
  which is where the problem *moves to if it moves anywhere*: the minted
  id is now **unknowable at append time** (it depends on which ids occupy
  `c/` at the op's linearized position, which concurrent ops can change).
  A client that locally computes `writerKey‖seq` and stamps it into a file
  as `_id` — the reading the "predictable mint" framing invites — re-opens
  the capture arm one layer up: subsequent edits to that file become ops
  targeting `Xkey‖n`, which is *Q's squat concept* (mutating it if policy
  allows, spraying `flag/rejected` if not). I checked whether the spec's
  own flows do this: they do not. §9's ingest is path-driven — it
  reconciles a file against the view via `path/<path> → id` after the
  create applies, so the natural write-back retrieves the *actual*
  (fallback) id; and `c/<id>/meta.created = tag` gives a second
  deterministic lookup. §6 also already warns the mint is "the creating
  op's tag … **or the squat-fallback id below**". But no sentence *forbids*
  local id computation, and direct-API agent writers (the flagship
  example) are exactly the clients that would do it. That is finding P1 —
  minor, one sentence, because the specified components are already
  correct and the apply-layer invariants (I1/I2/I4/I10) are untouched
  either way.
- *Interior consistency:* the fallback coexists cleanly with
  `mint-collision-risk` (adoption-side protection of admitted writers'
  future seqs) and with §10 (fallback ids are 64 hex, never equal to any
  mint id — mints are ≥ 65 hex — and adopt cleanly across epochs; I
  verified a squatted-then-fallback vault round-trips both concepts under
  I11). One pin missing: when `k > 1`, whether `flag/squat` is written
  once or per occupied candidate is ambiguous, and the choice lands in
  the I2 hash — P2.
- *Intent check:* intent D1 says `_id` is "minted once from the creating
  op (`writerKey ‖ seq`)". The fallback id is not literally that
  concatenation. I weighed this as a potential contradiction and judge it
  compatible: every property D1 actually assigns — minted exactly once,
  from the creating op, opaque, stable, never path- or content-derived,
  adopted on ingest — holds for the fallback (it is a deterministic
  function of the creating op's tag); the parenthetical describes the
  unsquatted case. Recording the judgment explicitly since "nothing may
  contradict the intent" is contract item 1.

**Ruling: N1 CLOSED. `flag/squat` + fallback mint is sound, does not move
the problem into the view, and is strictly better than the literal fix,
which I independently verified would break §10/I11.** Residuals P1/P2 are
minors, not reopeners.

## New Findings (all minor)

| ID | Section | Title |
|----|---------|-------|
| P1 | §6/§9 | Minted id is unknowable at append time; nothing forbids clients computing `writerKey‖seq` locally — the only channel through which N1's capture arm can re-enter |
| P2 | §6 | `flag/squat` multiplicity for `k > 1` unpinned (one flag vs one per occupied candidate) — lands in the I2 hash |
| P3 | §5 | "empty `type` state is unreachable through accepted ops" is false: `CreateConcept` with empty/absent `type` is never rejected and seeds an empty register |
| P4 | §5/§9 | Ingest of a file whose `type` key was removed/emptied emits `SetField type []` → rejected `empty-type` → the file is permanently pending-ingest and materialize permanently exits nonzero (reported, not silent — availability wart, not loss) |
| P5 | §9/§10 | Epoch-cycle ingest walk order unpinned, so which colliding concept wins in the new vault — and the `--force` "old conflict path → new conflict path" enumeration — is implementation-chosen |
| P6 | §6 | `mint-collision-risk` suffix grammar: an adopted id whose 64-hex prefix matches a writer key but whose suffix is non-minimal hex (e.g. leading zeros) can never be a real mint; accept/reject unpinned → applied/rejected partition can diverge across implementations |
| P7 | §9 | A human-authored double-suffix file (`p.conflict-<hex>.conflict-<hex>.md`) strips once to a still-reserved path → `CreateConcept` rejected `reserved-path` → permanently pending-ingest |

### P1 — Pin view-sourced id discovery (§9)

**Exploit.** Q pre-squats `Xkey‖5`. X's agent appends a minting
`CreateConcept` at seq 5, locally computes `_id = Xkey‖5` (the documented
mint shape), stamps it into its file/state, and thereafter issues
`SetBody { id: Xkey‖5, … }`. Apply gave X's concept
`SHA-256(Xkey‖5‖1)`; the agent's edits now target Q's squat concept —
captured if policy permits, `flag/rejected` noise forever if not. The
specified ingest watcher does not exhibit this (path-driven, post-apply),
but nothing stops a direct-API client from it. *Proposed text* (§9, `_id`
rules, appended): "A writer MUST NOT compute its minted `_id` locally: the
assigned id is knowable only after the create applies (§6 squat fallback)
and MUST be read from the view — `path/<path>` at the create's path, or
the concept whose `c/<id>/meta.created` equals the create's tag. Ingest's
write-back sources `_id` this way."

### P2 — Squat-flag multiplicity (§6)

**Derivation.** Mint at tag-id T with T and `SHA-256(…‖1)` both occupied:
`k = 2` lands. "Records the permanent audit flag
`flag/squat/<squatted-id>/<tag>`" — one flag (which id?) or two?
Implementations diverge inside the I2 full-range hash and the §10
`viewHash`. *Proposed:* "one `flag/squat/<candidate-id>/<tag>` per
occupied candidate probed (all `k' < k`, including the tag-id)."

### P3 — Empty `type` at creation (§5)

**Derivation.** §5 rejects only `SetField` on `type`. A
`CreateConcept { type: "" }` (reachable via ingest of a hand-authored file
with `type: ""` or no `type` line) is accepted and seeds an empty
register, so "unreachable through accepted ops" is false; the concept
materializes under the `type: unknown` fallback that the same bullet
reserves for "corrupt state". Deterministic and OKF-conformant ("unknown"
is non-empty), so nothing diverges — but the spec contradicts itself and
leaves the create-time rule unpinned. *Proposed:* "Apply rejects a
`CreateConcept` whose `type` is absent, an empty array, or a sole empty
string (`flag/rejected`, reason `empty-type`). Ingest substitutes the
literal string `unknown` when generating `CreateConcept` from a file with
missing/empty `type`, narrated in `log/`."

### P4 — Removed-`type` ingest deadlock (§5 vs §9)

**Exploit.** Human deletes the `type:` line from a materialized file. §9:
removed key → `SetField` with empty array → §5 rejects `empty-type`. The
view keeps the old type, the file now differs from its manifest entry
forever, materialize exits nonzero forever, and every watcher pass
re-appends a doomed op (unbounded `flag/rejected/<writer>/<seq>` growth).
Reported, recoverable (`--force-mirror` or restoring the line), so
availability-only. *Proposed* (§9, first ingest bullet): "Exception:
a removed or emptied `type` key generates no op (the view's `type`
stands, `type` being OKF-required); the discrepancy is narrated once and
the file's next materialize re-emits the line."

### P5 — Epoch ingest order (§9/§10)

**Derivation.** Carry-across of an undrained collision: fresh vault
ingests `p.md` and `p.conflict-<hex>.md`, both `CreateConcept` at `p`;
§7's first-wins-by-`ord` makes the *ingest walk order* decide which
concept re-wins — and hence both faces' on-disk locations and the
`--force` enumeration's "new conflict path". Unpinned, so two conformant
implementations produce different (each internally deterministic)
bundles. I11's property list survives either way (both concepts' path
registers hold `p`), which is why this is minor. *Proposed* (§10): "The
compact-ingest processes files in byte-lexicographic bundle-relative path
order; the `--force` enumeration is computed from the new vault's view
after ingest, not predicted."

### P6 — Mint-shape suffix grammar (§6)

**Derivation.** Adopted id = `<writer W's key>‖"007"`. Non-minimal hex can
never be a future mint of W, so rejection is unnecessary; but the rule as
written ("writerKey prefix equals … with `seq >=` seen-count") doesn't say
how the suffix parses, and an implementation that rejects on prefix match
alone diverges from one that parses. *Proposed:* "the suffix is parsed
with the mint grammar (minimal lowercase hex); a non-conforming suffix is
not mint-shaped and passes this check."

### P7 — Double conflict suffix (§9)

**Derivation.** Materialize can never emit a double-suffixed path (§7's
reservation keeps base paths clean), so such a file is human-authored;
ingest strips one suffix, the target still matches the reserved pattern,
the `CreateConcept` rejects `reserved-path`, and the file is permanently
pending-ingest. *Proposed:* "strip the suffix repeatedly until the
terminal component no longer matches."

## Invariant achievability (contract item 5 sweep)

- **I1/I2/I3:** fallback mint is a pure function of linearized state
  (deterministic probe order, pinned hash input encodings); the emission
  manifest is materialize-side peer-local state that apply never reads;
  `empty-type` rejection is order-fixed. No v1.2 mechanism reads a clock,
  randomness, or peer-local state in apply. Achievable (P2/P6 are
  cross-implementation hash pins, not per-vault divergence).
- **I4:** achievable; flag list now includes `optimistic`; squat/copydetect
  correctly not owed (no effect lost).
- **I5/I6/I7:** untouched by v1.2; I7's pathcollision wording now matches
  §4/§7.
- **I8:** `revbybase/` relocation and `ord`-in-`c/` keep every index
  derivable from `c/`. Achievable.
- **I9:** achievable under the pending-ingest carve-out, which is now
  *defined* ("judged on the emitted set") rather than implied.
- **I10:** untouched; fallback minting never bypasses policy/revocation
  checks (creates are still policy-checked; mutations still check current
  path).
- **I11:** achievable — the two round-2 killers (key-reuse deadlock,
  un-ingestable conflict copies) are both gone; verified the squatted-vault
  and undrained-conflict epoch cases round-trip the property list. P5
  affects face placement across implementations, not the I11 properties.

## Regression-grep notes

Cross-referenced every v1.2 addition: `empty-type` joins the
`flag/rejected` reason set consistently (§5/§3); `squat` and `copydetect`
appear in the §4 family list, the permanence list, and their defining
sections with matching key shapes; the §7 reservation note and §9
stripping rule cite each other and do not conflict (materialized copies
strip, direct ops reject — disjoint domains); §10's key-freshness MUST is
back-referenced from §6 verbatim; the manifest bullet's "never deleted or
overwritten" is consistent with atomic-write/containment text and with the
watcher-coordination sentence; §14's fidelity exclusions match n11. The
one internal falsehood found is P3's "unreachable" claim; the one
flow-level interaction is P4. OKF v0.1 conformance of the emitted tree
re-checked against the full OKF spec: conflicted-copy files are ordinary
conformant concepts; root-only `index.md` frontmatter matches OKF §11's
carve-out of §6; `# Update Log` + `## YYYY-MM-DD` satisfies §7 (title text
is unconstrained prose; the date-heading MUST is met); `type: unknown` is
non-empty per §9(2); pending-ingest human files can transiently violate
§9(1) but are excluded from the emitted set and force a nonzero exit — no
violations. Intent sweep D1–D7: no contradiction (D1 fallback-mint
judgment recorded above; D4/D5 append-only and epoch text unchanged and
conformant; D6/D7 unchanged).

## Closure summary

N1 CLOSED · N2 CLOSED · N3 CLOSED · N4 CLOSED · N5 CLOSED ·
n1–n14 all CLOSED. New findings P1–P7, all minor, none blocking: no
invariant is unachievable, no intent decision is contradicted, and each
has drop-in proposed text suitable for an editorial v1.2.1 pass during
build (P1 and P4 are the two worth doing before code exists).

VERDICT: SPEC-PASS
