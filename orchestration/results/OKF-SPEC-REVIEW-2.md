# Adversarial Closure Review: auto-okf SPEC.md (v1.1)

Reviewed: `/Users/cjr/Git/indexzero/hyperwiki2/okf/SPEC.md` (v1.1, 2026-07-13)
Against: `/Users/cjr/Git/indexzero/0x/slop/intent/autokf.intent.md` (confirmed
intent); `~/Git/GoogleCloudPlatform/knowledge-catalog/okf/SPEC.md` (OKF v0.1,
read in full); the round-1 findings checklist in
`orchestration/results/OKF-SPEC-REVIEW-1.md` (findings sections only).
Reviewer has no authoring history with this artifact.

## Verdict

v1.1 is a genuine repair, not a cosmetic one: all four round-1 blockers are
closed with mechanisms that hold up under attack (op-carried informational
`at`; apply-side unconditional casefold collision detection; the `ord` field
making `path/` derivable with a defined first-wins rule; SHA-256 conflict
suffixes with a reserved pattern), and 29 of the 34 prior findings are
soundly closed — in most cases with the round-1 proposed text adopted
verbatim and correctly cross-referenced. But the spec does not pass closure.
One prior major is still open in altered form: M1's future-id squat is
blocked only for **current or former** writers, so an admitted adversary can
still pre-squat the predictable mints of a writer *not yet admitted* —
including an optimistic writer whose key is visible in `hold/` before its
ack — permanently poisoning that writer's `CreateConcept`s (N1). And the
v1.1 fixes themselves introduce four new majors, exactly the regression
class this round was tasked to grep for: the B4 reserved-pattern fix makes
every conflicted-copy file un-ingestable, which contradicts the M12 fix's
own `--force` carry-across requirement and breaks epoch-cycle losslessness
for collision losers (N5); the M1 fix's `mint-collision-risk` rule deadlocks
`_id` adoption whenever a writer keypair recurs across epochs, and the spec
never requires key freshness (N2); the M7 exact-mirror fix orders materialize
to delete any `.md` file it did not produce, which silently destroys
human-authored files created between watcher debounce and a materialize run
— silent human-content loss in a product whose thesis is "deletion is
dangerous" (N3); and §5's `type: unknown` fallback says an empty state
"materializes `type: unknown` **and flags**", a materialize-time view write
that §7's B2 fix categorically forbids — the exact B2 failure mode in
one-flag form (N4). No new blocker: every invariant remains achievable once
these five are fixed, all are repairable without architectural change, and
proposed text is supplied for each. Fourteen new minors, mostly unpinned
encodings and flag-key shapes. Because a prior finding remains OPEN and the
fixes introduced majors, the round fails closure.

## Closure Table

| ID  | Status | Evidence (v1.1) |
|-----|--------|-----------------|
| B1  | CLOSED | §3 `at` bullet (payload field, informational, `1970-01-01` fallback, apply reads no clock); §9 "Dates come from each op's `at` field (§3), truncated to UTC `YYYY-MM-DD`"; rev record `at` sourced from op payload — I1/I9 compatible |
| B2  | CLOSED | §7 path-safety bullet: casefold+NFC collision detection "in apply, on every peer, unconditionally"; "Materialize itself never writes to the view"; materialize containment violations CLI-only. (But see N4: §5 reintroduces the pattern for `type`.) |
| B3  | CLOSED | §4 `c/<id>/path { path, tag, ord }` with ord = global apply ordinal; §7 "lower `ord` … first-wins: a squatter cannot evict"; I8 clause "winner selection uses the `ord` recorded in `c/<id>/path`" — winner rule defined and derivable from `c/` alone |
| B4  | CLOSED | §7: suffix = first-8-hex-of-SHA-256(`_id`) (same-writer losers no longer collide); pattern `\.conflict-[0-9a-f]{8}$` reserved, rejected `reserved-path`; full-hash extension + "MUST NOT emit two concepts to one file". Residuals: n1 (reservation covers only exactly 8 hex), N5 (reservation regression against ingest/epoch) |
| M1  | **OPEN** | §6 seen-id → `duplicate-id`; mutations policy-checked against current path; `mint-collision-risk` for "any **current or former** writer". Residual exploit: pre-admission squat of a future/held writer's mints — see N1. Original exploit paths (hijack probe, existing-writer squat) are closed |
| M2  | CLOSED | §8: `seqAtRemoval` cross-check — actual node position `seq > seqAtRemoval` rejected regardless of claimed clock; claimed-clock test bounded to `seq <= seqAtRemoval` window; `forged-clock` rejection (self-clock entry must equal actual seq). Position is unforgeable; mechanism sound |
| M3  | CLOSED | §3: `tag` removed from every op's field list; "derived by apply from the node (`node.key`, actual seq), never read from the payload"; `RemTag.tags`/`ResolveConflict` citations explicitly non-self-identifying |
| M4  | CLOSED | §5 reserved-key bullet (`tags`/`_id`/`_rev` post-NFC → `flag/rejected` reason `reserved-key`); §9 ingest strips `_id`/`_rev` from the diff and translates removed `tags` into `RemTag` citing observed tokens |
| M5  | CLOSED | §5 base discipline: null-base-with-head cites the head; unknown base stored + flagged against current head, never head until `ResolveConflict`. Edge gap when no head exists: n2 |
| M6  | CLOSED | §4 `wanted/<path>/<from-id>` (count = subkey count) + `wantedrank/<inv-count>/<path>`; §9 late-binding recompute bullet ("I8 is the definition; any event narration is an optimization of it"). Residual: n8 (MAX/pad width unpinned) |
| M7  | CLOSED | §9 exact-mirror bullet: deletes non-emitted `.md`, removes empty dirs, containment-checked, watcher treats mirror-deletions as materialize-authored. The rename→copy-mint loop is dead. Regression introduced: N3 |
| M8  | CLOSED | §8: `host.addWriter(key, { isIndexer: op.indexer, weight: 1 })`, explicit warning about autobee's `isIndexer ? 2 : 1` default |
| M9  | CLOSED | §8: ack = linearization of indexer-authored `AddWriter`; `host.ackWriter` + fold in seq order at ack position; re-delivery verification mandated with DEVIATIONS.md recording; `H_max = 512`, `hold-overflow`; explicit `optimistic: true` |
| M10 | CLOSED | §9 index.md normative structure: `# Contents`, bullet form with title fallback, description-clause omission rule, entry path forms, concepts-then-subdirs canonical byte order — satisfies OKF §6/§9(3) |
| M11 | CLOSED | §5 `ResolveConflict` bullet: existence + open-flag validity, `bad-resolve`, `text` synthesizes revision with `base = keep`, races converge by linearization (first valid wins, loser flags) |
| M12 | CLOSED | §10: refuses (without `--force`) while `flag/conflict` **or `flag/pathcollision`** non-empty; `--force` enumerates every conflicted copy in the new epoch `log/` entry. Regression: that enumeration's carry-across is unimplementable as specified — N5 |
| M13 | CLOSED | §9 extraction bullet: CommonMark inline+reference only, code-region skipping, scheme/protocol-relative = citation, `/`-prefix vs relative resolution, root-escape ignored, `.md`/fragment strip, NFC; source-side `SetPath` re-resolution |
| M14 | CLOSED | §14 "byte-fidelity **modulo the `_rev` frontmatter line** … I11's property list is the normative fidelity set". The `_rev` contradiction it named is fixed. Residual wording: `log.md` also necessarily differs across epochs — n11 |
| M15 | CLOSED | §7: reservation and collision compare casefolded NFC components; generated-face filenames (`index.md`, `log.md`) are in every directory's casefold-collision domain |
| m1  | CLOSED | §8 defines `flag/undelete/<id>/<tag>` (UndeleteConcept) and `flag/optimistic/<writerKey>/<seq>` (fold-time rejects); both in the §4 family list |
| m2  | CLOSED | §4 flag-lifecycle paragraph: `conflict` → ResolveConflict; `pathcollision` → freeing SetPath; six families named permanent. Cross-refs consistent with §5/§7/I7 (but see n5 on the pathcollision clear trigger) |
| m3  | CLOSED | §5: removed-token set per (id, value); removed-token citation = silent no-op; never-observed token flags once; named SU-Set |
| m4  | CLOSED | §3: "Pre-decode: op ≤ 64 KiB. Post-decode, fixed order: path ≤ 1024 bytes, depth ≤ 64." |
| m5  | CLOSED | §5: `len()` = u32 LE; null base = `len(0)` with zero bytes; copied-code-wins + DEVIATIONS.md rule |
| m6  | CLOSED | §6: no-revision concept omits `_rev`; ingest without `_rev` over revision-less concept cites `base: null` |
| m7  | CLOSED | §10: `predecessorCheckpoint = { viewHash, writerLengths }`, operator-signed, "provenance metadata, not proof", trusted-operator scope |
| m8  | CLOSED | §13 CLI list includes `resolve`, `undelete` |
| m9  | CLOSED | §13: `okf/root` placeholder, "published as auto-okf@0.0.1 alongside the scope (intent D7)"; names pinned |
| m10 | CLOSED | §8: 1 token per accepted op authored by any indexer, capped at `rateCeiling`; unacked default ceiling 64. Residual: initial fill unpinned — n10 |
| m11 | CLOSED | §9: double-quote iff YAML would reinterpret; flow lists; LF; trailing newline |
| m12 | CLOSED | §9: group by UTC date, headings descending, ordinal descending within, absolute bundle-relative links, forged-future dates accepted cosmetic |
| m13 | CLOSED | §9: original = file at `_id`'s current view path, else casefolded-lexicographically-first; all others copies |
| m14 | CLOSED | §8: `RemoveWriter` leaving zero indexers rejected `policy-governance` |
| m15 | CLOSED | §9: "UTC `YYYY-MM-DD` date headings (OKF §7 MUST)" |

Invariant achievability (contract item 4): I1, I2, I3, I5, I6, I7, I8, I9,
I10 are achievable as specified — I checked in particular that `ord` and the
seen-count are pure functions of the linearization (stable under autobee
view truncation/reapply), that the token bucket and revocation checks are
replay-stable, and that every view write traces to an op (modulo N4's
ambiguity). I4 is achievable but its flag list omits `optimistic` (n7). I11
is achievable on the default path but conditionally unachievable under key
reuse (N2) and violated for collision losers under `--force` (N5).

## New Findings Table

| ID | Severity | Section | Title |
|----|----------|---------|-------|
| N1 | major | §6/§8 | M1 residual: pre-admission mint squatting — `mint-collision-risk` covers only current/former writers; future and unacked-optimistic writers' predictable mints are squattable |
| N2 | major | §6/§10 | Writer-keypair reuse across epochs deadlocks `_id` adoption via `mint-collision-risk`; key freshness never required — I11 conditionally unachievable |
| N3 | major | §9 | Exact-mirror deletion (the M7 fix) silently destroys human-authored files not yet ingested — silent content loss against the intent's product thesis |
| N4 | major | §5 vs §7 | `type: unknown` fallback "materializes … **and flags**" is a materialize-time view write — reintroduces B2's failure mode in one-flag form; contradicts §7's "Materialize itself never writes to the view" |
| N5 | major | §7 vs §9/§10 | Reserved `\.conflict-` pattern (the B4 fix) makes conflicted-copy files un-ingestable: §10 `--force` carry-across is unimplementable, and human edits to conflict copies generate rejected `SetPath` ops |
| n1 | minor | §7 | Conflict-suffix reservation matches only exactly 8 hex; the full-hash fallback path is unreserved and its occupied case undefined |
| n2 | minor | §5 | Unknown-base `SetBody` on a concept with no head: flag key's `<head>` component undefined; headless-concept materialization undefined; interplay with the same-unknown-base sibling rule unstated |
| n3 | minor | §3/§6 | Mint-id `seq` hex encoding unpinned (minimal vs padded) → cross-implementation `_id` divergence; adopted id equal to a bare 64-hex key (empty seq suffix) has undefined `mint-collision-risk` parse |
| n4 | minor | §4/§5 | `CreateConcept.type` is never stated to seed the `c/<id>/f/type` LWW register; `c/<id>/meta.type` vs `f/type` ambiguity can materialize `type: unknown` for never-SetField'ed concepts on one reading |
| n5 | minor | §4/I7 | `pathcollision` clear trigger inconsistent: §4 says only a loser `SetPath` clears; I7 says "when the loser gets a free path" (which includes the winner vacating by rename/delete/tombstone) |
| n6 | minor | §4/I8 | `revbybase/` listed as a top-level bookkeeping family but keyed `c/<id>/revbybase/…` (inside `c/`); I8 calls it "derivable from `c/`" — circular as written |
| n7 | minor | §11 | I4's flag list omits `optimistic` (a fold-time-rejected op's effect disappears; only `flag/optimistic` records it) |
| n8 | minor | §4 | `wantedrank/` inv-count: MAX and zero-pad width unpinned → cross-implementation view-key divergence (feeds I2 hash and epoch `viewHash`) |
| n9 | minor | §4/§5/§7/§9 | Flag key shapes unpinned: `flag/staletag` shape never given; rename-loser `flag/clobber` key component (SetPath is not a field); ingest copy-detection "flag" family unnamed |
| n10 | minor | §8 | Token-bucket initial fill unpinned (empty vs full at admission/hold) → accept/reject partition differs across implementations |
| n11 | minor | §14 | Epoch byte-fidelity "modulo the `_rev` frontmatter line" still fails a tree diff on `log.md` (new epoch narrates fresh creations + the epoch entry); the exclusion must also name the regenerated `log.md` |
| n12 | minor | §4/§7/§9 | Casefold-collision loser apparently still holds `path/<its-exact-path>` (no exact competitor), so `bl/` marks links resolved to a path whose file materializes at the conflict path — intended state needs one line |
| n13 | minor | §5/§9 | Empty LWW state (removed key via `SetField` empty array) materialization unstated — must be "key omitted from frontmatter" or ingest/materialize disagree forever |
| n14 | minor | §9 | `log.md` top-level title and date-heading level unpinned (`#` vs `##`; OKF §7's example shows a `#` title above `##` dates) — cross-implementation byte divergence in a reserved face |

## New Findings Detail

### N1 (major) — Pre-admission mint squatting (M1 residual; M1 → OPEN)

**Exploit.** §6 rejects adoption of an id "whose writerKey prefix equals any
**current or former** writer's key with `seq >=` that writer's seen-count."
Writer X is not yet admitted — but X's key is public before admission by
construction: it must be known to issue `AddWriter`, and under optimistic
onboarding X's key is visible to every peer in `hold/<Xkey>/*` before the
ack linearizes. Admitted adversary Q issues
`CreateConcept { id: <Xkey||n> for n = 0..k, path: <inside Q's namespace>, type: t }`.
Every check passes: the ids are unseen (`duplicate-id` vacuous), the paths
are in Q's namespace (policy passes), and X is neither a current nor a
former writer (`mint-collision-risk` vacuous). The squats land as ordinary
concepts. When `AddWriter(X)` later linearizes and X's held `CreateConcept`
at seq n folds, its mint id `Xkey||n` is now "already present in `c/`" →
rejected `duplicate-id` (§6 seen-id rule). Worse than DoS: Q controls the
squatted concept's path — Q can `SetPath` it wherever policy allows and
harvest X's subsequent `SetBody`/`SetField` ops (X's client believes it
created that id), capturing X's content into a Q-owned concept. Once X is
admitted, *further* squats are blocked by the seen-count check, but the
pre-admission window is unbounded and cheap, and the poisoned seqs are
poisoned forever (append-only). Note the obvious fix — gate adoption on
indexer issuers — fails: adoption ops are legitimately generated by the
ingest watcher from any hand-authored file carrying an unknown `_id`, so a
squat launders through a file drop.

**Proposed replacement text** (§6, appended to the seen-id bullet):

> Squats cannot block mints: a `CreateConcept` **minting** (no explicit id)
> whose derived id `writerKey || seq` is already present in `c/` does not
> reject; it mints instead `SHA-256(writerKey || seq || k)` (64 hex) for the
> smallest `k >= 1` yielding an unseen id, and records the permanent audit
> flag `flag/squat/<squatted-id>/<tag>`. Creation by a genuine writer always
> succeeds; a squatter must spend one op per candidate and always loses.
> `duplicate-id` rejection applies only to **adoption** (explicit-id)
> creates. `flag/squat` joins the §4 family list as a permanent audit
> record.

### N2 (major) — Epoch cycling deadlocks under writer-key reuse

**Exploit/derivation.** §10 step 3: "init a fresh vault; ingest the
directory with `_id` adoption." Every adopted id from the old epoch is
mint-shaped: `<oldWriterKey(64 hex)>||<seq hex>`. §6 rejects adoption of any
id whose 64-hex prefix equals a **current** writer's key with
`seq >= seen-count`. In a fresh vault, seen-counts are ~0. So if any old
writer keypair is also a writer in the new vault, *every one of its
concepts' ids* is rejected `mint-collision-risk` — the epoch cycle drops
that writer's entire corpus from identity preservation, and I11 fails. The
spec never requires fresh keys. This is not exotic: corestore derives core
keys deterministically from (primaryKey, name); an implementation that
inits the new vault over the same corestore primary key and the same core
name — the natural reading of "init a fresh vault" for the same operator —
reuses the writer key *by default*. The M1 fix and the §10 adoption
contract are mutually inconsistent unless key freshness is normative.

**Proposed replacement text** (§10, appended to step 3):

> The fresh vault MUST use freshly generated writer keypairs: a writer
> keypair MUST NOT recur across epochs (corestore-derived keys MUST be
> namespaced by epoch). Otherwise adoption of the predecessor's mint-shaped
> ids is rejected `mint-collision-risk` and I11 is unachievable. `init`
> MUST enforce this by deriving writer cores under a per-epoch namespace
> recorded in vault metadata.

### N3 (major) — Exact-mirror deletion destroys un-ingested human files

**Exploit.** §9 materialize: "after emission it deletes any `.md` file
under the bundle root not produced by this run," and the watcher "treats
mirror-deletions as materialize-authored … never as human deletes." Human
H creates `notes/idea.md` (new concept, no `_id` yet). Before the watcher's
debounce fires — or while the watcher is simply not running; `materialize`
and `watch` are independent CLI verbs (§13) — the operator (or a schedule)
runs `materialize`. The file was not produced by this run → deleted. The
watcher then classifies the deletion as materialize-authored, so no op of
any kind records that content ever existed. Silent, total loss of
human-authored content — in a product whose thesis is "deletion is
dangerous" and whose I4 promises no silent loss (the file never became an
op, so I4's letter is untouched while its spirit is gutted). The same race
eats human *edits* to an existing file (edited bytes replaced by the view's
version; the edit is lost without a `SetBody`).

**Proposed replacement text** (§9, exact-mirror bullet, appended):

> Mirror-deletion (and overwrite) is gated by the emission manifest:
> materialize records, in peer-local state outside the view, the
> (path, content-hash) set it last emitted. A file whose current bytes
> differ from that manifest entry — or that has no entry — is **never
> deleted or overwritten**; it is reported as pending-ingest and the run
> exits nonzero unless ingest is run first (`materialize --force-mirror`
> restores unconditional mirroring for operator use). Converged-peer I9 is
> judged on the emitted set; pending-ingest files are transient local state
> that becomes ops.

### N4 (major) — §5's `type: unknown` fallback orders a materialize-time view write

**Exploit/derivation.** §5: "an empty state materializes `type: unknown`
**and flags**." Flags live in the view (`flag/…`, §4). §7 (the B2 fix):
"Materialize itself never writes to the view." Three implementers do three
things: (a) flag at materialize time — the literal reading — recreating B2
exactly (peer that materializes diverges from peer that doesn't; I2/I3
die); (b) flag at apply time when a `SetField` empties `type` —
deterministic, but nothing in §5 says so; (c) no flag at all, reading §7 as
controlling. One of the three destroys convergence and the other two
observably differ. This is a section-vs-section contradiction introduced in
v1.1 (the v1.0 sentence predates the B2 principle's "never writes" wording
and was not reconciled).

**Proposed replacement text** (§5, `type` bullet):

> **`type`**: LWW-array like any other key. `CreateConcept.type` seeds the
> register at the create's position (n4). Apply rejects any `SetField` on
> `type` whose value is an empty array or a sole empty string
> (`flag/rejected`, reason `empty-type`) — an empty `type` state is
> unreachable through accepted ops. `type: unknown` remains a
> materialize-only defensive fallback for corrupt state and writes nothing
> to the view (§7).

### N5 (major) — Reserved conflict pattern vs ingest and epoch carry-across

**Exploit/derivation.** §7 (B4 fix): `CreateConcept`/`SetPath` carrying a
terminal component matching `\.conflict-[0-9a-f]{8}$` are rejected
`reserved-path`. Now follow the spec's own flows. (1) Epoch cycle with
`--force` (§10/M12 fix): the collision loser's only on-disk face is
`p.conflict-<hex>.md`. The fresh vault's ingest sees an unknown `_id` at
path `p.conflict-<hex>` → `CreateConcept` at that path → **rejected
`reserved-path`**. The concept is not created; §10's requirement to
"enumerate every conflicted copy carried across" describes a carry-across
that cannot happen; the loser's state and identity are dropped from the new
epoch — directly against intent D5's "state- and identity-lossless" and
I11. (2) Steady state, same vault: a human edits `p.conflict-<hex>.md`.
Ingest sees a known `_id` whose view path is `p` at a "new" path → emits
`SetPath { path: "p.conflict-<hex>" }` → rejected `reserved-path`,
`flag/rejected` noise on every human touch of every conflicted copy (the
body edit itself lands, so this is noise plus a permanently re-fired
rejection, not loss). The B4 and M12 fixes contradict each other; nothing
in §9 teaches ingest that conflict-suffixed filenames are a materialize
artifact, not a path.

**Proposed replacement text** (§9, ingest `_id` rules, appended):

> Conflict-copy awareness: a file whose terminal component matches
> `\.conflict-[0-9a-f]{8,}$` ingests at the **suffix-stripped path**. Known
> `_id` whose view path equals the stripped path → no `SetPath` (the file
> is the loser's materialized face). Unknown `_id` (epoch cycle) →
> `CreateConcept` at the stripped path; the collision re-manifests in the
> new vault under §7's ordinary rules, the loser re-flags and
> re-materializes at a conflict path — state, identity, and collision
> status all carry across. §10's `--force` enumeration lists old conflict
> path → new conflict path.

### Minor findings

- **n1 (§7).** The reservation regex covers exactly 8 hex; the full-hash
  fallback (`.conflict-<64 hex>`) is not reserved, so a 2^32-grind adversary
  who engineers an 8-hex collision between two losers can pre-squat the
  full-hash landing path, and "MUST NOT emit two concepts to one file" has
  no mechanism left. *Proposed:* reserve `\.conflict-[0-9a-f]{8,}$` (any
  hex run ≥ 8) and state that an occupied fallback extends the same way as
  the 8-hex case.
- **n2 (§5).** Unknown-base `SetBody` on a concept with no head: the flag
  key `flag/conflict/<id>/<head>/<new>` has no `<head>`; whether the
  concept materializes with an empty body; and whether two `SetBody`s citing
  the same unknown base are additionally mutual siblings. *Proposed:* "with
  no current head, the flag is `flag/conflict/<id>/-/<new>`; the concept
  materializes bodyless until `ResolveConflict`; the unknown-base rule
  subsumes the same-base sibling rule (one flag per revision vs the head
  position, none pairwise)."
- **n3 (§3/§6).** Pin mint seq encoding: "seq is minimal lowercase hex, no
  leading zeros (`0` for seq 0)"; and "an adopted id exactly equal to a
  64-hex writer key is rejected `mint-collision-risk` (empty seq suffix)."
- **n4 (§4/§5).** State that `CreateConcept.type` seeds `c/<id>/f/type` as
  an LWW write at the create's position, and that `c/<id>/meta.type` is a
  bookkeeping copy of the creation value never read by materialize. (Folded
  into the N4 replacement text.)
- **n5 (§4/I7).** Align the clear trigger: "`pathcollision` clears whenever
  the loser's claim ceases to collide — its own `SetPath`, or the competing
  holder vacating by rename, deletion, or its own collision loss." Apply
  recomputes on the same events as §9 late-binding link resolution.
- **n6 (§4/I8).** Either move `revbybase/` to a true top-level family
  (`revbybase/<id>/<base>/<rev>`) or drop it from the bookkeeping list and
  I8, noting it is part of `c/` and trivially co-derived.
- **n7 (I4).** Add `optimistic` to I4's flag list.
- **n8 (§4).** Pin inv-count: "16-digit zero-padded decimal,
  `MAX = 10^16 − 1`."
- **n9 (§4/§5/§7/§9).** Pin `flag/staletag/<id>/<value>/<tag>`; rename-loser
  clobber as `flag/clobber/<id>/path/<tag>`; copy-detection mints record
  `flag/copydetect/<new-id>/<original-id>` (add to §4 list, permanent).
- **n10 (§8).** Pin: "buckets start full (at ceiling) at admission and at
  first hold."
- **n11 (§14).** "…byte-fidelity modulo the `_rev` frontmatter lines **and
  the regenerated `log.md`** (both necessarily re-derive in the new
  epoch)…"
- **n12 (§4/§7/§9).** One line: "a casefold loser retains `path/<its exact
  path>`; links to it resolve (`bl/`), and the emitted link is expected to
  be broken on disk (OKF §5.3 tolerates it)" — or, alternatively, demote
  such links to `wanted/`. Pick one.
- **n13 (§5/§9).** "An empty LWW state materializes as the key omitted from
  frontmatter."
- **n14 (§9).** Pin `log.md` shape: `# Update Log` title, `## YYYY-MM-DD`
  date headings.

## Regression-grep notes (contract item 5)

Cross-reference sweep of every v1.1 mechanism: all §3 reject reasons
(`reserved-key`, `duplicate-id`, `mint-collision-risk`, `reserved-path`,
`unsafe-path`, `bad-resolve`, `policy-governance`, `revoked`,
`forged-clock`, `hold-overflow`, `empty-type` proposed) land in the single
`flag/rejected` family; the §4 family list matches every flag name used in
§§3–10 (`squat`/`copydetect` would be additions per N1/n9); the bookkeeping
exclusion list matches materialize's `c/`-walk except the `revbybase/`
placement nit (n6); `seen/` usage in §3 and §6 is consistent; the §8
optimistic/hold/rate mechanisms reference only defined families. The
contradictions found are N4 (§5 vs §7), N5 (§7 vs §9/§10), N2 (§6 vs §10),
and the n5/n6/n7 wording splits. OKF-conformance spot-check of the emitted
faces (index structure, root-only frontmatter, `YYYY-MM-DD` headings,
reserved filenames, frontmatter-parseable conflicted copies) found no new
violations beyond n14's unpinned heading level. Intent sweep: no
contradiction with any confirmed decision D1–D7; observations only — the
intent's process constraints ("never delete from sslop/", "stacked PRs,
owner merges") and D5's naming of epoch cycling as the redaction mechanism
remain unstated in the spec, as in v1.0 (noted in round 1's coverage
matrix without finding IDs; unchanged).

## Open items

- **M1/N1** — pre-admission mint squatting (residual of M1; M1 is OPEN).
- **N2** — epoch key-reuse adoption deadlock (regression from the M1 fix).
- **N3** — mirror-delete destroys un-ingested human files (regression from
  the M7 fix).
- **N4** — materialize-time `type` flag (B2's failure mode reintroduced by
  unreconciled §5 wording).
- **N5** — conflicted copies un-ingestable; §10 `--force` carry-across
  unimplementable (B4 fix vs M12 fix).

VERDICT: SPEC-FAIL (open: M1/N1, N2, N3, N4, N5)
