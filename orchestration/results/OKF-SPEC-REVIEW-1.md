# Adversarial Review: auto-okf SPEC.md (v1.0-draft)

Reviewed: `/Users/cjr/Git/indexzero/hyperwiki2/okf/SPEC.md` (2026-07-13 draft)
Against: `/Users/cjr/Git/indexzero/0x/slop/intent/autokf.intent.md` (confirmed intent);
`~/Git/GoogleCloudPlatform/knowledge-catalog/okf/SPEC.md` (OKF v0.1, read in full);
autobee source (`index.js` at v1.0.10 and main, `lib/apply-calls.js` at main), autobee README;
hyperbee2 README (range-iteration surface).

## Verdict

The spec's skeleton is sound — the intent's seven decisions are all recognizably
present, the autobee §1 API claims check out against the actual source (all six
host methods exist; `view.write()`/`tryPut`/`flush` and `db.view` are real;
hyperbee2 has `createReadStream` with `gt/gte/lt/lte`, so every range walk the
spec assumes is implementable). But the document is not buildable to its own
invariants as written. Four mechanisms are blockers: (B1) `log.md` needs dates
and the §5 revision record needs an `at` field, yet no op in the frozen §3 wire
schema carries a timestamp — I1 forbids wall clocks, so the data cannot exist;
(B2) §7 orders materialize to write `flag/pathcollision` into the view based on
local-filesystem case behavior, which makes the view a function of which peer
materialized on which OS, destroying I1/I2; (B3) I8 declares `path/` "exactly
derivable from `c/`" but the path-collision winner is a linearization-order
fact that `c/` does not record — and §7 never even says whether the winner is
the first holder or the last claimant; (B4) the conflicted-copy suffix is the
first 8 hex of `_id`, which is a *writer-key prefix*, so any two losing
concepts minted by the same writer collide byte-identically at the same
conflict path, breaking I9's own "including conflicted copies" clause. Around
those, a cluster of majors would let an adversarial writer (the spec's own
threat model) forge OR-set tags, dodge revocation with a lied clock, hijack
frontmatter via `SetField("_id")`, squat future `_id`s, and displace heads
flag-free with fabricated bases. Each finding below carries proposed text; all
are fixable without changing the architecture.

## Findings Table

| ID  | Severity | Section    | Title |
|-----|----------|------------|-------|
| B1  | blocker  | §3/§5/§9   | No timestamp exists anywhere in the op schema; `log.md` dates and rev `at` are unproducible under I1/I9 |
| B2  | blocker  | §7         | Materialize-time `flag/pathcollision` writes keyed to local filesystem poison the view (I1/I2) |
| B3  | blocker  | §4/§7/§11  | I8 unachievable: path-collision winner not derivable from `c/`; winner rule itself undefined |
| B4  | blocker  | §7         | Conflicted-copy suffix = writer-key prefix → same-writer losers collide; suffix not reserved (I9/I4) |
| M1  | major    | §6         | `CreateConcept` citing a SEEN id is undefined; `_id` adoption enables squatting and hijack |
| M2  | major    | §8         | Causal revocation trusts the self-reported clock; a revoked adversary evades it forever |
| M3  | major    | §3         | `tag` is a client-supplied payload field → forgeable OR-set observation tokens (contradicts §3's own prose) |
| M4  | major    | §5/§9      | `SetField` on `tags`, `_id`, `_rev` undefined → merge-model category error and frontmatter injection |
| M5  | major    | §5         | Null/fabricated-base `SetBody` evades conflict detection → flag-free head displacement (I4) |
| M6  | major    | §4/§9/I7/I8| `wanted/` lifecycle: one-way clearing vs I8 derivability; vacated target paths; count-ranking impossible from the stated keyspace |
| M7  | major    | §9         | Materialize never reconciles stale files → rename leaves the old file → ingest mints a copy (feedback loop); I9 across materialize histories |
| M8  | major    | §1/§8      | "Uniform autobee weight" contradicts autobee's `addWriter` defaults (indexer=2, non-indexer=1); no weight value stated |
| M9  | major    | §8         | Optimistic onboarding: the "ack" event is never defined; autobee optimistic re-apply semantics unverified; `H_max` unbound |
| M10 | major    | §9         | `index.md` body underspecified (headings, title source, link form) → OKF §6/§9(3) conformance risk and implementer divergence |
| M11 | major    | §3/§5      | `ResolveConflict` semantic holes: `text?` base, nonexistent hashes, concurrent resolves |
| M12 | major    | §10        | Compact refuses on `flag/conflict` but not `flag/pathcollision` → silent permanent path mutation across epoch |
| M13 | major    | §9         | Link-extraction rules unspecified (syntax classes, code fences, relative-link re-resolution on rename, `.md` stripping) |
| M14 | major    | §14/I11    | Epoch-cycle "byte-fidelity" acceptance is unachievable: `_rev` necessarily changes across a cycle |
| M15 | major    | §7/§9      | Case-insensitivity: a concept named `Index` clobbers the generated `index.md` on APFS; reserved-check case rule unspecified |
| m1  | minor    | §4         | `flag/optimistic` and `flag/undelete` families named but never defined |
| m2  | minor    | §7/§11     | `clobber`/`staletag` called "clearable" with no clearing mechanism; flag-lifecycle table missing for most families |
| m3  | minor    | §5         | Benign concurrent `RemTag` of the same tag produces spurious `flag/staletag` (no removed-token memory) |
| m4  | minor    | §3         | "Pre-decode limits" include checks (path length, depth) that require decoding |
| m5  | minor    | §5         | revHash formula prose leaves `len()` encoding and null-base encoding undefined (pinned only by copied code) |
| m6  | minor    | §6         | `_rev` emission for a concept with no body revision is undefined |
| m7  | minor    | §10        | `predecessorCheckpoint` never defined; epoch chain is self-asserted and unverifiable |
| m8  | minor    | §13        | Ops `ResolveConflict`/`UndeleteConcept` exist but no CLI surface (`resolve`, `undelete`) is delivered |
| m9  | minor    | §13        | Intent D7's root `auto-okf@0.0.1` package is absent from deliverables |
| m10 | minor    | §8         | Token bucket "replenished by accepted indexer ops" is ambiguous; policy source for unacked writers undefined |
| m11 | minor    | §9         | YAML emission style (quoting, escaping, list form) unpinned — cross-implementation byte divergence |
| m12 | minor    | §9         | `log.md`: same-date grouping/ordering rule missing; adversarial future dates pin entries at top; entry link form unstated |
| m13 | minor    | §9         | Ingest copy-detection ("second is a copy") is filesystem-walk-order dependent |
| m14 | minor    | §8         | Removing the last indexer leaves the vault permanently ungovernable; unaddressed |
| m15 | minor    | §9         | "ISO-8601 date headings" should say `YYYY-MM-DD` (OKF §7 MUST); ISO-8601 admits datetimes |

Sections that survived attack, one line each: the reserved-path rule matches
OKF §3.1 exactly (OKF reserves `index.md`/`log.md` at *every* level, so
rejecting terminal `index`/`log` components in subdirectories is correct, and
directories named `index/` remain legal); root-only `index.md` frontmatter
matches OKF §11's carve-out of §6; §1's host-method list
(`addWriter/removeWriter/ackWriter/interrupt/createAnchor/genesis`) is verified
accurate against `lib/apply-calls.js`; hyperbee2 range iteration exists as
assumed; `RemTag`'s cross-value citation abuse is naturally inert (element maps
are per-value, so foreign tags read as absent); §12 non-goals faithfully
mirror the intent's out-of-scope list; the reference file
`~/Git/indexzero/uppr2-worktrees/attempt-opus-1/lib/registry.js` exists.

---

## Findings Detail

### B1 (blocker) — No timestamp anywhere in the op schema

**Exploit/derivation.** §9 requires `log.md` "ISO-8601 date headings … Dates
come from op-carried writer timestamps." §5 requires the revision record
`{ base, text, writer, at }`. Now read §3: `CreateConcept { id, path, type,
tag }`, `SetBody { id, base, text }` … no op carries a timestamp, and §3
declares the wire contract frozen ("message ids and field orders never
reordered or removed; generated codec committed under `spec/`"). I1 forbids
wall clocks in apply. So the `at` field and every `log.md` date heading have
no source. Three reasonable implementers do three different things: (a) add an
`at` field to every op (deviating from the committed schema), (b) use autobee's
node-envelope `timestamp` (present at main; not clearly present in the v1.0.10
node fields — and not part of "the op" the spec commits under `spec/`),
(c) stamp at apply time with the local clock, violating I1 and I9 outright.
Options (a) and (b) yield different wire formats and different `log.md` bytes.
As specified, I9's byte-identical `log.md` is unachievable.

**Proposed replacement text** (§3, op schema block): add to every op listing
the field `at` with the note:

> Every op carries `at`: the writer's wall-clock milliseconds at append time,
> encoded in the op payload. `at` is informational: never an input to merge,
> ordering, or conflict detection (I1); it is the sole source for `log.md`
> date headings and the `rev` record's `at`. Apply MUST NOT read any clock;
> a missing/garbage `at` materializes as `1970-01-01` rather than rejecting.

And in §9, replace "Dates come from op-carried writer timestamps" with "Dates
come from each op's `at` field (§3), truncated to UTC `YYYY-MM-DD`."

### B2 (blocker) — Materialize-time flag writes keyed to the local filesystem

**Exploit.** §7: "a path that … collides case-insensitively on a
case-insensitive filesystem is skipped with `flag/rejected` … at apply time
where detectable, `flag/pathcollision` at materialize time otherwise."
Concepts exist at `/Readme` and `/README`. Two peers converge; views are
bit-identical (I2 holds). The macOS peer runs `materialize`, detects the
case-fold collision, and — as instructed — writes `flag/pathcollision` into
the view. The Linux peer materializes both files and writes nothing. Views now
differ with no further ops: I2 is dead, and I3 dies with it (a rebuild never
reproduces a materialize-injected flag). Apply also cannot "detect" a peer's
filesystem without a peer-local read, which I1 explicitly bans. The mechanism
is self-contradictory: either the flag is deterministic (then it belongs in
apply, unconditionally) or it is local (then it must never touch the view).

**Proposed replacement text** (§7, path-safety bullet):

> Path safety (vault-ld M5 ancestry): case-fold (plus NFC) collision detection
> is performed **in apply, on every peer, unconditionally** — when a path's
> casefolded form equals another live concept's casefolded path, the
> linearization loser gets `flag/pathcollision` exactly as for exact-path
> collisions, and materializes at the conflicted-copy path on every platform.
> Materialize itself never writes to the view. Lexical/realpath containment is
> checked at materialize time; a violation aborts that file's emission and is
> reported on the CLI only (it is unreachable if apply's path validation is
> correct, and is a bug, not state).

### B3 (blocker) — I8's `path/`-from-`c/` derivability is impossible; the winner rule is undefined

**Exploit/derivation.** §7: on a two-concepts-one-path collision, "`path/<path>`
holds the linearization winner; the loser keeps its path value." So after the
dust settles, `c/A/path = /p` and `c/B/path = /p` — two records, same value.
I8 claims `path/` is "exactly derivable from `c/` at every quiescent point."
Derive it: the winner is whichever claim linearized {first? last?} — but (a)
§7 never says which ("linearization winner" is ambiguous between
first-holder-keeps and last-claimant-evicts; LWW intuition says last, squat
resistance says first; two implementers will observably differ on which
concept gets `/p.md` and which gets the conflict file), and (b) either way, the
order of two cross-writer ops is a topological-sort fact recorded nowhere in
`c/` — `tag = writerKey || seq` does not order across writers. I8 as stated is
unachievable with the §4 keyspace as stated.

**Proposed replacement text** (§4, keyspace line):

> `c/<id>/path    current path { path, tag, ord }` — `ord` is the global apply
> ordinal (count of nodes linearized so far) at which this path was set.

(§7, collision bullet):

> **Two concepts on one path**: the concept whose current path-claim has the
> **lower `ord`** (the earlier claim under linearization) holds `path/<path>`;
> a later claimant is the loser (first-wins: a squatter cannot evict). The
> loser keeps its path value and materializes at the conflicted-copy path.

(I8): append "— `path/` winner selection uses the `ord` recorded in
`c/<id>/path`, so derivability requires no information outside `c/`."

### B4 (blocker) — Conflicted-copy suffix collides for same-writer losers and is not reserved

**Exploit 1 (no adversary needed).** `_id` mint is `writerKey || seq` hex, so
the first 8 hex of any `_id` minted by writer W are the first 4 bytes of W's
public key — identical for *every* concept W creates. Writer X creates C at
`/p` (winner). Writer W's concepts A and B (both minted by W) are each
`SetPath`'d to `/p` and both lose. Both materialize at
`/p.conflict-<same-8-hex>` — one file, two concepts. Deterministic, yes;
byte-identical bundles, no: which body lands is walk-order luck. I9 ("including
conflicted copies") and I4 both break.

**Exploit 2 (adversarial).** The suffix pattern is not reserved: writer M
issues `CreateConcept` at path `p.conflict-abcd1234` (passes §7 validation —
only `index`/`log` are reserved), pre-occupying the loser's landing spot. The
loser's conflict file now collides with a real concept, and nothing in §7
defines a second-level escape.

**Proposed replacement text** (§7, collision bullet, replacing the suffix
sentence):

> …materializes at a **deterministic conflicted-copy path**:
> `<path>.conflict-<first-8-hex-of-SHA-256(_id)>` (hash, not prefix: `_id`
> prefixes are shared by a writer's every mint). The literal component pattern
> `\.conflict-[0-9a-f]{8}$` is **reserved**: `CreateConcept`/`SetPath` carrying
> it are rejected (`flag/rejected`, reason `reserved-path`), so conflict paths
> cannot be squatted. If two losers of the same path still hash-collide on
> 8 hex, extend to the full hash; materialize MUST NOT emit two concepts to
> one file under any input.

### M1 (major) — `CreateConcept` on a SEEN id is undefined; adoption enables squatting

**Exploit.** §6 defines adoption only for "an id the vault has never seen."
Path 1 (hijack probe): agent Q, policy-restricted to `namespacePrefixes:
['agents/q/']`, issues `CreateConcept { id: <victim's _id>, path:
'agents/q/stolen', type: 'X' }`. The path is inside Q's namespace, so a
path-based policy check passes. If apply treats seen-id create as
"adopt-or-update," the victim concept is renamed into Q's namespace and its
`type` overwritten — a full hijack through an op the policy layer waved
through. Path 2 (future-id squat): `_id`s are predictable (`writerKey||seq`,
both public). Q hand-authors a file with `_id = <W's key><W's next seq>` and
lets ingest adopt it. When W's genuine `CreateConcept` linearizes, its minted
id is now "seen" — behavior undefined; on the adopt-or-update reading, W's
create mutates Q's squatted concept instead of minting. Identity is corrupted
either way.

**Proposed replacement text** (§6, after the adoption sentence):

> A `CreateConcept` whose `id` is already present in `c/` is **rejected**
> (`flag/rejected`, reason `duplicate-id`) — creation never updates; only
> `SetField`/`SetPath`/`SetBody` mutate an existing concept, and each is
> policy-checked against the concept's **current** path, not the op's claimed
> path. Adopted ids MUST match `^[0-9a-f]{2,128}$` after NFC; a mint whose tag
> collides with a previously adopted id (predictable-mint squatting) rejects
> the *earlier adopted squat's* create at detection time is impossible, so
> instead: mint ids are `writerKey || seq` and adoption of an id whose
> writerKey prefix equals any current or former writer's key with `seq >=`
> that writer's seen-count is rejected (`flag/rejected`, reason
> `mint-collision-risk`).

### M2 (major) — Causal revocation trusts a forgeable clock

**Exploit.** §8: an op from a removed writer is rejected unless its `clock`
"strictly precedes" the recorded revocation clock — but `clock` is op payload,
i.e., whatever the writer claims. Adversary W is revoked at clock C (which
embeds the remover's observed seq of W, say `s`). W simply keeps appending
forever with a frozen clock copied from its pre-revocation state. Every claim
strictly precedes C; every peer accepts; `host.removeWriter` is (correctly)
never called, so autobee keeps linearizing W's core; W has unbounded
post-revocation write access. I10's guarantee is gutted for exactly the
adversarial writers the intent says the system must contain. The unforgeable
signal is the node's own position: autobee gives apply `node.length` — W
cannot lie about which seq an op physically occupies in W's core.

**Proposed replacement text** (§8, revocation bullet, appended):

> The claimed clock is cross-checked against unforgeable position:
> `gov/removed/<key>` also records `seqAtRemoval` = the revocation clock's
> entry for the removed writer. Any node from that writer with actual
> `node`-position `seq > seqAtRemoval` is rejected (reason `revoked`)
> **regardless of its claimed clock**; the claimed-clock strict-precedence
> test applies only to the (bounded) window of ops at `seq <= seqAtRemoval`
> still in flight. Additionally, apply rejects any op whose claimed
> self-clock entry does not equal its actual seq (reason `forged-clock`).

### M3 (major) — `tag` as a client-supplied op field is forgeable

**Exploit.** §3's schema puts `tag` in the payload of `CreateConcept`,
`SetField`, `AddTag`, etc., while §3's prose defines `tag = writerKey || seq`
— a value apply can and must derive from the node envelope (`node.key`,
`node.length` / the `seen/` fallback). If it's payload, adversary W appends
`AddTag { id, value: 'approved', tag: <writer-V's-token> }`: the OR-set
element map now attributes the add to V; a later honest `RemTag` computed
from view state cites V's token and W's forged observation both, or audit
(`flag/clobber/<...>/<tag>`) blames V for W's clobbers. Attribution and OR-set
causality both poison. The two readings (payload vs derived) are an internal
contradiction; implementers will observably differ on the wire format itself.

**Proposed replacement text** (§3): remove `tag` from every op's field list
and append after the `tag` bullet:

> `tag` is **derived by apply** from the node (`node.key`, actual seq), never
> read from the payload; no op encodes its own tag. Only `RemTag.tags` and
> `ResolveConflict.keep/supersede` carry *references to other ops'* tags/
> hashes, and those are citations, not self-identifications.

### M4 (major) — `SetField` on `tags`, `_id`, `_rev` is undefined

**Exploit.** §5 makes `tags` an OR-set "and only it," everything else
LWW — but nothing stops the op `SetField { id, key: 'tags', value: [...] }`.
One implementer rejects it; another writes an LWW register at `c/<id>/f/tags`
that now coexists with the OR-set element map — materialize emits which?
Divergent bundles. Worse: `SetField { key: '_id', value: ['deadbeef'] }`
— §5 only says `_id`/`_rev` are "never merged," not that the *field names*
are rejected — materializes a second `_id:` line (or a conflicting one) in
frontmatter; on the next ingest pass the file's `_id` is ambiguous or hijacked
to `deadbeef`, and §9's adoption machinery imports the lie. Ingest is also
told to emit "`SetField` with empty array" for a removed key — for a removed
`tags` key that is a category error the spec itself commits.

**Proposed replacement text** (§5, new bullet):

> **Reserved field keys**: `SetField` with `key` ∈ {`tags`, `_id`, `_rev`}
> (post-NFC, exact) is rejected (`flag/rejected`, reason `reserved-key`).
> Tag mutations travel only as `AddTag`/`RemTag`; identity and revision are
> never fields. Ingest translates a *removed* `tags` key into `RemTag` ops
> citing every currently observed token, and strips `_id`/`_rev` from the
> frontmatter diff before op generation.

### M5 (major) — Fabricated/null bases evade conflict detection (I4)

**Exploit.** §5: siblings and `flag/conflict` arise only when two revisions
cite the same **non-null** base; null base means "no base cited," no mutual
conflicts. Honest human H edits `/notes.md`; the file cites `_rev = R`
(current head), so H's `SetBody` has `base: R`. Concurrent adversarial (or
merely sloppy) writer W issues `SetBody { base: null, text: spam }` — or
`base: <random 32 bytes>` that never existed. W's op shares no base with
anything: no siblings, no flag. Head is LWW under linearization; if W
linearizes after H, the bundle materializes spam, H's text is demoted to a
non-head revision, and **no flag anywhere records it** — under honest
same-base concurrency the identical outcome would have produced
`flag/conflict`. I4 ("no op's effect disappears without a flag") is violated
by construction, asymmetrically punishing honest base citation.

**Proposed replacement text** (§5, bodies bullet, appended):

> A `SetBody` whose `base` is null **while a head exists** at its linearized
> position is treated as citing that head (it is an edit of *something*; the
> only flag-free fresh start is the concept's first revision). A `SetBody`
> citing a base hash absent from `c/<id>/rev/` is stored, flagged
> `flag/conflict/<id>/<head>/<new>` against the current head, and never
> becomes head until `ResolveConflict` selects it — fabricated ancestry
> cannot silently displace real ancestry.

### M6 (major) — `wanted/` lifecycle vs I8; vacated targets; ranking impossible from the keyspace

**Exploit.** Concept links `A → /guides/setup`; no holder → `wanted/…` entry.
Concept C lands at `/guides/setup`: entry clears (§9), edge promotes to
`bl/C/A`. Now C is renamed to `/guides/install` (or tombstoned, or loses the
path in a collision). §9's clearing is stated one-way ("clears when a concept
lands"); nothing re-creates the wanted entry or demotes `bl/C/A` on vacation.
An event-driven implementer leaves `bl/` pointing at a concept the link text
no longer resolves to, and `wanted/` blind to a once-again-dangling path; a
derivability-driven implementer (reading I8: `wanted/` "exactly derivable
from `c/`") recomputes and gets the opposite state. Observable divergence,
and only one of them satisfies I8. Separately: the key `wanted/<path>/<referrers>`
sorts by *path*; §9 and §14 demand output "sorted by referrer count" — no
keyspace scan of that layout yields count order, and it's ambiguous whether
`<referrers>` is one key per referrer or a count-in-the-key.

**Proposed replacement text** (§9, links bullet, appended):

> Link resolution is **late-binding and recomputed**: on every op that changes
> any concept's current path or liveness (SetPath, DeleteConcept,
> UndeleteConcept, collision win/loss), apply re-resolves affected `link/`
> edges — edges to a vacated path demote from `bl/` back to `wanted/`; edges
> to a newly occupied path promote. I8 is the definition; the event narration
> is an optimization of it.

(§4, keyspace): replace the `wanted/` line with:

> ```
> wanted/<path>/<from-id>       one key per unresolved referrer (count = subkey count)
> wantedrank/<inv-count>/<path> derived rank index, rewritten on referrer-count change
>                               (inv-count = zero-padded (MAX - count) so ascending
>                               scan yields most-wanted first)
> ```

### M7 (major) — Materialize never reconciles stale files; rename → ingest mints a spurious copy

**Exploit.** §9's materialize "walk `c/` and emit" says nothing about files
already on disk that no longer correspond to view state. Concept at `/a` is
renamed to `/b`. Materialize writes `b.md`; `a.md` (previous run's output,
same `_id` in its frontmatter) stays. The ingest watcher — running "behind"
per §9 — now sees the same `_id` at two paths and, per §9's own rule, **mints
a fresh concept via `CreateConcept` and flags**: the system fabricates a
duplicate concept out of its own exhaust, every rename, forever. Also breaks
I9 across peers: a peer that materialized before the rename has `a.md` +
`b.md`; a fresh peer emits only `b.md` — non-identical bundles from converged
views. The epoch-cycle procedure (§10 step 3: "ingest the directory") inherits
the corruption.

**Proposed replacement text** (§9, materialize, new bullet):

> Materialize makes the directory an **exact mirror** of the view: after
> emission it deletes any `.md` file under the bundle root not produced by
> this run (including prior conflicted copies, prior paths of renamed
> concepts, and per-directory `index.md` for directories that ceased to
> exist), and removes empty directories. Deletion honors the same containment
> checks as writes. The ingest watcher treats mirror-deletions as
> materialize-authored (in-flight-lock coordination), never as human deletes.

### M8 (major) — "Uniform autobee weight" vs autobee's actual defaults

**Exploit/derivation.** Verified against `lib/apply-calls.js`:
`addWriter(key, { isIndexer = true, weight = isIndexer ? 2 : 1 } = {})`.
The §3 op is `AddWriter { key, indexer: bool }`. An implementer who forwards
naively — `host.addWriter(key, { isIndexer: op.indexer })` — gets weight 2
for indexers and 1 for non-indexers: precisely the "unequal concurrent
weights" configuration §8 warns diverges 1.0.x topo comparators. Another
implementer passes `weight: 1` for everyone; a third `weight: 2`. Three
observably different vaults, and the spec's own safety rule silently violated
by its most literal reading.

**Proposed replacement text** (§8, weight bullet):

> Writers are admitted with an **explicit** uniform weight:
> `host.addWriter(key, { isIndexer: op.indexer, weight: 1 })` — never rely on
> autobee's defaults, which are `isIndexer ? 2 : 1` and would mix weights the
> moment a non-indexer is admitted.

### M9 (major) — Optimistic onboarding's "ack" is undefined; autobee replay semantics unverified

**Exploit/derivation.** §8: holds are "folded at the ack's linearized
position." What is "the ack"? Candidate readings: (a) an indexer's `AddWriter`
op naming the held writer (fold there); (b) apply calling `host.ackWriter(key)`
(exists in `apply-calls.js`) at some spec-silent trigger; (c) autobee itself
re-delivering the writer's nodes non-optimistically after acknowledgment — in
which case a hold/fold layer **double-applies** every held op. The spec builds
a mechanism on whichever of these autobee actually does without stating which,
and the source (v1.0.10 gate: `if (this.optimistic && !w.isRemoved &&
batch[0].optimistic)`) leaves re-delivery behavior unverified here. Also:
autobee's `optimistic` handler option defaults **true** (`handlers.optimistic
!== false`) and §1 lists the option without prescribing a value; and `H_max`
is named but never given a value or an overflow behavior.

**Proposed replacement text** (§8, optimistic bullet):

> Construct with explicit `optimistic: true`. **The ack is the linearization
> of an indexer-authored `AddWriter` op naming the held writer's key**; at
> that position apply calls `host.ackWriter(key)` and folds `hold/<key>/*` in
> seq order, then deletes the holds. Before building, verify against autobee
> source whether acknowledged optimistic nodes are re-delivered to apply; if
> they are, `hold/` stores only seqs (dedup guard), not payloads, and folding
> is replaced by dedup — record which in DEVIATIONS.md with the source line.
> `H_max = 512` held ops per writer; op 513+ from an unacked writer is
> rejected (`flag/rejected`, reason `hold-overflow`).

### M10 (major) — `index.md` body underspecified → OKF §6 conformance risk

**Exploit/derivation.** OKF §6 mandates "one or more sections, each grouping
concepts under a heading" with entries `* [Title](relative-url) - short
description`. The artifact says only "a listing of child concepts/
subdirectories with one-line descriptions … deterministic ordering." A
minimal implementer emits a bare bullet list with no heading — failing OKF §9
conformance item 3, which §14 makes an acceptance gate. Unstated: heading
text; whether Title comes from `title` frontmatter or the filename; whether
URLs are relative (OKF §6 example) or absolute bundle-relative (OKF §5.1
"recommended"); the entry form when `description` is absent. Two conformant-
intentioned implementers emit different bytes for every `index.md`.

**Proposed replacement text** (§9, index.md bullet, appended):

> Structure, normative: optional root frontmatter, then a single section
> heading `# Contents`, then one bullet per child:
> `* [<title frontmatter, else terminal path component>](<entry>) - <description>`
> — the ` - <description>` clause omitted entirely when `description` is
> absent. `<entry>` is the child's path relative to the directory (concept:
> `<name>.md`; subdirectory: `<name>/`). Concepts first, then subdirectories,
> each group in canonical byte order of the link target.

### M11 (major) — `ResolveConflict` semantics have holes

**Exploit.** `ResolveConflict { id, keep, supersede: [...], text? }`. (a)
`text?`: creates a merged revision — citing which base? Undefined: one
implementer bases it on `keep`, another on null (which, post-M5, means head)
— different revHashes, different `_rev`, divergent bundles. (b) Adversarial:
`keep` cites a revHash that doesn't exist under `c/<id>/rev/` — resolve to a
phantom head? materialize emits what body? (c) Two writers concurrently
resolve the same conflict with different `keep`s — second one: no-op
(conflict already cleared), new conflict, or LWW? All three are defensible;
the spec picks none.

**Proposed replacement text** (§5, after the conflict bullet):

> `ResolveConflict` is valid only if `keep` and every `supersede` entry exist
> under `c/<id>/rev/` and at least one cited flag is open; otherwise rejected
> (`flag/rejected`, reason `bad-resolve`). Effect: head := `keep` (LWW-pinned
> at this position), cited `flag/conflict` entries cleared. With `text`
> present, apply synthesizes one revision with `base = keep` and that revision
> becomes head. A later `ResolveConflict` over the same (now-cleared) flags is
> rejected `bad-resolve`; resolution races converge by linearization: first
> valid resolve wins, the loser flags.

### M12 (major) — Compact ignores open path collisions

**Exploit.** §10: compact refuses (without `--force`) only "while
`flag/conflict` is non-empty." Two concepts contend for `/p`; no body
conflicts exist. Operator compacts. The loser materializes at
`/p.conflict-<hex>.md` (its *only* on-disk face), the fresh vault ingests it,
and the loser's canonical path in the new epoch **is** the conflict path —
`path/` now holds it there, the flag is gone (new vault never saw a
collision), and the intent's "identity-lossless" cycle has silently rewritten
a concept's path with no audit trail. I11 promises path preservation per
"live concept"; the loser is live.

**Proposed replacement text** (§10):

> The compact command MUST refuse (without `--force`) while `flag/conflict`
> **or `flag/pathcollision`** is non-empty; with `--force`, it MUST enumerate
> in the new vault's epoch `log/` entry every conflicted copy carried across,
> old path → materialized path.

### M13 (major) — Link extraction rules unspecified

**Exploit/derivation.** §9 feeds `link/`, `bl/`, `wanted/` from "standard
markdown links per OKF §5" — undefined at every decision point where
implementers must choose: inline links only, or reference-style
(`[a][ref]` + `[ref]: /x.md`), autolinks, images? Links inside fenced code
blocks (a markdown tutorial concept would generate dozens of phantom
`wanted/` entries — the flagship's "ranked demand" becomes ranked noise)?
Relative links (`./other.md`, OKF §5.2) resolve against the containing
concept's *current path* — after a `SetPath` of the source, every relative
edge changes target, so extraction state must be recomputed on rename of the
**source** too (M6 covered the target side). And stored paths have "no `.md`
suffix" (§7) while OKF links carry `.md` — the strip/normalize rule
(`.md` removal, leading-`/` handling, `..` resolution, NFC) is nowhere.

**Proposed replacement text** (§9, links bullet):

> Extraction, normative: CommonMark inline and reference links only (no
> autolinks, no images), skipping fenced/indented code and inline code spans.
> Targets with a URI scheme or protocol-relative form are citations, ignored.
> `/`-prefixed targets are bundle-relative; other targets resolve against the
> source concept's current path directory with `.`/`..` normalization; a
> resolution escaping the bundle root is ignored. Strip one trailing `.md`,
> strip any fragment (`#...`), NFC-normalize; the result keys `link/`. A
> `SetPath` on a concept re-runs resolution of its own relative-form edges.

### M14 (major) — Epoch-cycle "byte-fidelity" is unachievable because `_rev` must change

**Derivation.** §14: "an epoch cycle round-trips a non-trivial bundle with
byte- and identity-fidelity (I11)." In the old vault the head's `_rev` is
`revHash(base = parent-rev, text)`. Cycling: ingest issues `SetBody` citing
the file's `_rev` (old head hash) as `base`, so the new head is
`revHash(base = old-head-hash, text)` ≠ old `_rev`. The re-materialized
bundle's `_rev:` line differs, always, by construction. I11 carefully lists
`_id, type, fields, tags, path, and head body` — excluding `_rev` — so §14's
unqualified "byte-fidelity" contradicts both the mechanism and its own
invariant. A conformance harness diffing bundles fails every cycle.

**Proposed replacement text** (§14): "…an epoch cycle round-trips a
non-trivial bundle with identity-fidelity and byte-fidelity **modulo the
`_rev` frontmatter line** (which necessarily re-derives in the new epoch;
I11's property list is the normative fidelity set)…"

### M15 (major) — Case-insensitive filesystems vs reserved names and generated faces

**Exploit.** §7 rejects `index`/`log` as terminal components — comparison
case unspecified. `CreateConcept { path: 'guides/Index' }` passes a
case-sensitive check. Materialize emits `guides/Index.md` and generates
`guides/index.md`. On default APFS/NTFS these are the same file: whichever is
written second silently destroys the first — a concept body or the generated
listing vanishes with no flag (I4), and macOS/Linux peers emit different
bundles (I9). The B2 fix moves collision detection into apply; this finding
requires the reserved check and the collision domain to be casefold-aware and
to include the generated faces.

**Proposed replacement text** (§7, reserved bullet):

> Reservation and collision checks compare **casefolded, NFC-normalized**
> components: terminal components casefolding to `index` or `log` are
> rejected (`reserved-path`), and generated-face filenames (`index.md`,
> `log.md`) are members of every directory's casefold-collision domain.

### Minor findings

- **m1 (§4).** `flag/optimistic` and `flag/undelete` appear in the family
  list and nowhere else. *Proposed:* delete both from the list, or add to §8:
  "`UndeleteConcept` writes `flag/undelete/<id>/<tag>` (audit); optimistic ops
  rejected at fold time write `flag/optimistic/<writerKey>/<seq>`."
- **m2 (§7/§11).** `clobber` is "audit, clearable" — no op or rule clears it;
  I7 covers only three families. *Proposed:* add a flag-lifecycle table: which
  families are permanent audit (`clobber`, `staletag`, `writeafterdelete`,
  `rejected`, `undelete`) and which clear (`conflict` → ResolveConflict;
  `pathcollision` → freeing SetPath), and strike "clearable" from §7.
- **m3 (§5).** Two writers concurrently `RemTag` the same value citing the
  same token; the later one finds it absent → `flag/staletag` for a benign,
  expected race — flag noise indistinguishable from real staleness.
  *Proposed:* keep a removed-token set per (id, value); a citation of a
  *removed* token is a silent no-op; only a never-observed token flags.
- **m4 (§3).** "Pre-decode limits … path ≤ 1024 bytes, depth ≤ 64" — path
  checks require decoding. *Proposed:* "Pre-decode: op ≤ 64 KiB. Post-decode,
  fixed order: path ≤ 1024 bytes, depth ≤ 64."
- **m5 (§5).** `revHash = SHA-256(len(base)||base||len(text)||…)` — `len()`
  encoding (varint? u32? endianness?) and the null-base byte form are
  unstated; only the copied `revhash.js` pins them. *Proposed:* "…where
  `len()` is u32 LE and a null base encodes as `len(0)` with zero bytes
  (distinct from any real hash) — normative text mirrors the copied code;
  on discrepancy the copied code wins and DEVIATIONS.md records it."
- **m6 (§6).** A created-but-never-bodied concept: is `_rev` omitted, null,
  or an empty-text hash? Divergent bundles + divergent ingest base citation.
  *Proposed:* "A concept with no revisions omits `_rev`; ingest of a file
  without `_rev` over a concept without revisions cites `base: null`."
- **m7 (§10).** `predecessorCheckpoint` is never defined (view hash? core
  lengths? bundle hash?) and the chain is self-asserted — any vault may claim
  any predecessor. *Proposed:* "checkpoint = { viewHash: I2 full-range hash,
  writerLengths: [[key, len]…] } signed by the operator key that ran compact;
  the chain is provenance metadata, not proof — consumers MUST treat
  cross-epoch identity as trusted-operator scope."
- **m8 (§13).** No CLI verb can emit `ResolveConflict` or `UndeleteConcept`;
  §10 requires conflicts be drained before compact, with no delivered tool to
  drain them. *Proposed:* add `resolve` and `undelete` to `okf/cli`.
- **m9 (§13).** Intent D7 ships `auto-okf@0.0.1` (root placeholder) alongside
  the scope; deliverables list only `@auto-okf/*`. *Proposed:* add the root
  `auto-okf` placeholder package to §13.
- **m10 (§8).** "Token bucket replenished by accepted indexer ops" — whose
  bucket, per which indexer ops, at what rate? And unacked writers have no
  `gov/writer/` policy row for the "hold-time rate-check" to read.
  *Proposed:* "each writer's bucket gains 1 token per accepted op *authored
  by any indexer*, capped at `rateCeiling`; unacked writers use a fixed
  default ceiling (64) until admitted."
- **m11 (§9).** YAML emission (quoting rules, flow vs block lists, escaping
  of `---`-bearing strings) is unpinned; per-implementation I9 holds but
  cross-implementation bundles differ and malformed emission can break OKF
  §9(1) parseability. *Proposed:* name the canonical emitter rules (double-
  quote iff YAML would reinterpret; flow lists; LF; trailing newline).
- **m12 (§9).** log.md: entries within one date heading — ordinal ascending
  or descending? A writer with `at` = year 3000 pins a heading above all
  future entries forever (accepted consequence? say so). Entry link form
  (absolute vs relative) unstated. *Proposed:* "group by UTC date, headings
  descending; within a heading, ordinal descending; entry links absolute
  bundle-relative; forged-future dates are an accepted cosmetic consequence
  of informational timestamps."
- **m13 (§9).** "same `_id` seen at two paths → second is a copy" — "second"
  by walk order is nondeterministic across runs/OSes. *Proposed:* "the file
  at the `_id`'s current view path (if present) is the original; otherwise
  the casefolded-lexicographically-first path wins; all others are copies."
- **m14 (§8).** `RemoveWriter` of the last indexer (including self-removal)
  bricks governance permanently. *Proposed:* "a `RemoveWriter` that would
  leave zero indexers is rejected (`policy-governance`)."
- **m15 (§9).** OKF §7 MUSTs `YYYY-MM-DD`; the artifact says "ISO-8601 date
  headings," which admits full datetimes. *Proposed:* say "UTC `YYYY-MM-DD`
  date headings (OKF §7)."

---

## Intent-Coverage Matrix

| Intent item | Spec section(s) | Status |
|---|---|---|
| Outcome: multi-writer OKF on autobee, append-only, merge-safe, plain-markdown dump | §0, §2, §8, §9 | Encoded |
| Outcome: monorepo restructure (`./vault-ld` kept, new `./okf`), copy-don't-depend, three copied leaves, zero cross-stack imports | §0, §13 | Encoded |
| D1 Identity: `_id` minted once from creating op, never path/content-derived, adopted on ingest; path = LWW property; rename+edit merge; collisions → deterministic conflicted copies | §6, §7 | Encoded — but see M1 (seen-id undefined), B4 (conflicted-copy suffix broken), B3 (winner rule undefined) |
| D2 `_rev`: body-head revHash in frontmatter; on-disk edits cite base; stale base → siblings + flag, never 409 | §6, §5 | Encoded |
| D3 Merge policy: fixed defaults — tags OR-set, other keys LWW-array + clobber flag, bodies siblings until ResolveConflict; no policy dial | §5 | Encoded — see M4 (tags-via-SetField hole), M5 (base evasion) |
| D4 Deletion: append-only as vault-metadata constant outside the log; tombstone-only delete; no prune op | §8 | Encoded (intent's `DeleteSubject` = spec's `DeleteConcept`, semantics faithful) |
| D5 Compaction: operator-only epoch cycling via hydrated face; predecessor key + checkpoint; refuse while conflicts undrained; **redaction mechanism** | §10 | Partial — mechanism and guardrail encoded; redaction role never named (and step 2's file deletion is its only trace); checkpoint undefined (m7); pathcollision gap (M12) |
| D6 Faces: materialize with derived `index.md`/`log.md`; ingest watcher; `wanted/` ranked demand, never flags; no Turtle export | §9, §4, §12 | Encoded — see B1, M6, M7, M10 |
| D7 Name: auto-okf; publish `auto-okf@0.0.1` + `@auto-okf/*` | §13 | Partial — scope packages present; root `auto-okf@0.0.1` placeholder MISSING (m9) |
| Example 1: flagship multi-agent session bundle (partitions, ThreadMode→DocumentMode) | §13, §14 | Encoded |
| Example 2: durable slop archive | §13 | Encoded |
| Example 3: vlurp curation — vlurp immutable, fetch to staging (never into bundle), `_id` via path→existing-id lookup, provenance (repo/ref/hash) frontmatter, drift → diffs + clobber flags | §13 | Partial — staging and `_id`-stamping encoded; vlurp-immutable, provenance-frontmatter, and drift-behavior clauses not restated anywhere |
| Success: zero-blocker review; invariants green; harness matrix all fault profiles; roundtrip + epoch cycle byte-/identity-faithful; examples regenerate deterministically | §11, §14 | Encoded — see M14 (byte-fidelity contradiction) |
| Constraint: OKF v0.1 conformance for every emitted bundle | §0(1), §14 | Encoded |
| Constraint: autobee only; autobase forbidden (dep, import, docs framing) | §0(3) | Encoded |
| Constraint: pnpm; node:test; usage-first READMEs | §13 | Encoded |
| Constraint: never delete from sslop/ | — | MISSING (process constraint; the spec directs a builder and says nothing) |
| Constraint: stacked PRs, owner merges | — | MISSING |
| Out of scope: subtree moves, per-key policy, vlurp changes, RDF/query, org creation, autokf stub | §12, §7 | Encoded (§12 adds HTTP API / text-CRDT / viz.html — supersets are fine) |

## OKF-Conformance Matrix (MUSTs touching emitted bundles)

| OKF v0.1 requirement | Spec section | Status |
|---|---|---|
| §3.1: `index.md`/`log.md` MUST NOT be used for concept documents (any level) | §7 (reserved terminal components), §9 (ingest ignores edits to them) | Covered — casefold gap (M15) |
| §4: every concept is UTF-8 markdown with YAML frontmatter block | §9 materialize (frontmatter per §6 ordering) | Covered — emitter rules unpinned (m11) |
| §4.1: `type` REQUIRED | §5 (`type` LWW; empty state → `type: unknown` + flag) | Covered |
| §4.1: consumers MUST tolerate unknown types / SHOULD NOT reject unknown keys | §6 relies on this for `_id`/`_rev` emission | Covered (consumer-side; reliance is legitimate) |
| §5.3: consumers MUST tolerate broken links | §9 `wanted/` (dangling = demand, never malformed) | Covered |
| §6: index files contain no frontmatter (…§11 exception: root `okf_version` only) | §9 ("frontmatter only at bundle root") | Covered |
| §6: index body = one or more sections, each grouping concepts under a heading, `* [Title](url) - description` entries | §9 ("a listing … with one-line descriptions") | GAP — heading/title/url/missing-description forms unspecified (M10); a heading-less listing fails §9(3) |
| §7: log date headings MUST use ISO 8601 `YYYY-MM-DD` | §9 ("ISO-8601 date headings, newest first") | Partial — `YYYY-MM-DD` not pinned (m15); date source does not exist in the wire schema (B1) |
| §9(1): every non-reserved `.md` has parseable YAML frontmatter | §9 (all emitted concepts and conflicted copies carry frontmatter) | Covered — contingent on m11; note conflicted-copy filename `<path>.conflict-<hex>.md` is a non-reserved concept doc and does carry frontmatter |
| §9(2): every frontmatter block has non-empty `type` | §5 (`type: unknown` fallback) | Covered |
| §9(3): reserved files follow §6/§7 structure when present | §14 (independent conformance check as acceptance gate) | Covered as a gate; content rules feeding it have the M10/m15/B1 gaps above |
| §11: `okf_version` in root `index.md` frontmatter is the only permitted index frontmatter | §9 (`okf_version: "0.1"` at root only) | Covered |

## Verification notes (contract item 3)

- autobee constructor/options: v1.0.10 `index.js` destructures `{ name,
  encrypted, encryptionKey }` and conditionally invokes `handlers.apply/open/
  close/update`; `optimistic` exists (`handlers.optimistic !== false` —
  default **true**, relevant to M9); `keyPair` handler exists. §1's claim list
  is accurate.
- host: `lib/apply-calls.js` (main) defines `addWriter(key, { isIndexer =
  true, weight = isIndexer ? 2 : 1 })`, `ackWriter`, `removeWriter`,
  `interrupt`, `createAnchor`, `genesis` (getter), `clock` (getter). All six
  §1 claims verified; the weight default drives M8. Caveat: apply-calls was
  fetched at `main`; v1.0.10's copy was confirmed imported but not
  independently diffed — the builder's §0 "fetch and verify" rule covers this.
- apply: `await this._handlers.apply(userBatch, this._workingView, this._host)`;
  node fields observed: `key`, `length`, `value`, `optimistic`, `version`,
  `core` (main also shows `timestamp`, `links` — v1.0.10 presence of
  `timestamp` unconfirmed, which is why B1 cannot lean on it).
- view: `hyperbee2` (`const Hyperbee = require('hyperbee2')`); README confirms
  `view.get`, `db.write()` → `tryPut`/`tryDelete`/`flush`, and
  `createReadStream({ gte, gt, lte, lt, reverse, limit })` — the artifact's
  range-walk assumptions (materialize, I2 hash) are implementable; entry shape
  is `{core, offset, seq, key, value}`.
- `replicate(...args)` delegates to `store.replicate(...)`; §1's
  `replicate(isInitiator)` is a valid usage, not a signature error.
- `~/Git/indexzero/uppr2-worktrees/attempt-opus-1/lib/registry.js` exists
  (6208 bytes).
