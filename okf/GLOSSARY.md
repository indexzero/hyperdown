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
  `[concept](okf/GLOSSARY.md#concept)` (or a path-relative form). Ground a
  load-bearing term once on first use, then keep the name stable. Do not
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
**Not this:** not the *file* on disk (that is its materialized face) and not
its *path* (that is a property of it). A concept survives a rename; the file
and path do not.

### `_id`
A concept's stable identity. Minted once, from the creating [op](#op)'s
[tag](#tag); opaque; never derived from path or content. Unique per
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
The identifier of one [op](#op): `writerKey ‖ seq`. Serves as the OR-set
observation token and the audit handle. Derived by [apply](#apply) from the
node, never trusted from the op payload.
**Not this:** not the `_id`. An `_id` is minted *from* a concept's creating tag,
but a tag names an op and an `_id` names a concept; after creation they can
differ (the squat-fallback mint gives a genuine concept an `_id` that is not
its creating op's tag).

### seq
A [writer](#writer)'s own monotonic index for an op within that writer's core.
One half of a [tag](#tag).
**Not this:** not the global order across all writers; not the view-kept
[seen-count](#ordinal--seen-count).

### ordinal / seen-count
A view-maintained per-writer count under `seen/<writerKey>`, incremented for
every node from that writer regardless of disposition. The deterministic
fallback used to key hold and rejection families when [autobee](#autobee)
exposes no per-node sequence. Separate usage: **`ord`** in `c/<id>/path` is the
*global* apply ordinal at which a path was set.
**Not this:** not [seq](#seq) (seq is per-writer and payload-derived; the
seen-count is view-derived). Not a wall clock.

### writer
An append-authorized participant — a human or an agent — identified by a public
key, owning one input core.
**Not this:** not the *author* of prose. Not merely "the key" or "the core";
those belong to the writer. Not an [indexer](#indexer) unless granted.

### indexer
A [writer](#writer) with governance authority: it may emit `AddWriter`,
`RemoveWriter`, `SetWriterPolicy`. Recorded `indexer: true` in
`gov/writer/<key>`.
**Not this:** not every writer. A non-indexer agent writes concepts but cannot
admit or revoke writers.

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
**Not this:** not a face generator. Apply produces view state; materialize
reads it.

### view
The keyspace-structured key/value state [apply](#apply) produces and peers
converge on. The queryable face.
**Not this:** not the on-disk [bundle](#bundle) (a projection of the view). Not
authoritative — the op log is.

---

## Faces and the flag namespace

### bundle
A directory tree of markdown files with YAML frontmatter — the OKF unit of
distribution and the on-disk materialized face.
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
**Not this:** not authoritative output — it is a regenerable face. Materialize
must never delete a human-authored file it did not itself produce.

### ingest
Re-enter human on-disk edits as the minimal set of [ops](#op). A changed field
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

### epoch / compact
Operator-only byte reclamation: materialize the live bundle, optionally delete
files on disk, init a fresh vault, ingest with `_id` adoption, record the
predecessor in the new vault's metadata. The CouchDB-compaction homage.
**Not this:** not an op — no in-log operation reclaims bytes. Not lossless of
history: old revisions and per-op attribution are shed by design.

---

## Substrate and guarantees

### autobee
The standalone multi-writer Hyperbee substrate the store is built on (hyperbee2
+ hypercore 11 in the delivered version). Provides the apply/view pattern,
replication, and optimistic writes.
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
law, I7 flag/conflict lifecycle, I8 index coherence, I9 face determinism, I10
governance, I11 epoch roundtrip.
**Not this:** not a test — an invariant is the property; a test is evidence for
it.

### severity
The weight of a defect. **Blocker:** an [invariant](#invariant-i1i11) is
unachievable as specified, or a [view](#view) hash diverges under any seed.
**Major:** a real defect or risk that does not by itself falsify an invariant
(a data-preservation or scale concern — C1 is one). **Minor:** everything else.
**Not this:** severity is about *invariant impact*, not how alarming the prose
sounds. A data-loss bug outside the deterministic core is a major, not a
blocker, when no hash diverges.
