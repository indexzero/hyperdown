# Vault-LD on Autobase: Implementation Specification

**Audience:** Claude Code, acting as sole implementer.
**Status:** Normative build instruction. RFC 2119 keywords (MUST, SHOULD, MAY) apply.
**Version:** 5.0 — 2026-07-03. Supersedes v4 (`01-implementation-spec-prompt.v4.md`). Applies the four regression fixes R1–R4 identified in the closure verification of v4 (`P2-3-CLOSURE.md` §2; see `P2-4-DISPOSITIONS.md`). v4 incorporated the resolutions of the v3 adversarial review findings F1–F3, M-a, m1–m5, n2, and the narrowed novelty claim (see `P2-3-DISPOSITIONS.md`). v3 incorporated B1–B3, M1–M10, m1–m7, n1–n2 (see `P2-2-DISPOSITIONS.md`).

---

## 0. Role and ground rules

You are implementing a multi-writer wiki storage backend targeting the Vault-LD format, built on the Holepunch (holepunchto) stack. Writers include autonomous AI agents; single-writer designs are out of scope by definition.

Before writing any code, you MUST fetch and read the primary sources in §1. Precedence rules:

1. Where this document conflicts with `SPEC.md` in the vault-ld repo on **format semantics**, the vault-ld spec wins.
2. Where this document conflicts with the autobase/autobee READMEs on **API signatures**, the READMEs win. The Holepunch stack is experimental and APIs move; verify every signature named here against the current README before use.
3. Every deviation you take from this document MUST be recorded in `DEVIATIONS.md` with a one-paragraph justification.

## 1. Primary sources (required reading, in order)

- `https://github.com/The-Knowledge-Graph-Guys/vault-ld` and its `SPEC.md`. This is the normative target format: Markdown vaults as linked data, YAML-LD frontmatter plus a composed shared `@context` yielding an RDF knowledge graph. Section references in this document (shadowing rules, dangling-link handling, export file layout, source-of-truth and preservation rules, the clobber rule, host-tool keys, keyword aliases, explicit `id`, `vld:path` roundtrip) MUST be verified against the current SPEC.md text; do not trust the section numbers here, trust the topics.
- `https://github.com/holepunchto/autobee`: multi-writer KV store built on Autobase and Hyperbee. Its README states it is experimental with breaking changes expected. Treat it as a reference implementation of the apply/view pattern; you MAY depend on it or reimplement the pattern on raw Autobase + Hyperbee, and MUST record the choice in DEVIATIONS.md.
- `https://github.com/holepunchto/autobase`: the multi-writer linearization engine. Read the sections on `apply`, view management, writer management (`addWriter` / `removeWriter`, indexer vs non-indexer writers), optimistic writes (`optimistic`, `host.ackWriter`, self-verification in apply), `signedLength`, and view rebuild on reordering.
- `https://github.com/holepunchto/hyperbee`, `https://github.com/holepunchto/corestore`, `https://github.com/holepunchto/hyperswarm`: storage, keying, and replication substrate.
- `https://github.com/holepunchto/hyperdispatch` and `https://github.com/holepunchto/compact-encoding`: op encoding and routing. SHOULD be used instead of ad hoc JSON ops; if you choose JSON for v1, record it as a deviation. Note that hyperdispatch's own README is a single sentence ("Generate operations/endpoints using Hyperschema"); read the **Hyperschema** repository (`https://github.com/holepunchto/hyperschema`) directly for the actual encoding semantics, and understand that the append-only wire-contract discipline in §3.3 is **this spec's own requirement**, not something inherited from hyperdispatch documentation. Note the append-only wire-contract requirement in §3.3.

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

Every op, of every type, carries one common field:

- `clock` (REQUIRED): the writer's observed vector clock, `[{writerKey, seq}, ...]`, captured at append time from the writer's local view of all writers' delivered lengths (writers MAY derive it from `base.heads()` at append time; it is op payload, so apply's determinism is unaffected). Its sole normative consumer is the revocation rule of §8.3.

```
SetField        { s: subject, p: term, o: value | [value, ...], tag: opId, ctxKind? }  // lww assignment (§5.1); o MAY be a canonical array
AddMember       { s, p, o, tag: opId, ctxKind? }                         // or-set container add
RemMember       { s, p, tags: [opId, ...], ctxKind? }                    // or-set remove, by observed tags (citation contract, §5.3)
UnsetField      { s, p, tag: opId }                                      // clears an lww register / removes field state (§9.2)
SetBody         { s, base: revHash | null, text: string }
SetPath         { s, path: string }                                      // authored context-relative path (§9.3)
DeleteSubject   { s, tag: opId }                                         // subject tombstone (§9.2)
ResolveConflict { s, keep: revHash, supersede: [revHash, ...], text?: string }  // body conflict resolution (§6)
ClearFlag       { flagKey }                                              // audit flags only (§6)
DefineTerm      { scope: ontologyName, term, def: jsonldTermDef }
DefineScope     { scope: ontologyName, base: iri, prefix: string }       // scope @base declaration (§10.1)
AddWriter       { key, indexer: bool }                                   // governance op (§8.0)
RemoveWriter    { key }                                                  // governance op (§8.0)
SetWriterPolicy { key, namespacePrefixes: [string], rateCeiling: int }   // governance op (§8.0, §8.6)
PruneRevisions  { s, before: revHash }                                   // governance op (§8.0, §11)
```

- `subject` is the note name per vault-ld naming (NFC-normalized per §3.1); `term` is a compact term resolved against the composed context.
- `o.ref` marks wiki-link object references; literals carry datatype where the context does not already pin one, and are stored in canonical lexical form (§10.2).
- `tag` (opId) is `writerKey || seq`, used for OR-set remove-by-observation and for supersession audit.
- `ctxKind` is OPTIONAL: `'scalar' | 'set'` — the term kind the writer resolved against, cited directly, enabling kind pinning (§5.7; `'scalar'` pins the **lww** kind, `'set'` pins the **or-set** kind). It SHOULD be the default for agent writers (it costs two bytes per op).
- `DefineScope` carries the **same authority as `DefineTerm`** (it is content, not governance); it is NOT a governance op under §8.0.
- `ResolveConflict`, `ClearFlag`, `UnsetField`, `DeleteSubject`, `SetPath` are ordinary content ops, subject to the namespace and rate policies of §8.5/§8.6 like any other write.
- Encode ops with hyperdispatch + compact-encoding.

### 3.3 Wire contract: append-only schema evolution

The hyperdispatch/Hyperschema op definitions are an append-only wire contract for the life of a vault: message ids and field orders MUST NOT be reordered or removed; new op types are added with new ids; deprecated ops keep their decoder forever. Record the schema version in the vault metadata. This is an I1 requirement (the log is replayed indefinitely). Decode failures are handled deterministically per §8.4, never by throwing out of `apply`.

## 4. View layout

The `apply` function folds the linearized op stream into one Hyperbee view with these key prefixes (use a proper keyspace encoder with escaping; naive string concatenation of user-controlled subjects into keys is forbidden; all subject/term components are NFC-normalized per §3.1):

```
n/<subject>/f/<term>            field state: lww register (canonical array, §5.1) or or-set element map
n/<subject>/body                head revision pointer (revHash)
n/<subject>/rev/<revHash>       immutable body revision {base, text, writer, at}
n/<subject>/layer               'schema' | 'data'  — export partition (§10.1)
n/<subject>/base                governing @base / scope for IRI minting (§7, §10.1)
n/<subject>/path                authored context-relative path, for vld:path roundtrip (§9.3, §10.4)
n/<subject>/id                  explicit @id IRI, overrides name-based minting (§5.8)
n/<subject>/deleted             subject tombstone (§9.2)
n/<subject>/host/<key>          host-tool keys (allowlist, §5.6): Markdown-face-only, never indexed
n/<subject>/mintedAs            IRI minted for a dangling target before the note exists (§7)
n/hold/<writerKey>/<seq>        held optimistic op payload, full decoded op (§8.2)
idx/spo/..., idx/pos/..., idx/osp/...   triple permutation indexes
bl/<target>/<source>/<term>     backlinks
ctx/<scope>/<term>              composed context term definitions
ctx/scope/<scope>               scope declaration {base, prefix} (§10.1)
ctx/gov/writer/<key>            writer record {indexer, namespacePrefixes, rateCeiling} (§8.0, §8.6)
ctx/gov/clock/<writerKey>       per-writer max-seq vector of applied ops (§8.3)
ctx/gov/removed/<key>           revocation record: clock of the RemoveWriter node (§8.3)
seen/<writerKey>                per-writer seen-count ordinal — fallback `<seq>` source (§8.2, §8.4).
                                Deliberately a top-level family, NOT under ctx/: it is incremented for
                                every node including rejected ones, and I10/§8.0 forbid rejected ops
                                from mutating ctx/. Bookkeeping like n/hold/ (§8.2).
unmapped-idx/<term>/<subject>   reverse index of unmapped-term writes, for bounded backfill (§10.3)
flag/rejected/<writerKey>/<seq> {reason, rawHashHex} — writer/seq-keyed, needs no decode (§8.4)
flag/dangling/<target>          coalesced: {count, mintedAs}; referrers recoverable from bl/ (§7)
flag/danglingretarget/<subject>/<term>/<target>   audit record for IRI retargeting (§7)
flag/unmapped/<subject>/<term>
flag/shadow/<scope>/<term>      only on *differing* redefinitions (§5.5)
flag/kindmismatch/<subject>/<term>/<tag>          op-type × term-kind mismatch (§5.2)
flag/kindcollapse/<subject>/<term>                lossy set→lww migration on redefinition (§5.5)
flag/clobber/<subject>/<term>/<tag>               cross-writer LWW overwrite (§5.4)
flag/staletag/<subject>/<term>/<tag>              RemMember cited a non-present tag (§5.3)
flag/epoch/<subject>/<term>/<tag>                 {citedKind, applyKind} kind divergence on a pinned op (§5.7)
flag/idcollision/<iri>          two subjects minted or declared the same IRI (§5.8)
flag/noscope/<subject>          schema subject with no derivable scope (§10.1)
flag/unsafepath/<subject>       materialize refused an unsafe path (§9.4)
flag/undelete/<subject>         a later op re-created a deleted subject (§9.2)
flag/writeafterdelete/<subject>/<tag>             concurrent write to a deleted subject (§9.2)
flag/linkambiguous/<subject>/<term>/<target>      wiki-link resolution ambiguity (§9.2)
flag/optimistic/<writerKey>/<seq>                 held pre-ack optimistic ops (§8.2)
flag/govoverride/<key>          a later SetWriterPolicy superseded an earlier one (§8.6)
flag/conflict/<subject>/<revHash>/<revHash>
```

The triple indexes MUST be maintained inside the same apply pass, so export and backlinks are pure range scans and never require a second consistency mechanism.

Every `<seq>` appearing as a key component in the hold and rejection families — `n/hold/<W>/<seq>`, `flag/rejected/<W>/<seq>`, `flag/optimistic/<W>/<seq>`, and the namespace/rate rejections recorded under `flag/rejected/` (§8.5/§8.6) — denotes the single per-writer ordinal source defined in §8.2/§8.4; no two of these families may disagree on a writer's op ordinals. Payload-derived `<tag>`s are explicitly **not** in this set: per-op flag tags (`flag/clobber/`, `flag/staletag/`, `flag/epoch/`, `flag/kindmismatch/`, `flag/writeafterdelete/`) embed the op-carried `tag = writerKey || seq` of §3.2, a payload value that other writers observe and cite under the §5.3 citation contract, and MUST NOT be rewritten to the view-maintained ordinal.

## 5. Merge semantics: the context is the CRDT policy table

This is the core novelty and MUST be implemented exactly.

### 5.1 Policy resolution and term kinds

For each incoming `SetField`/`AddMember`/`RemMember`/`UnsetField`, `apply` resolves the term against the current composed context state in the view (`ctx/` prefix, as of that point in the linearized order), unless the op pins a kind (§5.7). Term kinds are exactly three:

- **or-set** (`@container: @set`): **OR-set (observed-remove set)** semantics — concurrent adds union; a remove only deletes tags it observed, so concurrent add wins over remove of an unobserved tag.
- **lww** (everything else mapped, **including terms with no `@container`**): LWW register semantics where "last" means last in Autobase's deterministic linearization, never wall-clock time. There is no tie to break: linearization is a total order. Cross-writer overwrites are flagged per §5.4. An **lww register's value is a canonical array** (possibly length 1): `SetField.o` MAY be a scalar or an array; `apply` stores the array in canonical element order (sorted by the §10.2 byte form) and export emits **one triple per element**. The whole array supersedes atomically under LWW; there is no per-element merge on lww terms — deployments wanting element-wise merge declare `@container: @set`. YAML materialization emits a scalar when length is 1 and a flow array otherwise; ingest diffs at whole-array granularity for lww terms. (This matters because in JSON-LD/RDF, absence of `@container: @set` does not mean single-valued — multiple triples per predicate are the default; vault-ld's own example context defines `domain`/`range` with no `@container` and its example notes carry arrays.)
- **unmapped**: no context mapping (§5.6).

A `DefineTerm` carrying `@container: @list` (or any container other than `@set`) is rejected (`flag/rejected`, reason `unsupported-container`); `@list` support is a non-goal (§13).

### 5.2 Op/kind reconciliation table

`apply` MUST resolve the term kind from `ctx/` at the op's linearized position and apply this total table. Every cell is mandatory; none may be left to the implementer. The table rejects rather than coerces on mismatch; this choice is frozen and normative because it is observable in the view. (Keyword terms — `@type`, `@id`, and their context aliases — are resolved **before** this table, per §5.8.)

| incoming op | term kind = lww | term kind = or-set | term kind = unmapped |
|---|---|---|---|
| `SetField` | apply LWW register write (canonical array, §5.1) | reject: write `flag/kindmismatch/<s>/<p>/<tag>`, do not mutate `n/` | store verbatim + `flag/unmapped` + `unmapped-idx/` (§5.6) |
| `AddMember` | reject: `flag/kindmismatch`, do not mutate | apply OR-set add | **accumulate** verbatim into the unmapped accumulation list under `n/<s>/f/<term>` (canonical order and dedup per §5.6; never overwrite a prior unmapped value silently) + `flag/unmapped` + `unmapped-idx/` |
| `RemMember` | reject: `flag/kindmismatch`, do not mutate | OR-set remove-by-observed-tags per the citation contract (§5.3) | no-op + `flag/unmapped` |
| `UnsetField` | clear the register / remove field state; cross-writer removal of a present value flagged per §5.4 | reject: `flag/kindmismatch`, do not mutate | remove the verbatim value + `flag/unmapped` |

"Reject" means the op leaves a flag (satisfying I4) and never mutates `n/`, `ctx/`, or `idx/`.

### 5.3 `RemMember` citation contract

To delete member value `v` from `(s, p)`, a writer MUST cite **every** element-tag currently mapped to `v` in the writer's resolved view (`n/<s>/f/<p>` element map). Client libraries MUST compute this set, not accept a caller subset. `apply` removes exactly the cited tags that are present; a cited tag that is **not present** (never added, or already removed) is ignored *for effect* but recorded once under `flag/staletag/<s>/<p>/<tag>` (satisfies I4 auditability and does not mutate outcome). A concurrent `AddMember` of the same `v` under a new tag is by construction not cited and therefore survives — this is the OR-set add-wins law (I5). Because the totally-ordered Autobase log is retained, `apply` always has the full add/remove history and needs **no separate tombstone store** in the view. (This is the SU-Set observed-remove construction, not C-Set.)

### 5.4 LWW supersession is surfaced, not silent

On any `SetField` (or `UnsetField`, or `SetPath`, or `@id` write per §5.8) whose linearized predecessor for the same `(subject, term)` came from a **different writer** and carried a different value, `apply` MUST write `flag/clobber/<s>/<term>/<tag>` recording the superseded `{writerKey, seq, value}` and the superseding tag. Human tooling drains this queue; agents consuming the flag queue get a signal that they overwrote (or were overwritten by) another writer. Same-writer sequential updates do not flag. This makes I4 literally true for scalar registers: a losing write's effect is auditable. The same rule applies to the body head pointer (§6) when the superseded head came from a different writer and no `flag/conflict` was already written for the pair.

### 5.5 Shadowing and kind-changing redefinition

`apply` writes `flag/shadow/<scope>/<term>` **only** when a `DefineTerm` for `<term>` in a later-linearized scope resolves to a term definition that is **not structurally equal** (after canonical JSON-LD term-definition normalization) to the one already in `ctx/`. Identical redeclarations are idempotent and MUST NOT flag, per vault-ld §4.2.

When a `DefineTerm` changes a term's **kind** (lww↔or-set, or mapped↔unmapped), `apply` MUST, in the same pass, migrate every existing `n/*/f/<term>` (located via `unmapped-idx/` where applicable, else the term-keyed scan of §10.3):

- **lww→or-set:** convert the register's value(s) to element-map entries under a synthetic tag `writerKey || seq` of the `DefineTerm` op.
- **or-set→lww:** collapse the element map to an lww register deterministically (the element whose tag is greatest in linearized order wins) and write `flag/kindcollapse/<s>/<term>` per subject that had more than one element (I4: the collapse is lossy and audited).

This migration is in addition to `flag/shadow`. The I8 test suite MUST include a kind-changing redefinition and assert `idx/*` and export remain well-formed afterward.

### 5.6 Unmapped terms and host-tool keys

- Ops on terms with no context mapping MUST NOT be dropped. Store the value verbatim in `n/<s>/f/<term>` (accumulating, never silently overwriting — §5.2), write `flag/unmapped/...`, and maintain the reverse index `unmapped-idx/<term>/<s>` (§10.3), mirroring the spec's preservation requirement for unmapped keys. The unmapped accumulation list is stored in **canonical element order** (sorted by the §10.2 byte form), deduplicated (identical NFC-normalized byte sequences collapse to one entry, retaining the first-in-linearized-order tag for audit). This makes the stored list a pure function of the op *multiset*, independent of linearized order, so a later `DefineTerm` backfill (§10.3) is convergent (I2/I8). Unmapped values round-trip on the Markdown face (§9.2) and are backfilled into the indexes when a mapping later appears (§10.3).
- `apply` and the ingest watcher MUST maintain a configurable **host-key allowlist** (default exactly `{tags, aliases, cssclasses}`, the three keys named in vault-ld §4.3). Deployments MAY add editor-specific keys (e.g. `publish`, `permalink`) but MUST record the extension, because the allowlist is a convergence-relevant input: two peers with different allowlists produce different `flag/unmapped` sets for the same op. The allowlist SHOULD therefore be pinned in vault metadata and treated as append-only across a vault's life — append-only **except via the in-log `DefineTerm` promotion of the next bullet**, which is deterministic (it is an ordinary logged op, folded identically on every peer) and is the only sanctioned removal path; out-of-band configuration edits that remove a key are the convergence hazard the append-only rule exists to prevent. Keys on the allowlist are neither emitted as triples nor flagged `unmapped`; they are preserved on the Markdown face only (stored under `n/<s>/host/<key>` for lossless materialization, never in `idx/*`), per vault-ld §4.3 ("MUST NOT emit as triples and MUST NOT warn"). Only keys that are *neither* mapped *nor* on the allowlist get `flag/unmapped`.
- **Promotion.** A deployment MAY remove a key from the allowlist by adding a `DefineTerm` for it, which promotes it to a real predicate. When a `DefineTerm` promotes a formerly-allowlisted key `k` (i.e. `ctx/` gains a mapping for a key that was host-only), `apply` MUST, in the same pass, migrate every `n/<s>/host/k` into `n/<s>/f/k` under the newly-resolved kind (§5.2), delete the `host/` entries, and run the §10.3 backfill over the migrated fields. Conversely, a key added to the allowlist while mappings exist for it is a configuration error the loader MUST reject at startup. `materialize` MUST treat `f/` and `host/` as disjoint by construction (this migration guarantees it) and MUST error if a subject ever holds both `f/k` and `host/k`.

### 5.7 Policy epochs (kind pinning)

Because merge policy is read from the view at apply time, a reorg that reorders a `DefineTerm` relative to dependent field ops can change the merged result. This is still deterministic (any two nodes with the same linearized log produce identical views) but it is semantically surprising; the README MUST state it plainly (document it in code comments too).

Kind pinning is the opt-in mitigation: `SetField`/`AddMember`/`RemMember` MAY carry `ctxKind: 'scalar' | 'set'` (§3.2) — the term kind the writer resolved against, cited directly — where `'scalar'` pins the **lww** register kind (§5.1) and `'set'` pins the **or-set** kind. `unmapped` is not pinnable (there is no policy to cite); an op citing a kind for a term that resolves to `unmapped` is applied under the cited kind and flagged `flag/epoch` with `applyKind: unmapped`. When `ctxKind` is present and differs from the kind resolved from `ctx/` at the op's linearized position, `apply` MUST apply the op under the **cited** kind (`SetField` under cited `scalar` applies as LWW even if `ctx/` now says `@set`, storing into the register slot; `AddMember`/`RemMember` under cited `set` apply OR-set semantics into the element map) and write `flag/epoch/<s>/<term>/<tag>` recording `{citedKind, applyKind}`, so the reinterpretation is auditable. When the kinds agree, no flag. Writers that omit `ctxKind` accept apply-time policy. `materialize`/`export` treat a field that holds both a register slot and an element map (possible only via epoch divergence) by emitting the element map and flagging `flag/kindmismatch` — this state is always accompanied by an epoch flag and is resolvable by a subsequent op. Pinning costs two bytes per op and SHOULD be the default for agent writers.

### 5.8 Keyword terms (`@type`, `@id`)

vault-ld §4.3 requires conforming tools to honour keyword aliases declared in the composed context (the reference vault aliases `type: "@type"` and `id: "@id"`). `apply` MUST resolve keyword terms — directly or via context alias — **before** the §5.2 table:

- **`@type`** gets OR-set semantics with element tags, exactly as `@container: @set` terms (`AddMember`/`RemMember`; a `SetField` on `@type` is a kind mismatch). §10.1's layer rule reads the full `@type` element set as its type-based fallback (priority (2) of §10.1); when no authored path decides the layer and **any** member resolves to a schema meta-type, the subject is `schema`.
- **`@id`** is identity, not a field. A `SetField` on `@id` with a non-absolute-IRI value is rejected (`flag/rejected`, reason `bad-id`, per vault-ld §4.5: the value MUST be a full absolute IRI, used verbatim). With an absolute IRI it is stored as `n/<s>/id` (LWW, cross-writer supersession flagged per §5.4) and **overrides name-based minting** in `idx/*`, export, and dangling-takeover matching (§7). Two subjects whose minted-or-declared IRIs collide write `flag/idcollision/<iri>`; `apply` MUST NOT merge them (vault-ld §4.4.1/§4.5: same-named participating notes MUST warn; explicit `id` disambiguates same-named notes). `materialize` emits `id:` into frontmatter verbatim. Ingest of a foreign subject whose IRI extends no known `@base` creates the note with an explicit `id` (vault-ld §5.5), percent-decoding names when choosing file names per vault-ld §5.5.

## 6. Body revisions and conflicts

Prose does not decompose into registers. v1 model:

- Every `SetBody` creates an immutable revision keyed by content hash. The hash construction is fixed for interoperability (I2 across implementations): `revHash = SHA-256( len(base) || base || len(text) || utf8(NFC(text)) )`, hex lowercase, where `base` is the 64-char lowercase-hex revHash of the cited base revision or the empty string for `null`, `len(x)` is the 8-byte big-endian byte length of `x`, and `text` is NFC-normalized UTF-8.
- Head pointer is LWW under linearization; cross-writer head supersession without a shared-base conflict writes `flag/clobber` per §5.4.
- When apply observes two revisions citing the same `base` (true concurrency), it MUST keep both, set the head deterministically, and write `flag/conflict/...`. Reconciliation is an application-level activity (e.g. an agent consuming the flag queue), not a storage-level guess — and it has a concrete write vocabulary:
- **`ResolveConflict { s, keep, supersede, text? }`** (any writer within its namespace): `apply` sets `n/<s>/body = keep` (or, when `text` is present, a new revision whose `base` is `keep`), and clears every `flag/conflict/<s>/<a>/<b>` where `{a,b} ⊆ {keep} ∪ supersede`. Superseded revisions become prunable (§11).
- **`ClearFlag { flagKey }`** is restricted to flags whose semantics permit manual clearance (audit flags: `clobber`, `staletag`, `epoch`, `govoverride`, `danglingretarget`, `undelete`, `writeafterdelete`, `kindcollapse`, `linkambiguous`, `unsafepath`, `noscope`); structural flags (`unmapped`, `dangling`, `conflict`, `kindmismatch`, `idcollision`, `optimistic`, `rejected`) are cleared only by their defining resolution (a mapping, a target, a `ResolveConflict`, a corrected op, an ack) and reject a `ClearFlag` (reason `flag-not-clearable`). This makes I7's "explicit resolving op" real and bounds the flag namespace.
- Revision retention and pruning are governed by §11.
- No text CRDT in v1 (see non-goals).

## 7. Dangling links

Per the vault-ld dangling-link rule: a `ref` to a nonexistent subject mints the IRI, writes the triple, and writes a dangling flag. When the target subject later materializes (any op creating it), apply clears the flag. This MUST be order-independent in effect: the same linearized log yields the same final flag set regardless of which op the linearization placed first.

Normative details:

- **Mint base.** A dangling `ref` MUST mint the target IRI in the **data namespace** (root `@base`) per vault-ld §4.4.1, regardless of the referrer's scope, and record the minted IRI under `n/<target>/mintedAs`.
- **Flag coalescing.** Dangling flags MUST be coalesced: `flag/dangling/<target>` keyed by target with a referrer **count** (and the minted IRI), not one row per `(s, p, target)` — a fan-out to distinct targets is bounded by distinct-target count, and a fan-out to one target is O(1). The full referrer set is recoverable from `bl/<target>/...`, which is maintained regardless.
- **Takeover.** When any op later creates `<target>`: if the new note mints (or declares via explicit `@id`, §5.8) the **same** IRI (an instance at root), `apply` clears the flag and reuses the IRI; if the new note mints or declares a **different** IRI (e.g., a schema note under an ontology `@base`, or an explicit `@id`), `apply` MUST NOT silently merge — it rewrites the referring triples to the new IRI, clears `flag/dangling/<target>`, and writes `flag/danglingretarget/<s>/<p>/<target>` per referring triple for audit.
- The I7 test suite MUST cover both the same-IRI and different-IRI takeover cases.

## 8. Writer governance

### 8.0 Governance-op authority

`AddWriter`, `RemoveWriter`, `SetWriterPolicy`, and `PruneRevisions` are **governance ops**. `apply` MUST evaluate the **issuing** writer's role against `ctx/gov/writer/<issuerKey>` at the op's linearized position and reject (reason `policy-governance`, under `flag/rejected/<issuer>/<seq>`) any governance op whose issuer is not a confirmed **indexer** at that position. `ctx/gov/writer/<key>` MUST record `indexer: bool`, written by the `AddWriter` op that admitted the writer (and by genesis below). Genesis: the vault creator's key is the initial indexer, recorded in vault metadata and seeded into `ctx/gov` by the first `apply` invocation deterministically. `host.addWriter`/`host.removeWriter` MUST only ever be invoked for governance ops that passed this check. The I10 test suite MUST include: a non-indexer's `AddWriter{indexer:true}` never results in `host.addWriter` being called and never mutates `ctx/gov`.

(Without this check, any confirmed agent could append `AddWriter{indexer:true}` ops for puppet keys, capture the indexer quorum, and route around every other defense in this section. The check is the difference between I10 holding and I10 being vacuous against the stated adversary.)

### 8.1 Roles and onboarding

- Humans and at least one pinning/server node are **indexer** writers. AI agents join as **non-indexer** writers so an ephemeral agent swarm cannot stall the indexer set. Verify the current autobase API for declaring indexer status at `addWriter` time.
- Onboarding is `AddWriter` from an existing indexer (enforced at apply time per §8.0). New agents MAY write optimistically before confirmation if the current autobase version supports optimistic writes (§8.2).
- Support the autobase `encryptionKey` option end to end for private vaults.

### 8.2 Optimistic writes: do not apply until acked

Optimistic ops MUST self-verify in `apply` (per the autobase README): apply MUST check the op's writer against `ctx/gov` and MUST NOT mutate `n/` (other than `n/hold/`), `ctx/`, or `idx/` for a writer that is neither confirmed nor acked. Held optimistic ops MUST be stored **with their full decoded payload** under `n/hold/<W>/<seq> = <op>` (not merely flagged), plus `flag/optimistic/<W>/<seq>`. When an indexer `AddWriter`/`ackWriter` for `W` linearizes, `apply` MUST, in the same pass, range-scan `n/hold/<W>/*` in ascending `seq` order and fold each held op through the normal §5 pipeline **at the ack's linearized position** (their effect is as if they occurred there; this is deterministic because both the held set and the pipeline are pure functions of the linearized prefix), then delete `n/hold/<W>/*` and clear the optimistic flags. Ops from `W` that arrive after the ack are applied normally. Because Autobase does not re-present earlier nodes to `apply`, the payload MUST live in the view (`n/hold/`), never solely in Autobase node history. This do-not-apply-until-ack policy is chosen over apply-then-maybe-discard because the latter can transiently violate I10.

**Hold-buffer ordinal.** The hold-buffer key MUST use a per-writer monotonic ordinal that is a pure function of linearized order and is defined for *unapplied* ops. Implementations MUST NOT key the hold buffer by `ctx/gov/clock/<W>` (which counts applied ops and does not advance for held ops). Determine the ordinal as follows and record the choice in DEVIATIONS.md: (a) if the current Autobase `apply` node exposes a stable per-writer sequence/index, use it; (b) otherwise maintain, inside apply, a per-writer *seen-count* `seen/<W>` (a dedicated top-level key family, §4 — deliberately outside `ctx/`, so incrementing it for a rejected op does not conflict with I10's "never mutate `ctx/`" or §8.0's mandated never-mutates-`ctx/gov` test) incremented for **every** node from `W` (applied, held, or rejected) in linearized order, and key holds/rejections by it. Option (b) is a pure function of the linearized prefix and is therefore reorg-stable. `seen/` is excluded from `materialize`/export walks — it is bookkeeping, like `n/hold/` — but is included in the I2 view hash, because it is deterministic view state. `flag/rejected` (§8.4) and namespace/rate rejections (§8.5/§8.6) MUST use the **same** ordinal source as the hold buffer so that no two families disagree on a writer's op ordinals.

**Hold-time rate limiting and bounding.** Held optimistic ops are subject to the §8.5 rate ceiling **at hold time**: apply MUST run the token-bucket check before writing `n/hold/<W>/<seq>`, and an over-ceiling optimistic op is rejected (`flag/rejected`, reason `policy-rate`) and MUST NOT be held. A writer that has never been acked has a hold-buffer cap of `H_max` ops (vault metadata constant); optimistic ops beyond `H_max` for an unacked writer are rejected (reason `policy-rate`) and not held. When a `RemoveWriter` for an unacked `W` linearizes, apply MUST delete `n/hold/<W>/*` and clear the optimistic flags without folding them (a revoked writer's speculative ops never take effect). Deployments SHOULD document that an optimistic write folded at its ack position merges *after* confirmed ops that linearized before the ack; agents that need authoring-time ordering MUST carry `ctxKind` and SHOULD obtain confirmation before writing to contended registers.

### 8.3 Revocation: causal, not positional

`RemoveWriter` is revocation. Because the documented Autobase API does not expose per-node causal references inside `apply`, causal revocation MUST be carried in-band: every op carries the `clock` field of §3.2 — the writer's observed vector clock, captured at append time (it is op payload, so apply's determinism is unaffected). `apply` maintains `ctx/gov/clock/<writerKey>` = the per-writer max-seq vector as ops are applied. When `apply` reaches `RemoveWriter{key:W}`, it records `ctx/gov/removed/<W> = clock(RemoveWriter node)`. A subsequent op `x` from `W` is rejected (reason `revoked`) iff `x.clock` does **not** dominate strictly below the recorded clock — i.e. iff `x` did not causally precede the revocation, judged solely from op-embedded clocks. An op from `W` with a missing or malformed `clock` is rejected (reason `revoked`) once `ctx/gov/removed/<W>` exists. This is a pure function of op payloads and linearized order and is therefore reorg-stable. No rule may consult `signedLength` inside `apply`, because its value at apply time is peer-local; a rule quantified over "signedLength at the time x is linearized" would make two peers replaying the same log partition the same op differently, violating I1/I2.

The I10 test suite MUST include a test that replays the same log (a) incrementally, (b) from scratch, and (c) under a forced reorg, asserting an identical applied/rejected partition in all three.

(Alternative, considered and rejected: define revocation purely positionally — "any op from W linearized after the RemoveWriter node is rejected." That is deterministic and trivially implementable, but the partition flips under pre-`signedLength` reorgs, so I10's reorg-stability claim would have to be weakened. The clock-in-op design preserves I10 at the cost of one small field per op; take that trade.)

### 8.4 Undecodable and structurally invalid ops

`apply` MUST NOT throw on a malformed op; a throw would be nondeterministic across node versions and could stall the view. Instead: ops are flagged in a **writer/seq-keyed** namespace that requires no successful decode:

```
flag/rejected/<writerKey>/<seq>  →  { reason, rawHashHex }
reason ∈ { undecodable, oversize-subject, oversize-op, depth-exceeded, unknown-msgid,
           policy-namespace, policy-rate, policy-governance, kindmismatch, garbage-base,
           revoked, bad-id, unsupported-container, unsafe-path, flag-not-clearable }
```

Because the writer key and a per-writer ordinal (§8.2) are available **before** payload decode, every attempted op is flaggable, closing the I4 hole. Verify against the current autobase API that a per-writer sequence/index is actually exposed on the apply node. If the current Autobase node exposes no per-writer ordinal inside apply, key all `<seq>`-bearing families (`flag/rejected/`, `n/hold/`, and every namespace/rate rejection) by the view-maintained per-writer **seen-count** `seen/<W>` (a top-level key family outside `ctx/`, §4/§8.2; incremented for every node from `W` regardless of disposition), never by the *applied* count `ctx/gov/clock/<W>`. Record the resolution in DEVIATIONS.md.

Hard limits MUST be defined and enforced as early as decoding permits: subject ≤ 1024 bytes, single op payload ≤ 64 KiB, literal nesting depth ≤ 64. Limits are checked in a fixed order and the **first** violated determines the single recorded reason: (1) `oversize-op` (total payload > 64 KiB — the only truly pre-decode check), (2) `unknown-msgid`/`undecodable`, (3) `depth-exceeded`, (4) `oversize-subject`. This ordering is normative because the recorded reason is view-observable (I2). Ops exceeding a limit are rejected under `flag/rejected` and never mutate `n/`. (Content constraints on subjects and paths — traversal safety — are specified in §9.4.)

### 8.5 Rate ceilings and flag flooding

Because all effects flow through apply, enforcement in apply is airtight against a writer that bypasses client code — but a policy op in the same log cannot preempt a burst that linearizes before it. Therefore:

- Rate ceilings MUST have a **default that applies to every writer from its first op**, independent of any explicit policy op. The window MUST be defined in **writer-local** terms so that the accept/reject decision for `W`'s op depends only on `W`'s own op stream and prior accepted state, not on interleaving: `apply` maintains, per writer, a token bucket replenished by **accepted ops from indexer writers** observed in the linearized stream (rate: R tokens per indexer op, capacity C, both vault metadata constants); each of `W`'s ops consumes one token, and an op arriving to an empty bucket is rejected (reason `policy-rate`). Because indexer-op counts at each position are themselves a pure function of the linearized prefix, the partition remains a pure function of linearized order; and because a reorg cannot change the *multiset* of ops, only their order, the bucket bound degrades gracefully: I10's stability claim for rate rejections is scoped to the region at or below `signedLength` (where order is final by construction). A naive "≤ N ops per K global linearized positions" window is forbidden: which ops fall in such a window depends on interleaving, so the applied/rejected partition would flip under legal reorgs.
- Ops beyond the ceiling are rejected under `flag/rejected/<W>/<seq>` (reason `policy-rate`), and a rejected op writes **one** rejection record, not a per-target flag, bounding view growth to O(rejected-ops) with a tiny constant.
- Dangling-flag coalescing (§7) bounds the other flooding surface.
- An explicit indexer `SetWriterPolicy` op may only *tighten* below the default; it is never a prerequisite for protection.

### 8.6 Namespace governance

`SetWriterPolicy { key, namespacePrefixes: [string], rateCeiling: int }` is a governance op (issuer must be an indexer, §8.0). `apply` stores it under `ctx/gov/writer/<key>` (preserving the record's `indexer` bit) with **LWW-under-linearization** merge (governance is intentionally centralized; the last indexer decision wins, and the loser is auditable via `flag/govoverride/<key>`). A writer `W` may only mutate a subject whose NFC-normalized name matches one of `W`'s `namespacePrefixes` (empty ⇒ unrestricted, for indexers/humans); a violating op is rejected under `flag/rejected/<W>/<seq>` reason `policy-namespace`. Prefix matching is defined on **path segments** after NFC normalization: prefix `p` matches subject `s` iff `s == p` or `s` starts with `p + '/'` (byte-prefix matching is forbidden: `agents/alice` MUST NOT match `agents/alicecooper`). Two indexers disagreeing resolve by linearization; document that namespace policy is deliberately **not** a mergeable CRDT because it is a security boundary. The I10 test suite MUST include: an agent op outside its namespace never mutates `n/`.

## 9. Materialization and ingestion

### 9.1 Materialize

`materialize(dir)`: walk `n/` and `ctx/`, emit an Obsidian-compatible vault: YAML-LD frontmatter from field state, body from head revision, `context.jsonld` from `ctx/`. Field-to-YAML ordering MUST be canonical (sorted) so materialization is byte-deterministic for a given view; YAML scalar rendering uses the canonical literal forms of §10.2, never the YAML library's default float/date rendering.

`materialize` MUST walk `n/<s>/f/*` including terms with no `ctx/` mapping and emit them into frontmatter under their original key (they were authored; they round-trip on the Markdown face), MUST emit host-tool keys from `n/<s>/host/*` (§5.6), MUST emit `id:` from `n/<s>/id` (§5.8), and MUST suppress subjects carrying a `n/<s>/deleted` tombstone (§9.2). Every file write is subject to the path-safety rules of §9.4.

### 9.2 Ingest

A file watcher ingests human edits: parse the changed file (NFC-normalizing file names per §3.1), diff frontmatter against view state per field, diff body against head revision, emit the minimal op set. Never emit a whole-file op. Host-allowlist keys (§5.6) are stored under `n/<s>/host/<key>`, not emitted as field ops, and never flagged.

**Wiki-link grammar.** Ingest parses `[[...]]` per vault-ld §4.4.1: the alias part is ignored for resolution, a fragment is discarded (with optional warning), and a path disambiguates same-named notes. Ambiguity is detected by **apply**, not ingest: apply writes `flag/linkambiguous/<s>/<term>/<target>` when, at the link op's linearized position, more than one non-deleted subject mints-or-declares the target IRI and the link carries no path qualifier (§5.8 `flag/idcollision` covers the identity collision itself). Ingest MAY emit a path-qualified target to pre-resolve, but MUST NOT itself decide ambiguity, since view state is authoritative and evolves under linearization.

**Removal and deletion.** A removed frontmatter line is expressed as `UnsetField { s, p, tag }` (§3.2): `apply` clears the lww register / removes the term's field state; cross-writer removal of a present value is flagged per §5.4. A removed file is expressed as `DeleteSubject { s, tag }`: `apply` writes an `n/<s>/deleted` tombstone that suppresses the subject from `materialize`, `idx/*`, `bl/*`, and export while retaining body revisions until pruned (§11); a later op re-creating `<s>` clears the tombstone and is flagged `flag/undelete/<s>` for audit. Ingest emission of `DeleteSubject` is subject to a configurable "deletions require confirmation" guard, since a dropped file may be accidental. Deletion is LWW under linearization; a write concurrent with (linearized after) a deletion writes `flag/writeafterdelete/<s>/<tag>` (I4). Two implementers MUST NOT invent alternative conventions (e.g. `SetField` with a null/magic value); these two ops are the only removal vocabulary.

### 9.3 Path capture and placement

The ingest watcher captures each note's authored context-relative path (NFC-normalized) by emitting `SetPath { s, path }` (§3.2); `apply` stores it in `n/<subject>/path` (LWW under linearization; cross-writer supersession flagged per §5.4). The view is written only by `apply` folding ops, so the path MUST travel as an op — no component writes `n/` directly. `materialize` MUST write each note to `n/<s>/path` when present, else to the vault-ld default reconstructable location (unpinned instance at context root; schema placement per §10.1 and vault-ld §5.1). On ingest, a `vld:path` triple is consumed into a `SetPath` op and never stored as a field (vault-ld §5.5).

### 9.4 On-disk safety

The spec's clobber rule (generated regeneration must not destroy authored prose) is satisfied structurally *for the view*: bodies live in the view; regeneration is a pure projection. On-disk safety is a separate, explicitly-handled concern:

- **Path safety (normative).** Subjects and paths are attacker-controlled strings. Before writing any file, `materialize` MUST validate that the NFC-normalized, resolved absolute target path is lexically contained within the vault root: no `..` segment escapes, no absolute-path override, no symlinked parent that resolves outside root (resolve with `fs.realpath` on the parent directory and re-check containment). A subject name or `path` value that (a) contains a path separator in the subject position, (b) escapes root, (c) is an absolute path, or (d) collides case-insensitively with another note on a case-insensitive filesystem, causes `materialize` to skip the file and record `flag/unsafepath/<s>` (I4). `apply` additionally rejects a `SetPath` whose value escapes root (reason `unsafe-path`, §8.4 enum). The reference implementation MUST include an adversarial test: an op naming `../escape` is contained and never writes outside root on any peer. (Without this, a single op is an arbitrary-file-write primitive on every materializing replica.)
- `materialize` MUST write atomically (write to a temp file, `fsync`, `rename`) and MUST skip files with unsaved external modifications (compare on-disk mtime/hash against the last-materialized hash; if changed, treat as an ingest event first). The per-path in-flight lock MUST be held across the mtime/hash check **and** the rename, with a re-stat under the lock immediately before rename, so the check-then-rename pair is not a TOCTOU window.
- The watcher MUST debounce and read only after write-settle (size stable for one interval) and MUST ignore files currently being written by `materialize` (the same per-path in-flight lock).
- Document in the README that clobber-immunity is a view property; filesystem races are handled by the mechanisms above.

## 10. Export

### 10.1 Layer partition, scopes, and `@base`

vault-ld decides export layer by *folder*, which the op log deliberately discards; layer is therefore graph-relevant metadata and MUST be materialized into the view. Maintain a per-subject record `n/<subject>/layer` ∈ `{schema, data}`, derived deterministically. A subject's layer is derived, in priority order: (1) if `n/<s>/path` is present, `schema` iff the authored path's top segment is `Ontologies/` or `Vocabularies/` (vault-ld §5.4 step 5, §5.1), else `data` — this reproduces vault-ld's normative folder partition exactly; (2) absent a path, `schema` iff the `@type` element set (§5.8) contains a recognized meta-type (`owl:Ontology|owl:Class|owl:ObjectProperty|owl:DatatypeProperty|rdfs:Class|rdf:Property|skos:ConceptScheme|skos:Concept`); (3) else `data`. Record in DEVIATIONS.md that folder-based partition is honored only when an authored path is present, and that type-based inference is a documented fallback that MAY diverge from a folder-only vault-ld tool for locally-typed schema notes. `exportTurtle(dir)` produces `schema.ttl` and `data.ttl` by range-scanning `idx/spo`, partitioned by this record.

**Scopes and `@base` (normative).** vault-ld mints IRIs from the governing `@base` (nearest context at or above the note's folder; each referenced ontology context declares the `@base` for its own namespace). The log has no folders, so scope must be declared and bound explicitly:

- The op `DefineScope { scope, base, prefix }` (§3.2; same authority as `DefineTerm` — content, not governance) declares a scope's `@base` and Turtle prefix. `apply` stores `ctx/scope/<scope> = {base, prefix}`; redefinition follows §5.5 shadowing rules.
- `DefineTerm.def` MAY carry `scope` membership for the term.
- **Subject-scope binding.** A subject's governing scope is (a) the scope of its authored path's nearest context when `n/<s>/path` is present (computed at ingest and carried on the `SetPath` op), else (b) the scope that defines the subject's primary `@type` term when that is unambiguous, else (c) the data namespace (root `@base`). The binding is stored in `n/<s>/base` at apply time by these rules and re-evaluated only by ops that change its inputs, so it is deterministic.
- `materialize` places a schema note with scope `S` at `Ontologies/<S>/Classes|Properties/<name>.md` per vault-ld §5.1. The noscope demotion applies to **pathless subjects only** (those whose layer came from priority (2) of the layer rule above): a pathless schema subject with **no derivable scope** is placed under the data root with `layer = data` and `flag/noscope/<s>` is written (I4). A subject **with** an authored `Ontologies/`/`Vocabularies/` path keeps `layer = schema` from priority (1) even when its scope is underivable — `flag/noscope/<s>` is still written, its placement follows its authored path (§9.3), and its IRI minting falls back to the data namespace (root `@base`) per subject-scope binding rule (c).
- An explicit `@id` (§5.8) overrides scope-based minting entirely.

Record in DEVIATIONS.md that scope binding uses the (b)/(c) inference when no authored path exists, and that a pathless schema subject lacking a recognized meta-type defaults to `data` (the layer-derivation deviations themselves are recorded per the rule above).

### 10.2 Canonical literal forms

Output MUST be byte-deterministic; two peers with converged views MUST produce identical bytes. Literals MUST be stored and emitted in canonical lexical form: `xsd:integer` with no decimal point or leading zeros; `xsd:decimal`/`xsd:double` per the XSD canonical mapping (never platform `toString`); `xsd:dateTime`/`xsd:date` in canonical ISO-8601 with explicit `Z`; booleans as `true`/`false`; strings NFC-normalized (§3.1) with Turtle escaping applied in a fixed codepoint order; language tags lowercased. Turtle prefix order, subject order, predicate order (by IRI byte value), and object order (by term byte value) are all fixed ascending. YAML materialization emits scalars via the same canonical mapping. This is an I1/I9 requirement.

### 10.3 Unmapped terms

`exportTurtle` MUST NOT emit unmapped terms as triples (no predicate IRI exists), matching vault-ld, but MUST NOT lose them: they persist on the Markdown face (§9.1) and in the view. Every write of `flag/unmapped/<s>/<term>` MUST also write `unmapped-idx/<term>/<s>`, so that backfill is a bounded range scan over `unmapped-idx/<term>/*`, never a full `n/` walk (a full walk per `DefineTerm` would make repeated `DefineTerm` a cheap apply-time DoS within the rate ceiling). When a later `DefineTerm` supplies a mapping, `apply` MUST re-scan the term's `unmapped-idx/` range and backfill `idx/*` and `bl/*` in the same pass, then clear the corresponding `flag/unmapped` and `unmapped-idx/` entries. (Host-key promotion additionally migrates `n/*/host/<key>` per §5.6.) The I8 test suite MUST include: a deferred `DefineTerm` makes previously-unmapped values index-visible.

### 10.4 `vld:path` roundtrip

`exportTurtle`, when producing a **roundtrip** face, MUST emit `vld:path "<path>.md"` for every note whose `n/<s>/path` differs from its reconstructable default, and MUST omit it for defaults and for query-only exports (config flag `roundtrip: bool`). Ingest consumption of `vld:path` is specified in §9.3. This is required for the "opens cleanly in Obsidian" + roundtrip acceptance criteria.

## 11. Compaction, snapshots, and retention

v1 accepts monotonic log growth, and the README MUST state the accepted cost in writing with worked numbers (e.g., 50 agents × 500 ops/day ≈ 9.1M ops/year of never-collected input-core blocks; at 10% `SetBody` averaging 4 KB, ≈ 3.6 GB/year of retained body revisions). Naive log truncation is unsafe below `signedLength` because Autobase relinearizes from history.

Mitigations, normative in v1:

- **Snapshots.** At `signedLength` checkpoints, indexers MAY publish a signed **view snapshot** (a Hyperbee checkout hash) so new peers bootstrap from the snapshot rather than replaying the whole log; ops below the snapshot's `signedLength` become archival. A snapshot MUST be co-signed by a quorum of the indexer set **as recorded in `ctx/gov` at the snapshot's `signedLength` checkpoint** (not the current indexer set; a single indexer's signature is insufficient). A bootstrapping peer MUST (1) verify the snapshot hash chains to a quorum-signed system-core checkpoint, and (2) verify the co-signers were confirmed indexers in `ctx/gov` at that checkpoint's linearized position. This closes the removed-indexer replay: a key removed after the checkpoint cannot retroactively co-sign, and a key added after cannot either.
- **Revision pruning.** Body revisions MUST support the `PruneRevisions { s, before: revHash }` op (§3.2, governance op per §8.0), which removes non-head revisions older than the cutoff except those referenced by an open `flag/conflict`. Revisions superseded by a `ResolveConflict` (§6) become prunable. Pruning is itself a logged op so it is deterministic and auditable (I1/I4).
- DXOS-style epochs are the documented future direction for full log compaction.

## 12. Invariants (numbered; the test suite and the review prompts reference these)

- **I1 Determinism:** apply is a pure function of the linearized op sequence. No wall clock, no randomness, no map-iteration-order dependence, no floating-point formatting variance, no Unicode-normalization variance (§3.1), no throw-on-malformed-op variance (§8.4), no reads of peer-local replication state (`signedLength`, `heads()`) inside apply (§8.3).
- **I2 Convergence:** any set of peers that have exchanged all ops produce bit-identical views (verified by hashing a full range scan).
- **I3 Rebuild equivalence:** a view rebuilt from scratch from the same log equals the incrementally maintained view.
- **I4 No silent loss:** no op's effect disappears without a flag. Unmapped, dangling, shadowed, conflicting, kind-mismatched, kind-collapsed (§5.5), stale-tag, clobbered (cross-writer LWW supersession, §5.4), epoch-divergent, id-colliding (§5.8), unsafe-path (§9.4), deleted-then-written (§9.2), undecodable/oversize (writer/seq-keyed, §8.4), and policy-rejected effects all leave `flag/` records.
- **I5 OR-set law:** concurrent add and remove of the same member converge to the member present (add wins over remove of unobserved tag), under the citation contract of §5.3.
- **I6 LWW law:** for a fixed linearized log, scalar outcome depends only on linearized order, never on arrival order at any peer. Where a term's kind changes across a reorg and an op omits `ctxKind`, the op is reinterpreted per the kind at its linearized position (deterministic but epoch-sensitive, §5.7); this is auditable via `flag/epoch` only when `ctxKind` is present. Agent writers SHOULD carry `ctxKind` to make the outcome authoring-stable.
- **I7 Flag lifecycle:** dangling flags clear when targets materialize (both same-IRI and retargeted takeover, §7); conflict flags persist until an explicit resolving op (`ResolveConflict`, §6); audit flags are drainable via `ClearFlag` (§6); structural flags reject `ClearFlag`.
- **I8 Index coherence:** `idx/*` and `bl/*` are always consistent with `n/*` within a single view state, including after deferred-`DefineTerm` backfill (§10.3), host-key promotion migration (§5.6), and kind-changing redefinition migration (§5.5).
- **I9 Export determinism:** converged peers emit identical `.ttl` and identical materialized vaults (canonical literal forms, §10.2).
- **I10 Governance:** ops from removed writers after the causal revocation point (§8.3), unacked optimistic ops (§8.2), governance ops from non-indexers (§8.0), and policy-violating ops (namespace, rate, limits) never mutate `n/` (other than `n/hold/`), `ctx/`, or `idx/`; the applied/rejected partition is reorg-stable for revocation (§8.3), optimistic gating (§8.2), governance authority (§8.0), namespace and size-limit policies, and — for the region at or below each peer's current `signedLength`, which is peer-local and advances monotonically to a common value — for rate policy (§8.5). Above `signedLength` the rate partition MAY differ between peers until the checkpoint advances, at which point the frozen region's partition is identical on all peers.

## 13. Non-goals (v1)

- No text CRDT for bodies. No `@container: @list` (ordered containers; a `DefineTerm` declaring one is rejected per §5.1). No fine-grained per-writer read ACLs beyond the shared `encryptionKey`. No HTTP API. No SPARQL engine (the triple indexes exist; a query layer is future work). No Obsidian plugin. No full log compaction (snapshots and revision pruning per §11 only).

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

The README's novelty section MUST state the narrowed claim: the contribution is neither per-predicate CRDT selection (SU-Set/C-Set; m-ld single-valued constraints; ECHO/ComposeDB schema-driven typing) nor a new CRDT. It is the specific reflexive composition: the `@context` that selects OR-set-vs-LWW *per predicate* is **itself an ordinary content object in the very same single-total-order Autobase op log, folded by the very same deterministic `apply`, under the very same multi-writer governance and merge rules as the data it governs** — so schema evolution and data evolution share one linearization and one determinism proof, at the cost of epoch-sensitivity (§5.7). Unlike m-ld (constraints are engine config) and ECHO (schema is a semver'd, separately-governed registry with explicit migration epochs), here the policy table has no privileged channel: it is data. The README MUST additionally state plainly that this novelty is an **engineering composition** (SU-Set semantics + Autobase linearization + in-log mutable context), not a new CRDT or a new merge theory.

Node.js 20+, plain JavaScript matching Holepunch ecosystem conventions (verify current CJS/ESM convention from the autobase repo and follow it). Brittle/bare compatibility SHOULD be preserved where cheap.

## 15. Acceptance

The build is complete when:

- every invariant I1..I10 has a passing test, including: the triple-replay revocation test (incremental / from-scratch / forced-reorg identical partitions, §8.3); the non-indexer governance-op rejection test (§8.0); the reorg-stability test for namespace policy (§8.6); the dual takeover test for I7 (§7); the backfill test for I8 (§10.3); the kind-changing-redefinition test for I8 (§5.5); and the adversarial `../escape` path-containment test (§9.4);
- `materialize` output opens cleanly in Obsidian;
- `exportTurtle` output parses with a standard Turtle parser and partitions into `schema.ttl`/`data.ttl` per §10.1;
- a roundtrip export/ingest cycle preserves note placement via `vld:path` (§10.4);
- a human deletion of a frontmatter field and of a whole note survives a full ingest → converge → materialize cycle (the deletion is not resurrected, §9.2);
- and a three-writer demo (two simulated agents, one human ingest path) converges after partition and heal.
