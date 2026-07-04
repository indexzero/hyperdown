# @hyperwiki/core

Core package of the Vault-LD-on-Autobase system (SPEC-FINAL §14): the op wire
contract, the deterministic `apply` function, the view keyspace codec,
canonical string/literal forms, and the body revision hash. Everything here is
**pure**: `apply` operates only on the view interface autobase hands it — no
wall clock, no randomness, no reads of peer-local replication state such as
`signedLength` or `heads()` (I1; enforced by a source-scan test in the
invariant suite).

The op log is the source of truth (§2). This package folds the linearized op
stream into one keyspace-structured view (§4); materialization, ingest, Turtle
export, autobase wiring, and replication live in later packages.

## Public API

All exports come from `index.js` (also importable per-module via the
`exports` map, e.g. `@hyperwiki/core/apply`).

### Apply (`lib/apply.js`)

- `createApply(config) → async apply(nodes, view, host)` — build the
  deterministic apply function for a vault. `config.genesisKey` is required
  (§8.0 genesis indexer); see "Vault-metadata constants" below for the rest.
- `isSafePath(path) → boolean` — §9.4 lexical path containment (no `..`
  segments, no absolute paths, no backslashes, no drive letters).
- `namespaceMatches(prefixes, subject) → boolean` — §8.6 path-segment prefix
  matching (`agents/alice` matches `agents/alice/notes`, never
  `agents/alicecooper`); empty prefix list means unrestricted.
- `normalizeTermDef(def) → object|null` — canonical JSON-LD term-definition
  form used for §5.5 structural equality (string defs become `{'@id': …}`,
  keys sorted, `{'@id': null}` removes the mapping).

### Ops (`lib/ops.js`, wire format generated into `spec/`)

- `encodeOp(type, payload) → Buffer` — encode one of the 15 §3.2 op types
  (`'set-field'`, `'add-member'`, … `'prune-revisions'`) via the committed
  hyperdispatch/hyperschema code in `spec/`.
- `decodeOp(buf) → { ok: true, type, op } | { ok: false, reason }` — never
  throws garbage; failures map deterministically to the §8.4 reasons
  `'unknown-msgid'` / `'undecodable'`.
- `makeTag(writerKey, seq) → Buffer` / `tagHex(tag)` / `parseTag(tag)` —
  §3.2 opId construction (`writerKey || 8-byte BE seq`).
- `normalizeClock(clock) → { writerHex: seq } | null` — §3.2/§8.3 vector
  clock normalization (malformed ⇒ `null`).
- `OP_TYPES` (array), `GOVERNANCE_OPS` (Set of the four §8.0 governance ops).

### Keyspace codec (`lib/keyspace.js`, exported as `keyspace`)

Key builders for every §4 family (`nField(s, p)`, `nBody(s)`, `nRev(s, rev)`,
`nHold(w, ord)`, `ctxTerm(term)`, `govWriter(w)`, `idxSpo/Pos/Osp`, `bl`,
`unmappedIdx`, `flag(family, …comps)`, …) plus `esc`/`unesc`, `parseKey(key)`,
`range(prefix)` for prefix scans, and `pad(ord)` for fixed-width ordinals.
Escaping is mandatory (§4): user components round-trip losslessly, so a
subject named `../escape` or `a/b` can never escape its key family (§9.4).

### Canonical forms (`lib/canonical.js`, exported as `canonical`)

`nfc`, `canonicalInteger`, `canonicalDecimal`, `canonicalDouble`,
`canonicalDateTime`, `canonicalDate`, `canonicalLang`, `canonicalLexical`,
`canonicalValue`, `canonicalArray` (sorted + deduped §5.1 register arrays),
`byteForm` (the §10.2 total-order sort key), `valuesEqual`, `sortValues`,
`valueDepth`, `stableStringify`. XSD canonical mappings, never platform
`toString` (§10.2); NFC before any key/IRI/hash use (§3.1).

### Revision hash (`lib/revhash.js`)

- `revHash(base, text) → hex` — the fixed §6 construction
  `SHA-256(len(base) || base || len(text) || utf8(NFC(text)))`, lowercase hex;
  `base` is a 64-char lowercase-hex revHash or `null`.
- `rawHashHex(buf) → hex` — SHA-256 of raw op bytes for §8.4 rejection records.

### MemView (`lib/memview.js`)

- `new MemView()` — in-memory view used by the unit suite; also the executable
  documentation of the **view-interface contract** `apply` expects.

## View-interface contract

`apply(nodes, view, host)` is called by autobase with linearized nodes shaped
`{ from: { key: Buffer }, value: Buffer }`. It requires of `view` exactly the
hyperbee surface MemView implements:

- `await view.get(key) → { key, value } | null`
- `await view.put(key, value)` / `await view.del(key)`
- `view.createReadStream({ gt, gte, lt, lte, reverse, limit })` — async
  iterable of `{ key, value }`, keys in UTF-8 byte order (matching a Hyperbee
  with utf-8 keys), values JSON-round-tripped (matching `valueEncoding:
  'json'`).

`host` needs `addWriter(key, { indexer })` and `removeWriter(key)` (guarded by
`host.removeable(key)` when present); both are only ever invoked for
governance ops that passed the §8.0 authority check. MemView additionally
provides `hash()` (full-range-scan view hash, the I2 convergence check) and
`dump(prefix)` for tests.

## Policy-epoch caveat (§5.7 — read this)

Merge policy is read from the composed context in the view (`ctx/`) **at apply
time**. A reorg that reorders a `DefineTerm` relative to dependent field ops
can therefore change the merged result. This is still deterministic — any two
nodes with the same linearized log produce identical views — but it can be
semantically surprising: the same op may merge as an LWW register in one
linearization epoch and as an OR-set add in another. The opt-in mitigation is
**kind pinning**: `SetField`/`AddMember`/`RemMember` may carry
`ctxKind: 'scalar' | 'set'`, the kind the writer resolved against. When the
cited kind differs from the kind resolved at the op's linearized position, the
op is applied under the **cited** kind and `flag/epoch/<s>/<term>/<tag>`
records `{ citedKind, applyKind }` so the reinterpretation is auditable.
Pinning costs two bytes per op and should be the default for agent writers.

## Vault-metadata constants (downstream packages must pin these)

Every peer of a vault must run `createApply` with identical values; they are
convergence-relevant inputs (I2) and belong in vault metadata:

| key | default | role |
| --- | --- | --- |
| `genesisKey` | (required) | vault creator's key, seeded as the initial indexer into `ctx/gov` on first apply (§8.0) |
| `rootBase` | `'vault://data/'` | data-namespace `@base` for name-based and dangling IRI minting (§7, §10.1) |
| `hostAllowlist` | `['tags', 'aliases', 'cssclasses']` | §5.6 host-tool keys; append-only across a vault's life except via in-log `DefineTerm` promotion |
| `rate.tokensPerIndexerOp` (R) | `1` | §8.5 bucket replenishment per accepted indexer op |
| `rate.capacity` (C) | `1024` | §8.5 bucket capacity; explicit policy may only tighten below it |
| `rate.holdMax` (H_max) | `64` | §8.2 hold-buffer cap for never-acked writers |
| `limits.maxSubjectBytes` | `1024` | §8.4 |
| `limits.maxOpBytes` | `65536` | §8.4 |
| `limits.maxDepth` | `64` | §8.4 |

## Wire contract

The op encodings under `spec/` are generated by `schema/build.js`
(`pnpm run build:schema`) and are **append-only for the life of a vault**
(§3.3): message ids and field orders are pinned by the committed
`dispatch.json`/`schema.json`; never reorder or remove structs, fields, or
commands — add new ops as new commands and keep deprecated decoders forever.

## Deviations and tests

Every deviation from SPEC-FINAL, including the §8.2/§8.4 per-writer ordinal
resolution (`seen/<W>` seen-count), the §10.1 layer/scope inference notes, the
keyspace layout resolutions, and two UNVERIFIED items, is recorded with
justification in [`../../DEVIATIONS.md`](../../DEVIATIONS.md).

The invariant unit suite (I1..I10, §12) lives in
[`../../test/`](../../test/) and runs with `pnpm test` from the repo root
(node core test runner). It drives `apply` directly with scripted op
sequences over `MemView`; the multi-process autobase harness is a later
phase.
