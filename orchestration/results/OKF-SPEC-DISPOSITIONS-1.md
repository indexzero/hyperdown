# Dispositions: auto-okf SPEC.md adversarial review, round 1

Review: `orchestration/results/OKF-SPEC-REVIEW-1.md` (against v1.0-draft).
Applied in: `okf/SPEC.md` v1.1 (2026-07-13).
Contract check: no disposition below contradicts
`~/Git/indexzero/0x/slop/intent/autokf.intent.md`; M14 realigns §14's
acceptance wording *to* the intent's actual promise (state- and
identity-fidelity — "State- and identity-lossless; history intentionally
shed").

## Blockers

| ID | Disposition | Where applied / choice recorded |
|----|-------------|---------------------------------|
| B1 | FIXED | §3: every op carries payload field `at` (writer wall-clock ms, informational only, never merge input; missing/garbage → `1970-01-01`). §9 log.md dates now "each op's `at` field (§3), truncated to UTC `YYYY-MM-DD`". **Choice:** of the review's three implementer paths, option (a) op-carried `at` was chosen over (b) autobee node-envelope `timestamp` — (b) is unconfirmed in v1.0.10 and lives outside the wire contract committed under `spec/`, so only (a) preserves I1/I9 and the frozen-wire rule; (c) apply-time local clock violates I1 outright. |
| B2 | FIXED | §7 path-safety bullet replaced: case-fold (+NFC) collision detection runs in apply, on every peer, unconditionally; materialize never writes to the view; containment violations at materialize time abort emission and report on CLI only (bug, not state). |
| B3 | FIXED | §4: `c/<id>/path` now `{ path, tag, ord }` with `ord` = global apply ordinal. §7: winner = lower `ord`. I8 (§11) appended: derivability needs no information outside `c/`. **Choice:** first-wins (earlier claim holds the path) per the review's proposed text — squat resistance; a later claimant cannot evict, which best preserves I4/I8 and the intent's adversarial-writer containment. |
| B4 | FIXED | §7 collision bullet: suffix is now `first-8-hex-of-SHA-256(_id)` (hash, not writer-key prefix); component pattern `\.conflict-[0-9a-f]{8}$` reserved (`reserved-path`); residual 8-hex collision extends to the full hash; materialize MUST NOT emit two concepts to one file under any input. |

## Majors

| ID | Disposition | Where applied |
|----|-------------|---------------|
| M1 | FIXED | §6 new "Seen-id rule" bullet: `CreateConcept` on a present id rejected (`duplicate-id`); mutation ops policy-checked against the concept's *current* path; adopted ids match `^[0-9a-f]{2,128}$`; adoption of an id whose writerKey prefix equals any current/former writer's key with `seq >=` that writer's seen-count rejected (`mint-collision-risk`). §9 ingest adoption cross-references these rules. Note: the review's proposed text contained a self-corrupted clause ("rejects the *earlier adopted squat's* create at detection time is impossible, so instead"); it was integrated as the coherent rule the clause resolves to — reject the *adoption* prospectively via the seen-count bound, since retroactively rejecting an already-applied squat would break I3 replay stability. |
| M2 | FIXED | §8 revocation bullet appended: `gov/removed/<key>` records `seqAtRemoval`; nodes at actual `seq > seqAtRemoval` rejected regardless of claimed clock; claimed-clock test confined to the bounded in-flight window; self-clock ≠ actual seq rejected (`forged-clock`). §4 `gov/removed/` line updated. |
| M3 | FIXED | §3: `tag` removed from every op's field list (schema block updated); `tag` derived by apply from the node, never payload; `RemTag.tags` and `ResolveConflict.keep`/`supersede` are citations only. |
| M4 | FIXED | §5 new "Reserved field keys" bullet: `SetField` on `tags`/`_id`/`_rev` rejected (`reserved-key`). §9 ingest: strips `_id`/`_rev` from the frontmatter diff; removed `tags` key translates to `RemTag` ops citing every observed token. |
| M5 | FIXED | §5 new "Base discipline" bullet: null base while a head exists cites that head; a base absent from `c/<id>/rev/` is stored, flagged `flag/conflict/<id>/<head>/<new>`, and never becomes head until `ResolveConflict`. |
| M6 | FIXED | §9 new late-binding bullet: link resolution recomputed on every path/liveness-changing op; vacated paths demote `bl/` → `wanted/`; I8 is the definition. §4: `wanted/<path>/<from-id>` (one key per referrer) + `wantedrank/<inv-count>/<path>`; `wantedrank/` added to bookkeeping families and I8. |
| M7 | FIXED | §9 new mirror bullet: materialize deletes any `.md` not produced by this run (prior conflicted copies, prior paths of renames, orphan `index.md`), removes empty directories, same containment checks; ingest treats mirror-deletions as materialize-authored. |
| M8 | FIXED | §8 weight bullet: explicit `host.addWriter(key, { isIndexer: op.indexer, weight: 1 })`; never rely on autobee's `isIndexer ? 2 : 1` defaults. |
| M9 | FIXED | §8 optimistic bullet: explicit `optimistic: true`; ack = linearization of an indexer-authored `AddWriter` naming the held key, whereupon apply calls `host.ackWriter` and folds holds in seq order; builder MUST verify autobee re-delivery semantics (dedup-guard fallback, recorded in DEVIATIONS.md); `H_max = 512`, overflow rejected (`hold-overflow`). |
| M10 | FIXED | §9 index.md bullet: normative structure — `# Contents` heading; `* [<title, else terminal path component>](<entry>) - <description>` with the description clause omitted when absent; entries relative to the directory; concepts then subdirectories, canonical byte order. |
| M11 | FIXED | §5 new `ResolveConflict` bullet: valid only if `keep` + all `supersede` exist and ≥1 cited flag open, else `bad-resolve`; head := keep, LWW-pinned; `text` synthesizes a revision with `base = keep`; races converge first-valid-wins, loser flags. |
| M12 | FIXED | §10: compact refuses (without `--force`) on `flag/conflict` **or** `flag/pathcollision`; `--force` enumerates every carried conflicted copy (old path → materialized path) in the new epoch's `log/` entry. |
| M13 | FIXED | §9 new extraction bullet: CommonMark inline + reference links only; no autolinks/images; code fences/spans skipped; scheme'd targets ignored; `/`-prefixed = bundle-relative; relative targets resolve against source's current path with `.`/`..` normalization; strip one `.md` + fragment, NFC; `SetPath` re-runs the source's relative-edge resolution. |
| M14 | FIXED | §14 amended: "identity-fidelity and byte-fidelity **modulo the `_rev` frontmatter line** … I11's property list is the normative fidelity set." This is an acceptance-wording correction, not an invariant weakening: I11 (unchanged) never promised `_rev` stability, `_rev` re-derivation across epochs is structural (the new head cites the old head as base), and the intent's own promise is state- and identity-losslessness with history intentionally shed. |
| M15 | FIXED | §7 reserved bullet: reservation and collision checks compare casefolded, NFC-normalized components; `index.md`/`log.md` are members of every directory's casefold-collision domain. Interlocks with the B2 fix (detection lives in apply). |

## Minors

All fifteen were trivial to apply as proposed; all are FIXED in v1.1.
BACKLOG CANDIDATES: none.

| ID | Disposition | Where applied |
|----|-------------|---------------|
| m1 | FIXED | §8: `flag/undelete/<id>/<tag>` written by `UndeleteConcept`; `flag/optimistic/<writerKey>/<seq>` written for ops rejected at fold time. Both families retained in §4. |
| m2 | FIXED | §4 flag-lifecycle paragraph: `conflict` and `pathcollision` clear (with their rules); `clobber`, `staletag`, `writeafterdelete`, `undelete`, `rejected`, `optimistic` are permanent audit. "Clearable" struck from §7's clobber line. |
| m3 | FIXED | §5 tags bullet: removed-token set per (id, value); citing an already-removed token is a silent no-op; only never-observed tokens flag `staletag`. |
| m4 | FIXED | §3 limits: "Pre-decode: op ≤ 64 KiB. Post-decode, fixed order: path ≤ 1024 bytes, depth ≤ 64." |
| m5 | FIXED | §5 bodies bullet: `len()` = u32 LE; null base = `len(0)` with zero bytes; copied code wins on discrepancy, recorded in DEVIATIONS.md. |
| m6 | FIXED | §6 `_rev` bullet: no revisions → `_rev` omitted; ingest without `_rev` over a revision-less concept cites `base: null`. |
| m7 | FIXED | §10 step 4: checkpoint = `{ viewHash (I2 full-range hash), writerLengths }`, operator-signed; chain is provenance, not proof; cross-epoch identity is trusted-operator scope. |
| m8 | FIXED | §13 `okf/cli`: `resolve` and `undelete` verbs added. |
| m9 | FIXED | §13: `okf/root` line — `auto-okf@0.0.1` root placeholder (intent D7); package-name sentence updated. |
| m10 | FIXED | §8 rate bullet: 1 token per accepted op authored by any indexer, capped at the writer's `rateCeiling`; unacked writers use fixed default ceiling 64. |
| m11 | FIXED | §9 YAML-emission bullet: quote-iff-reinterpreted, flow lists, LF, trailing newline. |
| m12 | FIXED | §9 log.md bullet: group by UTC date, headings descending, ordinal descending within a heading, links absolute bundle-relative; forged-future dates accepted as cosmetic. |
| m13 | FIXED | §9 `_id` rules: copy detection = current-view-path original, else casefolded-lexicographically-first; walk order no longer matters. |
| m14 | FIXED | §8 governance bullet: `RemoveWriter` leaving zero indexers rejected (`policy-governance`). |
| m15 | FIXED | §9 log.md bullet: "UTC `YYYY-MM-DD` date headings (OKF §7 MUST)". |

## Backlog candidates

None — every minor was applied in v1.1.

## Waivers

None. No `Sign-off` required.
