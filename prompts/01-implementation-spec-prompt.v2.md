# Vault-LD on Autobase: Implementation Specification

**Audience:** Claude Code, acting as sole implementer.
**Status:** Normative build instruction. RFC 2119 keywords (MUST, SHOULD, MAY) apply.
**Version:** 2.0 — 2026-07-03. Supersedes v1 (`01-implementation-spec-prompt.md`). Incorporates the resolutions of adversarial review findings F1–F20 (see `P2-1-DISPOSITIONS.md`).

---

## 0. Role and ground rules

You are implementing a multi-writer wiki storage backend targeting the Vault-LD format, built on the Holepunch (holepunchto) stack. Writers include autonomous AI agents; single-writer designs are out of scope by definition.

Before writing any code, you MUST fetch and read the primary sources in §1. Precedence rules:

1. Where this document conflicts with `SPEC.md` in the vault-ld repo on **format semantics**, the vault-ld spec wins.
2. Where this document conflicts with the autobase/autobee READMEs on **API signatures**, the READMEs win. The Holepunch stack is experimental and APIs move; verify every signature named here against the current README before use.
3. Every deviation you take from this document MUST be recorded in `DEVIATIONS.md` with a one-paragraph justification.

## 1. Primary sources (required reading, in order)

- `https://github.com/The-Knowledge-Graph-Guys/vault-ld` and its `SPEC.md`. This is the normative target format: Markdown vaults as linked data, YAML-LD frontmatter plus a composed shared `@context` yielding an RDF knowledge graph. Section references in this document (shadowing rules, dangling-link handling, export file layout, source-of-truth and preservation rules, the clobber rule, host-tool keys, `vld:path` roundtrip) MUST be verified against the current SPEC.md text; do not trust the section numbers here, trust the topics.
- `https://github.com/holepunchto/autobee`: multi-writer KV store built on Autobase and Hyperbee. Its README states it is experimental with breaking changes expected. Treat it as a reference implementation of the apply/view pattern; you MAY depend on it or reimplement the pattern on raw Autobase + Hyperbee, and MUST record the choice in DEVIATIONS.md.
- `https://github.com/holepunchto/autobase`: the multi-writer linearization engine. Read the sections on `apply`, view management, writer management (`addWriter` / `removeWriter`, indexer vs non-indexer writers), optimistic writes (`optimistic`, `host.ackWriter`, self-verification in apply), `signedLength`, and view rebuild on reordering.
- `https://github.com/holepunchto/hyperbee`, `https://github.com/holepunchto/corestore`, `https://github.com/holepunchto/hyperswarm`: storage, keying, and replication substrate.
- `https://github.com/holepunchto/hyperdispatch` and `https://github.com/holepunchto/compact-encoding`: op encoding and routing. SHOULD be used instead of ad hoc JSON ops; if you choose JSON for v1, record it as a deviation. Note the append-only wire-contract requirement in §3.3.

## 2. Architecture: the log is the source of truth

The vault-ld spec permits a deployment to designate one serialization as source of truth, with the other faces generated and read-only. This system takes that to its conclusion:

- **Source of truth:** the Autobase op log (one input Hypercore per writer).
- **Generated faces:** (a) the Markdown/Obsidian vault on disk, (b) the Turtle export (`schema.ttl`, `data.ttl`, per the spec's export layout), (c) the queryable Hyperbee view.

No component ever treats a generated face as authoritative. Human edits to the on-disk vault re-enter the system as ops (§9).

## 3. Op schema

All writes are semantic ops appended to the writer's own core. Never store whole files as values; file-granularity last-writer-wins is the failure mode this design exists to avoid.

### 3.1 Canonical string form: Unicode normalization

Before a subject or term is used as a Hyperbee key, as an IRI-minting input, or as a hash input, it MUST be normalized to Unicode **NFC** (`String.prototype.normalize('NFC')`). Ingestion MUST NFC-normalize file names read from disk before diffing or emitting ops, because platform filesystems (notably macOS/APFS and HFS+) may deliver NFD. Percent-encoding per vault-ld §4.5 is applied **after** NFC normalization. Two subjects are the same subject iff their NFC-normalized, then percent-encoded, byte sequences are equal. This is an I1/I2 requirement, not a nicety.

### 3.2 Op types

```
SetField        { s: subject, p: term, o: value, tag: opId, ctxEpoch?: hash }   // scalar assignment
AddMember       { s, p, o, tag: opId, ctxEpoch?: hash }                         // @set container add
RemMember       { s, p, tags: [opId, ...], ctxEpoch?: hash }                    // @set remove, by observed tags (citation contract, §5.3)
SetBody         { s, base: revHash | null, text: string }
DefineTerm      { scope: ontologyName, term, def: jsonldTermDef }
AddWriter       { key, indexer: bool }
RemoveWriter    { key }
SetWriterPolicy { key, namespacePrefixes: [string], rateCeiling: int }          // indexer-only; see §8.6
PruneRevisions  { s, before: revHash }                                          // indexer-only; see §11
```

- `subject` is the note name per vault-ld naming (NFC-normalized per §3.1); `term` is a compact term resolved against the composed context.
- `o.ref` marks wiki-link object references; literals carry datatype where the context does not already pin one, and are stored in canonical lexical form (§10.2).
- `tag` (opId) is `writerKey || seq`, used for OR-set remove-by-observation.
- `ctxEpoch` is OPTIONAL: a hash of the `ctx/` sub-tree the writer resolved against, enabling epoch pinning (§5.7).
- Encode ops with hyperdispatch + compact-encoding.

### 3.3 Wire contract: append-only schema evolution

The hyperdispatch/Hyperschema op definitions are an append-only wire contract for the life of a vault: message ids and field orders MUST NOT be reordered or removed; new op types are added with new ids; deprecated ops keep their decoder forever. Record the schema version in the vault metadata. This is an I1 requirement (the log is replayed indefinitely). Decode failures are handled deterministically per §8.4, never by throwing out of `apply`.

## 4. View layout

The `apply` function folds the linearized op stream into one Hyperbee view with these key prefixes (use a proper keyspace encoder with escaping; naive string concatenation of user-controlled subjects into keys is forbidden; all subject/term components are NFC-normalized per §3.1):

```
n/<subject>/f/<term>            field state: LWW register or OR-set element map
n/<subject>/body                head revision pointer (revHash)
n/<subject>/rev/<revHash>       immutable body revision {base, text, writer, at}
n/<subject>/layer               'schema' | 'data'  — export partition (§10.1)
n/<subject>/base                governing @base / scope for IRI minting (§7, §10.1)
n/<subject>/path                authored context-relative path, for vld:path roundtrip (§9.3, §10.4)
n/<subject>/host/<key>          host-tool keys (allowlist, §5.6): Markdown-face-only, never indexed
n/<subject>/mintedAs            IRI minted for a dangling target before the note exists (§7)
idx/spo/..., idx/pos/..., idx/osp/...   triple permutation indexes
bl/<target>/<source>/<term>     backlinks
ctx/<scope>/<term>              composed context term definitions
ctx/gov/writer/<key>            writer policy record {namespacePrefixes, rateCeiling} (§8.6)
ctx/gov/removed/<key>           revocation record: causal clock of the RemoveWriter node (§8.3)
flag/rejected/<writerKey>/<seq> {reason, rawHashHex} — writer/seq-keyed, needs no decode (§8.4)
flag/dangling/<target>          coalesced: {count, mintedAs}; referrers recoverable from bl/ (§7)
flag/danglingretarget/<subject>/<term>/<target>   audit record for IRI retargeting (§7)
flag/unmapped/<subject>/<term>
flag/shadow/<scope>/<term>      only on *differing* redefinitions (§5.5)
flag/kindmismatch/<subject>/<term>/<tag>          op-type × term-kind mismatch (§5.2)
flag/clobber/<subject>/<term>/<tag>               cross-writer LWW overwrite (§5.4)
flag/staletag/<subject>/<term>/<tag>              RemMember cited a non-present tag (§5.3)
flag/epoch/<subject>/<term>/<tag>                 epoch divergence on a pinned op (§5.7)
flag/optimistic/<writerKey>/<seq>                 held pre-ack optimistic ops (§8.2)
flag/govoverride/<key>          a later SetWriterPolicy superseded an earlier one (§8.6)
flag/conflict/<subject>/<revHash>/<revHash>
```

The triple indexes MUST be maintained inside the same apply pass, so export and backlinks are pure range scans and never require a second consistency mechanism.

## 5. Merge semantics: the context is the CRDT policy table

This is the core novelty and MUST be implemented exactly.

### 5.1 Policy resolution

- For each incoming `SetField`/`AddMember`/`RemMember`, `apply` resolves the term against the current composed context state in the view (`ctx/` prefix, as of that point in the linearized order), unless the op pins an epoch (§5.7).
- Terms declared with `@container: @set` get **OR-set (observed-remove set)** semantics: concurrent adds union; a remove only deletes tags it observed, so concurrent add wins over remove of an unobserved tag.
- Scalar terms (single-valued, datatyped) get **LWW register** semantics where "last" means last in Autobase's deterministic linearization, never wall-clock time. There is no tie to break: linearization is a total order. Cross-writer overwrites are flagged per §5.4.

### 5.2 Op/kind reconciliation table

`apply` MUST resolve the term kind from `ctx/` at the op's linearized position and apply this total table. Every cell is mandatory; none may be left to the implementer. The table rejects rather than coerces on mismatch; this choice is frozen and normative because it is observable in the view.

| incoming op | term kind = scalar | term kind = `@set` | term kind = unmapped |
|---|---|---|---|
| `SetField` | apply LWW register write | reject: write `flag/kindmismatch/<s>/<p>/<tag>`, do not mutate `n/` | store verbatim + `flag/unmapped` (§5.6) |
| `AddMember` | reject: `flag/kindmismatch`, do not mutate | apply OR-set add | store verbatim (as single-valued) + `flag/unmapped` |
| `RemMember` | reject: `flag/kindmismatch`, do not mutate | OR-set remove-by-observed-tags per the citation contract (§5.3) | no-op + `flag/unmapped` |

"Reject" means the op leaves a flag (satisfying I4) and never mutates `n/`, `ctx/`, or `idx/`.

### 5.3 `RemMember` citation contract

To delete member value `v` from `(s, p)`, a writer MUST cite **every** element-tag currently mapped to `v` in the writer's resolved view (`n/<s>/f/<p>` element map). Client libraries MUST compute this set, not accept a caller subset. `apply` removes exactly the cited tags that are present; a cited tag that is **not present** (never added, or already removed) is ignored *for effect* but recorded once under `flag/staletag/<s>/<p>/<tag>` (satisfies I4 auditability and does not mutate outcome). A concurrent `AddMember` of the same `v` under a new tag is by construction not cited and therefore survives — this is the OR-set add-wins law (I5). Because the totally-ordered Autobase log is retained, `apply` always has the full add/remove history and needs **no separate tombstone store** in the view. (This is the SU-Set observed-remove construction, not C-Set.)

### 5.4 LWW supersession is surfaced, not silent

On any `SetField` whose linearized predecessor for the same `(subject, term)` came from a **different writer** and carried a different value, `apply` MUST write `flag/clobber/<s>/<term>/<tag>` recording the superseded `{writerKey, seq, value}` and the superseding tag. Human tooling drains this queue; agents consuming the flag queue get a signal that they overwrote (or were overwritten by) another writer. Same-writer sequential updates do not flag. This makes I4 literally true for scalar registers: a losing write's effect is auditable. The same rule applies to the body head pointer (§6) when the superseded head came from a different writer and no `flag/conflict` was already written for the pair.

### 5.5 Shadowing

`apply` writes `flag/shadow/<scope>/<term>` **only** when a `DefineTerm` for `<term>` in a later-linearized scope resolves to a term definition that is **not structurally equal** (after canonical JSON-LD term-definition normalization) to the one already in `ctx/`. Identical redeclarations are idempotent and MUST NOT flag, per vault-ld §4.2.

### 5.6 Unmapped terms and host-tool keys

- Ops on terms with no context mapping MUST NOT be dropped. Store the value verbatim in `n/<s>/f/<term>` and write `flag/unmapped/...`, mirroring the spec's preservation requirement for unmapped keys. Unmapped values round-trip on the Markdown face (§9.2) and are backfilled into the indexes when a mapping later appears (§10.3).
- `apply` and the ingest watcher MUST maintain a configurable **host-key allowlist** (default `{tags, aliases, cssclasses, publish, permalink}`). Keys on the allowlist are neither emitted as triples nor flagged `unmapped`; they are preserved on the Markdown face only (stored under `n/<s>/host/<key>` for lossless materialization, never in `idx/*`), per vault-ld §4.3 ("MUST NOT emit as triples and MUST NOT warn"). A deployment MAY remove a key from the allowlist by adding a `DefineTerm` for it, which promotes it to a real predicate. Only keys that are *neither* mapped *nor* on the allowlist get `flag/unmapped`.

### 5.7 Policy epochs

Because merge policy is read from the view at apply time, a reorg that reorders a `DefineTerm` relative to dependent field ops can change the merged result. This is still deterministic (any two nodes with the same linearized log produce identical views) but it is semantically surprising; the README MUST state it plainly (document it in code comments too).

Epoch pinning is the opt-in mitigation: ops MAY carry `ctxEpoch` (§3.2), a hash of the `ctx/` sub-tree the writer resolved against. When present, `apply` compares it to the `ctx/` state at the op's linearized position; if they differ for the specific term the op touches, `apply` MUST apply the op under the **writer-cited** epoch's kind and additionally write `flag/epoch/<s>/<term>/<tag>` recording both epochs, so the reinterpretation is auditable and, if desired, replayable. Writers that omit `ctxEpoch` accept apply-time policy. Pinning is not mandatory (it costs a context read per op and most ops don't need it).

## 6. Body revisions and conflicts

Prose does not decompose into registers. v1 model:

- Every `SetBody` creates an immutable revision keyed by content hash (hash covers `base` and `text`).
- Head pointer is LWW under linearization; cross-writer head supersession without a shared-base conflict writes `flag/clobber` per §5.4.
- When apply observes two revisions citing the same `base` (true concurrency), it MUST keep both, set the head deterministically, and write `flag/conflict/...`. Reconciliation is an application-level activity (e.g. an agent consuming the flag queue), not a storage-level guess.
- Revision retention and pruning are governed by §11.
- No text CRDT in v1 (see non-goals).

## 7. Dangling links

Per the vault-ld dangling-link rule: a `ref` to a nonexistent subject mints the IRI, writes the triple, and writes a dangling flag. When the target subject later materializes (any op creating it), apply clears the flag. This MUST be order-independent in effect: the same linearized log yields the same final flag set regardless of which op the linearization placed first.

Normative details:

- **Mint base.** A dangling `ref` MUST mint the target IRI in the **data namespace** (root `@base`) per vault-ld §4.4.1, regardless of the referrer's scope, and record the minted IRI under `n/<target>/mintedAs`.
- **Flag coalescing.** Dangling flags MUST be coalesced: `flag/dangling/<target>` keyed by target with a referrer **count** (and the minted IRI), not one row per `(s, p, target)` — a fan-out to distinct targets is bounded by distinct-target count, and a fan-out to one target is O(1). The full referrer set is recoverable from `bl/<target>/...`, which is maintained regardless.
- **Takeover.** When any op later creates `<target>`: if the new note mints the **same** IRI (an instance at root), `apply` clears the flag and reuses the IRI; if the new note mints a **different** IRI (e.g., a schema note under an ontology `@base`), `apply` MUST NOT silently merge — it rewrites the referring triples to the new IRI, clears `flag/dangling/<target>`, and writes `flag/danglingretarget/<s>/<p>/<target>` per referring triple for audit.
- The I7 test suite MUST cover both the same-IRI and different-IRI takeover cases.

## 8. Writer governance

### 8.1 Roles and onboarding

- Humans and at least one pinning/server node are **indexer** writers. AI agents join as **non-indexer** writers so an ephemeral agent swarm cannot stall the indexer set. Verify the current autobase API for declaring indexer status at `addWriter` time.
- New agents MAY write optimistically before confirmation if the current autobase version supports optimistic writes (§8.2); otherwise onboarding is `AddWriter` from an existing indexer.
- Support the autobase `encryptionKey` option end to end for private vaults.

### 8.2 Optimistic writes: do not apply until acked

Optimistic ops MUST self-verify in `apply` (per the autobase README): apply MUST check the op's writer against `ctx/gov` and MUST NOT mutate `n/`, `ctx/`, or `idx/` for a writer that is neither confirmed nor acked; such ops are held under `flag/optimistic/<W>/<seq>` and become effective only after an indexer `AddWriter`/`ackWriter` for `W` linearizes, at which point apply replays them deterministically. This do-not-apply-until-ack policy is chosen over apply-then-maybe-discard because the latter can transiently violate I10.

### 8.3 Revocation: causal, not positional

`RemoveWriter` is revocation. The revocation point MUST be defined in **causal**, not index, terms: an op `x` from writer `W` is *post-revocation* iff the `RemoveWriter{key:W}` node causally precedes `x` in the Autobase DAG (i.e., `x` transitively references it), **or** `RemoveWriter{key:W}` is at or before `signedLength` at the time `x` is linearized and `x` is beyond it. Ops that are causally concurrent with the removal and both fall before `signedLength` are resolved once by the finalized linear order and never revisited.

Formally: `apply`, when it reaches a `RemoveWriter{key:W}` node, records `ctx/gov/removed/<W> = <this node's causal clock>`; any subsequent op from `W` whose causal clock does not strictly precede that node is rejected under `flag/rejected/<W>/<seq>` (reason `revoked`). This is a pure function of the DAG and stable across reorg. The I10 test suite MUST include a test that reorders the log and asserts the applied/rejected partition is invariant.

### 8.4 Undecodable and structurally invalid ops

`apply` MUST NOT throw on a malformed op; a throw would be nondeterministic across node versions and could stall the view. Instead: ops are flagged in a **writer/seq-keyed** namespace that requires no successful decode:

```
flag/rejected/<writerKey>/<seq>  →  { reason, rawHashHex }
reason ∈ { undecodable, oversize-subject, oversize-op, depth-exceeded, unknown-msgid,
           policy-namespace, policy-rate, kindmismatch, garbage-base, revoked }
```

Because `<writerKey>/<seq>` is available from the Autobase node metadata **before** payload decode, every attempted op is flaggable, closing the I4 hole. Hard limits MUST be defined and enforced pre-decode: subject ≤ 1024 bytes, single op payload ≤ 64 KiB, literal nesting depth ≤ 64. Ops exceeding a limit are rejected under `flag/rejected` and never mutate `n/`.

### 8.5 Rate ceilings and flag flooding

Because all effects flow through apply, enforcement in apply is airtight against a writer that bypasses client code — but a policy op in the same log cannot preempt a burst that linearizes before it. Therefore:

- Rate ceilings MUST have a **default that applies to every writer from its first op**, enforced by `apply` counting per-writer ops within a linearized window (e.g., ≤ N ops per K linearized positions from that writer), independent of any explicit policy op.
- Ops beyond the ceiling are rejected under `flag/rejected/<W>/<seq>` (reason `policy-rate`), and a rejected op writes **one** rejection record, not a per-target flag, bounding view growth to O(rejected-ops) with a tiny constant.
- Dangling-flag coalescing (§7) bounds the other flooding surface.
- An explicit indexer `SetWriterPolicy` op may only *tighten* below the default; it is never a prerequisite for protection.

### 8.6 Namespace governance

Add op `SetWriterPolicy { key, namespacePrefixes: [string], rateCeiling: int }`, indexer-only. `apply` stores it under `ctx/gov/writer/<key>` with **LWW-under-linearization** merge (governance is intentionally centralized; the last indexer decision wins, and the loser is auditable via `flag/govoverride/<key>`). A writer `W` may only mutate a subject whose NFC-normalized name has a prefix in `W`'s `namespacePrefixes` (empty ⇒ unrestricted, for indexers/humans); a violating op is rejected under `flag/rejected/<W>/<seq>` reason `policy-namespace`. Two indexers disagreeing resolve by linearization; document that namespace policy is deliberately **not** a mergeable CRDT because it is a security boundary. The I10 test suite MUST include: an agent op outside its namespace never mutates `n/`.

## 9. Materialization and ingestion

### 9.1 Materialize

`materialize(dir)`: walk `n/` and `ctx/`, emit an Obsidian-compatible vault: YAML-LD frontmatter from field state, body from head revision, `context.jsonld` from `ctx/`. Field-to-YAML ordering MUST be canonical (sorted) so materialization is byte-deterministic for a given view; YAML scalar rendering uses the canonical literal forms of §10.2, never the YAML library's default float/date rendering.

`materialize` MUST walk `n/<s>/f/*` including terms with no `ctx/` mapping and emit them into frontmatter under their original key (they were authored; they round-trip on the Markdown face), and MUST emit host-tool keys from `n/<s>/host/*` (§5.6).

### 9.2 Ingest

A file watcher ingests human edits: parse the changed file (NFC-normalizing file names per §3.1), diff frontmatter against view state per field, diff body against head revision, emit the minimal op set. Never emit a whole-file op. Host-allowlist keys (§5.6) are stored under `n/<s>/host/<key>`, not emitted as field ops, and never flagged.

### 9.3 Path capture and placement

The ingest watcher captures each note's authored context-relative path (NFC-normalized) into `n/<subject>/path`. `materialize` MUST write each note to `n/<s>/path` when present, else to the vault-ld default reconstructable location (unpinned instance at context root; flat schema placement per vault-ld §5.1). On ingest, a `vld:path` triple is consumed into `n/<s>/path` and never stored as a field (vault-ld §5.5).

### 9.4 On-disk safety

The spec's clobber rule (generated regeneration must not destroy authored prose) is satisfied structurally *for the view*: bodies live in the view; regeneration is a pure projection. On-disk safety is a separate, explicitly-handled concern:

- `materialize` MUST write atomically (write to a temp file, `fsync`, `rename`) and MUST skip files with unsaved external modifications (compare on-disk mtime/hash against the last-materialized hash; if changed, treat as an ingest event first).
- The watcher MUST debounce and read only after write-settle (size stable for one interval) and MUST ignore files currently being written by `materialize` (a per-path in-flight lock).
- Document in the README that clobber-immunity is a view property; filesystem races are handled by the mechanisms above.

## 10. Export

### 10.1 Layer partition (schema vs data)

vault-ld decides export layer by *folder*, which the op log deliberately discards; layer is therefore graph-relevant metadata and MUST be materialized into the view. Maintain a per-subject record `n/<subject>/layer` ∈ `{schema, data}`, derived deterministically: a subject is `schema` iff it carries `@type` resolving to `owl:Ontology | owl:Class | owl:ObjectProperty | owl:DatatypeProperty | rdfs:Class | rdf:Property | skos:ConceptScheme | skos:Concept`, else `data`. This mirrors vault-ld §5.4 step 5 without needing folders. `exportTurtle(dir)` produces `schema.ttl` and `data.ttl` by range-scanning `idx/spo`, partitioned by this record. Also materialize the governing scope/`@base` per subject as `n/<subject>/base` (needed for §7 IRI takeover). Record in DEVIATIONS.md that layer is inferred from `@type` rather than folder, and that a schema subject lacking a recognized meta-type defaults to `data`.

### 10.2 Canonical literal forms

Output MUST be byte-deterministic; two peers with converged views MUST produce identical bytes. Literals MUST be stored and emitted in canonical lexical form: `xsd:integer` with no decimal point or leading zeros; `xsd:decimal`/`xsd:double` per the XSD canonical mapping (never platform `toString`); `xsd:dateTime`/`xsd:date` in canonical ISO-8601 with explicit `Z`; booleans as `true`/`false`; strings NFC-normalized (§3.1) with Turtle escaping applied in a fixed codepoint order; language tags lowercased. Turtle prefix order, subject order, predicate order (by IRI byte value), and object order (by term byte value) are all fixed ascending. YAML materialization emits scalars via the same canonical mapping. This is an I1/I9 requirement.

### 10.3 Unmapped terms

`exportTurtle` MUST NOT emit unmapped terms as triples (no predicate IRI exists), matching vault-ld, but MUST NOT lose them: they persist on the Markdown face (§9.1) and in the view. When a later `DefineTerm` supplies a mapping, `apply` MUST re-scan `n/*/f/<term>` for that term and backfill `idx/*` and `bl/*` in the same pass, then clear the corresponding `flag/unmapped`. The I8 test suite MUST include: a deferred `DefineTerm` makes previously-unmapped values index-visible.

### 10.4 `vld:path` roundtrip

`exportTurtle`, when producing a **roundtrip** face, MUST emit `vld:path "<path>.md"` for every note whose `n/<s>/path` differs from its reconstructable default, and MUST omit it for defaults and for query-only exports (config flag `roundtrip: bool`). Ingest consumption of `vld:path` is specified in §9.3. This is required for the "opens cleanly in Obsidian" + roundtrip acceptance criteria.

## 11. Compaction, snapshots, and retention

v1 accepts monotonic log growth, and the README MUST state the accepted cost in writing with worked numbers (e.g., 50 agents × 500 ops/day ≈ 9.1M ops/year of never-collected input-core blocks; at 10% `SetBody` averaging 4 KB, ≈ 3.6 GB/year of retained body revisions). Naive log truncation is unsafe below `signedLength` because Autobase relinearizes from history.

Mitigations, normative in v1:

- **Snapshots.** At `signedLength` checkpoints, an indexer MAY publish a signed **view snapshot** (a Hyperbee checkout hash) so new peers bootstrap from the snapshot rather than replaying the whole log; ops below the snapshot's `signedLength` become archival.
- **Revision pruning.** Body revisions MUST support the `PruneRevisions { s, before: revHash }` op (§3.2, indexer-only), which removes non-head revisions older than the cutoff except those referenced by an open `flag/conflict`. Pruning is itself a logged op so it is deterministic and auditable (I1/I4).
- DXOS-style epochs are the documented future direction for full log compaction.

## 12. Invariants (numbered; the test suite and the review prompts reference these)

- **I1 Determinism:** apply is a pure function of the linearized op sequence. No wall clock, no randomness, no map-iteration-order dependence, no floating-point formatting variance, no Unicode-normalization variance (§3.1), no throw-on-malformed-op variance (§8.4).
- **I2 Convergence:** any set of peers that have exchanged all ops produce bit-identical views (verified by hashing a full range scan).
- **I3 Rebuild equivalence:** a view rebuilt from scratch from the same log equals the incrementally maintained view.
- **I4 No silent loss:** no op's effect disappears without a flag. Unmapped, dangling, shadowed, conflicting, kind-mismatched, stale-tag, clobbered (cross-writer LWW supersession, §5.4), epoch-divergent, undecodable/oversize (writer/seq-keyed, §8.4), and policy-rejected effects all leave `flag/` records.
- **I5 OR-set law:** concurrent add and remove of the same member converge to the member present (add wins over remove of unobserved tag), under the citation contract of §5.3.
- **I6 LWW law:** scalar outcome depends only on linearized order, never on arrival order at any peer.
- **I7 Flag lifecycle:** dangling flags clear when targets materialize (both same-IRI and retargeted takeover, §7); conflict flags persist until an explicit resolving op.
- **I8 Index coherence:** `idx/*` and `bl/*` are always consistent with `n/*` within a single view state, including after deferred-`DefineTerm` backfill (§10.3).
- **I9 Export determinism:** converged peers emit identical `.ttl` and identical materialized vaults (canonical literal forms, §10.2).
- **I10 Governance:** ops from removed writers after the causal revocation point (§8.3), unacked optimistic ops (§8.2), and policy-violating ops (namespace, rate, limits) never mutate `n/`, `ctx/`, or `idx/`; the applied/rejected partition is reorg-stable.

## 13. Non-goals (v1)

- No text CRDT for bodies. No fine-grained per-writer read ACLs beyond the shared `encryptionKey`. No HTTP API. No SPARQL engine (the triple indexes exist; a query layer is future work). No Obsidian plugin. No full log compaction (snapshots and revision pruning per §11 only).

## 14. Deliverables

```
/packages/core        ops, encodings (hyperdispatch), apply, view schema, keyspace codec
/packages/store       autobase wiring, writer governance, swarm replication
/packages/faces       materialize, ingest watcher, turtle export
/packages/cli         init, join, add-writer, remove-writer, materialize, export, flags
/test                 unit + the invariant suite (I1..I10 each mapped to at least one test)
DEVIATIONS.md
README.md             architecture, the policy-epoch caveat (§5.7), retention costs (§11),
                      threat model summary, narrowed novelty claim (below)
```

The README's novelty section MUST state the narrowed claim: this system's contribution is not per-predicate CRDT selection (see SU-Set, m-ld, schema-driven protobuf CRDTs) but **in-log reflexive merge policy** — the JSON-LD `@context` that selects OR-set vs LWW per predicate is itself a first-class, multi-writer-replicated object in the same linearized op log as the data it governs, yielding deterministic-but-epoch-sensitive semantics (§5.7).

Node.js 20+, plain JavaScript matching Holepunch ecosystem conventions (verify current CJS/ESM convention from the autobase repo and follow it). Brittle/bare compatibility SHOULD be preserved where cheap.

## 15. Acceptance

The build is complete when: every invariant I1..I10 has a passing test (including the reorg-stability test for I10 §8.3, the dual takeover test for I7 §7, and the backfill test for I8 §10.3); `materialize` output opens cleanly in Obsidian; `exportTurtle` output parses with a standard Turtle parser and partitions into `schema.ttl`/`data.ttl` per §10.1; a roundtrip export/ingest cycle preserves note placement via `vld:path` (§10.4); and a three-writer demo (two simulated agents, one human ingest path) converges after partition and heal.
