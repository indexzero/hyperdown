# Vault-LD on Autobase: Implementation Specification

**Audience:** Claude Code, acting as sole implementer.
**Status:** Normative build instruction. RFC 2119 keywords (MUST, SHOULD, MAY) apply.

---

## 0. Role and ground rules

You are implementing a multi-writer wiki storage backend targeting the Vault-LD format, built on the Holepunch (holepunchto) stack. Writers include autonomous AI agents; single-writer designs are out of scope by definition.

Before writing any code, you MUST fetch and read the primary sources in §1. Precedence rules:

1. Where this document conflicts with `SPEC.md` in the vault-ld repo on **format semantics**, the vault-ld spec wins.
2. Where this document conflicts with the autobase/autobee READMEs on **API signatures**, the READMEs win. The Holepunch stack is experimental and APIs move; verify every signature named here against the current README before use.
3. Every deviation you take from this document MUST be recorded in `DEVIATIONS.md` with a one-paragraph justification.

## 1. Primary sources (required reading, in order)

- `https://github.com/The-Knowledge-Graph-Guys/vault-ld` and its `SPEC.md`. This is the normative target format: Markdown vaults as linked data, YAML-LD frontmatter plus a composed shared `@context` yielding an RDF knowledge graph. Section references in this document (shadowing rules, dangling-link handling, export file layout, source-of-truth and preservation rules, the clobber rule) MUST be verified against the current SPEC.md text; do not trust the section numbers here, trust the topics.
- `https://github.com/holepunchto/autobee`: multi-writer KV store built on Autobase and Hyperbee. Its README states it is experimental with breaking changes expected. Treat it as a reference implementation of the apply/view pattern; you MAY depend on it or reimplement the pattern on raw Autobase + Hyperbee, and MUST record the choice in DEVIATIONS.md.
- `https://github.com/holepunchto/autobase`: the multi-writer linearization engine. Read the sections on `apply`, view management, writer management (`addWriter` / `removeWriter`, indexer vs non-indexer writers), optimistic writes, and view rebuild on reordering.
- `https://github.com/holepunchto/hyperbee`, `https://github.com/holepunchto/corestore`, `https://github.com/holepunchto/hyperswarm`: storage, keying, and replication substrate.
- `https://github.com/holepunchto/hyperdispatch` and `https://github.com/holepunchto/compact-encoding`: op encoding and routing. SHOULD be used instead of ad hoc JSON ops; if you choose JSON for v1, record it as a deviation.

## 2. Architecture: the log is the source of truth

The vault-ld spec permits a deployment to designate one serialization as source of truth, with the other faces generated and read-only. This system takes that to its conclusion:

- **Source of truth:** the Autobase op log (one input Hypercore per writer).
- **Generated faces:** (a) the Markdown/Obsidian vault on disk, (b) the Turtle export (`schema.ttl`, `data.ttl`, per the spec's export layout), (c) the queryable Hyperbee view.

No component ever treats a generated face as authoritative. Human edits to the on-disk vault re-enter the system as ops (§8).

## 3. Op schema

All writes are semantic ops appended to the writer's own core. Never store whole files as values; file-granularity last-writer-wins is the failure mode this design exists to avoid.

```
SetField    { s: subject, p: term, o: value, tag: opId }        // scalar assignment
AddMember   { s, p, o, tag: opId }                              // @set container add
RemMember   { s, p, tags: [opId, ...] }                         // @set remove, by observed tags
SetBody     { s, base: revHash | null, text: string }
DefineTerm  { scope: ontologyName, term, def: jsonldTermDef }
AddWriter   { key, indexer: bool }
RemoveWriter{ key }
```

- `subject` is the note name per vault-ld naming; `term` is a compact term resolved against the composed context.
- `o.ref` marks wiki-link object references; literals carry datatype where the context does not already pin one.
- `tag` (opId) is `writerKey || seq`, used for OR-set remove-by-observation.
- Encode ops with hyperdispatch + compact-encoding.

## 4. View layout

The `apply` function folds the linearized op stream into one Hyperbee view with these key prefixes (use a proper keyspace encoder with escaping; naive string concatenation of user-controlled subjects into keys is forbidden):

```
n/<subject>/f/<term>            field state: LWW register or OR-set element map
n/<subject>/body                head revision pointer (revHash)
n/<subject>/rev/<revHash>       immutable body revision {base, text, writer, at}
idx/spo/..., idx/pos/..., idx/osp/...   triple permutation indexes
bl/<target>/<source>/<term>     backlinks
ctx/<scope>/<term>              composed context term definitions
flag/dangling/<subject>/<term>/<target>
flag/unmapped/<subject>/<term>
flag/shadow/<scope>/<term>
flag/conflict/<subject>/<revHash>/<revHash>
```

The triple indexes MUST be maintained inside the same apply pass, so export and backlinks are pure range scans and never require a second consistency mechanism.

## 5. Merge semantics: the context is the CRDT policy table

This is the core novelty and MUST be implemented exactly:

- For each incoming `SetField`/`AddMember`/`RemMember`, `apply` resolves the term against the current composed context state in the view (`ctx/` prefix, as of that point in the linearized order).
- Terms declared with `@container: @set` get **OR-set (observed-remove set)** semantics: concurrent adds union; a remove only deletes tags it observed, so concurrent add wins over remove of an unobserved tag.
- Scalar terms (single-valued, datatyped) get **LWW register** semantics where "last" means last in Autobase's deterministic linearization, never wall-clock time. There is no tie to break: linearization is a total order.
- Ops on terms with no context mapping MUST NOT be dropped. Store the value verbatim and write `flag/unmapped/...`, mirroring the spec's preservation requirement for unmapped keys.
- Term redefinitions that shadow an existing definition MUST write `flag/shadow/...`, mirroring the spec's shadowing rule.
- **Policy epoch caveat (document this in code comments and README):** because merge policy is read from the view at apply time, a reorg that reorders a `DefineTerm` relative to dependent field ops can change the merged result. This is still deterministic (any two nodes with the same linearized log produce identical views) but it is semantically surprising; the README MUST state it plainly.

## 6. Body revisions and conflicts

Prose does not decompose into registers. v1 model:

- Every `SetBody` creates an immutable revision keyed by content hash (hash covers `base` and `text`).
- Head pointer is LWW under linearization.
- When apply observes two revisions citing the same `base` (true concurrency), it MUST keep both, set the head deterministically, and write `flag/conflict/...`. Reconciliation is an application-level activity (e.g. an agent consuming the flag queue), not a storage-level guess.
- No text CRDT in v1 (see non-goals).

## 7. Dangling links

Per the vault-ld dangling-link rule: a `ref` to a nonexistent subject mints the IRI, writes the triple, and writes `flag/dangling/...`. When the target subject later materializes (any op creating it), apply clears the flag. This MUST be order-independent in effect: the same linearized log yields the same final flag set regardless of which op the linearization placed first.

## 8. Writer governance

- Humans and at least one pinning/server node are **indexer** writers. AI agents join as **non-indexer** writers so an ephemeral agent swarm cannot stall the indexer set. Verify the current autobase API for declaring indexer status at `addWriter` time.
- New agents MAY write optimistically before confirmation if the current autobase version supports optimistic writes; a policy op from an indexer confirms or discards them. Otherwise onboarding is `AddWriter` from an existing indexer.
- `RemoveWriter` is revocation. Additionally, `apply` MUST enforce policy on every op: per-writer namespace restrictions and per-writer rate ceilings are checked in apply, and violating ops are recorded under `flag/` and not applied. Because all effects flow through apply, this is airtight against a writer that bypasses client code.
- Support the autobase `encryptionKey` option end to end for private vaults.

## 9. Materialization and ingestion

- `materialize(dir)`: walk `n/` and `ctx/`, emit an Obsidian-compatible vault: YAML-LD frontmatter from field state, body from head revision, `context.jsonld` from `ctx/`. Field-to-YAML ordering MUST be canonical (sorted) so materialization is byte-deterministic for a given view.
- A file watcher ingests human edits: parse the changed file, diff frontmatter against view state per field, diff body against head revision, emit the minimal op set. Never emit a whole-file op.
- The spec's clobber rule (generated regeneration must not destroy authored prose) is satisfied structurally: bodies live in the view; regeneration is a pure projection.

## 10. Export

`exportTurtle(dir)` produces `schema.ttl` and `data.ttl` by range-scanning `idx/spo`, partitioned per the spec's schema/data split. Output MUST be byte-deterministic: canonical prefix ordering, canonical subject/predicate/object ordering, stable literal formatting. Two peers with converged views MUST produce identical bytes.

## 11. Invariants (numbered; the test suite and the review prompts reference these)

- **I1 Determinism:** apply is a pure function of the linearized op sequence. No wall clock, no randomness, no map-iteration-order dependence, no floating-point formatting variance.
- **I2 Convergence:** any set of peers that have exchanged all ops produce bit-identical views (verified by hashing a full range scan).
- **I3 Rebuild equivalence:** a view rebuilt from scratch from the same log equals the incrementally maintained view.
- **I4 No silent loss:** no op's effect disappears without a flag. Unmapped, dangling, shadowed, conflicting, and policy-rejected effects all leave `flag/` records.
- **I5 OR-set law:** concurrent add and remove of the same member converge to the member present (add wins over remove of unobserved tag).
- **I6 LWW law:** scalar outcome depends only on linearized order, never on arrival order at any peer.
- **I7 Flag lifecycle:** dangling flags clear when targets materialize; conflict flags persist until an explicit resolving op.
- **I8 Index coherence:** `idx/*` and `bl/*` are always consistent with `n/*` within a single view state.
- **I9 Export determinism:** converged peers emit identical `.ttl` and identical materialized vaults.
- **I10 Governance:** ops from removed writers after revocation point, and policy-violating ops, never mutate `n/`, `ctx/`, or `idx/`.

## 12. Non-goals (v1)

- No text CRDT for bodies. No fine-grained per-writer read ACLs beyond the shared `encryptionKey`. No HTTP API. No SPARQL engine (the triple indexes exist; a query layer is future work). No Obsidian plugin.

## 13. Deliverables

```
/packages/core        ops, encodings (hyperdispatch), apply, view schema, keyspace codec
/packages/store       autobase wiring, writer governance, swarm replication
/packages/faces       materialize, ingest watcher, turtle export
/packages/cli         init, join, add-writer, remove-writer, materialize, export, flags
/test                 unit + the invariant suite (I1..I10 each mapped to at least one test)
DEVIATIONS.md
README.md             architecture, the policy-epoch caveat, threat model summary
```

Node.js 20+, plain JavaScript matching Holepunch ecosystem conventions (verify current CJS/ESM convention from the autobase repo and follow it). Brittle/bare compatibility SHOULD be preserved where cheap.

## 14. Acceptance

The build is complete when: every invariant I1..I10 has a passing test; `materialize` output opens cleanly in Obsidian; `exportTurtle` output parses with a standard Turtle parser; and a three-writer demo (two simulated agents, one human ingest path) converges after partition and heal.
