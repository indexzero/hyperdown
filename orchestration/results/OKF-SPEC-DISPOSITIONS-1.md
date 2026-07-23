# Dispositions: auto-okf SPEC.md adversarial reviews

## Round 1

Review: `orchestration/results/OKF-SPEC-REVIEW-1.md` (against v1.0-draft).
Applied in: `okf/SPEC.md` v1.1 (2026-07-13).
Contract check: no disposition below contradicts
`~/Git/indexzero/0x/slop/intent/autokf.intent.md`; M14 realigns §14's
acceptance wording *to* the intent's actual promise (state- and
identity-fidelity — "State- and identity-lossless; history intentionally
shed").

### Blockers

| ID | Disposition | Where applied / choice recorded |
|----|-------------|---------------------------------|
| B1 | FIXED | §3: every op carries payload field `at` (writer wall-clock ms, informational only, never merge input; missing/garbage → `1970-01-01`). §9 log.md dates now "each op's `at` field (§3), truncated to UTC `YYYY-MM-DD`". **Choice:** of the review's three implementer paths, option (a) op-carried `at` was chosen over (b) autobee node-envelope `timestamp` — (b) is unconfirmed in v1.0.10 and lives outside the wire contract committed under `spec/`, so only (a) preserves I1/I9 and the frozen-wire rule; (c) apply-time local clock violates I1 outright. |
| B2 | FIXED | §7 path-safety bullet replaced: case-fold (+NFC) collision detection runs in apply, on every peer, unconditionally; materialize never writes to the view; containment violations at materialize time abort emission and report on CLI only (bug, not state). |
| B3 | FIXED | §4: `c/<id>/path` now `{ path, tag, ord }` with `ord` = global apply ordinal. §7: winner = lower `ord`. I8 (§11) appended: derivability needs no information outside `c/`. **Choice:** first-wins (earlier claim holds the path) per the review's proposed text — squat resistance; a later claimant cannot evict, which best preserves I4/I8 and the intent's adversarial-writer containment. |
| B4 | FIXED | §7 collision bullet: suffix is now `first-8-hex-of-SHA-256(_id)` (hash, not writer-key prefix); component pattern `\.conflict-[0-9a-f]{8}$` reserved (`reserved-path`); residual 8-hex collision extends to the full hash; materialize MUST NOT emit two concepts to one file under any input. |

### Majors

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

### Minors

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

### Backlog candidates

None — every minor was applied in v1.1.

### Waivers

None. No `Sign-off` required.

## Round 2

Review: `orchestration/results/OKF-SPEC-REVIEW-2.md` (against v1.1).
Applied in: `okf/SPEC.md` v1.2 (2026-07-13). The review's closure table
(B1–B4, M2–M15, m1–m15 CLOSED; M1 reopened as N1) was taken as the
regression baseline: no v1.2 edit weakens any of those 29 closed
mechanisms, and I1–I11 are unchanged as stated (I4's flag list gained
`optimistic` per n7 — a strengthening). Contract check: no disposition
below contradicts `~/Git/indexzero/0x/slop/intent/autokf.intent.md`; N3
in particular realigns materialize *to* the intent's product thesis
("deletion is dangerous") and N5 to D5's state- and identity-losslessness.

### Majors

| ID | Disposition | Where applied / choice recorded |
|----|-------------|---------------------------------|
| N1 | FIXED | §6: reviewer's proposed text adopted — mints are squat-proof. A minting `CreateConcept` (no explicit id; §3 schema now `id?`, id absent = mint, present = adopt) whose derived `writerKey \|\| seq` id is occupied does not reject: it mints `SHA-256(writerKey \|\| seq \|\| k)` (64 hex; input pinned as raw 32-byte key, u64 LE seq, u64 LE k — pinned beyond the review text to forestall an n3-class encoding finding) for the smallest `k >= 1` yielding an unseen id and records permanent `flag/squat/<squatted-id>/<tag>`. `duplicate-id` now applies only to adoption. `flag/squat` added to the §4 family list (permanent). **Choice:** the alternative framing "reject any `CreateConcept` whose id encodes a writerKey other than the issuer's own" was NOT adopted — the review itself shows adoption-gating fails (squats launder through ingest of a hand-authored file carrying the id), and such a rule would reject every legitimate §10 epoch adoption (predecessor mint ids encode old writer keys by definition). The fallback-mint mechanism closes both the DoS and the content-harvest exploit: a genuine writer's create always succeeds, and since minting ops carry no id, clients learn the minted id from the view, never from local prediction. M1 is now CLOSED. |
| N2 | FIXED | §10 step 3: reviewer's proposed text verbatim — fresh writer keypairs MUST be used; a keypair MUST NOT recur across epochs; corestore-derived keys MUST be namespaced by epoch; `init` enforces via a per-epoch namespace recorded in vault metadata. **Choice recorded:** of the review's two options, key freshness was chosen (the reviewer's own proposed text); adoption remains subject to `mint-collision-risk`, which stays meaningful against live-writer squats. §6 cross-references: "Epoch-cycle adoption never trips this rule because writer keypairs MUST NOT recur across epochs (§10)." |
| N3 | FIXED | §9 mirror bullet replaced: exact-mirror deletion is gone. Materialize reconciles through a peer-local emission manifest (path, content-hash) outside the view; only manifest-tracked files whose bytes still match are removal candidates; a `.md` file with differing bytes or no manifest entry is never deleted or overwritten — it is left in place, surfaced as pending-ingest (an ingest candidate), and the run exits nonzero unless ingest runs first; `materialize --force-mirror` restores unconditional mirroring for operator use; I9 judged on the emitted set. Watcher classification narrowed to manifest-gated reconciliation deletions. Closes both the delete race and the human-edit overwrite race the review names. |
| N4 | FIXED | §5 `type` bullet replaced with the reviewer's proposed text (n4 folded in): `CreateConcept.type` seeds `c/<id>/f/type` at the create's linearized position; `c/<id>/meta.type` is a bookkeeping copy never read by materialize; apply rejects `SetField` on `type` with an empty array or sole empty string (`flag/rejected`, reason `empty-type`) — empty `type` unreachable through accepted ops; `type: unknown` is a materialize-only defensive fallback for corrupt state that writes nothing to the view. **Choice:** apply-time rejection (the reviewer's option) over apply-time flagging of empty state — B2's "materialize never writes the view" holds with no exceptions. |
| N5 | FIXED | §9 new "Conflict-copy awareness" ingest bullet, reviewer's proposed text: terminal `\.conflict-[0-9a-f]{8,}$` ingests at the suffix-stripped path; known `_id` at its own view path → no `SetPath` (kills the per-touch `reserved-path` rejection noise); unknown `_id` (epoch cycle) → `CreateConcept` at the stripped path, the collision re-manifests under §7 and the loser re-flags/re-materializes — state, identity, and collision status carry across. §10 `--force` enumeration reworded to "old conflict path → new conflict path" with the §9 cross-reference; §7 reservation notes ingest strips before op generation, so the B4 reservation and the M12 carry-across no longer contradict. I11 achievable for collision losers. |

### Minors

| ID | Disposition | Where applied |
|----|-------------|---------------|
| n1 | FIXED | §7: reservation widened to `\.conflict-[0-9a-f]{8,}$` (any terminal hex run ≥ 8); occupied fallback extends the same way as the 8-hex case, occupation being possible only by another conflicted copy since the reservation covers every extension length. Ingest's §9 recognition uses the same `{8,}` pattern (N5). |
| n2 | FIXED | §5 base-discipline bullet: no-head unknown-base flag is `flag/conflict/<id>/-/<new>`; concept materializes bodyless until `ResolveConflict`; unknown-base rule subsumes the same-base sibling rule (one flag per revision against the head position, none pairwise). |
| n3 | FIXED | §6: mint `seq` pinned as minimal lowercase hex, no leading zeros, `0` for seq 0; adopted id exactly equal to a 64-hex writer key rejected `mint-collision-risk` (empty seq suffix). |
| n4 | FIXED | Folded into the N4 replacement text (seed + `meta.type` bookkeeping-copy sentences in §5). |
| n5 | FIXED | §4 lifecycle paragraph and §7 collision bullet: `pathcollision` clears whenever the loser's claim ceases to collide — own `SetPath`, or the competing holder vacating by rename, deletion, or its own collision loss; apply recomputes on the same events as §9 late-binding link resolution. I7's wording was already the broad reading and is unchanged. |
| n6 | FIXED | §4: `revbybase/` moved to a true top-level family, `revbybase/<id>/<base>/<rev>`, noted as trivially co-derived from `c/<id>/rev/`; bookkeeping list and I8 now non-circular. **Choice:** the review's first option (top-level family) over dropping it from I8. |
| n7 | FIXED | §11 I4 flag list: `optimistic` added. |
| n8 | FIXED | §4 `wantedrank/`: inv-count = 16-digit zero-padded decimal, `MAX = 10^16 − 1`. |
| n9 | FIXED | §5: `flag/staletag/<id>/<value>/<tag>`; §7: rename-loser `flag/clobber/<id>/path/<tag>` (with a note that the `<tag>` component keeps the key unique even against a frontmatter field literally named `path` — a sharper guarantee than the review's parenthetical); §9: copy-detection mints record `flag/copydetect/<new-id>/<original-id>`; `copydetect` added to the §4 family list (permanent). |
| n10 | FIXED | §8: buckets start full (at ceiling) at admission and at first hold. |
| n11 | FIXED | §14: byte-fidelity modulo the `_rev` frontmatter lines **and the regenerated `log.md`**. |
| n12 | FIXED | §7 path-safety bullet: **option one chosen** — a casefold loser retains `path/<its exact path>`; links to it resolve into `bl/`; the emitted absolute link is expected broken on disk (OKF §5.3 tolerates dangling links). Demotion to `wanted/` rejected: it would make `wanted/` disagree with `path/` (a path both occupied and wanted), breaking I8's derivability story. |
| n13 | FIXED | §5 LWW bullet: an empty LWW state materializes as the key omitted from frontmatter. (No clash with N4: `type` can never reach an empty state through accepted ops.) |
| n14 | FIXED | §9 `log.md` bullet: shape pinned — one `# Update Log` title, `## YYYY-MM-DD` date headings. |

### Backlog candidates

None — every minor was applied in v1.2; none conflicted with a major fix.

### Waivers

None. No `Sign-off` required.
