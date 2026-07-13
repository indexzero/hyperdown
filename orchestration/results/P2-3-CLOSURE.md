# P2-3-CLOSURE.md — Closure Verification of Spec v4 Against P2-2 Review Findings

**Artifact verified:** `prompts/01-implementation-spec-prompt.v4.md` (v4.0, 2026-07-03).
**Findings source:** `orchestration/results/P2-2-SPEC-REVIEW.md` (F1, F2, F3, M-a, m1–m5, n2, §6 narrowed novelty text).
**Method:** for each finding, the reviewer's proposed replacement text was located in v4, checked for substantive presence (verbatim or equivalent), and checked for integration (cross-references resolve; no contradiction with adjacent normative text). Regression check confined to the deltas and their blast radius per the assignment; this is not a fresh full adversarial review.

---

## 1. Closure table

| ID | Status | v4 location | Verification notes |
|----|--------|-------------|--------------------|
| **F1** | **CLOSED** | §8.2 "Hold-buffer ordinal" para; §8.4 fallback sentence; §4 keyspace | Both proposed paragraphs adopted verbatim. §8.2 forbids keying holds by `ctx/gov/clock/<W>`, defines option (a) node-exposed ordinal / option (b) seen-count `ctx/gov/seen/<W>` incremented for every node (applied, held, rejected), requires DEVIATIONS.md record, and requires `flag/rejected` + namespace/rate rejections to use the same ordinal source. §8.4 replaces the old `from.key`-only hedge with the seen-count fallback and explicitly bans the applied-count. Keyspace §4 adds `ctx/gov/seen/<writerKey>` with a comment pointing at §8.2/§8.4, plus a single-ordinal-source note after the key listing. Cross-references resolve. (But see regressions R1 and R2 below — the integration itself introduces two tensions.) |
| **F2** | **CLOSED** | §8.2 "Hold-time rate limiting and bounding" para | Proposed paragraph adopted verbatim: §8.5 token-bucket check runs at hold time; over-ceiling optimistic op → `flag/rejected` reason `policy-rate`, not held; `H_max` cap for never-acked writers (vault metadata constant); `RemoveWriter` for an unacked `W` deletes `n/hold/<W>/*` and clears optimistic flags without folding; fold-after-confirmed-ops semantics documented with the ctxKind/confirmation guidance. `policy-rate` is present in the §8.4 reason enum; the deletion-without-folding rule is consistent with §8.3 revocation and with I10's `n/hold/` carve-out. |
| **F3** | **CLOSED** | §12 I6; §12 I10 final clause | I6 adopted verbatim (fixed-log qualifier, epoch-sensitivity for `ctxKind`-omitting ops per §5.7, `flag/epoch` only when `ctxKind` present, SHOULD-carry guidance). I10's final clause adopted verbatim (rate-policy stability scoped to each peer's `signedLength`, peer-locality and monotonic convergence stated, above-checkpoint divergence permitted until freeze). Both are consistent with §5.7 and §8.5 body text; the §12 statements no longer overclaim. |
| **M-a** | **CLOSED** | §10.1 layer-derivation sentence | Proposed priority-order text adopted verbatim: (1) authored-path top segment `Ontologies/`/`Vocabularies/` reproduces vault-ld §5.4 step 5 exactly; (2) `@type` meta-type fallback; (3) `data`; DEVIATIONS.md recording mandated. Integration verified: §5.8's `@type` bullet was rewritten to describe itself as "priority (2) of §10.1" gated on "when no authored path decides the layer", and the §10.1 closing DEVIATIONS sentence defers to "the rule above". (But see regression R4 — the pre-existing `flag/noscope` "layer = data" sentence was not reconciled with priority (1).) |
| **m1** | **CLOSED** | §5.6 second bullet | Adopted verbatim: default exactly `{tags, aliases, cssclasses}` per vault-ld §4.3; `publish`/`permalink` demoted to documented MAY-extensions; allowlist named a convergence-relevant input; SHOULD pin in vault metadata, append-only. (See regression R3 — "append-only" now sits in tension with the pre-existing promotion sentence in the next bullet.) |
| **m2** | **CLOSED** | §8.4 limits paragraph | Adopted verbatim: fixed check order (1) `oversize-op` (only truly pre-decode), (2) `unknown-msgid`/`undecodable`, (3) `depth-exceeded`, (4) `oversize-subject`; first violation determines the single recorded reason; ordering declared normative because view-observable (I2). The old "enforced pre-decode" claim is corrected to "as early as decoding permits". |
| **m3** | **CLOSED** | §5.6 first bullet; §5.2 table cell | Adopted verbatim in §5.6 (canonical element order by §10.2 byte form; dedup of identical NFC-normalized byte sequences retaining first-in-linearized-order tag; pure function of op multiset; convergent §10.3 backfill, I2/I8). §5.2's AddMember×unmapped cell cross-references it ("canonical order and dedup per §5.6"). Cross-references resolve. |
| **m4** | **CLOSED** | §9.2 wiki-link paragraph | Adopted verbatim: ambiguity detected by apply, not ingest; flag written when >1 non-deleted subject mints-or-declares the target IRI at the link op's linearized position and no path qualifier; ingest MAY pre-resolve via path-qualified target but MUST NOT decide ambiguity. Consistent with §4 (flag listed as a view key, §9.2) and §5.8 (`flag/idcollision` covering the identity collision). |
| **m5** | **CLOSED** | §11 snapshots bullet | Adopted verbatim: quorum of the indexer set as recorded in `ctx/gov` at the snapshot's `signedLength` checkpoint (not the current set); bootstrapping peer must (1) verify hash chain to a quorum-signed system-core checkpoint and (2) verify co-signers were confirmed indexers in `ctx/gov` at that checkpoint's linearized position; removed-indexer replay closed. The v3 "same quorum that signs signedLength" phrasing is gone. |
| **n2** | **CLOSED** | §5.7 second para; §3.2 `ctxKind` bullet | Adopted verbatim in §5.7: `'scalar'` pins lww, `'set'` pins or-set, `unmapped` not pinnable, cited-kind-over-unmapped applied under cited kind with `flag/epoch {applyKind: unmapped}`. §3.2's op-schema bullet mirrors the scalar↔lww / set↔or-set mapping, so the two mentions agree. |
| **Novelty (§6 of review)** | **CLOSED** | §14 README novelty paragraph | The narrowed replacement adopted verbatim: disclaims per-predicate CRDT selection (SU-Set/C-Set, m-ld single-valued constraints, ECHO/ComposeDB schema-driven typing) and any new CRDT; claims only the reflexive composition (context as ordinary content object in the same single-total-order log, same `apply`, same governance); explicitly distinguishes m-ld (engine config) and ECHO (semver'd separately-governed registry); retains the "engineering composition" concession. Consistent with §5's "core novelty" framing. |

All eleven items are CLOSED in substance.

---

## 2. Regressions (blast radius of the applied deltas)

### R1 — `ctx/gov/seen/<W>` fallback contradicts I10's letter and §8.0's mandated test (substantive)

Introduced by the F1 fix. §8.2 option (b) requires apply to increment `ctx/gov/seen/<W>` "for **every** node from `W` (applied, held, or rejected)". But:

- **I10 (§12)** states that rejected/unacked/policy-violating ops "never mutate `n/` (other than `n/hold/`), **`ctx/`**, or `idx/`". Under fallback (b), every rejected op mutates `ctx/gov/seen/<W>` — a key squarely under `ctx/`. I10 carves out `n/hold/` but not `ctx/gov/seen/`.
- **§8.0's mandated I10 test** reads: "a non-indexer's `AddWriter{indexer:true}` never results in `host.addWriter` being called and **never mutates `ctx/gov`**." Under fallback (b), processing that very rejected op increments `ctx/gov/seen/<issuer>`, so the test as written fails on any conforming fallback-(b) implementation.

This is a contradiction between normative clauses, not merely loose prose: fallback (b) is the branch the spec itself expects to be likely (F1 exists because the Autobase README documents no per-node ordinal), and the acceptance criteria (§15) require every I10 test to pass. Fix is small: add a `ctx/gov/seen/` carve-out to I10 and the §8.0 test (mirroring the `n/hold/` carve-out), or relocate the seen-count outside the `ctx/` prefix (e.g. a dedicated `seen/` family).

### R2 — §4's single-ordinal note over-reaches to "every per-op flag tag" (minor)

The F1 integration added to §4: "Every `<seq>` appearing in this keyspace (`n/hold/`, `flag/rejected/`, **and every per-op flag tag**) denotes the single per-writer ordinal source defined in §8.2/§8.4." But per-op flag tags (`flag/clobber/<s>/<term>/<tag>`, `flag/staletag/...`, `flag/epoch/...`) embed the op-carried `tag = writerKey || seq` defined in §3.2 — a payload value that other writers observe and cite under the §5.3 citation contract. Apply cannot rewrite those tags to the view-maintained seen-count without breaking tag citation, and under fallback (b) the payload seq and the seen-count are not guaranteed identical. §8.2's own sentence scopes the same-ordinal requirement correctly ("`flag/rejected` (§8.4) and namespace/rate rejections (§8.5/§8.6)"); the §4 note should be narrowed to match (holds, `flag/rejected`, `flag/optimistic`, namespace/rate rejections — not payload-derived `<tag>`s).

### R3 — Allowlist "append-only" vs the promotion-removal sentence (minor)

The m1 fix (§5.6, second bullet) says the allowlist is "treated as **append-only** across a vault's life". The immediately following pre-existing promotion bullet says "A deployment MAY **remove** a key from the allowlist by adding a `DefineTerm` for it." The intent is compatible (out-of-band config edits are the convergence hazard; in-log `DefineTerm` promotion is the sanctioned removal path), but the two sentences literally conflict. One clarifying clause ("append-only except via §5.6 promotion, which is in-log and deterministic") would reconcile them.

### R4 — §10.1 `flag/noscope` demotion vs new priority-(1) layer rule (minor)

The M-a fix makes the authored path's top segment authoritative for layer ("this reproduces vault-ld's normative folder partition exactly"). The pre-existing sentence later in §10.1 — "a schema subject with **no derivable scope** is placed under the data root with `layer = data` and `flag/noscope/<s>` is written" — was not reconciled: a subject with an authored path under `Ontologies/` but no derivable schema scope gets `layer = schema` from priority (1) and `layer = data` from the noscope sentence. In v3 (type-derived layer) these did not collide; the collision is new to the v4 delta. A one-line scope qualifier (e.g. the noscope demotion applies only to pathless subjects, whose layer came from priority (2)) resolves it. Two implementers reading v4 today could partition this edge case differently (I2/I9-adjacent).

No other regressions found. Specifically checked and clean: `policy-rate` enum membership and hold-time keying (F2); fold-at-ack scoped to the §5 pipeline so tokens are consumed once (F2); `RemoveWriter`-deletes-holds vs I10's `n/hold/` carve-out (F2); I6/I10 rewording vs §5.7/§8.5 body text (F3); §5.8 `@type` bullet vs §10.1 priorities (M-a); §5.2↔§5.6 unmapped-list cross-references (m3); §9.2 vs §4 flag ownership (m4); §3.2↔§5.7 `ctxKind` agreement (n2); §14 vs §5 novelty framing.

---

## 3. Verdict

All eleven tracked items (F1, F2, F3, M-a, m1–m5, n2, narrowed novelty) are **CLOSED**: the reviewer's replacement text is present in substance (verbatim in every case) and cross-references resolve. However, the F1 integration introduces a genuine normative contradiction (R1): the fallback seen-count lives under `ctx/`, which I10's text and §8.0's mandated test both forbid rejected ops from mutating — the spec as written mandates a test its own mechanism fails. R2–R4 are minor wording tensions fixable with one line each.

**VERDICT: G1-FAIL** — open items: regression R1 (`ctx/gov/seen/` under fallback (b) contradicts I10's "never mutate `ctx/`" and §8.0's "never mutates `ctx/gov`" test; needs a carve-out or key relocation before the gate can pass). R2, R3, R4 are minor and non-blocking but should be dispositioned in the same editing pass.
