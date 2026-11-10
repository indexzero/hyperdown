---
title: auto-okf Glossary
scope: >
  The long-lived vocabulary of the auto-okf system. One term, one meaning, so a
  reader building a mental model never re-grounds a drifting word. Pipeline and
  delivery-process terms (gate, blocker severity, stacked PR) are deliberately
  absent — they are short-lived and belong to the delivery record, not the
  system.
reference: >
  Link a term from any document with
  `[concept](okf/GLOSSARY.md#concept)` (or a path-relative form). Define a
  term once, at its first use, then keep the name stable. Do not
  redefine a term locally; fix it here.
sibling: vault-ld/GLOSSARY.md (the other system in this repo; different domain vocabulary)
---

# auto-okf Glossary

Each term gives its **canonical meaning**, then a **not this** line naming the
sibling it drifts into. The drift line is the point: these words collide
because their implementations touch, and a reader loses the thread when one
word carries several ideas.

---

## Identity and operations

### concept
A single unit of knowledge — one markdown document in a [bundle](#bundle).
**Not this:** not the *file* on disk (that is its form in the bundle) and not
its *path* (that is a property of it). A concept survives a rename; the file
and path do not.

### `_id`
A concept's stable identity. Minted once, from the creating [op](#op--operation)'s
[tag](#tag-opid); opaque; never derived from path or content. Unique per
[vault](#vault). Survives deletion (a tombstone keeps it). The CouchDB `_id`
homage.
**Not this:** not the path, not a content hash, not the `tag` it was minted
from after that first moment.

### `_rev`
A concept's body version — the [revHash](#revhash) of the current head
revision, carried in materialized frontmatter. Changes on every body edit. The
CouchDB `_rev` homage.
**Not this:** not identity. Two concepts never share an `_id`; one concept has
many `_rev`s over its life.

### revHash
The content hash of a body revision — `SHA-256` over the base pointer and the
NFC-normalized text, in a fixed byte construction.
**Not this:** not the `_id`. A revHash names one version of one concept's body;
the `_id` names the concept across all versions.

### tag (opId)
The identifier of one [op](#op--operation): `writerKey ‖ seq`. Serves as the OR-set
observation token and the audit handle. Derived by [apply](#apply) from the
node, never trusted from the op payload.
**Not this:** not the `_id`. An `_id` is minted *from* a concept's creating tag,
but a tag names an op and an `_id` names a concept; after creation they can
differ (the squat-fallback mint gives a genuine concept an `_id` that is not
its creating op's tag).

### seq
The position of an op's node in its [writer](#writer)'s core,
`node.length - 1`. Unforgeable and the same on every peer. A writer's seqs
increase, and can have gaps: a node that never reaches [apply](#apply), such
as an empty block, still takes a position. One half of a [tag](#tag-opid).
**Not this:** not the global order across all writers; not the view-kept
[`seen/` entry](#ordinal--seen).

### ordinal / `seen/`
`seen/<writerKey>` holds the last folded position of that writer plus one,
written for every node from that writer regardless of disposition. The
store builds an op's clock from it: the entry for another writer is that
writer's last folded position. Separate usage: **`ord`** in
`c/<id>/path` is the *global* apply ordinal at which a path was set.
**Not this:** not [seq](#seq) (seq is the position of one node; `seen/` is
view state that apply writes as it folds). Not a wall clock.

### writer
An append-authorized participant — a human or an agent — identified by a public
key, owning one input core. An [indexer](#indexer)'s `AddWriter` admits it
(`gov/writer/<key>`); until then none of its ops takes effect.
**Not this:** not the *author* of prose. Not merely "the key" or "the core";
those belong to the writer. Not an [indexer](#indexer) unless granted. Not
merely an autobee writer: autobee also adds a key that a rejected
`AddWriter` names, or that a member's forged approval names, and
[apply](#apply) rejects every op of a key with no `gov/writer` record. A
writable store (`db.writable`) is that substrate admission, not this.

### member
A [writer](#writer) with a `gov/writer` record. Only [apply](#apply) writes
that record: for the genesis key, and for each key that an accepted
`AddWriter` of an [indexer](#indexer) names. Every member is an autobee
writer.
**Not this:** not an autobee writer, which is a key that
[autobee](#autobee) added. A member can make any key an autobee writer, so
an autobee writer is not always a member. apply rejects every op of a key
with no `gov/writer` record.

### indexer
A [writer](#writer) with governance authority: it may emit `AddWriter`,
`RemoveWriter`, `SetWriterPolicy`. Recorded `indexer: true` in
`gov/writer/<key>`.
**Not this:** not every writer. A non-indexer agent writes concepts but cannot
admit or revoke writers. Not autobee's `isIndexer`, which is always false in
this store (every writer stands at weight 0); `Bundle.isIndexer` reads
`gov/`.

### path
A concept's location: a flat, absolute, [bundle](#bundle)-relative string, held
as an LWW register on the concept.
**Not this:** not identity (Kleppmann: position is a register on a stable `_id`,
not the thing itself). Not a tree node — auto-okf has no parent pointers, so a
"directory" is only a shared path prefix.

### op / operation
A semantic write appended to a writer's core (`CreateConcept`, `SetField`,
`AddTag`, `SetBody`, `SetPath`, `DeleteConcept`, `AddWriter`, …). The source of
truth is the totally-ordered log of these.
**Not this:** not a file write. Never store a whole file as an op value.

### apply
The deterministic, pure function folding the linearized op stream into the
[view](#view). No wall clock, no randomness, no peer-local reads (invariant
I1).
**Not this:** not the step that writes the bundle. Apply produces view
state; materialize reads it.

### view
The keyspace-structured key/value state [apply](#apply) produces and peers
converge on. A caller can query it.
**Not this:** not the on-disk [bundle](#bundle) (a projection of the view). Not
authoritative — the op log is.

---

## The bundle and the flag namespace

### bundle
A directory tree of markdown files with YAML frontmatter — the OKF unit of
distribution, and what [materialize](#materialize) writes to disk. The code
and the CLI say `face` and `<face-dir>` for the same thing.
**Not this:** not the [vault](#vault) (the vault is the multi-writer store; the
bundle is its projection). Not the source of truth.

### vault
The multi-writer store: [autobee](#autobee) over corestore, one input core per
writer. The source of truth.
**Not this:** not the bundle. A vault materializes to a bundle; a bundle ingests
back into a vault.

### materialize
Project the [view](#view) to an on-disk OKF [bundle](#bundle) — one markdown
file per live concept, plus derived `index.md` and `log.md`. Byte-deterministic
for a converged view (invariant I9).
**Not this:** not authoritative output. Materialize can write the bundle
again from the view. Materialize must never delete a human-authored file it
did not itself produce.

### ingest
Re-enter human on-disk edits as the minimal set of [ops](#op--operation). A changed field
becomes one `SetField`; a moved file becomes one `SetPath`; never a whole-file
op.
**Not this:** not a bulk import — it diffs against view state and emits the
smallest op set.

### flag / flag-family
A view record under `flag/…` meaning *something needs attention* — the I4
no-silent-loss ledger that agents drain. Families include `conflict`,
`clobber`, `rejected`, `pathcollision`, `writeafterdelete`.
**Not this:** not [`wanted/`](#wanted). A flag says "look at this"; a wanted
entry says "the graph is asking for this to be written."

### `wanted/`
A ranked demand index of link targets that do not yet resolve — red links, in
Cunningham's sense. Sorted by referrer count. Queryable work for writers.
**Not this:** not a flag. An unwritten concept is legitimate, healthy state,
never an error.

### generation / import
A generation is one [vault](#vault), one key set and one log. An operator
starts the next generation with two commands. `materialize` writes the live
view to a [bundle](#bundle). `auto-okf import` then creates a new vault from
that bundle in a new directory, with `_id` adoption. See SPEC §10 for the
rules of import.
**Not this:** not an op. No op in the log reclaims bytes. Not lossless of
history: a generation drops the old revisions and the attribution of each
op. `materialize` reports every value that the bundle cannot hold, and the
operator fixes those values before `import` (SPEC §10).

---

## Substrate and guarantees

### autobee
The standalone multi-writer Hyperbee substrate the store is built on:
autobee@2.12.1, on hyperbee2 + hypercore 11. Provides the apply/view pattern,
one core per writer, linearization, and replication. The store configures it
so that a node reaches [apply](#apply) only from a writer that autobee has
added, and every writer stands at weight 0.
**Not this:** **not autobase.** Autobase is a forbidden dependency, import, and
docs framing.

### append-only (guarantee)
A vault-metadata constant, fixed at init and unrepresentable as an op: no
operation reduces the log. `DeleteConcept` is a tombstone, not a byte deletion.
**Not this:** not a per-writer permission an agent could flip — it lives outside
the log so it cannot be reached from inside it.

### invariant (I1–I11)
A named correctness property the test suite maps to: I1 determinism, I2
convergence, I3 rebuild equivalence, I4 no-silent-loss, I5 OR-set law, I6 LWW
law, I7 flag/conflict lifecycle, I8 index coherence, I9 bundle determinism, I10
governance, I11 generation roundtrip.
**Not this:** not a test — an invariant is the property; a test is evidence for
it.
