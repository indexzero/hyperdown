# DEVIATIONS

Deviations from SPEC-FINAL (`prompts/01-implementation-spec-prompt.v5.md`),
one paragraph each (§0 rule 3). Only true deviations and spec-instructed
recordings live here; implementation resolutions where the spec is silent are
documented in code comments (with source citations) and package READMEs.

**node:test instead of brittle.** User mandate (project owner). The Holepunch
convention is the brittle runner; this repo's entire suite runs on the Node
core test runner (`node --test`). No test-runner code is imported by library
packages, so brittle/bare compatibility of the libraries is unaffected.

**§1 dependency: autobee only; autobase is FORBIDDEN.** User directive
(2026-07-04, final): this repo is a wiki implementation on top of autobee,
and autobase appears nowhere — not as a dependency, not as an import, not as
docs framing. Verified against the fetched autobee package.json (v1.0.10,
2026-07-04): current autobee is a standalone multiwriter Hyperbee built on
hyperbee2 + hypercore 11 with NO autobase dependency; its own contract is
`new Autobee(store, key, { apply(nodes, view, host), open, close, update,
encryptionKey, encrypted, keyPair, optimistic })` with
`host.addWriter/removeWriter/ackWriter/interrupt/createAnchor`, node shape
`{key, value, length}`, and `update()/updated()/flush()` synchronization.
SPEC-FINAL's autobase-specific mechanics (apply node shape, `signedLength`
finality, indexer checkpoints) are therefore ported onto autobee's actual
contract; each port mapping is recorded by the store build below. Citations
to the autobase README in `vault-ld/core` comments predate this correction
and are historical; core itself is transport-agnostic (its apply consumes a
node stream and a view interface) and depends only on
hyperschema/hyperdispatch/compact-encoding/b4a.

**§8.2/§8.4 ordinal resolution (spec-instructed).** The autobase README
documents no per-writer sequence on apply nodes, so option (b) applies: the
view-kept seen-count `seen/<W>` (top-level family, outside `ctx/`, incremented
for every node from `W` regardless of disposition) keys all `<seq>`-bearing
families. Excluded from materialize/export walks; included in the I2 view
hash. If a future autobase exposes a stable per-writer index, switching is a
new entry here.

**§10.1 layer inference (spec-instructed).** Folder-based schema/data
partition is honored only when an authored path is present; absent a path,
layer is inferred from the `@type` element set, which MAY diverge from a
folder-only vault-ld tool for locally-typed schema notes.

**§13 store: SPEC-FINAL→autobee port mappings.** Verified against the
installed autobee@1.0.10 source. (a) Apply node shape: autobee hands
`{ key, value, length, optimistic }` (key = writer core key); the store
wraps each node as `{ from: { key }, value, length }` before core's apply.
(b) Host surface: core's `host.addWriter(key, { indexer })` maps to
autobee's `host.addWriter(key, { isIndexer, weight })`; autobee's
`removeWriter`/`removeable` are not exposed at all (see (d)).
(c) `signedLength`-scoped clauses:
autobee has no separate signing pipeline (`views()` reports
`signedLength === length`; finality is flush/anchor —
`host.createAnchor()` is the checkpoint primitive), so §8.5's
"at or below signedLength" rate-partition scope and §11's quorum-signed
snapshots have no 1:1 substrate; view convergence is asserted by full-scan
hash equality and §11 snapshot machinery stays future work (P4 harness
territory). (d) §8.3: revocation is decided solely by core's in-log clock
rule; `opRemoveWriter` records `ctx/gov/removed/<W>` and deliberately never
invokes autobee's positional `host.removeWriter` (positional removal cut
W's concurrent nodes out of the remover's linearization while peers that
had already linearized them kept them — permanent divergence; review
finding B1). The removed writer stays admitted at the substrate level, so
every node linearizes on every peer: ops linearized after the RemoveWriter
are uniformly accepted/rejected (`revoked`) by the clock rule, and a racing
op that linearizes before it (autobee orders concurrent nodes by node
timestamp) is uniformly applied — either way one convergent view (I2), the
partition a pure function of the final log (I10). Two store-side
consequences: the emitted §3.2 clock counts the appending op itself in the
writer's own entry (`seq + 1`; DAG heads alone give the pre-append length,
which a removal that never delivered the op would dominate, mis-accepting
racing ops), and containment of a revoked peer is app-level —
`Vault.append` refuses new local ops (`VAULT_REVOKED`) once
`ctx/gov/removed/<self>` exists and the op's clock does not causally
precede it.

**§8.2 optimistic onboarding on autobee (ackWriter port).** Autobee's
optimistic path requires the batch to anchor in its system during apply or
it is rolled back and the writer dropped from pending; the store's apply
wrapper therefore calls `host.ackWriter(node.key)` for optimistic nodes
("acknowledge a writer without changing their permissions"). This is
DAG-level only and deterministic (same apply, same nodes on every peer):
core's §8.2 hold buffer (`n/hold/` + `flag/optimistic/`) remains the sole
view-effect gate until an in-log `AddWriter` from a confirmed indexer
linearizes and core folds the held range. Because the hold defers the op's
*effect* to the ack position, peers converge to identical views even when
the raw optimistic node linearized at different positions on different
peers (observed and asserted in test/store-convergence.test.js).

**Uniform autobee topo weight for all writers.** autobee@1.0.10's
linearization comparators disagree for concurrent nodes of unequal weight
(lib/topo.js: `isOrderedBefore` breaks its walk on
`node.weight < link.weight` while `cmp` sorts higher weight first), so
peers that receive concurrent indexer/non-indexer (weight 2/1) nodes in
different arrival orders keep permanently divergent linearizations —
observed empirically, fatal for I2 under core's order-sensitive apply (the
reference codebases sidestep it with order-independent first-seen-wins
applies). The store therefore admits every writer with weight 2 (the
genesis auto-add weight), keeping the `isIndexer` bit for autobee's
bookkeeping; §8.0 governance authority is decided from `ctx/gov` by core,
never from autobee writer state, so spec semantics are unaffected.

**UNVERIFIED.** (1) `host.removeWriter` is guarded by `host.removeable(key)`;
the autobase README does not state whether `removeable` is exact under all
quorum states. (2) The exact reserved-character set of vault-ld §4.5
percent-encoding was not confirmed against the vault-ld SPEC.md text;
`encodeURIComponent`-after-NFC is used, centralized in one function
(`encodeName`) if adjustment is needed. Both are marked in code and are P4
harness targets. *(Item (2) resolved by the faces build; see the §4.5
entry below. Item (1) remains open.)*

**vault-ld §4.5 percent-encoding verified; `encodeName` over-encodes
(resolves UNVERIFIED item (2)).** Fetched from the vault-ld SPEC.md
(2026-07-03): "A file name may contain characters that are not legal in an
IRI (spaces are the common case); when minting an identity from a file
name, a tool MUST percent-encode the offending characters per RFC 3987, so
`Red Lentil Soup.md` mints `.../Red%20Lentil%20Soup`." Core's `encodeName`
(`encodeURIComponent` after NFC, vault-ld/core/lib/apply.js) agrees with
the spec's own example, but over-encodes characters RFC 3987 permits in an
IRI path segment — non-ASCII `ucschar` letters and sub-delims/`:`/`@` — so
`Café` mints `vault://data/Caf%C3%A9` where a minimal RFC 3987 minter
yields `.../Café`. The mapping is injective and applied uniformly after
NFC, so §3.1 same-subject identity and I2 convergence are unaffected
inside a vault; the deviation is cross-tool IRI equality with a strict
vault-ld minter for names containing such characters. Core is a frozen
input to the faces build (P3-3), so the fix site is recorded instead of
patched: `encodeName` in vault-ld/core/lib/apply.js, and the §10.1
fallback mint in vault-ld/faces/lib/turtle.js that deliberately mirrors it
(the two must change together).

**§6 a null `base` is "no base cited", never a shared base (review finding
M1).** A literal reading of §6's "two revisions citing the same `base`"
makes every pair of null-base `SetBody` revisions on a subject true
concurrency, so N independent creations yield N-choose-2 `flag/conflict`
rows and the detection rescan made every `SetBody` O(R) in the subject's
revision count — quadratic per subject, unbounded flag state, and a
single-writer DoS of every peer's apply (two soak runs died when one
setBody exceeded the 120s command budget; CODE-REVIEW.md M1). Resolution:
independent null-base creations are LWW on the head pointer and raise no
mutual `flag/conflict`; cross-writer supersession among them is still
surfaced via the §5.4 `flag/clobber` (O(1) per op), and `flag/conflict` is
reserved for two revisions citing the same NON-null base — which still
keeps both revisions, sets the head deterministically, and writes exactly
one flag per pair (I4 intact). Same-base detection now reads the
base-keyed bookkeeping index `revbybase/<s>/<base>/<rev>` (maintained by
`SetBody`, `ResolveConflict`-with-text, and `PruneRevisions`; like `seen/`
it is included in the I2 view hash and excluded from materialize/export)
in O(matches) instead of scanning `n/<s>/rev/*`.

**§9.4 `flag/unsafepath` is a materialize report, not a view row.** §9.4
directs `materialize` to record `flag/unsafepath/<s>` for skipped unsafe
paths, but §9.3 mandates that no component writes the view except `apply`
folding ops, and core exposes no flag-writing op. `materialize` therefore
returns unsafe skips in its report (`unsafe: [{ subject, reason }]`,
covering separator-in-subject, escape, absolute-path, and
case-insensitive-collision skips), while the view-side audit remains
apply's rejection of unsafe `SetPath` values (`flag/rejected`, reason
`unsafe-path`, §8.4). I4 is preserved in substance (no silent skip; every
skip is observable) at the cost of the flag living in the report instead
of the view.

---

## okf (auto-okf) deviations — okf/SPEC.md v1.2

**okf §5 `revHash` length prefix: copied code wins (u64 BE, not u32 LE).**
okf SPEC §5 describes `len()` as "u32 LE", but the same sentence pins the
resolution: "this normative text mirrors the copied code; on discrepancy
the copied code wins and DEVIATIONS.md records it." The copied
`vault-ld/core/lib/revhash.js` (provenance header in
`okf/core/lib/revhash.js`) uses an 8-byte big-endian length prefix over the
64-char lowercase-hex base string (empty for null). That formula is
byte-identical between the two stacks, which is exactly what the copy rule
exists to preserve; the u32-LE prose in §5 is the deviation being recorded.

**okf §3 per-writer ordinal: `seen/` view counter, after checking autobee's
node.** As §3 instructs, autobee@1.0.10 was checked before resolving:
`lib/writers.js` `createNode()` does expose a per-node `length` (and
`_applyBatch` hands those nodes to apply), so a transport-side seq exists.
Core nevertheless derives position from the stream itself via the
view-kept `seen/<writerKey>` count (incremented for every node regardless
of disposition), because core is transport-agnostic and the §8 unforgeable-
position rule (`seqAtRemoval`, forged-clock) must bind to the same ordinal
apply uses for `flag/rejected`/`hold/` keys. Under autobee's per-writer
FIFO delivery the seen-count equals the node seq.

**okf §8 hold buffer stores full payloads: acked optimistic nodes are NOT
re-delivered to apply.** §8 requires verifying re-delivery before choosing
between payload-holding and seq-dedup. autobee@1.0.10 `index.js`
`_optimisticBatch()` applies an unacked writer's optimistic batch exactly
once at its linearized position (rolling back only when
`system.canApply()` fails); a later `host.ackWriter()`
(`lib/apply-calls.js`) flips writer state without replaying prior nodes
into apply. Therefore `hold/<writerKey>/<seq>` stores the full decoded
payload (JSON-safe hydration) and the ack's `AddWriter` folds holds in seq
order at its own linearized position, as specified for this branch.

**okf §8 uniform topo weight is 2, not the literal `weight: 1`.** §8
mandates `host.addWriter(key, { isIndexer: op.indexer, weight: 1 })` to
avoid autobee's mixed defaults, but autobee@1.0.10's GENESIS auto-add is
uncontrollable from apply and uses the defaults (`index.js`
`_processApplyBatch` → `lib/apply-calls.js` `weight = isIndexer ? 2 : 1`
with `isIndexer` defaulting true): the genesis writer is always weight 2.
A literal `weight: 1` for admitted writers would therefore re-create
exactly the mixed-weight condition §8 exists to prevent (`lib/topo.js`:
`isOrderedBefore()` breaks the walk on `node.weight < link.weight` while
`cmp()` sorts higher weight first — divergent linearizations under
concurrency). §8's substance is the UNIFORM weight; the store's
HostAdapter (`okf/store/lib/vault.js`) pins every `addWriter` at the
genesis value `weight: 2` (the vault-ld harness-proven resolution),
overriding the `weight: 1` core passes. Side effect: autobee's cosmetic
`isIndexer` getter (`lib/writers.js`: `weight === 2`) reads true for all
writers; §8 governance authority is decided from `gov/` by core, never
from autobee state.

**okf §8 optimistic nodes are acked at the DAG level inside the store's
apply wrapper.** §8 places the ack at the linearization of the indexer's
`AddWriter` (core calls `host.ackWriter` there), but autobee@1.0.10 rolls
an unacked writer's optimistic batch back entirely unless the writer is in
its system after apply (`index.js` `_optimisticBatch`: post-apply
`system.get(key)` check, else view rollback + `removePending()`), which
would discard the batch before any `AddWriter` could fold it. The store's
`_apply` therefore calls `host.ackWriter(node.key)` for every
optimistic-flagged node before folding (deterministic: the flag is
oplog-encoded, so every peer makes the same call); core's `hold/` buffer
remains the only VIEW-effect gate, so the §8 semantics (effects land at
the in-log ack's linearized position) are unchanged. Same resolution as
vault-ld §8.2 (harness-proven).

**okf core fix required by T4 (out of store scope, minimal):
`opFromJson`/`opToJson` hold hydration corrupted held `SetField` ops.**
`okf/core/lib/ops.js` hex-converted any field named `key` when rehydrating
a held op (`Buffer.from('status', 'hex')` → empty buffer), so an unacked
writer's held `set-field` folded under an empty frontmatter key on every
peer — converged (I2 held) but wrong, and unreachable by core's unit suite
(its hold tests held only `create-concept`/`set-body`). Since governance
ops (the only ops with a buffer `key`) are rejected before the hold branch,
a held op can never carry a buffer: hydration is now a plain
null-normalizing copy. View bytes are unchanged for every previously
passing case (string fields always serialized as-is); the store's
optimistic-onboarding integration test is the regression test. Full suite
(114 vault-ld + 62 okf-core + 15 store) green after the fix.

**okf §10 epoch namespace derivation (spec-silent detail).** §10 requires
writer cores namespaced per epoch and "recorded in vault metadata" but not
HOW the id is minted. The store derives it purely:
`epoch = 'genesis'` when the chain fields are null, else
`sha256(predecessorKey bytes || stableStringify(predecessorCheckpoint))`
— so every peer of one vault computes the same namespace from the same
pinned metadata, a joiner reconstructs it from the invite's chain fields
alone, and a reused corestore directory still yields fresh writer keypairs
across epochs. Recorded as `metadata.epoch` and validated against the
chain fields at every load.

---

## @auto-okf/faces (T5)

**okf §9 conflicted-copy hash-collision extension is applied per-value,
order-independently.** §7 says two path-collision losers whose `_id` hashes
share the first 8 hex "extend to the full 64-hex hash, and an occupied
fallback extends the same way." Rather than probe-and-extend (order
dependent), materialize groups losers by path, counts how many share each
8-hex prefix, and any prefix shared by more than one loser makes *all* its
members emit the full 64-hex suffix. Distinct `_id`s never collide on the
full hash, so no further probing is possible or needed; the result is a pure
function of the loser set (I9). The `.conflict-<hex8+>` component is reserved
in apply, so no live concept can hold a conflict path and only loser-vs-loser
collisions are reachable.

**okf §9 `flag/copydetect` audit record is not emitted by ingest (no core
op writes it).** §9 says a copy-split records `flag/copydetect/<new-id>/
<original-id>`. The view is written only by core's apply folding ops, and the
12-op wire contract has no op that writes a `copydetect` flag (apply never
references the family). Faces therefore surfaces copy detection as its
observable effect — the copy is minted as a fresh `CreateConcept` (no `id`)
at its path, and a `'copy'` event is emitted on the watcher — but writes no
`flag/copydetect` row. Recording the flag would require a new core op
(out of T5 scope; core is imported unmodified). The identity outcome (copy
gets a fresh `_id`, original keeps its path) is exactly as specified.

**okf §9 minted `_id` write-back is deferred to the next materialize, not
written into the human file by the watcher.** §9 says a file with a missing
`_id` mints "and writes back into the file." Instead of the watcher rewriting
the just-read file (an echo hazard mid-settle), ingest records the ingested
bytes' hash in the emission manifest; the concept now exists in the view at
that path, so the next `materialize` regenerates the file with the
deterministic minted `_id`/`_rev` stamped in (its bytes already match the
manifest, so the overwrite is permitted, not blocked as pending-ingest).
Net effect is identical — the file ends up carrying its `_id` — with one
fewer write and no watcher/echo coupling. A minted id is taken to be the
create op's tag (`writerKey‖seq`); under the §6 squat fallback the true id
would differ, but that requires an adversary pre-occupying the tag id and is
unreachable through ordinary ingest.

**okf §9 materialize path-safety violations are reported, never written to
the view.** §7 notes a materialize-time containment violation "is reported on
the CLI only." Faces re-checks lexical + realpath containment before every
write (atomic temp+fsync+rename in the target's real parent) and collects any
violation in `report.unsafe`; it never writes a `flag/` row (materialize
never writes the view, §7). Same resolution as vault-ld §9.4.

**okf §9 deletion of a conflicted-copy face is a no-op, not a
`DeleteConcept`.** A conflicted copy is a transient materialized face, not the
concept's canonical location; removing it on disk would otherwise delete a
live concept that the next materialize immediately re-emits. The watcher
therefore skips `DeleteConcept` for any file whose terminal matches
`.conflict-<hex8+>` (emitting `'delete-skipped'` with reason
`conflict-copy`), consistent with "deletion is dangerous." Deleting the
winner's canonical file still deletes the concept behind the confirmation
guard.
