---
title: Vault-LD Glossary
scope: >
  The long-lived vocabulary of the Vault-LD system. One term, one meaning, so a
  reader building a mental model never re-grounds a drifting word. Delivery-
  process terms (gate, blocker severity, stacked PR) are absent — they belong to
  the delivery record, not the system.
reference: >
  Link a term from any document with
  `[subject](vault-ld/GLOSSARY.md#subject)` (or a path-relative form). Ground a
  load-bearing term once on first use, then keep the name stable. Do not redefine
  a term locally; fix it here.
sibling: okf/GLOSSARY.md (the other system in this repo; different domain vocabulary)
---

# Vault-LD Glossary

Each term gives its **canonical meaning**, then a **not this** line naming the
sibling it drifts into. Vault-LD is a linked-data system: its unit is the
*subject*, not the *concept*, and its predicates are *terms* resolved against a
shared *context*. Where a substrate term is shared with auto-okf, it is
restated here so this glossary is self-contained.

---

## Subjects, terms, and identity

### subject
A single note — the Vault-LD unit of knowledge, named by its file name. Every
write op names a subject.
**Not this:** not a "concept" (that is auto-okf's word). Not its IRI (the IRI is
the subject's minted identity) and not the file (the file is a materialized
face).

### term
A compact predicate key on a subject (for example `prepTime`, `subClassOf`),
resolved against the composed [context](#context--context) to a full predicate
IRI and a merge kind.
**Not this:** not a literal value, and not a frontmatter key in general — a term
is a *mapped* predicate. An unmapped key is stored and flagged [`unmapped`](#flag-families), not treated as a term.

### context (`@context`)
The composed JSON-LD context: the table that maps [terms](#term) to predicate
IRIs **and selects each term's merge kind** ([OR-set](#or-set) for
`@container: @set`, [LWW register](#lww-register) otherwise). The system's
novelty is that this table is itself a first-class, multi-writer-replicated
object in the same op log as the data it governs.
**Not this:** not a per-note header (Vault-LD forbids per-note `@context`; there
is one composed context). Not static config — it evolves through `DefineTerm`
and `DefineScope` ops, which is what makes the [policy epoch](#policy-epoch--ctxkind) hazard real.

### IRI
A subject's minted identity: governing [`@base`](#base--id) plus the
percent-encoded file name. The stable name a triple refers to.
**Not this:** not the subject's file path, and not folder-derived — folders
never enter the IRI.

### `@base` / `@id`
`@base` is the namespace a scope mints IRIs against; an explicit `@id` overrides
name-based minting with a verbatim absolute IRI.
**Not this:** not the file location. Two same-named notes distinguished only by
`@id` are distinct subjects, never merged.

---

## Merge policy: the context is the CRDT table

### OR-set
Observed-remove set semantics, selected for a term declared `@container: @set`.
Concurrent adds union; a remove deletes only the tags it observed, so a
concurrent add wins over a remove of an unobserved tag (invariant I5; the
SU-Set construction).
**Not this:** not LWW. Applying `SetField` to an `@set` term, or `AddMember` to
a scalar term, is a kind mismatch, not a silent coercion.

### LWW register
Last-writer-wins register semantics, selected for a scalar (non-`@set`) term.
"Last" means last in the deterministic linearization, never wall-clock time. The
value is a canonical array (possibly length 1) that supersedes atomically.
**Not this:** not intent-order or arrival-order. A superseded cross-writer write
is recorded `flag/clobber`, so LWW loss is auditable, not silent (invariant I4,
I6).

### policy epoch / `ctxKind`
Because a term's merge kind is read from the [context](#context--context) at
apply time, a reorg that moves a `DefineTerm` across dependent writes can change
a write's meaning — deterministically, but surprisingly. An op MAY carry
`ctxKind` to pin the kind it was written against; a mismatch is applied under
the cited kind and flagged `epoch`.
**Not this:** not nondeterminism. Any two peers with the same linearized log
compute the same view; only the *meaning* of an unpinned write can shift across
two legal linearizations.

### triple
A `(subject, predicate, object)` fact, the RDF unit. Maintained in the
permutation indexes `idx/spo`, `idx/pos`, `idx/osp` inside the same apply pass,
so export and query are pure range scans.
**Not this:** not the stored field state (`n/<subject>/f/<term>`) — triples are
the index derived from it, kept coherent with it (invariant I8).

---

## Faces and the flag namespace

### vault
The multi-writer store: [autobee](#autobee) over corestore, one input core per
[writer](#writer). The source of truth.
**Not this:** not the materialized Obsidian vault on disk (that is a face).

### materialize
Project the [view](#view) to an Obsidian-compatible vault on disk: YAML-LD
frontmatter from field state, body from head revision, `context.jsonld` from the
context. Byte-deterministic for a converged view (invariant I9).
**Not this:** not authoritative. Human edits to the on-disk vault re-enter as
ops.

### exportTurtle
Generate `schema.ttl` and `data.ttl` by range-scanning `idx/spo`, partitioned
into the schema and data [layers](#layer). Byte-deterministic: converged peers
emit identical bytes.
**Not this:** not the same as materialize — materialize emits markdown; export
emits Turtle. Unmapped terms have no predicate IRI and are never exported as
triples.

### layer (schema / data)
The export partition of a subject: schema (ontology and vocabulary resources)
or data (instances). Materialized into the view since the op log carries no
folders.
**Not this:** not a folder. The layer is derived from an authored path when
present, else inferred from `@type`.

### flag / flag-family
A view record under `flag/…` meaning *something needs attention* — the I4
no-silent-loss ledger. Families: `dangling`, `shadow`, `unmapped`, `conflict`,
`clobber`, `staletag`, `kindmismatch`, `epoch`, `rejected`, `govoverride`.
**Not this:** not an error to reject the vault over. A flag is a queued item for
a human or agent to resolve.

### dangling
A `ref` to a subject that does not yet exist: the IRI is minted in the data
namespace, the triple is written, and `flag/dangling` is recorded. It clears
when the target materializes.
**Not this:** not a broken write. The edge is preserved; the flag is the record
that its target is unwritten.

### unmapped
A frontmatter key with no [term](#term) mapping in the context. Stored verbatim
and flagged, never dropped, and re-indexed if a later `DefineTerm` maps it.
**Not this:** not a host key. `tags`, `aliases`, `cssclasses` are allowlisted
editor affordances — never emitted as triples and never flagged.

---

## Substrate and guarantees (shared with auto-okf)

### writer
An append-authorized participant — human or agent — identified by a public key,
owning one input core.
**Not this:** not the author of prose; not merely the key or the core; not an
[indexer](#indexer) unless granted.

### indexer
A [writer](#writer) with governance authority (`AddWriter`, `RemoveWriter`,
`SetWriterPolicy`). AI agents join as non-indexers so an ephemeral swarm cannot
stall the indexer set.
**Not this:** not every writer.

### apply
The deterministic, pure function folding the linearized op stream into the
[view](#view). No wall clock, no randomness, no peer-local reads (invariant I1).
**Not this:** not a face generator.

### view
The keyspace-structured key/value state [apply](#apply) produces and peers
converge on.
**Not this:** not the on-disk vault or the Turtle export — those are projections.

### tag (opId)
The identifier of one op: `writerKey ‖ seq`. The OR-set observation token and
audit handle, derived by apply from the node.
**Not this:** not a subject IRI; not read from the op payload.

### autobee
The standalone multi-writer Hyperbee substrate (hyperbee2 + hypercore 11 in the
delivered version). The spec was authored "on Autobase"; each such mechanic is
ported to autobee (see the spec's port-mapping section).
**Not this:** **not autobase.** Autobase is a forbidden dependency, import, and
docs framing.

### append-only (guarantee) / governance
Governance ops require an [indexer](#indexer) issuer, checked in apply.
Revocation is decided by an in-log causal clock, never by positional removal.
No op reduces the log.
**Not this:** not enforced by client code — every guarantee flows through apply,
so a writer bypassing the client cannot evade it (invariant I10).

### invariant (I1–I10)
A named correctness property: I1 determinism, I2 convergence, I3 rebuild
equivalence, I4 no-silent-loss, I5 OR-set law, I6 LWW law, I7 flag lifecycle, I8
index coherence, I9 export determinism, I10 governance.
**Not this:** not a test — an invariant is the property; a test is evidence for
it.

### severity
The weight of a defect. **Blocker:** an [invariant](#invariant-i1i10) is
unachievable as specified, or a [view](#view) hash diverges under any seed.
**Major:** a real defect or risk that does not by itself falsify an invariant.
**Minor:** everything else.
**Not this:** severity is about *invariant impact*, not how alarming the prose
sounds.
