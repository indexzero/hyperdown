# P2-1-DISPOSITIONS.md — Disposition of adversarial findings F1–F20

**Applies to:** `prompts/01-implementation-spec-prompt.v2.md` (spec v2, 2026-07-03), revised from
`prompts/01-implementation-spec-prompt.md` (spec v1) per `orchestration/results/P1-1-SPEC-REVIEW.md`.

Legend: section references (§) below are **v2** section numbers unless marked "v1".

---

## Blockers (all applied, as required)

| ID | Sev | Disposition | Where in v2 | Notes |
|----|-----|-------------|-------------|-------|
| F1 | blocker | **FIXED** | §3.1 (canonical string form); referenced from §4, §8.6, §9.2, §10.2, I1 | NFC before keying/IRI-minting/hashing; percent-encoding after NFC; ingest normalizes filenames. |
| F2 | blocker | **FIXED** | §5.2 (op/kind reconciliation table); flag key in §4 | Reviewer's table adopted with the reject-on-mismatch policy (the table's own stated intent); the stray "coerce?" aside in the review text was resolved to reject, per the reviewer's parenthetical that rejection is the chosen single rule. |
| F3 | blocker | **FIXED** | §8.4 (undecodable/structurally invalid ops); `flag/rejected/<writerKey>/<seq>` in §4; §3.3 cross-reference | Writer/seq-keyed rejection namespace; pre-decode hard limits (subject ≤ 1024 B, op ≤ 64 KiB, depth ≤ 64); apply never throws. `revoked` added to the reason enum to serve F6. |
| F4 | blocker | **FIXED — Option B chosen** | §5.4 (`flag/clobber`); extended to body-head supersession in §6; I4 updated in §12 | The reviewer marked Option B "stronger"; it also preserves I4 verbatim rather than narrowing it (task rule 4: prefer not weakening invariants). I4's enumeration was *extended* (never narrowed) to list all flag classes. Option A's `superseded` counter was not added since Option B subsumes its auditability purpose. |
| F5 | blocker | **FIXED** | §10.1 (layer partition); `n/<subject>/layer` and `n/<subject>/base` in §4; DEVIATIONS.md note mandated | Layer inferred from `@type` meta-types; default `data`; export partitions by the view record. |
| F6 | blocker | **FIXED** | §8.3 (causal revocation); `ctx/gov/removed/<key>` in §4; I10 updated in §12; reorg-stability test mandated in §15 | Revocation point defined causally + via `signedLength` finalization, exactly per the proposed text. |

## Majors

| ID | Sev | Disposition | Where in v2 |
|----|-----|-------------|-------------|
| F7 | major | **FIXED** | §10.2 (canonical literal forms), applied to YAML materialization in §9.1; I9 cross-references it. |
| F8 | major | **FIXED** | §5.7 (policy epochs): optional `ctxEpoch` on ops (§3.2), writer-cited-epoch application + `flag/epoch`, README caveat retained for the omit case. Opt-in, per the reviewer's stated position. |
| F9 | major | **FIXED** | §5.3 (`RemMember` citation contract): cite-all-tags-for-value contract, `flag/staletag` for non-present cited tags, no separate tombstone store; referenced from the §5.2 table and I5. |
| F10 | major | **FIXED** | §9.1 (materialize emits unmapped terms), §10.3 (no unmapped triples in Turtle; backfill `idx/*`/`bl/*` on later `DefineTerm`; clear `flag/unmapped`); I8 test mandated (§10.3, §15). |
| F11 | major | **FIXED** | §5.6 (host-key allowlist, default `{tags, aliases, cssclasses, publish, permalink}`; `n/<s>/host/<key>` in §4; ingest behavior §9.2; materialize behavior §9.1). |
| F12 | major | **FIXED** | §7 (mint in data namespace / root `@base`; `n/<target>/mintedAs`; same-IRI vs retarget takeover; `flag/danglingretarget`; dual I7 test mandated in §7/§15). |
| F13 | major | **FIXED** | §9.3 (path capture, `vld:path` consumed on ingest), §10.4 (`vld:path` emission under `roundtrip: bool`), `n/<subject>/path` in §4; acceptance updated in §15. |
| F14 | major | **FIXED** | §8.5 (default rate ceiling from first op; one rejection record per rejected op) and §7 (coalesced `flag/dangling/<target>` with referrer count). Reconciliation with F12: the coalesced dangling flag carries `{count, mintedAs}`; per-referrer detail lives in `bl/` (already maintained), and only the rare retarget audit record (`flag/danglingretarget`) stays per-triple. |
| F15 | major | **FIXED** | §11 (new section: README retention numbers in writing; signed view snapshots at `signedLength`; `PruneRevisions` op added to §3.2, indexer-only, conflict-referenced revisions exempt; epochs documented as future direction). Non-goals (§13) updated to say full log compaction is out of scope, which keeps this within v1's non-goal envelope. |
| F16 | major | **FIXED** | §8.6 (namespace governance: `SetWriterPolicy` op in §3.2; `ctx/gov/writer/<key>` LWW-under-linearization; `flag/govoverride`; prefix-restricted mutation; I10 namespace test mandated). |

## Minors / nits

| ID | Sev | Disposition | Where in v2 |
|----|-----|-------------|-------------|
| F17 | minor | **FIXED** | §5.5 — `flag/shadow` only on structurally different definitions; identical redeclarations idempotent, no flag. |
| F18 | minor | **FIXED** | §8.2 — do-not-apply-until-ack for optimistic writers; `flag/optimistic/<W>/<seq>`; deterministic replay after ack; I10 wording covers unacked optimistic ops. |
| F19 | minor | **FIXED** | §9.4 — atomic temp-file/fsync/rename writes, mtime/hash skip-and-ingest-first, watcher debounce + write-settle + per-path in-flight lock; README documents that clobber-immunity is a view property. |
| F20 | nit | **FIXED** | §3.3 — append-only wire contract for hyperdispatch/Hyperschema message ids and field orders; schema version recorded in vault metadata; framed as an I1 requirement. |

## BACKLOG CANDIDATES

None. All four minors/nits (F17–F20) were trivial to integrate and were applied in v2.

The reviewer's conformance matrix (P1-1-SPEC-REVIEW.md §4) additionally notes vault-ld gaps that were **not** numbered findings and are therefore not dispositioned here, but are natural backlog items for a v3 pass: explicit percent-encoding/percent-decoding statements beyond the F1 hook (partially covered by §3.1), `flag/ambiguous` for ambiguous bare links, keyword-alias handling in materialize, skipping type-less (non-participating) notes on ingest, and an explicit-`id`-override path in the op schema.

## Invariant integrity statement (task rule 4)

No invariant I1–I10 was weakened. I4 was the only invariant a finding proposed amending (F4 Option A); Option B was chosen instead, so I4's "no op's effect disappears without a flag" stands verbatim, with its illustrative enumeration extended to the new flag classes. I1, I7, I8, I9, I10 gained *additional* obligations (normalization, dual takeover, backfill coherence, canonical literals, reorg-stable governance); none lost any.

## Choice record (task rule 1)

- **F4:** Option B (`flag/clobber` surfacing) — reviewer marked it "stronger"; it preserves I4 unamended, best serving invariants I1–I10.
- **F2:** reject-on-mismatch for every mismatch cell, per the reviewer's parenthetical that rejection (not coercion) is the intended single frozen rule.
- **F14 × F12 key-shape conflict:** coalesced `flag/dangling/<target>` (F14) adopted as the flag shape; F12's per-triple detail preserved via `bl/` and the per-triple `flag/danglingretarget` audit record.
