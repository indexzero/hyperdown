---
status: "Normative build instruction"
version: "1.11"
date: "2026-10-28"
contract: "~/Git/indexzero/0x/slop/intent/autokf.intent.md"
on_conflict: "The intent wins, and this document is corrected."
---

# auto-okf: Implementation Specification

This document states every rule of auto-okf. The RFC 2119 keywords MUST,
MUST NOT, SHOULD and MAY apply. This document implements the confirmed
intent that the `contract` key above names.

---

## 0. Role and ground rules

**auto-okf** is a multi-writer store for
[Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
bundles, built on **autobee**. Its writers include autonomous AI agents.
A single-writer design is out of scope.

Precedence rules:

1. If this document conflicts with the OKF `SPEC.md` (v0.1) on the
   **emitted bundle format**, OKF wins. Conformance (OKF §9) judges only
   the emitted tree. This document defines everything internal.
2. If this document conflicts with the autobee README or source on an
   **API signature**, autobee wins. Fetch and verify before use. The
   autobee README says "Expect breaking changes".
3. **Autobase is forbidden**: no dependency, no import, and no document
   that frames okf in autobase terms.
4. Every deviation from this document goes to `DEVIATIONS.md`, one
   paragraph per deviation. Where this document is silent, the
   implementation states its choice in a code comment, with its source.

The Vault-LD implementation, `./vault-ld`, shares this repository.
**Copy, don't depend**: `@auto-okf/*` packages MUST NOT import from
`@autovault-ld/*`. okf copies three deterministic modules, each with a
header that names its source: `keyspace.js`, `canonical.js` and
`revhash.js`. Everything else is written new.

## 1. Primary sources (required reading, in order)

- OKF `SPEC.md` v0.1 (local:
  `~/Git/GoogleCloudPlatform/knowledge-catalog/okf/SPEC.md`). It defines
  the bundle structure, concept documents, frontmatter, cross-linking,
  the index and log files, and conformance. It is normative for
  everything that materialize emits.
- The autobee README **and source** (`https://github.com/holepunchto/autobee`).
  The store pins autobee at exactly `2.12.1` in `okf/store/package.json`
  (test: "the store pins autobee at exactly 2.12.1" in
  `okf/store/test/pins.test.js`). autobee is a standalone multi-writer
  Hyperbee on hyperbee2 and hypercore 11, with no autobase dependency. A
  path such as `lib/topo.js` is relative to the autobee package root.
  `DEVIATIONS.md`, "Substrate behaviour that okf relies on", states why
  okf relies on each behavior below, and which parts the README does not
  document. okf uses this surface of autobee:
  - Constructor: `new Autobee(store, key, handlers)`. The store passes
    `apply`, `open`, `update`, `encryptionKey`, `encrypted`, `keyPair`,
    `optimistic: false`, `bootstrapWeight: 0` and `fastForward: false`.
    The README does not list `bootstrapWeight` or the value `false` of
    `fastForward`. The `Autobee` constructor in `index.js` reads both.
  - apply: autobee calls `apply(nodes, view, host)`, in `ApplyView.apply`
    in `lib/apply-view.js`. apply receives only the nodes with a
    non-empty value (`_applyBatch` in `index.js`). A node carries
    `{ key, value, length, ... }` (`createNode` in `lib/writers.js`).
    `node.length` is the length of the writer's core after the node, so
    `node.length - 1` is its position (§3).
  - view: `view` is what the `open` handler returns (`ApplyView.open`).
    The store returns an adapter over the hyperbee2 bee. The adapter has
    `get`, `write()` batches of `tryPut`, `tryDelete` and `flush`, and
    `createReadStream`.
  - host (`ApplyCalls` in `lib/apply-calls.js`): core calls only
    `host.addWriter(key, { weight: 0 })` (§8). The README lists only the
    `isIndexer` option for that call. `weight` is an option of
    `ApplyCalls.addWriter`.
    `host.ackWriter` is a deprecated no-op. okf uses no other host call.
  - instance: `db.key`, `db.discoveryKey`, `db.id`, `db.local`,
    `db.view`, `db.writable`, `append(value)`, `update()`, `updated()`,
    `flush()`, `replicate(isInitiator | stream)` and
    `db.wakeup({ key, length })`. The store calls `db.wakeup` at open for
    each key with a `gov/writer` record. okf also uses `ready()` and
    `close()` from ready-resource, and the `error` event. okf reads no
    undocumented autobee property.
- The hyperbee2@2.20.1 source, for the range iteration surface. Verify
  it. Do not assume the `createReadStream` signature of classic hyperbee.
  okf uses `get`, `write()` with `tryPut`, `tryDelete` and `flush`, and
  `createReadStream`.
- The corestore README. The corestore pin is exactly `7.16.1` in
  `okf/store/package.json` (test: "the store pins corestore at exactly
  7.16.1"). The floor is 7.12.6, the first release that honors a
  `manifestVersion` for one core (`_auth` in the corestore `index.js`).
  autobee asks for its system core and its view core at manifest version
  3 (`_getCorePreload`, `DEFAULT_MANIFEST_VERSION`). Its view encryption
  refuses a view core below version 3 (`AutobeeEncryption.encrypt` in
  `lib/encryption.js`). `DEVIATIONS.md` records the evidence.
- The hyperswarm README. The hyperswarm pin is exactly `4.17.0` (test:
  "the store pins hyperswarm at exactly 4.17.0"). The store reads
  hyperswarm state that the README does not document. See "Replication"
  in `okf/store/README.md`.

## 2. Architecture: the log is the source of truth

- **Source of truth:** the autobee op log, with one input core per
  writer.
- **Generated projections:** (a) the OKF bundle on disk: markdown with
  frontmatter, `index.md` and `log.md`. (b) The view: concepts, links,
  `wanted/` and flags.
- No component treats a generated projection as authoritative. Human
  edits to the bundle re-enter as ops (§9). A converged view can always
  regenerate the bundle, byte for byte (I9).

## 3. Op schema

Every write is a semantic op that a writer appends to its own core. The
encoding is hyperschema, hyperdispatch and compact-encoding. The wire
contract is append-only for the life of a vault: no message id and no
field order is ever reordered or removed. The generated codec is
committed under `spec/`.

```
CreateConcept { id?, path, type }                 // id absent = mint, id present = adopt (§6)
SetField      { id, key, value }                  // LWW-array register (§5)
AddTag        { id, value }                       // OR-set add on `tags`
RemTag        { id, value, tags: [tag, ...] }     // OR-set remove by observed tags
SetBody       { id, base: revHash | null, text }  // immutable revision (§5)
SetPath       { id, path }                        // rename: LWW register (§7)
DeleteConcept { id }                              // tombstone only (§8)
UndeleteConcept { id }
ResolveConflict { id, keep: revHash, supersede: [revHash...], text? }
AddWriter     { key, indexer: bool, swarmKey? }   // governance (§8)
RemoveWriter  { key }
SetWriterPolicy { key, namespacePrefixes, rateCeiling }
```

### The clock and `at`

Every op carries `clock`, the writer's observed vector clock, in the op
payload. Causal revocation needs it (§8). Each entry is a position
(below). The clock carries the self entry, which is the op's own
position, and one entry for each writer that §8 names. Such an entry is
that writer's last position in the issuer's folded view: its `seen/`
value minus one. The store builds every entry from okf's view and its own
local core, and reads no autobee head.

Every op carries `at`: the writer's wall-clock milliseconds at append
time, in the op payload. `at` is informational. It is never an input to
merge, ordering or conflict detection (I1). It is the sole source of the
`log.md` date headings (§9) and of the `rev` record's `at` (§4, §5).
Apply MUST NOT read any clock. A missing or garbage `at` is no rejection:
it materializes as `1970-01-01`.

### The tag and the seq

`tag` (opId) is `writerKey || seq`, the OR-set observation token and the
audit handle. apply **derives** it from the node (`node.key`, actual
seq). apply never reads it from the payload, and no op encodes its own
tag. Only `RemTag.tags` and the `keep` and `supersede` of
`ResolveConflict` carry tags or hashes of *other* ops. Those are
citations.

**The per-writer ordinal is the node's position.** The actual seq of a
node is its 0-based position in its writer's core: `node.length - 1`. The
position is unforgeable, the same on every peer, and stable under
reorders. Apply MUST take the seq from the position for every node,
whatever its disposition. The position gives the seq for the `tag`, for
`flag/rejected/<writerKey>/<seq>`, for the §6 mint, and for the §8
position rules (`seqAtRemoval`, `forged-clock`).

Apply records the last position plus one in `seen/<writerKey>` (§4). A
node that never reaches apply, such as an empty block, still takes a
position. So the seqs of one writer's ops can have gaps, and
`seen/<writerKey>` can skip.

A node without a positive integer `length` breaks the autobee contract:
apply throws, and the node is never an op rejection. autobee then closes.

The writer's store takes the seq of a new op right before it encodes the
op. The seq is the length of its local core. When the node of its
previous append is not in the core yet, the seq is one past that append's
seq. The store serializes its appends. The seq never depends on how far
apply folded the local core. `DEVIATIONS.md`, "Substrate behaviour that
okf relies on", states why the length gives the next position.

### Normalization and limits

Every string is NFC-normalized before keying, hashing or comparison. The
copied `canonical.js` is the code.

The limits have a fixed check order and a single recorded reason. Before
decode: an op is at most 64 KiB. After decode, in this order: a path is
at most 1024 bytes, and its depth is at most 64. apply rejects an
undecodable or oversize op into `flag/rejected/<writerKey>/<seq>`. apply
MUST NOT throw.

## 4. View keyspace

The view is one keyspace, encoded with the copied `keyspace.js`. Escaping
is mandatory. No user string is ever concatenated raw into a key.

```
c/<id>/meta                     { type, created: tag, deleted?: tag }
c/<id>/f/<key>                  frontmatter field state (LWW-array or OR-set element map)
c/<id>/path                     current path { path, tag, ord } — ord is the
                                global apply ordinal (count of nodes linearized
                                so far) at which this path was set (§7, I8)
c/<id>/body                     head revision pointer (revHash)
c/<id>/rev/<revHash>            immutable revision { base, text, writer, at }
revbybase/<id>/<base>/<rev>     base-keyed revision index (no O(R²) scans),
                                a top-level bookkeeping family, derived
                                from c/<id>/rev/
path/<path>                     path -> id (current holder; collision losers flagged)
link/<from-id>/<to-path>        outbound links (extracted from body, §9)
bl/<to-id>/<from-id>            backlinks (resolved links only)
wanted/<path>/<from-id>         demand index: one key per unresolved referrer
                                (count = subkey count; NOT a flag — §9)
wantedrank/<inv-count>/<path>   derived rank index, rewritten on referrer-count
                                change (inv-count = (MAX − count) as a 16-digit
                                zero-padded decimal, MAX = 10^16 − 1, so an
                                ascending scan yields most-wanted first)
log/<ordinal>                   append-only narration records -> log.md (§9)
flag/conflict|clobber|staletag|pathcollision|writeafterdelete|undelete|rejected|squat/...
                                (no `copydetect` family: no op writes one —
                                ingest reports a copy as an event, §9)
seen/<writerKey>                last folded position + 1 (bookkeeping, §3)
gov/writer/<key>                { indexer, namespacePrefixes, rateCeiling, swarmKey? }
gov/removed/<key>               revocation clock + seqAtRemoval (§8)
rate/<writerKey>                token-bucket state
```

The bookkeeping families are `seen/`, `rate/`, `revbybase/` and
`wantedrank/`. The I2 view hash includes them, and materialize excludes
them.

The lifecycle of a flag depends on its family:

- `conflict` clears only through `ResolveConflict` (§5).
- `pathcollision` clears when the claim of the loser stops colliding
  (§7). apply recomputes this on the same events as the link resolution
  of §9.
- `clobber`, `staletag`, `writeafterdelete`, `undelete`, `rejected` and
  `squat` are permanent audit records. No op and no rule clears them.

## 5. Merge semantics: fixed defaults

okf has no per-key policy dial. The rules are frozen.

- **`tags`** (the OKF frontmatter key, and only it): **OR-set**.
  Concurrent adds union, and a `RemTag` cites every observed tag mapped
  to the value (the client computes them). The view keeps a
  removed-token set per (id, value). A citation of an already-removed
  token is a silent no-op, so concurrent removes of the same tag never
  flag. A citation of a never-observed token has no effect, and apply
  records it once under `flag/staletag/<id>/<value>/<tag>`. A concurrent
  add wins over a remove of the unobserved tag (SU-Set semantics, I5).
- **Every other frontmatter key**: **LWW-array register** under
  linearization order. A value is a canonical array, possibly of length
  1, and a new value supersedes it atomically. Length 1 materializes as
  one YAML scalar. An empty LWW state, such as after a `SetField` with an
  empty array, materializes as the key omitted from the frontmatter. A
  cross-writer supersession with a different value writes
  `flag/clobber/<id>/<key>/<tag>`, so the loser is auditable (I4).
- **Reserved field keys**: apply rejects a `SetField` whose `key`, after
  NFC, is exactly `tags`, `_id` or `_rev` (`flag/rejected`, reason
  `reserved-key`). Tag mutations travel only as `AddTag` and `RemTag`.
  Identity and revision are never fields (§6, and the ingest rules of
  §9).
- **`_id` and `_rev` are never merged**: `_id` is identity (§6), and
  `_rev` is derived output, never stored as a field.

### Bodies

Every `SetBody` creates an immutable revision keyed by
`revHash = SHA-256(len(base)||base||len(text)||utf8(NFC(text)))` (copied
`revhash.js`). `len()` is an **8-byte big-endian** length prefix (u64
BE), and the base is the 64-character lowercase hex string. A null base
encodes as `len(0)`, eight zero bytes, distinct from any real hash. This
text mirrors the copied code. On a discrepancy the copied code wins, and
`DEVIATIONS.md` records it.

The head pointer is LWW under linearization. Two revisions that cite the
same **non-null** base are siblings: apply keeps both, the head is
deterministic, and exactly one `flag/conflict/<id>/<a>/<b>` exists. Only
`ResolveConflict` clears it. A null base is "no base cited", so
independent creations do not conflict with each other.

**Base discipline** (I4):

- A `SetBody` whose `base` is null **while a head exists** at its
  linearized position cites that head. The only flag-free start is the
  concept's first revision.
- A `SetBody` that cites a base hash absent from `c/<id>/rev/` is stored
  and flagged `flag/conflict/<id>/<head>/<new>` against the current head.
  It never becomes head until a `ResolveConflict` selects it. So
  fabricated ancestry cannot silently displace real ancestry.
- With no current head, the flag is `flag/conflict/<id>/-/<new>`, and the
  concept materializes bodyless until a `ResolveConflict`.
- The unknown-base rule subsumes the same-base sibling rule. Each
  revision gets one flag against the head position. Revisions that cite
  the same unknown base get no pairwise flag.

**`ResolveConflict`** is valid only if `keep` and every `supersede` entry
exist under `c/<id>/rev/`, and at least one cited flag is open. Otherwise
apply rejects it (`flag/rejected`, reason `bad-resolve`). Its effect: the
head becomes `keep`, LWW-pinned at this position, and the cited
`flag/conflict` entries clear. With `text` present, apply synthesizes one
revision with `base = keep`, and that revision becomes head. A later
`ResolveConflict` over the same, now cleared, flags is rejected
`bad-resolve`. Resolution races converge by linearization: the first
valid resolve wins, and the loser is rejected.

### `type`

`type`, OKF's one required key, is an LWW-array like any other key.
materialize emits the first element as the scalar `type`.
`CreateConcept.type` seeds the `c/<id>/f/type` register at the create's
linearized position. `c/<id>/meta.type` is a bookkeeping copy of the
creation value, and materialize never reads it.

apply rejects a `SetField` on `type` whose value is an empty array or a
sole empty string (`flag/rejected`, reason `empty-type`). So no accepted
op makes the `type` state empty. `type: unknown` is a fallback that only
materialize uses, for corrupt state, and it writes nothing to the view
(§7).

## 6. Identity: `_id` and `_rev` (the CouchDB homage)

**`_id`** is the concept's stable identity. It is minted exactly once, it
is opaque, and it is never derived from a path or from content. `_id` is
unique per vault, and equality means the same concept and nothing else.
It survives deletion, because a tombstone keeps it.

- **Mint.** A `CreateConcept` with no `id` mints. The mint is the
  creating op's `tag`: `writerKey || seq` in hex, where `seq` is minimal
  lowercase hex with no leading zeros, and `0` for seq 0. When that id is
  occupied, the mint is the squat-fallback id below.
- **Adopt.** A `CreateConcept` that carries an `id` adopts it: an id that
  the vault never saw, which ingest supplies (§9, §10). Adoption is what
  keeps identity across a generation.
- **Seen-id rule.** apply **rejects** an adopting `CreateConcept` whose
  `id` is already present in `c/` (`flag/rejected`, reason
  `duplicate-id`). Creation never updates. `duplicate-id` applies only to
  adoption.
- **A squat cannot block a mint.** A minting `CreateConcept` whose
  derived id is already present in `c/` is not rejected. apply mints
  `SHA-256(writerKey || seq || k)` instead, for the smallest `k >= 1`
  that gives an unseen id. The input is the raw 32-byte writer key, the
  seq as u64 LE and `k` as u64 LE, and the output is 64 hex. apply
  records the permanent audit flag `flag/squat/<squatted-id>/<tag>`. So a
  genuine writer's creation always succeeds, and a squatter spends one op
  per candidate and always loses.
- **Existing concepts.** Only `SetField`, `AddTag`, `RemTag`, `SetPath`,
  `SetBody`, `DeleteConcept`, `UndeleteConcept` and `ResolveConflict`
  mutate an existing concept. apply policy-checks each against the
  concept's **current** path, never an op-claimed path.

Adopted ids MUST match `^[0-9a-f]{2,128}$` after NFC. A mint id is
`writerKey || seq`, both public, so it is predictable. For that reason
apply rejects two adoptions as `mint-collision-risk` (`flag/rejected`):

- An adopted id whose `writerKey` prefix equals the key of a current or
  former writer, with `seq >=` that writer's `seen/` value. That value is
  its last folded position plus one (§3).
- An adopted id exactly equal to a 64-hex writer key (an empty seq
  suffix).

Adoption across a generation never trips this rule, because writer
keypairs MUST NOT recur across generations (§10).

**`_rev`** is the body-head revHash at materialization time, emitted into
the frontmatter. On ingest, an edited file's `_rev` is the `base` that
its `SetBody` cites.

- A stale `_rev` gives siblings and `flag/conflict`, never a rejection.
  apply keeps both revisions.
- A missing `_rev`, as in a hand-authored file, cites the current head.
- A concept with no revisions omits `_rev` from the emitted frontmatter.
- The ingest of a file without `_rev`, over a concept without revisions,
  cites `base: null`.

The frontmatter emission order is `_id`, `_rev`, `type`, then the
remaining keys canonically sorted. This conforms to OKF: §4.1 permits
arbitrary producer keys, and by §9 consumers do not reject them.

## 7. Paths, renames, collisions (the Kleppmann rules)

`path` is an **LWW register on the concept**, not identity. A move as
delete and reinsert duplicates under concurrency, so position is a
register on a stable identity (Kleppmann, PaPoC 2020).

A path is NFC-normalized, bundle-relative and forward-slash, and it is
stored without the `.md` suffix. Reservation and collision checks compare
**casefolded, NFC-normalized** components.

### Reserved and unsafe paths

- A terminal component that casefolds to `index` or `log` is reserved by
  OKF §3.1 and rejected (`flag/rejected`, reason `reserved-path`).
- The generated file names `index.md` and `log.md` are members of every
  directory's casefold-collision domain. So a concept can never clobber a
  generated file, on any file system.
- The component pattern `\.conflict-[0-9a-f]{8,}$`, any terminal hex run
  of 8 or more, is **reserved**. A `CreateConcept` or `SetPath` that
  carries it is rejected (`flag/rejected`, reason `reserved-path`). So
  nobody can squat the 8-hex landing path or a longer fallback. Ingest of
  a conflicted copy never trips this, because it strips the suffix first
  (§9).
- apply rejects a path that is absolute or that escapes the bundle root
  (`flag/rejected`, reason `unsafe-path`).

### Renames and collisions

- **Rename and concurrent edit: merge.** The edit targets the `_id`, so
  it follows the concept.
- **Rename and concurrent rename: the linearization winner.** apply
  records the loser in `flag/clobber/<id>/path/<tag>` for audit. `path`
  there names the §4 path register, because `SetPath` is not a field. The
  `<tag>` component keeps the key unique, also against a frontmatter
  field named `path`.
- **Two concepts on one path: first wins.** The concept whose current
  path claim has the **lower `ord`** (§4), the earlier claim under
  linearization, holds `path/<path>`. A later claimant is the loser, so a
  squatter cannot evict.

The loser keeps its path value, and materializes at a **deterministic
conflicted-copy path**: `<path>.conflict-<first-8-hex-of-SHA-256(_id)>`.
The suffix is a hash, because a writer's every mint shares an `_id`
prefix. The path is byte-deterministic (I9), flagged
`flag/pathcollision/<path>/<loser-id>`, and narrated in `log.md`.

If two losers of the same path collide on 8 hex, the suffix extends to
the full 64-hex hash. An occupied fallback extends the same way. Only
another conflicted copy can occupy it, because the reservation covers
every length. materialize MUST NOT emit two concepts to one file under
any input.

The flag clears when the loser's claim stops colliding. Its own later
`SetPath` does that. So does the competing holder when it vacates by
rename, deletion or its own collision loss.

### Casefold collisions

apply detects casefold (plus NFC) collisions **on every peer,
unconditionally**. A path collides when its casefolded form equals
another live concept's casefolded path, or a generated file name. The
linearization loser gets `flag/pathcollision`, exactly as for an
exact-path collision, and materializes at the conflicted-copy path on
every platform.

A casefold loser keeps `path/<its exact path>`, because it has no
exact-path competitor. Links to it resolve into `bl/`, and the emitted
absolute link is broken on disk. OKF §5.3 tolerates dangling links. okf
does not demote the link to `wanted/`, because `wanted/` and `path/` then
disagree.

### Containment at materialize

materialize never writes to the view. Before any file write, it checks
lexical and realpath containment again. A violation aborts that file's
emission. It is reported on the CLI only, and never written to the view.
Correct path validation in apply makes it unreachable, so it is a bug,
not state.

### Directory moves

**Subtree and directory moves do not exist in v1.** OKF has no directory
object and no parent pointer: `path` is a flat absolute string on a
stable `_id`, and a directory is only a shared path prefix. So a
directory move is N independent `SetPath` ops, each a plain LWW rename
under the rules above.

No cycle can arise, because no op redirects a child-to-parent edge. The
concurrent-move cycle problem (Kleppmann et al., IEEE TPDS 2021) applies
only to parent-pointer trees with a reparent op. What v1 lacks is
atomicity: the N ops interleave, so a bundle can show a half-moved
directory.

The v2 path is one atomic multi-concept path rewrite: a batch op
`MoveSubtree { fromPrefix, toPrefix }` that apply expands
deterministically in one `view.write()` batch. Its prior art is multi-key
and read-atomic transactions, not move CRDTs for replicated trees.

## 8. Governance and the append-only guarantee

### Append-only

**Append-only is a vault-metadata constant.** `init` writes it, open
loads it, and it is identical on every peer. It is **not representable
as an op**. The wire contract has no prune op and no op that reclaims or
destroys bytes.

`DeleteConcept` writes a tombstone. The concept leaves materialize,
`index.md` and `path/`, and its bytes and `_id` remain. `UndeleteConcept`
restores it and writes `flag/undelete/<id>/<tag>` for audit. A write to a
tombstoned concept lands, and apply flags it `flag/writeafterdelete`
(I4).

### Governance ops

`AddWriter`, `RemoveWriter` and `SetWriterPolicy` require an **indexer
issuer**. apply checks the issuer against `gov/writer/<issuer>` at the
op's linearized position. It rejects a violation (reason
`policy-governance`). apply also rejects these ops:

- A `RemoveWriter` that leaves zero indexers (`policy-governance`).
  So a vault can never become ungovernable.
- An `AddWriter` with `indexer: false` that demotes the last live
  indexer (`policy-governance`).
- An `AddWriter` whose key is not 32 bytes (`bad-writer-key`).
- An `AddWriter` whose `swarmKey` is not 32 bytes (`bad-swarm-key`).
- A `SetWriterPolicy` whose key has no `gov/writer/<key>` record
  (`policy-governance`).

apply checks the length of a key only in an `AddWriter`. The other two
ops take a key of any length:

- A `RemoveWriter` whose key is not 32 bytes records `gov/removed/<key>`
  (`opRemoveWriter` in `okf/core/lib/apply.js`). No writer has that key,
  so the record names no writer.
- A `SetWriterPolicy` whose key is not 32 bytes is rejected
  `policy-governance` (`opSetWriterPolicy`). No `gov/writer` record has
  that key, because apply rejects the `AddWriter` that names it.

The store refuses such a key before the append (`VAULT_BAD_WRITER_KEY`),
so only a modified client sends one.

A rejected governance op changes no `gov/` key. An accepted `AddWriter`
stores its `swarmKey` on `gov/writer/<key>` (`opAddWriter` in
`okf/core/lib/apply.js`), and the swarm firewall of every peer admits
that key. See "Replication" in `okf/store/README.md`.

**Genesis.** The vault creator's key is the first indexer. apply seeds
its record deterministically (`ensureGenesis`), with no `swarmKey`. The
invite binds the creator's swarm key to `genesisKey` instead, as
`metadata.swarm.genesis`. So a folded `RemoveWriter` of the creator takes
that key out of every peer's allowlist. It takes out the `swarmKey` of
each other removed writer in the same way (`_refreshAllowlistOnce` in
`okf/store/lib/bundle.js`).

### Revocation

**Revocation is causal and in-band, never positional.** For a
`RemoveWriter`, apply records `gov/removed/<key>`: the op's clock and
`seqAtRemoval`. `seqAtRemoval` is that clock's entry for the removed
writer, the last position of that writer that the remover had folded
(§3). So an unforgeable position cross-checks the claimed clock. apply
rejects two kinds of op from the removed writer (reason `revoked`):

- A node that sorts after the removal, with a seq above `seqAtRemoval`.
  apply rejects it **regardless of its claimed clock**.
- An op at `seq <= seqAtRemoval` that sorts after the removal, whose
  clock does not strictly precede the revocation clock. The
  strict-precedence test applies only to this window.

Every clock entry is a position, so `seqAtRemoval` and a seq have the
same unit. apply also rejects any op whose claimed self entry does not
equal its actual seq (reason `forged-clock`).

`host.removeWriter` is NEVER called. Every node must keep linearizing on
every peer, so that the clock rule runs the same way everywhere. A
removal in autobee is not a complete apply filter. See `DEVIATIONS.md`,
"Substrate behaviour that okf relies on".

**The revocation check binds only the ops that sort after the removal.**
apply runs it only when `gov/removed/<key>` exists at the op's linearized
position (`applyNode` in `okf/core/lib/apply.js`). apply runs in
autobee's order (Order, below), so it cannot reject an op that sorts
before the removal. **Revocation stops cooperating
clients only. A revoked key with a modified client can keep writing
until the next generation. Quorum-signed revocation epochs are the
planned fix.** okf cannot stop that without a change to autobee.

`SECURITY_MODEL.md`, "The trust model", states how a cooperating client
stops, how a modified client evades the check and what that costs. "The
eviction ladder" there states what an operator can do.

**Re-admission.** An accepted `AddWriter` that names a revoked writer
deletes `gov/removed/<key>` (`opAddWriter`). From that position on, the
writer's ops pass the revocation check. That includes an op that the
writer made while partitioned from the removal, when the op sorts after
the re-admission. Such an op is concurrent with the revocation, every
peer decides it the same way, and I10 holds.

### The clock carries self and the writers with a `gov/writer` record

The store puts the self entry into the clock of every op. It also puts an
entry for each writer that has a `gov/writer/<key>` record and a folded
op in its view, and for no other key.

Only an indexer's `AddWriter` writes that record. So a grant (below) can
make a key an autobee writer, but the key is not clocked until an indexer
admits it. The count of its ops in the view does not change this. The
writers that indexers admitted bound the size of a clock, so no member
can push an honest op above `maxOpBytes` (§3).

apply accepts a clock with no entry for a writer that has no `gov/writer`
record. No rule above needs such an entry:

- `forged-clock` reads only the self entry, and every clock carries it.
- `seqAtRemoval` reads the entry of the removed writer. If the remover's
  view has no `gov/writer` record for the target, the entry is absent and
  `seqAtRemoval` is -1. The target then has no window, and the result is
  the same as with its last folded position. The remover's folded ops of
  the target are causal ancestors of the `RemoveWriter` node. autobee
  sorts a node after each node that it links (`_isLinked` in
  `lib/writers.js`, `addSorted` in `lib/topo.js`). An op of the target
  that sorts after the removal comes later in the target's core. So its
  seq is above that position, and apply rejects it `revoked`.
- The strict-precedence test compares every entry. apply never deletes a
  `gov/writer` record, so a revoked writer stays in the clock. If it
  left, an in-flight op can cite a writer that a later revocation clock
  omits. The test then rejects that op, although its clock precedes
  the revocation (I10).
- Two views can disagree on an admission, because a reorder can flip the
  outcome of an `AddWriter`. Then an op's clock can carry an entry that
  the revocation clock omits, and the test fails. Such a difference can
  reject an op in the window. It never admits one.

### The grant, and admission before effect

**An autobee grant follows every `AddWriter` op.** Apply MUST call
`host.addWriter(key, { weight: 0 })` for every `AddWriter` op it folds,
whether it accepts or rejects the op (`grant` in
`okf/core/lib/apply.js`). The grant does not depend on the op's
disposition. The call comes right after a successful decode, before
every check that can reject the op. Those checks are the §3 post-decode
limits, `forged-clock`, the revocation check, the indexer-issuer rule and
the rate check. They read the op's linearized position, and a reorder
can flip their outcome. The grant reads the op bytes alone, so every peer
makes it in every order, and no reorder undoes it.

apply grants only a 32-byte key, because autobee copies the key into a
fixed 34-byte system key (`encodeSystemWriterKey` in `lib/encoding.js`).
The weight is explicit and uniform: 0 for every writer, never autobee's
default `isIndexer ? 2 : 1`. The store passes `bootstrapWeight: 0`, so
genesis stands at 0 too. A grant at 0 changes no weight and opens no
promotion. See `DEVIATIONS.md`, "Substrate behaviour that okf relies
on".

The grant makes the key an autobee writer, so its nodes reach apply on
every peer. It gives no okf membership: **okf membership comes only from
`gov/`**, which apply decides. Only an accepted `AddWriter` writes the
`gov/writer/<key>` record.

**Admission comes before effect.** A writer's ops take effect only once
an indexer's `AddWriter` has admitted its key, at that op's linearized
position. The genesis indexer is the one writer admitted without an
`AddWriter`. apply rejects each op of a writer with no
`gov/writer/<key>` record at the op's linearized position, with a flag
(I4):

- A content op that passes the earlier checks is rejected `not-a-writer`
  (`flag/rejected/<writerKey>/<seq>`). It never reaches the content
  pipeline, takes no rate token and changes no `c/` key (I10).
- A governance op is rejected `policy-governance`, because its writer is
  not an indexer.

`seen/<writerKey>` moves past a rejected op (§3), so the §6
`mint-collision-risk` rule protects that key's future mints. Admission is
not retroactive: the `AddWriter` revives none of the writer's earlier
rejected ops.

The admission check has a fixed place in apply's single-reason order:

1. The §3 limits, the `forged-clock` check and the revocation check,
   which bind every op.
2. The indexer-issuer rule.
3. The admission check.
4. The rate check.

The store passes `optimistic: false`, so autobee drops every node of a
writer that it has not added, before apply. The store refuses an append
until `db.writable` is true, that is until autobee has added the writer.
`DEVIATIONS.md`, "Substrate behaviour that okf relies on", states both
behaviors.

`db.writable` signals admission in autobee only. It is not okf
membership. A rejected `AddWriter` grants its key too. So a writer that
is not an indexer can make a key writable, and apply then rejects each op
of that key. A forged approval makes a key writable too. See
`SECURITY_MODEL.md`, "What the substrate decides, and what okf decides".

### Order

Every writer stands at weight 0, so autobee orders nodes by timestamp,
then writer key, then length (`cmp` in `lib/topo.js`). A writer stamps a
node with its own wall clock, and never below the newest node that its
system holds (`append` in `index.js`). So concurrent writes sort by their
writers' clocks, and a writer with a slow clock loses each LWW race (§5)
against a concurrent write.

A peer does not process a node whose timestamp is more than two hours
past the peer's own clock (`MAX_FORWARD_TIME_DRIFT` in
`lib/writers.js`). That node waits, with each node that links it, until
the peer's clock reaches it. autobee bounds no timestamp in the past, so
a writer can choose where its node sorts. `SECURITY_MODEL.md`, "The trust
model", states that residual. The op field `at` (§3) orders nothing.

### Rate limit and encryption

The rate limit is a token bucket per writer, never a global window:

- Each writer's bucket gains 1 token per accepted op *authored by any
  indexer*, capped at that writer's `rateCeiling`.
- A bucket starts full, at its ceiling, at admission. The genesis
  indexer's bucket starts full at its first op. So the accept and reject
  partition is fixed, and no implementation chooses it.
- A writer's ceiling is the `rateCeiling` of its `gov/writer` record
  (`SetWriterPolicy`), else the pinned `rate.defaultCeiling`. That is
  1024 unless the metadata at `init` sets another value
  (`METADATA_DEFAULTS` in `okf/store/lib/metadata.js`).
- So a writer that is not an indexer has a budget of 1024 ops by default,
  and only accepted indexer ops refill it.
- An indexer's accepted op takes one token and adds one to every bucket,
  its own too (`takeToken` and `accepted` in `okf/core/lib/apply.js`).
  Test: "I10: token buckets refill from accepted indexer ops".

okf supports `encryptionKey`, with `encrypted: true`, end to end. autobee
encrypts the writer cores, the system and the view. The view needs
corestore 7.12.6 or later (§1).

## 9. Faces

### materialize

**materialize(dir)** walks `c/` and emits a bundle that conforms to OKF
v0.1. It is byte-deterministic: converged peers emit identical bundles
(I9).

- One markdown file per live concept at its path (`<path>.md`). The
  frontmatter follows the §6 order, and the body is the head revision
  text. Conflicted copies follow §7.
- **`index.md` per directory**, derived and never authored, with the
  structure of OKF §6. Only the bundle root has frontmatter
  (`okf_version: "0.1"`). The structure is normative: the optional root
  frontmatter, one section heading `# Contents`, then one bullet per
  child in the form below. Concepts come first, then subdirectories, each
  group in canonical byte order of the link target.
- **`log.md` at the bundle root**, derived and never authored, with the
  structure of OKF §7. Its shape is fixed: one `# Update Log` title, then
  `## YYYY-MM-DD` UTC date headings (OKF §7 MUST), newest first.
- YAML emission is pinned. A scalar is double-quoted if and only if YAML
  otherwise reinterprets it. Lists are flow-style. Line endings are
  LF, with a trailing newline. Byte identity across implementations and
  OKF §9(1) parseability depend on this.
- Writes are atomic (temp file, fsync, rename), with containment checks
  and an in-flight lock per path.

An `index.md` bullet has this form:

```
* [<title frontmatter, else terminal path component>](<entry>) - <description>
```

`<entry>` is the child's path relative to the directory: `<name>.md` for
a concept, `<name>/` for a subdirectory. Without a `description`, the
bullet has no ` - <description>` clause.

materialize generates the `log.md` entries from the `log/` family:
creations, renames (old → new), deletions, undeletions, conflict
resolutions and path collisions (`logLine` in
`okf/faces/lib/materialize.js`). A generation writes no entry (§10).

- A date comes from the op's `at` field (§3), truncated to UTC
  `YYYY-MM-DD`. It is informational, and merge never uses it.
- Entries group by UTC date, headings descending. Within a heading,
  entries are in descending ordinal order.
- Entry links are absolute and bundle-relative.
- Entries are deterministic for a converged view (I9).
- A forged future date is an accepted cosmetic result of informational
  timestamps.

### The emission manifest

materialize reconciles the directory to the view **through an emission
manifest**, never by blind mirroring. The manifest is peer-local state
outside the view: the (path, content-hash) set that materialize last
emitted.

After emission, a file is a removal candidate only on three conditions.
The manifest tracks it, this run did not produce it, and its current
bytes still match its manifest entry. Such files are earlier conflicted
copies, earlier paths of renamed concepts, and the `index.md` of a
directory that is gone. materialize then removes empty directories. A
deletion honors the same containment checks as a write.

materialize **never deletes or overwrites** a `.md` file whose current
bytes differ from its manifest entry, or that has no entry. A file with
no entry is authored by a person and not ingested yet. materialize leaves
the file in place and reports it as pending-ingest. The CLI prints a
`notice:`, never an `error:`. The exit codes follow ADR-004:

- 0: a clean run.
- 3: pending-ingest files remain, and materialize projected everything
  that it owns. An ingest before the run prevents this exit.
- 1: a real failure: I/O, a corrupt vault, bad arguments or an unsafe
  path.

`materialize --force-mirror` restores unconditional mirroring, for
operator use. A stale file, a generated file that a person edited, is
also a notice with exit 0 or 3.

The ingest watcher treats a reconciliation deletion as authored by
materialize, through the in-flight locks, and never as a deletion by a
person. I9 is judged on the emitted set. A pending-ingest file is
transient local state that becomes ops.

### Ingest: from edits to ops

The **ingest watcher** turns edits by a person into the smallest set of
ops. It debounces, waits for writes to settle, and shares the in-flight
locks with materialize. Ingest diffs the frontmatter per key against the
view state, and never makes a whole-file op:

- A changed key gives `SetField`, `AddTag` or `RemTag`.
- A removed key gives a `SetField` with an empty array.
- A body difference gives one `SetBody` that cites the file's `_rev`.
- Ingest strips `_id` and `_rev` from the frontmatter diff before it
  makes ops. They are identity and derived output, never fields (§5).
- A *removed* `tags` key gives `RemTag` ops that cite every currently
  observed token, never a `SetField` on `tags`.
- `index.md` and `log.md` are reserved. Ingest ignores an edit to them,
  with a single narrated log entry.

### Ingest: the `_id` of a file

- A known `_id` at a new path gives a `SetPath`: a real move.
- The same `_id` at two paths is a copy, and the detection is
  deterministic. The file at the `_id`'s current view path, if present,
  is the original. Otherwise the original is the path that is first in
  casefolded lexicographic order. Every other file is a copy: ingest
  mints a new concept for it with `CreateConcept`, and the original keeps
  its path.
- A missing `_id` gives a mint (`CreateConcept`).
- An `_id` that is present but unknown to this vault is **adopted**, by
  a `CreateConcept` with the supplied id. The seen-id and mint-collision
  rules of §6 apply. Import relies on this: it adopts every
  `_id` of the bundle (§10).

The watcher reports a copy split as a `'copy'` watcher event, **not** as
a `flag/copydetect` view row. The 12-op wire contract (§3) has no op that
writes such a flag, and a new core op is out of scope for v1.

The watcher does **not** write a minted `_id` back into the file that it
just read, because that write echoes while the file settles. The next
`materialize` stamps the file with the deterministic `_id` and `_rev`.
The file's bytes match the emission manifest, so materialize overwrites
it and does not block it as pending-ingest.

### Ingest: conflicted copies

A file whose terminal component matches `\.conflict-[0-9a-f]{8,}$`
ingests at the **suffix-stripped path**. Ingest strips every trailing
reserved suffix.

- A known `_id` whose view path equals the stripped path gives no
  `SetPath`. The file is the loser's materialized copy, and its body and
  frontmatter diffs ingest normally.
- An unknown `_id` gives a `CreateConcept` at the stripped path. The
  collision then follows §7 again: apply flags the loser, and it
  materializes at a conflicted-copy path.
- A deleted conflicted copy is **not** a `DeleteConcept`. A conflicted
  copy is a transient materialized file, not the concept's canonical
  location. The watcher skips the deletion and emits a
  `'delete-skipped'` narration with reason `conflict-copy`. Otherwise the
  removal of a loser's file deletes a live concept that the next
  `materialize` emits again.
- The import of a bundle (§10) takes no conflicted copy. It refuses a
  bundle that holds one, so the operator resolves each collision in the
  bundle before a generation.

### Ingest: deletions

A file deleted on disk gives a `DeleteConcept`, behind a confirmation
guard that is on by default. That holds for the winner's canonical file
too. A conflicted copy is the exception (above).

**Deletion ordering in the live watcher.** A vanished path MUST NOT emit
`DeleteConcept` from the event that noticed it. The watcher queues it,
and drains the queue only when it is quiet: no pending debounce timer and
no in-flight ingest. So a moved file's new path ingests first, and its
`SetPath` vacates the old `path/` claim. The drained delete then finds no
holder and emits nothing. This is the ingest-before-delete order of
`scan()`. A file that truly vanished still deletes, behind the guard, one
quiet window later.

**A tombstoned `_id` on disk is intent to keep.** A file whose known
`_id` resolves to a tombstoned concept MUST make ingest emit
`UndeleteConcept` before any other op for that file. So the `SetPath` and
`SetBody` that follow land on a live concept, and apply records the
permanent `flag/undelete` audit row. A conflicted copy is exempt: a
transient file never restores the concept that it mirrors.

apply itself never restores a concept on a `SetPath`. Otherwise a late
rename from any writer undoes a deletion, and the replay of existing logs
changes. A write to a tombstone still lands and flags (§8).
Ingest decides, because the evidence, the file on disk, is there.

**Directory watch events MUST rescan, never drop.** A watch path that is
not a `.md` file, and that is a directory or no longer exists, schedules
one coalesced `scan()`. macOS delivers a subtree move as directory-rename
events only, never as the nested new `.md` paths. So a watcher that drops
such events loses the move. `scan()` loses nothing: it ingests first, and
then deletes the vacated paths.

### Links

Links are standard markdown links per OKF §5, and the absolute
bundle-relative form is preferred. Extraction feeds `link/`, `bl/` and
`wanted/`.

**A link whose target path does not resolve goes to `wanted/`, the ranked
demand index, and never to `flag/`** (OKF §5.3). `wanted/` is queryable,
and `wantedrank/` ranks it by referrer count (§4). An entry clears when a
concept lands on that path.

Link resolution is **late-binding and recomputed**. On every op that
changes a concept's current path or liveness, apply resolves the affected
`link/` edges again. Those ops are `SetPath`, `DeleteConcept`,
`UndeleteConcept`, and a collision win or loss. An edge to a vacated path
moves from `bl/` back to `wanted/`, and an edge to a newly occupied path
moves to `bl/`. I8 is the definition. Any event narration is an
optimization of it.

Extraction is normative:

- Only CommonMark inline and reference links count. Autolinks and images
  do not.
- Extraction skips fenced code, indented code and inline code spans.
- A target with a URI scheme, or in protocol-relative form, is a citation
  and is ignored.
- A `/`-prefixed target is bundle-relative. Any other target resolves
  against the directory of the source concept's current path, with `.`
  and `..` normalized.
- A resolution that escapes the bundle root is ignored.
- Extraction strips one trailing `.md` and any fragment (`#...`), and
  NFC-normalizes. The result keys `link/`.
- A `SetPath` on a concept resolves its own relative edges again.

### Ingest: preflight, pending files and scope

**Oversize preflight (ADR-005).** Ingest refuses a file whose `set-body`
op, encoded, exceeds the §3 `maxOpBytes` limit. It refuses the file
by name, with the limit and the size of the encoded op, before it appends
any op for that file. Sibling files in the same run are unaffected. The
op holds the body and also its `_id`, base, clock and time, so ingest can
refuse a body below the limit. apply's `oversize-op` rejection stays, as
the second defense.

**Pending files.** A file with no `_id` of its own, a note without `_id`
or a copy, gets its concept from its ingest. It gets its `_id` only when
materialize stamps it, after the ingest completes. An ingest that core
rejects in part, or that throws, leaves the file pending.

So ingest records the concept of each pending file in the peer-local file
`<bundle>/.okf-pending.json`. A record holds the file's path, the sha256
of the bytes of that ingest, and the concept's path in the view then
(`at`).

- A later ingest takes the recorded concept, where it otherwise mints or
  splits a copy, only on evidence that the file is the same.
- The evidence is the file at the recorded path. A file at another path
  with the same bytes, while the recorded path is gone from the disk, is
  evidence too. That case is a rename, and the ingest moves the concept.
- Ingest never takes a concept that is not live at `at`.
- A record whose file a delete pass found gone, and that deleted nothing,
  takes back only the same bytes at its path.
- The record of a concept goes when an ingest of its file or of the
  concept completes. It also goes when the delete of the file takes
  effect.
- `scan()` tries the delete of each path that the emission manifest or
  the pending record lists and the disk no longer holds. The delete of a
  pending path deletes the recorded concept, behind the confirmation
  guard.

**Path-scoped one-shot ingest (ADR-001).** The one-shot scan set is the
whole bundle. Trailing bundle-relative paths restrict it to those paths.
So one agent's ingest never takes the pending file that another agent is
still writing. A named path that does not exist, or that resolves outside
the bundle root, is an error: exit 1, the path named, zero ops appended.
The zero-path form behaves exactly as the full scan.

### Per-file state vocabulary (ADR-002)

The rules above imply a state for each file, and the state names are
contract. The CLI `status` command reports them read-only: it appends no
op, writes no file and touches no manifest.

| State | Meaning |
|---|---|
| `in-log` | the bytes on disk match the log's canonical projection, by hash |
| `pending-ingest` | authored by a person and not in the log, and ingest can make a concept |
| `dirty` | in the log, and the bytes on disk differ from the projection |
| `absent` | in the log and missing from disk, and materialize can restore it |
| `foreign` | not in the log, not manifest-tracked, and ingest cannot make a concept |

A `dirty` file is an edit that ingest folds in as diffs, or a log that
moved past the last materialize. An example of a `foreign` file is
another writer's unfinished work.

## 10. Generations: materialize, then import (the CouchDB homage, part two)

Byte reclamation is an **operator act through the bundle**, never an op.
A generation is two commands, in these steps:

1. `auto-okf materialize <dir> <face-dir>` writes the bundle of the live
   vault. It holds the live heads with `_id` and `_rev`, no tombstoned
   concept, and each path-collision loser as a conflicted copy (§7).
2. The operator resolves in the bundle what must not cross. Each
   conflicted copy gets a path of its own, or is merged and removed. A
   note can be removed.
3. `auto-okf import <face-dir> <new-dir> [--encryption-key <hex64>]
   [--metadata <okf-vault.json>] [--predecessor <vault-key>]` creates a
   new vault in `<new-dir>` with the rules of `init`. It fills the vault
   from the notes of the bundle with **`_id` adoption** (§6, §9).
4. The operator archives or destroys the old vault out-of-band.

For an encrypted vault, the bundle of step 1 is the plaintext export, and
materialize says so. It also marks that bundle: before its first
plaintext write, it writes the file `.okf-encrypted` at the root of
`<face-dir>`, and it never removes it.

The bundle shows only the head body of each concept. So the operator
resolves an open body conflict in the vault before step 1
(`auto-okf flags <dir> conflict`, then `auto-okf resolve`).

The bundle is inert source. import reads it once, writes nothing to it
and opens no predecessor vault. So no stage, no verification copy and no
live predecessor exist.

Within a generation the log only grows (§8). So a generation is also the
only way to redact. The new vault holds only what the bundle holds. The
old log stays on every replica of the old vault until each replica is
destroyed.

Live state and identity survive a generation. History is shed by design:
old revisions, per-op attribution and clocks. State fidelity and identity
fidelity across a generation are an acceptance criterion (§14).

### Rules of import

The code is `okf/faces/lib/import.js`, and `IngestWatcher.importNote` in
`okf/faces/lib/ingest.js`.

**Refusals.** import refuses each of these before any write, by name:

- A `<new-dir>` that is pinned, not empty, or not a directory. A store
  there takes the import or the key.
- A bundle that holds a `.conflict-<hex>` note: a collision is still
  open.
- A note at a reserved `.okf-` name, or under a directory with one (any
  segment, casefolded).
- A note whose frontmatter holds no `_id` (`IMPORT_MISSING_ID`). import
  keeps each `_id`, and a minted one differs from the bundle.
- An entry that is not a regular file or a directory, such as a symlink.
- A missing `--encryption-key` for a bundle that holds `.okf-encrypted`,
  or with the `--metadata` of an encrypted predecessor
  (`IMPORT_ENCRYPTION_KEY_REQUIRED`). A generation of an encrypted vault
  is never unencrypted. The mark is in the bundle, so the refusal needs
  no `--metadata`, and no flag turns it off.

**One import holds `<new-dir>`.** Before it creates the vault, import
creates the claim file `okf-import-claim` in `<new-dir>` with an
exclusive open (`claimDir`). A second import into the same `<new-dir>`
refuses by name (`IMPORT_DIR_CLAIMED`) and removes nothing.

The store's first open moves the claim into `<new-dir>/db/`, because
hypercore-storage moves each unknown file at the top of a new storage
directory there. From then on the new vault's files hold `<new-dir>`, and
a second import refuses it as not empty. A successful import removes the
claim at both places. A failed one removes it with the rest of what it
created.

**Import-mode ingest.**

- import reads every regular `.md` file of the bundle at any depth, dot
  segments included, except the generated files `index.md` and `log.md`.
- import ignores the bundle's emission manifest. The manifest is
  materialize's peer-local echo suppression, and a check against it
  skips every note as an echo.
- import ignores ingest's pending record (`.okf-pending.json`, §9). That
  is state of a live directory, not of a generation.
- import treats every `_rev` as absent. The new vault has no base, so
  each head is the concept's first revision (`base: null`), the only
  flag-free start (§5), and `_rev` re-derives (§14). After one generation
  every head is `base: null` already, so a later generation keeps `_rev`
  too.
- import checks each op against `maxOpBytes` as encoded, before it
  appends the op. An op that core rejects fails the import by name.

**Fresh writer keypairs.** A writer keypair MUST NOT recur across
generations. Otherwise apply rejects the adoption of the predecessor's
mint-shaped ids as `mint-collision-risk` (§6), and I11 cannot hold. The
store derives writer cores under a per-generation corestore namespace
that the vault metadata records (`generation`). import needs a new or
empty directory.

**Metadata.**

- `--metadata` carries `limits`, `rate` and `schemaVersion` from the
  predecessor's `okf-vault.json`. So a note that fitted the predecessor's
  limits fits the new vault's.
- `--metadata` never carries the `swarm` allowlist (`carriedMetadata` in
  `okf/faces/lib/import.js`): a generation is the eviction point. The new
  vault's invite lists only the swarm key of the peer that ran the
  import, and an indexer admits each writer again
  (`add-writer --swarm-key`).
- `--predecessor` records `predecessorKey`, the generation chain. The
  generation id is `'root'` without a predecessor, else
  `sha256(predecessorKey bytes)` (`generationId` in
  `okf/store/lib/metadata.js`).
- A joiner needs the new `okf-vault.json` as its invite metadata to
  derive the same namespace.
- The chain is the operator's claim. It is unsigned, okf never verifies
  it, and it is provenance metadata, not proof. Consumers MUST treat
  cross-generation identity as trusted-operator scope.
- import writes no generation entry to the new vault. The chain is
  `predecessorKey`, and the new `log.md` narrates creations only.

**The fidelity check.** After the import, import takes the notes that a
materialize of the new vault writes: its byte plan, in memory. They must
equal the notes read from the bundle, byte for byte, without each `_rev`
frontmatter line.

- `index.md` and `log.md` are generated files that import never reads, so
  the check leaves them out.
- A difference fails the import by name (`IMPORT_FIDELITY`), with each
  difference listed.
- A note that warns does not round-trip. It fails the check, and the
  error carries the warnings. A note warns when it does not parse, has no
  `type`, or copies another note's `_id`. A successful import has no
  warning.
- import writes no verification copy to disk.

**Cleanup on a failure.** Some failures come once the new vault exists:
`IMPORT_FIDELITY`, `IMPORT_OVERSIZE`, `IMPORT_REJECTED` and
`IMPORT_NOT_ENCRYPTED`. On each, import closes the new vault. It removes
what it created while it held the claim, and then the claim (`release`,
from `claimDir`). import removes a `<new-dir>` that it made. An existing
empty `<new-dir>` stays, empty.

**Encryption.** `--encryption-key` encrypts the new vault. import reads
plaintext and writes none, so it prints no plaintext warning.

### What the bundle cannot hold

**`materialize` reports every value that the bundle cannot hold. An
operator fixes those values before `import`.** The view can hold some
values that the bundle cannot:

- A scalar `null` is omitted.
- Only the first `type` value is written.
- A reference or an object is written as a string.
- A lone UTF-16 surrogate in a string becomes U+FFFD in the UTF-8 note.

import cannot see such a change, because it reads only the bundle. So
materialize parses back the bytes of each note that it renders. It reads
each field the way ingest reads it, and compares it with the view
(`lossyFields` in `okf/faces/lib/materialize.js`). Each difference is in
`report.lossy` as `{ id, path, key, before, after }`.

A path is such a value too. Two spellings that fold together (NFC, then
lowercase), such as the directories of `Notes/a` and `notes/b`, are one
directory on a case-insensitive file system. APFS, the macOS default, is
one. There the import gives each note the spelling that was written
first, and materialize writes in byte order.

So materialize groups the directory prefixes and the note paths by their
folded form (`lossyPaths`). For each note whose path changes under the
first spelling in byte order, `report.lossy` holds an entry with the key
`path`: `before` is the concept's path, and `after` is the path that the
note gives back. The report reads no disk, so it is the same on a
case-sensitive file system.

`auto-okf materialize` prints a warning for each entry and exits 1. The
operator changes the value in the vault to one that the bundle can hold,
and materializes again, before the import.

## 11. Invariants (the test suite maps to these)

- **I1 Determinism:** apply is a pure function of the linearized op
  sequence. No wall clock, no randomness, no map-iteration order, no
  peer-local reads.
- **I2 Convergence:** peers that exchanged all ops have bit-identical
  views (full range-scan hash).
- **I3 Rebuild equivalence:** a from-scratch rebuild equals the
  incremental view.
- **I4 No silent loss:** no op's effect disappears without a flag
  (clobber, staletag, conflict, pathcollision, writeafterdelete,
  rejected). `wanted/` entries are demand, NOT loss.
- **I5 OR-set law** (tags): a concurrent add and a remove of the
  unobserved tag leave the tag present.
- **I6 LWW law:** a register's outcome depends only on linearized order.
- **I7 Conflict lifecycle:** same-non-null-base siblings persist until
  `ResolveConflict`. A `wanted/` entry clears when its path materializes.
  A pathcollision flag clears when the loser gets a free path.
- **I8 Index coherence:** `path/`, `link/`, `bl/`, `wanted/`,
  `wantedrank/` and `revbybase/` are exactly derivable from `c/` at every
  quiescent point. The `path/` winner selection uses the `ord` in
  `c/<id>/path`, so the derivation needs no information outside `c/`.
- **I9 Bundle determinism:** converged peers emit byte-identical bundles,
  including `index.md`, `log.md` and conflicted copies.
- **I10 Governance:** four kinds of op never mutate `c/`, and the
  applied and rejected partition is replay-stable:
  - an op from a writer with no `gov/writer/<key>` record,
  - a revoked writer's op after the causal revocation point,
  - an unauthorized governance op,
  - a policy-violating op.
- **I11 Roundtrip:** materialize, then import into a new vault (a
  generation, §10), preserves every live concept's `_id`, `type`, fields,
  tags, path and head body, byte for byte. §10, "What the bundle cannot
  hold", states the values that do not survive.

## 12. Non-goals (v1)

v1 has none of these:

- RDF, Turtle or SPARQL.
- A per-key merge policy.
- Subtree-move atomicity.
- A text CRDT for bodies.
- An HTTP API.
- Changes to the vlurp codebase.
- `viz.html`.

**Known limitations (v1).** Determinism (I1, I2, I10) holds in both
cases. They are limits of scale and of one edge, not correctness gaps.

- **Soak memory and liveness under a sustained flood.** This is a scale
  limit. Under a lossy flood of about 22 minutes, with backpressure on,
  RSS grew without a plateau, to about 3.1 GB. A lagging peer did not
  converge inside a 5-minute heal window. Liveness and throughput are the
  affected axis: caught-up peers stay byte-identical, no view hash
  diverges, file descriptors stay flat, and nothing crashes.
- **An empty-string `type` on ingest.** apply rejects an empty `type`
  register at the op level (§5, reason `empty-type`). The ingest edge
  around an empty-string `type` in an authored file is a known minor
  issue.

The soak limit involves autobee under flood. That cause is UNVERIFIED
against the autobee@2.12.1 source, which states nothing about memory
under load. The lead on the okf side is uncoalesced OR-set add tokens
(§5, `tags`). A fix is architectural and risks determinism on passing
code, so it is deferred on purpose, and sign-off is pending. The figures
come from the v1 milestone of 2026-07-14 (`DELIVERY.md`), on that
milestone's autobee release. This document states no figure for autobee
2.12.1.

## 13. Deliverables

```
okf/core       ops, wire codec, apply, keyspace (copied), canonical (copied),
               revhash (copied), memview test double
okf/store      vault lifecycle on autobee, metadata pinning (incl. the
               append-only constant + generation chain), governance plumbing,
               swarm replication, backpressure option
okf/faces      materialize (bundle + index.md + log.md), ingest watcher,
               wanted index, the import of a bundle into a new vault (§10)
okf/cli        init, join, keys, add-writer, remove-writer, materialize,
               ingest (optionally path-scoped, ADR-001), watch, status
               (ADR-002), wanted, flags, resolve, undelete, import, bootstrap
okf/root       the `auto-okf` root placeholder package (published as
               auto-okf@0.0.1 alongside the scope)
okf/test       unit + invariant suite (I1..I11 each ≥ 1 test)
examples/agent-session/    flagship: multi-agent findings/determinations/RFC
                           bundle, partitioned + healed, ThreadMode→DocumentMode
examples/slop-archive/     durable LLM-output archive (append-only shown off)
examples/vlurp-library/    one script: vlurpfile → staging → _id-stamped bundle
```

The build uses Node 20 or later, plain JS and a pnpm workspace
(`vault-ld/*` and `okf/*`). Tests use **node:test only**, the Node core
test runner (`node --test`). okf does not use the Holepunch brittle and
bare convention. A library package imports no test runner, so
compatibility with autobee is unaffected. Each package and each example
has a usage-first README. The package names are `auto-okf` (root) and
`@auto-okf/{core,store,faces,cli}`.

## 14. Acceptance

The work is complete when all of these hold:

- I1 to I11 each pass.
- The multi-process harness matrix (fault proxy, partitions, permutation
  replay) is green at clean, lossy and partitioned.
- A generation (materialize, then import) round-trips a non-trivial
  bundle, including a drained conflict, with identity fidelity and byte
  fidelity. Byte fidelity is **modulo the `_rev` frontmatter lines and
  the regenerated `index.md` and `log.md`**, which re-derive in the new
  generation. I11's property list is the normative fidelity set.
- All three examples run from committed scripts and regenerate their
  committed output byte-identically.
- Every emitted bundle passes an independent OKF v0.1 conformance check.
  The frontmatter parses, `type` is present, and the reserved files have
  the structure of OKF §6 and §7.
- `wanted/` ranks unwritten concepts by referrer count in the flagship
  example.
