---
title: Breath Glossary
purpose: >
  One term, one meaning, for every document in this repository. Referenced by
  all PR bodies, delivery records, specs, READMEs, and issues so a human reader
  builds one stable model instead of re-grounding drifting words. This is the
  single source of truth for vocabulary (Paley "ground before leaning";
  Diataxis "consistent terminology").
how-to-reference: >
  Any document may link a term with `[writer](BREATH.OF.GLOSSARY.md#writer)`.
  A document that uses a load-bearing term for the first time SHOULD link it
  once, then keep the name stable thereafter. Do not redefine a term locally;
  fix it here and let every document inherit the fix.
audience: A capable reader in an imperfect state — skimming, tired, or returning after days away.
---

# Breath Glossary

A term is listed with its **canonical meaning**, then an explicit **not this**
line naming the sibling it drifts into. The drift line is the point: these
words collide because their implementations touch, and the reader loses the
thread when one word carries four ideas.

Two systems share this repo. Where a term means different things in each,
both are given.

---

## Identity and operations

### concept
A single unit of knowledge — one markdown document in a bundle.
**Not this:** not the *file* on disk (that is its materialized face) and not
its *path* (that is a property of it). A concept survives a rename; the file
and path do not.

### `_id`
A concept's stable identity. Minted exactly once, from the creating op's
[tag](#tag); opaque; never derived from path or content. Unique per
[vault](#vault). Equality asserts "same concept," nothing else. Survives
deletion (a tombstone keeps it). The CouchDB `_id` homage.
**Not this:** not the path, not a content hash, not the `tag` it was minted
from after that first moment.

### `_rev`
A concept's body version — the [revHash](#revhash) of the current head
revision, carried in materialized frontmatter. Changes on every body edit.
The CouchDB `_rev` homage.
**Not this:** not identity. Two concepts can never share an `_id`; one concept
has many `_rev`s over its life.

### tag (opId)
The identifier of a single op: `writerKey ‖ seq`. Serves as the OR-set
observation token and the audit handle. Derived by [apply](#apply) from the
node, never trusted from the op payload.
**Not this:** not the `_id`. An `_id` is *minted from* a concept's creating
tag, but a `tag` names an op, and an `_id` names a concept. After creation
they diverge (see the squat-fallback case: a concept's `_id` can differ from
its creating op's tag).

### seq
A writer's own monotonic index for an op within that writer's core (op 0, 1,
2 …). One half of a [tag](#tag).
**Not this:** not the global order of the op across all writers (that is
[ordinal](#ordinal)); not the view-kept [seen-count](#ordinal).

### ordinal / seen-count
A view-maintained per-writer count under `seen/<writerKey>`, incremented for
every node from that writer regardless of disposition. The deterministic
fallback used to key hold/rejection families when autobee exposes no per-node
sequence. Distinct usage: **`ord`** in `c/<id>/path` is the *global* apply
ordinal (count of nodes linearized so far) at which a path was set.
**Not this:** not [seq](#seq) (seq is per-writer and payload-derived; the
seen-count is view-derived). Not a wall clock.

### writer
An append-authorized participant — a human or an agent — identified by a
public key, owning one input core.
**Not this:** not the *author* of prose. Not merely "the key" or "the core" in
isolation; a writer is the participant those belong to. Not an
[indexer](#indexer) unless separately granted.

### indexer
A [writer](#writer) with governance authority: it may emit `AddWriter`,
`RemoveWriter`, `SetWriterPolicy`. Recorded as `indexer: true` in
`gov/writer/<key>`.
**Not this:** not every writer. A non-indexer agent can write concepts but
cannot admit or revoke writers.

### path
A concept's location: a flat, absolute, bundle-relative string, held as an LWW
register on the concept.
**Not this:** not identity (Kleppmann: position is a register on a stable
`_id`, not the thing itself). Not a tree node — OKF has no parent pointers, so
a "directory" is only a shared path prefix.

### op / operation
A semantic write appended to a writer's core (`CreateConcept`, `SetField`,
`SetPath`, `DeleteConcept`, `AddWriter`, …). The source of truth is the
totally-ordered log of these.
**Not this:** not a file write. Never store a whole file as an op value.

### apply
The deterministic, pure function that folds the linearized op stream into the
[view](#view). No wall clock, no randomness, no peer-local reads (invariant
I1).
**Not this:** not a face generator. Apply produces view state; materialize
reads it.

### view
The keyspace-structured key/value state that [apply](#apply) produces and
peers converge on. The queryable face.
**Not this:** not the on-disk bundle (that is a projection of the view). Not
authoritative — the op log is.

---

## Faces and the flag namespace

### bundle
A directory tree of markdown files with YAML frontmatter — the OKF unit of
distribution and the on-disk materialized face.
**Not this:** not the [vault](#vault) (the vault is the multi-writer store;
the bundle is its projection). Not the source of truth.

### vault
The multi-writer store: autobee over corestore, holding one input core per
writer. The source of truth.
**Not this:** not the bundle. A vault materializes to a bundle; a bundle
ingests back into a vault.

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
"no silent loss" ledger that agents drain. Families include `conflict`,
`clobber`, `rejected`, `pathcollision`, `writeafterdelete`.
**Not this:** not [`wanted/`](#wanted). A flag says "a human/agent should look
at this"; a wanted entry says "the graph is asking for this to be written."

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

## Substrate

### autobee
The standalone multi-writer Hyperbee substrate the store is built on
(hyperbee2 + hypercore 11 in the delivered version). Provides the apply/view
pattern, replication, and optimistic writes.
**Not this:** **not autobase.** Autobase is a forbidden dependency, import, and
docs framing. Where a spec authored "on Autobase" names a mechanic, read the
autobee port (see each spec's port-mapping section).

### append-only (guarantee)
A vault-metadata constant, fixed at init and unrepresentable as an op: no
operation reduces the log. `DeleteConcept` is a tombstone, not a byte deletion.
**Not this:** not a per-writer permission an agent could flip — it lives
outside the log precisely so it cannot be reached from inside it.

---

## Correctness and process vocabulary

### invariant (I1–I11)
A named correctness property the test suite maps to. I1 determinism, I2
convergence, I3 rebuild equivalence, I4 no-silent-loss, I5 OR-set law, I6 LWW
law, I7 flag/conflict lifecycle, I8 index coherence, I9 face determinism, I10
governance, I11 epoch roundtrip.
**Not this:** not a test — an invariant is the property; a test is evidence for
it.

### gate (G1, G3, G4, G6)
An evidence checkpoint in the delivery pipeline. G1 spec (zero blockers), G3
clean-clone build, G4 harness-grounded code review, G6 independent final
verification.
**Not this:** not a phase — a gate is the checkpoint that ends one.

### blocker / major / minor
Severity. **Blocker:** an invariant is unachievable as specified, or a view
hash diverges under any seed. **Major:** an observable defect or real risk that
does not by itself falsify an invariant (e.g. a data-preservation or scale
concern). **Minor:** everything else.
**Not this:** severity is about *invariant impact*, not about how alarming the
prose sounds. A data-loss bug outside the deterministic core is a major, not a
blocker, when no hash diverges.

### SPEC-FINAL
The pinned, normative spec revision a build targets. For vault-ld,
`prompts/01-implementation-spec-prompt.v5.md`; for auto-okf, `okf/SPEC.md`.
**Not this:** not a draft. Earlier revisions live in git history and are
superseded.

### stacked PR
A pull request based on another PR's branch rather than on `main`. Merged
bottom-up; the supervisor opens them but never merges.
**Not this:** not an independent PR against main (those are called out as
independent, e.g. the spec-upstream PRs).

---

## A note on the edit vocabulary

The `BREATH.OF.EDITS.*.md` plans use three words from the Paley essay:

- **beat** — one movement in the reader's model (define a term, establish a
  state, report evidence, turn the argument, state a consequence). A paragraph
  or sentence should perform one.
- **open obligation** — a subject, pronoun, topic, or promise the reader is
  still holding because the prose has not closed it.
- **recovery point** — a single line after a dense passage that restores
  orientation ("what changed"), so a wandering reader can rejoin.
