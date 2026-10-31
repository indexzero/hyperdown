# auto-okf: Implementation Specification

**Status:** Normative build instruction, v1.11 (2026-10-28). RFC 2119
keywords (MUST, SHOULD, MAY) apply.
**Changelog:** v1.11 pins autobee at exactly 2.12.1 and corestore at
exactly 7.16.1 (§1). It states the order of concurrent writes and its
two-hour bound (§8). The revocation check binds only the ops that sort
after the removal, so revocation stops cooperating clients only (§8). It
states the `swarmKey` field of `AddWriter`, the rejection of a bad key,
and the rejection of an `AddWriter` that demotes the last live indexer
(§3, §8). It states re-admission and the default rate ceiling (§8), and
the events of `log.md` (§9). It states the claim of an import, its
cleanup, the swarm allowlist across a generation, and redaction (§10). P7 leaves
"Known limitations": ingest strips every trailing reserved suffix, and
the regression test of #28 holds (§9, §12).
v1.10 makes a generation two commands: `materialize`, then
`auto-okf import` of the face into a new directory (§10). The staging
step, the verification copy, the live-state check against a predecessor,
`--force`, the generation `log/` entry and the record of the
predecessor's view hash and writer lengths are gone. The metadata
records `predecessorKey` alone, and the generation id derives from it.
`materialize` reports every value that the face cannot hold, and
`auto-okf materialize` exits 1 on one (§9, §10, §11, §13).
v1.9 states the transport contract for autobee@2.12.1
only (§1): the constructor options that the store passes, the apply, host
and instance surfaces that okf uses, and the corestore floor 7.12.6. Every
statement about autobee cites the installed
source as `file:line`. `DEVIATIONS.md` records each substrate behaviour
that okf relies on (§0, §1, §2, §3, §7, §8, §12).
v1.8 bounds the clock. An op's clock carries the self
entry and an entry for each writer with a `gov/writer` record, a revoked
writer too, and no other key. A key that no indexer admitted is never
clocked. So its ops cannot push an honest op above `maxOpBytes` (§3, §8).
v1.7 makes the per-writer ordinal the node's position: the
actual seq of a node is `node.length - 1`, its position in its writer's
core, and `seen/<writerKey>` holds the last folded position plus one.
Every clock entry is a position, and the store builds no clock entry from
substrate heads. A node that never reaches apply, such as an empty block,
still takes a position, so the seqs of a writer's ops can have gaps (§3,
§4, §6, §8).
v1.6 makes an autobee grant follow every `AddWriter` op:
apply calls `host.addWriter(key, { weight: 0 })` for every `AddWriter` op
it folds, accepted or rejected, before any check that can reject it. okf
membership comes only from `gov/`. The uniform weight is 0 (§8).
v1.5 makes admission come before effect: a writer's ops take
effect only once an indexer's `AddWriter` has admitted it. A content op
from any other writer is rejected `not-a-writer`, and a governance op from
it is rejected `policy-governance` (§8, `okf/core/lib/apply.js:407-426`).
The hold buffer, the `optimistic` flag family, the `hold-overflow`
rejection and the unacked rate ceiling are gone (§3, §4, §8, §11).
v1.4 closes the live-watcher directory-move
data-preservation gap (issue #30) with three §9 ingest-watcher rules — a
disk file bearing a known-but-tombstoned `_id` is intent-to-keep
(`UndeleteConcept` first), vanished-path deletion defers to a quiet-window
drain so present-file ingests land first, and directory watch events
schedule a coalesced `scan()` instead of being dropped; the deterministic
core is unchanged (a write to a tombstone still lands-and-flags, §8), and
the corresponding Known-limitations entry is removed. v1.3 upstreams the
auto-okf delivery + deviation learnings
(sources: `DELIVERY.md`, `DEVIATIONS.md`) so the spec matches delivered
reality: revHash length prefix corrected to u64 BE (§5); uniform writer
weight pinned (§8; v1.6 sets it to 0); the onboarding of a new writer
resolved (§8; v1.5 replaces it); the per-writer seen-count ordinal resolution
settled (§3; v1.7 replaces it); `flag/copydetect`
corrected to an ingest watcher event, not a view row (no core op writes it —
§4, §9); conflicted-copy face deletion skip and deferred `_id` write-back
documented (§9); the generation `log/` entry clarified as a filesystem artifact
and the `_rev`-stripped staging step of the generation cycle documented (§10); a "Known
limitations (v1)" note added (C1 soak scale limit, P7 double-conflict-suffix
ingest, P4 empty-`type` ingest, plus the live-watcher directory-move
data-preservation gap, issue #30); node:test mandate confirmed. A
source-driven review pass also corrected §7's directory-move deferral
rationale — a category error citing the TPDS-2021
tree-move CRDT (which solves cycles in explicit parent-pointer trees OKF does
not have); the real v2 path is an atomic multi-concept path rewrite
(`MoveSubtree` batch via `view.write()`) with read-atomic/RAMP transactions
as the prior art (source: `sslop/041/FINDINGS.md`). v1.2 applies adversarial
review round 2
(`orchestration/results/OKF-SPEC-REVIEW-2.md`): majors N1–N5 fixed
(squat-proof minting, generation key freshness, manifest-gated mirror
reconciliation, apply-time `empty-type` rejection, conflict-copy ingest
round-trip), minors n1–n14 applied. v1.1 applied adversarial review
round 1 (`orchestration/results/OKF-SPEC-REVIEW-1.md`): blockers B1–B4
fixed, majors M1–M15 fixed, minors m1–m15 applied. Dispositions for both
rounds: `orchestration/results/OKF-SPEC-DISPOSITIONS-1.md`. v1.1 and
v1.0-draft are the prior revisions in git history.
**Contract:** this document implements the confirmed intent at
`~/Git/indexzero/0x/slop/intent/autokf.intent.md`. On conflict, the intent
wins and this document gets corrected.

---

## 0. Role and ground rules

You are implementing **auto-okf**: a multi-writer storage substrate for
[Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
bundles, built on **autobee**. Writers include autonomous AI agents;
single-writer designs are out of scope by definition.

Precedence rules:

1. Where this document conflicts with the OKF `SPEC.md` (v0.1) on **emitted
   bundle format**, OKF wins. Conformance (OKF §9) judges only the emitted
   tree; everything internal is this document's to define.
2. Where this document conflicts with the autobee README/source on **API
   signatures**, autobee wins. Fetch and verify before use; autobee is
   experimental ("Expect breaking changes", autobee@2.12.1
   `README.md:5`).
3. **Autobase is forbidden**: no dependency, no import, no docs framing.
4. Every deviation from this document goes to `DEVIATIONS.md` (terse: one
   paragraph per genuine deviation; implementation resolutions where this
   spec is silent go in code comments with source citations).

Sibling stack: `./vault-ld` (the Vault-LD implementation) shares this repo.
**Copy, don't depend** (owner directive): `@auto-okf/*` packages MUST NOT
import from `@autovault-ld/*`. Three deterministic modules are copied in
with a provenance header (`keyspace.js`, `canonical.js`, `revhash.js`);
everything else is written fresh on the same *patterns* — the designs below
name their vault-ld ancestors so the builder can steal knowledge, never code
paths.

## 1. Primary sources (required reading, in order)

- OKF `SPEC.md` v0.1 (local: `~/Git/GoogleCloudPlatform/knowledge-catalog/okf/SPEC.md`):
  bundle structure, concept documents, frontmatter, cross-linking, index/log
  files, conformance. Normative for everything materialize emits.
- autobee README **and source** (`https://github.com/holepunchto/autobee`,
  read `index.js`). The contract below is verified against the installed
  **autobee@2.12.1**, pinned at exactly `2.12.1` in
  `okf/store/package.json` (test: "the store pins autobee at exactly
  2.12.1" in `okf/test/store-deps.test.js`): a standalone multiwriter
  Hyperbee on hyperbee2 and hypercore 11, with no autobase dependency
  (autobee `package.json`). A citation such as
  `index.js:95` is relative to the autobee package root. `DEVIATIONS.md`
  ("Substrate behaviour that okf relies on") records each behaviour that
  okf relies on, with its source, and the parts of it that the README does
  not document.
  - Constructor: `new Autobee(store, key, handlers)`
    (`README.md:66-87`). The store passes `apply`, `open`, `update`,
    `encryptionKey`, `encrypted`, `keyPair`, `optimistic: false`,
    `bootstrapWeight: 0` and `fastForward: false`. The README does not
    list `bootstrapWeight` (`index.js:49`) or the value `false` of
    `fastForward` (`index.js:105-108`).
  - apply receives `(nodes, view, host)` (`README.md:74`,
    `lib/apply-view.js:17-19`), and only the nodes with a non-empty value
    (`index.js:1444`). A node carries `{ key, value, length, ... }`
    (`README.md:192-194`, `lib/writers.js:808-829`). `node.length` is the
    length of the writer's core after the node (`lib/writers.js:332`,
    `:571-579`, `:748`), so `node.length - 1` is its position (§3).
  - `view` is what the `open` handler returns (`README.md:75`,
    `lib/apply-view.js:8-10`). The store returns an adapter over the
    hyperbee2 bee, with `get`, `write()` batches of
    `tryPut`/`tryDelete`/`flush`, and `createReadStream` (below).
  - host (`lib/apply-calls.js:3-69`): core calls only
    `host.addWriter(key, { weight: 0 })` (§8). The README lists only
    `isIndexer` for it (`README.md:210-218`). The `weight` option is at
    `lib/apply-calls.js:33`. `host.removeWriter` is never called (§8).
    `host.ackWriter` is a deprecated no-op (`README.md:224-227`,
    `lib/apply-calls.js:44-47`). okf uses no other host call.
  - instance: `db.key`, `db.discoveryKey`, `db.id`, `db.local`,
    `db.view`, `db.writable` (`README.md:90-116`), `append(value)`
    (`README.md:122-124`), `update()`, `updated()`, `flush()`
    (`README.md:143-153`), `replicate(isInitiator | stream)`
    (`README.md:155-163`, `index.js:454-458`), `ready()` and `close()`
    from ready-resource (`index.js:35`, `:391-452`), and the `error`
    event (`index.js:669-690`). okf reads no undocumented autobee
    property.
- hyperbee2@2.20.1 source (range iteration surface — verify, do not
  assume classic hyperbee's `createReadStream` signature): `get`
  (`index.js:346`), `write()` (`index.js:151`) with `tryPut`, `tryDelete`
  and `flush` (`lib/write.js:46`, `:51`, `:84`), and `createReadStream`
  (`index.js:211`).
- corestore, hyperswarm READMEs. The corestore pin is exactly `7.16.1`
  (`okf/store/package.json`, test: "the store pins corestore at exactly
  7.16.1"). The floor is 7.12.6, the first release that
  honours a per-core `manifestVersion` (corestore@7.16.1 `index.js:714`).
  autobee asks for its system and view cores at manifest version 3
  (`index.js:213-221`), and its view encryption refuses a view core below
  version 3 (`lib/encryption.js:83-86`). `DEVIATIONS.md` records the
  evidence.

## 2. Architecture: the log is the source of truth

- **Source of truth:** the autobee op log (one input core per writer:
  autobee@2.12.1 `README.md:11`).
- **Generated faces:** (a) the OKF bundle on disk (markdown + frontmatter,
  `index.md`, `log.md`), (b) the queryable view (concepts, links, `wanted/`,
  flags).
- No component ever treats a generated face as authoritative. Human edits to
  the bundle re-enter as ops (§9). A face can always be regenerated,
  byte-identically, from a converged view (I9).

## 3. Op schema

All writes are semantic ops appended to the writer's own core, encoded with
hyperschema + hyperdispatch + compact-encoding. The wire contract is
append-only for the life of a vault (message ids and field orders never
reordered or removed; generated codec committed under `spec/`).

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

- Every op carries `clock` (the writer's observed vector clock, op payload)
  — required for causal revocation (§8; vault-ld §8.3 ancestry). Each
  entry is a position (below). The clock carries the self entry and an
  entry for each writer that §8 names. For such a writer, the entry is
  the last position of that writer in the issuer's folded view, that is
  its `seen/` value minus one. The self entry is the op's own position.
  The store builds every entry from okf's view and its own local core. It
  reads no substrate head.
- Every op carries `at`: the writer's wall-clock milliseconds at append
  time, encoded in the op payload. `at` is informational: never an input to
  merge, ordering, or conflict detection (I1); it is the sole source for
  `log.md` date headings (§9) and the `rev` record's `at` (§4, §5). Apply
  MUST NOT read any clock; a missing/garbage `at` materializes as
  `1970-01-01` rather than rejecting.
- `tag` (opId) = `writerKey || seq`, the OR-set observation token and audit
  handle. `tag` is **derived by apply** from the node (`node.key`, actual
  seq), never read from the payload; no op encodes its own tag. Only
  `RemTag.tags` and `ResolveConflict.keep`/`supersede` carry *references to
  other ops'* tags/hashes, and those are citations, not
  self-identifications.
- **The per-writer ordinal is the node's position.** The actual seq of a
  node is its 0-based position in its writer's core: `node.length - 1`.
  The transport documents `node.length` as the position in the writer's
  core (autobee@2.12.1 `README.md:194`), and sets it to the length of the
  core after the node (`lib/writers.js:332`, `:571-579`, `:748`). The
  position is unforgeable, the same on every peer, and stable under
  reorders. Apply MUST take the
  seq from the position for every node, whatever its disposition: for the
  `tag`, for `flag/rejected/<writerKey>/<seq>`, for the §6 mint, and for
  the §8 position rules (`seqAtRemoval`, `forged-clock`). Apply records
  the last position plus one in `seen/<writerKey>` (§4). A node that never
  reaches apply, such as an empty block, still takes a position: every
  node enters the substrate's system, and only a node with a non-empty
  value reaches apply (`index.js:1430`, `:1444`). So the seqs of one
  writer's ops can have gaps, and `seen/<writerKey>` can skip. A node
  without a positive integer `length` breaks the transport contract: apply
  throws, and the node is never an op rejection. The substrate then closes
  (`README.md:140-141`, `index.js:669-690`).
- The writer's store takes the seq of a new op right before it encodes
  the op: the length of its local core, or one past the seq of its
  previous append when that node is not in the core yet. A local node
  waits in memory until the substrate writes it to the core
  (`lib/writers.js:729-754`, `:768-789`). Its appends are serialized. The
  seq never depends on how far apply has folded the local core.
  `DEVIATIONS.md` records why the length gives the next position.
- Strings are NFC-normalized before keying, hashing, or comparison (§3.1 of
  the vault-ld spec is copied semantics; `canonical.js` is the copied code).
- Limits, fixed check order, single recorded reason. Pre-decode: op ≤
  64 KiB. Post-decode, fixed order: path ≤ 1024 bytes, depth ≤ 64.
  Undecodable/oversize ops are rejected into
  `flag/rejected/<writerKey>/<seq>` — apply MUST NOT throw.

## 4. View keyspace

One keyspace-encoded view (copied `keyspace.js`; escaping mandatory; user
strings never concatenate raw into keys):

```
c/<id>/meta                     { type, created: tag, deleted?: tag }
c/<id>/f/<key>                  frontmatter field state (LWW-array or OR-set element map)
c/<id>/path                     current path { path, tag, ord } — ord is the
                                global apply ordinal (count of nodes linearized
                                so far) at which this path was set (§7, I8)
c/<id>/body                     head revision pointer (revHash)
c/<id>/rev/<revHash>            immutable revision { base, text, writer, at }
revbybase/<id>/<base>/<rev>     base-keyed revision index (M1 ancestry: no O(R²)
                                scans) — a true top-level bookkeeping family,
                                trivially co-derived from c/<id>/rev/
path/<path>                     path -> id (current holder; collision losers flagged)
link/<from-id>/<to-path>        outbound links (extracted from body, §9)
bl/<to-id>/<from-id>            backlinks (resolved links only)
wanted/<path>/<from-id>         demand index: one key per unresolved referrer
                                (count = subkey count; NOT a flag — §9;
                                Special:WantedPages)
wantedrank/<inv-count>/<path>   derived rank index, rewritten on referrer-count
                                change (inv-count = (MAX − count) as a 16-digit
                                zero-padded decimal, MAX = 10^16 − 1, so an
                                ascending scan yields most-wanted first)
log/<ordinal>                   append-only narration records -> log.md (§9)
flag/conflict|clobber|staletag|pathcollision|writeafterdelete|undelete|rejected|squat/...
                                (no `copydetect` family: no op writes one —
                                copy-splits surface as an ingest event, §9)
seen/<writerKey>                last folded position + 1 (bookkeeping, §3)
gov/writer/<key>                { indexer, namespacePrefixes, rateCeiling }
gov/removed/<key>               revocation clock + seqAtRemoval (§8)
rate/<writerKey>                token-bucket state
```

Bookkeeping families (`seen/`, `rate/`, `revbybase/`,
`wantedrank/`) are included in the I2 view hash and excluded from
materialize.

Flag lifecycle: `conflict` clears only via `ResolveConflict` (§5);
`pathcollision` clears whenever the loser's claim ceases to collide — its
own subsequent `SetPath`, or the competing holder vacating by rename,
deletion, or its own collision loss (§7; apply recomputes this on the same
events as §9's late-binding link resolution); `clobber`, `staletag`,
`writeafterdelete`, `undelete`, `rejected`, and `squat` are
permanent audit records — no op or rule clears them.

## 5. Merge semantics: fixed defaults

There is no per-key policy dial (owner decision; the vault-ld policy-epoch
saga is the cautionary tale). The rules are frozen:

- **`tags`** (the OKF frontmatter key, and only it): **OR-set**. Concurrent
  adds union. `RemTag` cites every observed tag mapped to the value (client
  computes). The view keeps a removed-token set per (id, value): a citation
  of an already-removed token is a silent no-op (benign concurrent removes
  of the same tag never flag); a citation of a never-observed token is
  ignored for effect and recorded once under
  `flag/staletag/<id>/<value>/<tag>`. Concurrent add wins over
  remove-of-unobserved (SU-Set semantics; I5).
- **Every other frontmatter key**: **LWW-array register** under
  linearization order. Values are canonical arrays (possibly length 1),
  superseding atomically; one materialized YAML scalar when length is 1.
  An empty LWW state (e.g. a key removed via `SetField` with an empty
  array) materializes as the key omitted from frontmatter. A cross-writer
  supersession with a different value writes
  `flag/clobber/<id>/<key>/<tag>` (I4: the loser is auditable).
- **Reserved field keys**: `SetField` with `key` ∈ {`tags`, `_id`, `_rev`}
  (post-NFC, exact) is rejected (`flag/rejected`, reason `reserved-key`).
  Tag mutations travel only as `AddTag`/`RemTag`; identity and revision
  are never fields (§6; ingest obligations in §9).
- **Bodies**: every `SetBody` creates an immutable revision keyed by
  `revHash = SHA-256(len(base)||base||len(text)||utf8(NFC(text)))` (copied
  `revhash.js`), where `len()` is an **8-byte big-endian** length prefix
  (u64 BE) and a null base encodes as `len(0)` with eight zero bytes
  (distinct from any real hash) — this normative text mirrors the copied
  code; on discrepancy the copied code wins and DEVIATIONS.md records it.
  (Delivery correction: earlier drafts said "u32 LE"; the copied
  `revhash.js` uses u64 BE over the 64-char lowercase-hex base string, so
  the code — and this corrected text — wins.) Head pointer is LWW under linearization. Two
  revisions citing the same **non-null** base are true siblings: both
  retained, head deterministic, exactly one `flag/conflict/<id>/<a>/<b>`,
  cleared only by `ResolveConflict`. A null base is "no base cited": no
  mutual conflicts among independent creations (M1 ancestry — no
  N-choose-2 blowup).
- **Base discipline** (I4): a `SetBody` whose `base` is null **while a head
  exists** at its linearized position is treated as citing that head (it
  is an edit of *something*; the only flag-free fresh start is the
  concept's first revision). A `SetBody` citing a base hash absent from
  `c/<id>/rev/` is stored, flagged `flag/conflict/<id>/<head>/<new>`
  against the current head, and never becomes head until `ResolveConflict`
  selects it — fabricated ancestry cannot silently displace real ancestry.
  With no current head, the flag is `flag/conflict/<id>/-/<new>` and the
  concept materializes bodyless until `ResolveConflict`; the unknown-base
  rule subsumes the same-base sibling rule (one flag per revision against
  the head position, none pairwise among revisions citing the same unknown
  base).
- **`ResolveConflict`** is valid only if `keep` and every `supersede` entry
  exist under `c/<id>/rev/` and at least one cited flag is open; otherwise
  it is rejected (`flag/rejected`, reason `bad-resolve`). Effect: head :=
  `keep` (LWW-pinned at this position); cited `flag/conflict` entries
  clear. With `text` present, apply synthesizes one revision with
  `base = keep`, and that revision becomes head. A later `ResolveConflict`
  over the same (now-cleared) flags is rejected `bad-resolve`; resolution
  races converge by linearization: the first valid resolve wins, the loser
  flags.
- **`type`** (OKF's one required key): LWW-array like any other key;
  materialize emits the first element as the scalar `type`.
  `CreateConcept.type` seeds the `c/<id>/f/type` register at the create's
  linearized position; `c/<id>/meta.type` is a bookkeeping copy of the
  creation value, never read by materialize. Apply rejects any `SetField`
  on `type` whose value is an empty array or a sole empty string
  (`flag/rejected`, reason `empty-type`) — an empty `type` state is
  unreachable through accepted ops. `type: unknown` remains a
  materialize-only defensive fallback for corrupt state and writes nothing
  to the view (§7: materialize never writes the view).
- **`_id` and `_rev` are never merged**: `_id` is identity (§6); `_rev` is
  derived output, never stored as a field.

## 6. Identity: `_id` and `_rev` (the CouchDB homage)

- **`_id`** is the concept's stable identity: minted exactly once, opaque,
  never path- or content-derived. Mint = the creating op's `tag`
  (`writerKey || seq`, hex; `seq` is minimal lowercase hex, no leading
  zeros, `0` for seq 0) — or the squat-fallback id below when that tag-id
  is occupied. A `CreateConcept` with no explicit `id` mints; one carrying
  an id **adopts** it — an id the vault has never seen, supplied by ingest
  (§9, §10; this is what makes generation cycling identity-preserving). `_id`
  is unique per vault; equality asserts same concept, nothing else. It
  survives deletion (tombstones keep it).
- **Seen-id rule**: an **adopting** `CreateConcept` (explicit `id`) whose
  `id` is already present in `c/` is **rejected** (`flag/rejected`, reason
  `duplicate-id`) — creation never updates; `duplicate-id` rejection
  applies only to adoption. **Squats cannot block mints**: a
  `CreateConcept` **minting** (no explicit id) whose derived id
  `writerKey || seq` is already present in `c/` does not reject; it mints
  instead `SHA-256(writerKey || seq || k)` (64 hex; over the raw 32-byte
  writer key, u64 LE seq, u64 LE k) for the smallest `k >= 1` yielding an
  unseen id, and records the permanent audit flag
  `flag/squat/<squatted-id>/<tag>`. Creation by a genuine writer always
  succeeds; a squatter must spend one op per candidate and always loses.
  Only `SetField`/`AddTag`/`RemTag`/`SetPath`/`SetBody`/
  `DeleteConcept`/`UndeleteConcept`/`ResolveConflict` mutate an existing
  concept, and each is policy-checked against the concept's **current**
  path, never an op-claimed path. Adopted ids MUST match
  `^[0-9a-f]{2,128}$` after NFC. Because mint ids are `writerKey || seq`
  (both public, hence predictable), adoption of an id whose writerKey
  prefix equals any current or former writer's key with `seq >=` that
  writer's `seen/` value (its last folded position plus one, §3) is
  rejected (`flag/rejected`, reason
  `mint-collision-risk`), and an adopted id exactly equal to a 64-hex
  writer key is likewise rejected `mint-collision-risk` (empty seq
  suffix). Generation-cycle adoption never trips this rule because writer
  keypairs MUST NOT recur across generations (§10).
- **`_rev`** is the body-head revHash at materialization time, emitted into
  frontmatter. On ingest, an edited file's `_rev` is the `base` its
  `SetBody` cites — the file carries its own causal context. A stale `_rev`
  produces siblings + `flag/conflict`, never a rejection (we keep both;
  CouchDB would 409). Missing `_rev` (hand-authored): cite the current
  head. A concept with no revisions omits `_rev` from emitted frontmatter;
  ingest of a file without `_rev` over a concept without revisions cites
  `base: null`.
- Frontmatter emission order: `_id`, `_rev`, `type`, then remaining keys
  canonically sorted. OKF-conformant (§4.1 arbitrary producer keys; §9
  consumers must not reject).

## 7. Paths, renames, collisions (the Kleppmann rules)

- `path` is an **LWW register on the concept**, not identity (Kleppmann,
  PaPoC 2020: move-as-delete+reinsert duplicates under concurrency; position
  must be a register on stable identity).
- Paths are NFC-normalized, bundle-relative, forward-slash, no `.md` suffix
  stored. Reservation and collision checks compare **casefolded,
  NFC-normalized** components: terminal components casefolding to `index`
  or `log` are reserved by OKF §3.1 and rejected (`flag/rejected`, reason
  `reserved-path`), and the generated-face filenames (`index.md`, `log.md`)
  are members of every directory's casefold-collision domain — a concept
  can never clobber a generated face on any filesystem.
- **Rename + concurrent edit → merge** (the edit targets `_id`; it follows).
- **Rename + concurrent rename → linearization winner**, loser recorded in
  `flag/clobber/<id>/path/<tag>` (audit; `path` here names the §4 path
  register, `SetPath` not being a field — the `<tag>` component keeps the
  key unique even against a frontmatter field literally named `path`).
- **Two concepts on one path**: the concept whose current path-claim has
  the **lower `ord`** (§4 — the earlier claim under linearization) holds
  `path/<path>`; a later claimant is the loser (first-wins: a squatter
  cannot evict). The loser keeps its path value but materializes at a
  **deterministic conflicted-copy path**:
  `<path>.conflict-<first-8-hex-of-SHA-256(_id)>` (hash, not prefix: `_id`
  prefixes are shared by a writer's every mint) — byte-deterministic (I9),
  flagged `flag/pathcollision/<path>/<loser-id>`, narrated in `log.md`.
  The literal component pattern `\.conflict-[0-9a-f]{8,}$` (any terminal
  hex run of 8 or more) is **reserved**: `CreateConcept`/`SetPath`
  carrying it are rejected (`flag/rejected`, reason `reserved-path`), so
  neither the 8-hex landing path nor any longer fallback can be squatted.
  (Ingest of materialized conflicted copies never trips this: it strips
  the suffix before op generation — §9 conflict-copy awareness.) If two
  losers of the same path still hash-collide on 8 hex, extend to the full
  64-hex hash, and an occupied fallback extends the same way (occupation
  is only possible by another conflicted copy, the reservation covering
  every extension length); materialize MUST NOT emit two concepts to one
  file under any input. The flag clears whenever the loser's claim ceases
  to collide — its own subsequent `SetPath`, or the competing holder
  vacating by rename, deletion, or its own collision loss (§4 lifecycle).
- Path safety (vault-ld M5 ancestry): a path that escapes the bundle root
  or is absolute is rejected in apply (`flag/rejected`, reason
  `unsafe-path`). Case-fold (plus NFC) collision detection is performed
  **in apply, on every peer, unconditionally** — when a path's casefolded
  form equals another live concept's casefolded path (or a generated-face
  filename, above), the linearization loser gets `flag/pathcollision`
  exactly as for exact-path collisions and materializes at the
  conflicted-copy path on every platform. A casefold loser retains
  `path/<its exact path>` (it has no exact-path competitor): links to it
  resolve into `bl/`, and the emitted absolute link is expected to be
  broken on disk — OKF §5.3 tolerates dangling links (chosen over
  demotion to `wanted/`, which would make `wanted/` disagree with
  `path/`). Materialize itself never writes to the view. Lexical +
  realpath containment is re-checked at materialize
  time before any file write; a violation aborts that file's emission and
  is reported on the CLI only (it is unreachable if apply's path
  validation is correct, and is a bug, not state).
- **Subtree/directory moves do not exist in v1.** OKF has no directory
  object and no parent pointers: `path` is a flat absolute string on a
  stable `_id` (an LWW register, §7), and a "directory" is only a shared
  path prefix. A directory move is therefore expressible as N independent
  per-concept `SetPath` ops (prefix rewrite), each a plain LWW rename with
  the usual §7 collision/clobber resolution — no cycle can arise, because
  there is no mutable child→parent edge to redirect (the concurrent-move
  cycle problem of Kleppmann et al., IEEE TPDS 2021, applies only to
  explicit parent-pointer trees with a reparent op, which OKF does not
  have). What v1 lacks is atomicity: the N ops interleave, so a face may
  observe a half-moved directory. The v2 path is an atomic multi-concept
  path rewrite — a single batch op (`MoveSubtree { fromPrefix, toPrefix }`)
  expanded deterministically within one apply step (autobee `view.write()`
  batch: autobee@2.12.1 `README.md:203-205`, hyperbee2@2.20.1
  `index.js:151`); the relevant prior art is multi-key / read-atomic
  transactions, not replicated-tree move CRDTs.

## 8. Governance and the append-only guarantee

- **Append-only is a vault-metadata constant**, written at `init`, loaded at
  open, identical on every peer, and **not representable as an op**. There
  is no prune op, no byte-reclaiming op, no byte-destroying operation in the
  wire contract at all. `DeleteConcept` writes a tombstone: the concept
  disappears from materialize/`index.md`/`path/`, its bytes and `_id`
  remain. `UndeleteConcept` restores and writes `flag/undelete/<id>/<tag>`
  (audit). A write to a tombstoned concept lands and flags
  `flag/writeafterdelete` (I4).
- Governance ops (`AddWriter`, `RemoveWriter`, `SetWriterPolicy`) require an
  **indexer issuer**, checked in apply against `gov/writer/<issuer>` at the
  op's linearized position; violations are rejected (reason
  `policy-governance`) and change no `gov/` key. `host.removeWriter` is
  never called (below). The autobee grant of an `AddWriter` op does not
  depend on the op's disposition (the grant rule below). A `RemoveWriter` that
  would leave zero indexers is rejected (reason `policy-governance`) — a
  vault can never become permanently ungovernable. An `AddWriter` with
  `indexer: false` that would demote the last live indexer is rejected the
  same way. An `AddWriter` whose key is not 32 bytes is rejected
  `bad-writer-key`, and one whose `swarmKey` is not 32 bytes is rejected
  `bad-swarm-key`. Neither writes a `gov/` key
  (`okf/core/lib/apply.js:554-567`). An accepted `AddWriter` stores its
  `swarmKey` on `gov/writer/<key>`, and the swarm firewall of every peer
  admits that key (`okf/store/README.md`, Replication). Genesis: the vault
  creator's key is the first indexer, seeded deterministically.
- **Revocation is causal, in-band, never positional** (vault-ld B1
  ancestry, harness-proven): apply records `gov/removed/<key>` = the
  RemoveWriter's clock; a subsequent op from that writer whose clock does
  not strictly precede it is rejected (reason `revoked`).
  `host.removeWriter` is NEVER called — every node must keep linearizing on
  every peer so the clock rule can run uniformly. A substrate removal
  would stop the writer's ordinary nodes, the nodes without the
  optimistic bit, before apply (autobee@2.12.1 `lib/system.js:108-114`,
  `:246-250`, `index.js:1447`). It is not a complete apply filter.
  `canApply` returns true for a node with the optimistic bit before it
  reads the removal record (`lib/system.js:242-245`). The store's
  `optimistic: false` does not close that path for a removed writer.
  autobee applies the option only to its filter at `index.js:1357-1359`.
  A writer with a system record stays added there, also after a removal
  (`lib/writers.js:526-530`). `_processBatch` then passes the node's own
  bit to `canApply` (`index.js:1415`, `:1447`). The revoked
  writer's own store refuses further local appends. The claimed clock is
  cross-checked against unforgeable position: `gov/removed/<key>` also records
  `seqAtRemoval` = the revocation clock's entry for the removed writer,
  which is the last position of that writer that the remover had folded
  (§3). A node from that writer that sorts after the removal, and whose
  actual seq, its position `node.length - 1`, is above `seqAtRemoval`,
  is rejected (reason `revoked`) **regardless of its claimed clock**. The
  claimed-clock strict-precedence test applies only to the window of ops
  at `seq <= seqAtRemoval` that sort after the removal. Every entry of
  every clock is a position, so `seqAtRemoval` and the seq of an op have
  the same unit. Additionally, apply rejects any op whose claimed
  self-clock entry does not equal its actual seq, its position (reason
  `forged-clock`).
- **The revocation check binds only the ops that sort after the
  removal.** Apply runs it only when `gov/removed/<key>` exists at the
  op's linearized position (`okf/core/lib/apply.js:399-403`). Apply runs
  in the substrate's order (the order bullet below), and it cannot reject
  an op that sorts before the removal. **Revocation stops cooperating
  clients only. A revoked key with a modified client can keep writing
  until the next generation. Quorum-signed revocation epochs are the
  planned fix.** The mechanism: the client stamps its node below the
  `RemoveWriter`'s timestamp and leaves the removal out of the node's
  links. The node then sorts before the removal on every peer
  (autobee@2.12.1 `lib/topo.js:168-179`), and its op takes effect. No
  `flag/rejected` entry records it. okf cannot stop that without changing
  autobee. The store of a revoked writer refuses its own appends
  (`VAULT_REVOKED`, test "writer add/remove round trip: causal
  revocation, uniform on every peer"), so a cooperating client stops.
  `SECURITY_MODEL.md` (the trust model, G5, G34) states the residual and
  the eviction ladder.
- **Re-admission.** An accepted `AddWriter` that names a revoked writer
  deletes `gov/removed/<key>` (`okf/core/lib/apply.js:579-581`). From
  that position on, the writer's ops pass the revocation check. That
  includes an op that the writer made while it was partitioned from the
  removal, when the op sorts after the re-admission. Such an op is
  concurrent with the revocation, every peer decides it the same way,
  and I10 holds.
- **The clock carries self and the writers with a `gov/writer` record.**
  The store puts the self entry into the clock of every op. It also puts
  an entry for each writer that has a `gov/writer/<key>` record and a
  folded op in its view, and for no other key. Only an indexer's
  `AddWriter` writes that record. So the grant rule below can make a key
  an autobee writer, but that key is not clocked until an indexer admits
  it. The count of its ops in the view does not change this. The size of
  a clock is bounded by the writers that indexers admitted, and no member
  can push an honest op above `maxOpBytes` (§3). Apply accepts a clock
  with no entry for a writer that has no `gov/writer` record. No rule
  above needs such an entry:
  - `forged-clock` reads only the self entry, and every clock carries it,
    also the clock of a writer with no record.
  - `seqAtRemoval` reads the entry of the removed writer. If the
    remover's view has no `gov/writer` record for the target, the entry
    is absent and `seqAtRemoval` is -1, so that target has no window. The
    result is the same as with the target's last folded position. Each op
    of the target that the remover folded is a causal ancestor of the
    `RemoveWriter` node, so the substrate sorts it before the removal. The
    substrate processes a node only once every node that it links is in
    the system, and sorts it after them (autobee@2.12.1
    `lib/writers.js:603-606`, `lib/topo.js:109-150`).
    Each op of the target that sorts after the removal comes later in the
    target's core, so its seq is above that position, and apply rejects it
    `revoked`.
  - The strict-precedence test compares every entry. Apply never deletes
    a `gov/writer` record, so a revoked writer stays in the clock. If it
    left, an in-flight op could cite a writer that a later revocation
    clock omits. The test would then reject that op, although its clock
    precedes the revocation (I10).
  - Two views can disagree on an admission, because a reorder can flip
    the outcome of an `AddWriter`. Then an op's clock can carry an entry
    that the revocation clock omits, and the test fails. So such a
    difference can reject an op in the window, and it never admits one.
- **An autobee grant follows every `AddWriter` op.** Apply MUST call
  `host.addWriter(key, { weight: 0 })` for every `AddWriter` op it folds,
  whether it accepts or rejects the op. The call comes right after a
  successful decode, before every check that can reject the op: the §3
  post-decode limits, `forged-clock`, the revocation check, the
  indexer-issuer rule and the rate check. Those checks read the op's
  linearized position, and a reorder can flip their outcome. The grant
  reads the op bytes alone, so every peer makes it in every order, and no
  reorder undoes it. Only a 32-byte key is granted: autobee@2.12.1 copies
  the key into a fixed 34-byte system key (`lib/encoding.js:64-69`). The
  weight is explicit and uniform, 0 for every writer, never autobee's
  default `isIndexer ? 2 : 1` (`lib/apply-calls.js:33`). A grant at 0
  changes no weight and opens no promotion (`lib/system.js:75-88`,
  `lib/promotions.js:111-113`). The store constructs autobee with
  `bootstrapWeight: 0`, so genesis stands at 0 too (`index.js:49`,
  `:1411-1413`). The grant makes the key an autobee writer, so its nodes
  reach apply on every peer (`index.js:1359`, `:1474-1477`,
  `lib/system.js:242-251`). It confers no okf membership: **okf
  membership comes only from `gov/`**, which apply decides. A granted key
  with no `gov/writer/<key>` record has each of its ops rejected, with a
  flag (I4). A content op that passes the earlier checks is rejected
  `not-a-writer`, and a governance op is rejected `policy-governance`
  (below, `okf/core/lib/apply.js:407-426`).
- **Admission comes before effect.** A writer's ops take effect only once
  an indexer-authored `AddWriter` naming its key has admitted it, at that
  op's linearized position. The genesis indexer is the one writer admitted
  without an `AddWriter` (seeded, above). A content op from a writer with
  no `gov/writer/<key>` record at the op's linearized position is
  rejected (`flag/rejected/<writerKey>/<seq>`, reason `not-a-writer`,
  `okf/core/lib/apply.js:426`). Each earlier check below can reject it
  first. It never reaches the content pipeline,
  takes no rate token, and mutates no `c/` key (I10). `seen/<writerKey>` moves past it
  (§3), so the §6 `mint-collision-risk` rule protects that key's future
  mints. Admission is not retroactive: the `AddWriter` revives none of the
  writer's earlier rejected ops, and only its later ops take effect. The
  check has a fixed place in apply's single-reason order. It runs after
  the §3 limits, the `forged-clock` check and the revocation check, which
  bind every op. It runs after the indexer-issuer rule above, so a
  governance op from such a writer is rejected `policy-governance` (it is
  not an indexer, `okf/core/lib/apply.js:407-412`). It runs before the
  rate check. The store constructs autobee with `optimistic: false`, so
  autobee drops every node of a writer that it has not added before apply
  (autobee@2.12.1 `index.js:95`, `:1357-1364`). The store refuses an append until
  `db.writable` is true, that is until autobee has added the writer
  (`README.md:114-116`, `index.js:196-198`). `db.writable` signals this
  substrate admission only. It is not okf membership. Every folded
  `AddWriter` grants its key, a rejected one too (the grant rule above,
  `okf/core/lib/apply.js:375`). So a writer that is not an indexer can
  make a key writable with an `AddWriter` that apply rejects
  `policy-governance`. A member can also forge an approval that names a
  key, and autobee then adds that key at weight 0 (`index.js:1432-1441`,
  `lib/system.js:75`). The appends of such a key then resolve, and apply
  rejects each of its ops. Only an `AddWriter` that apply accepts writes
  the `gov/writer/<key>` record (`okf/core/lib/apply.js:554-575`), so only
  it grants okf membership and lets the key's content ops take effect.
- **Order.** Every writer stands at weight 0, so autobee orders nodes by
  timestamp, then writer key, then length (autobee@2.12.1
  `lib/topo.js:168-179`). A writer stamps a node with its own wall clock,
  and never below the newest node that its system holds (`index.js:1540-1543`,
  `lib/system.js:233`). So concurrent writes sort by the clocks of their
  writers, and a writer with a slow clock loses each LWW race (§5)
  against a concurrent write. A peer does not process a node whose
  timestamp is more than two hours past the peer's own clock
  (`lib/writers.js:15`, `:595-597`, `:649`). That node waits, with each
  node that links it, until the peer's clock reaches it. autobee bounds no
  timestamp in the past, so a writer can choose where its node sorts
  (test "A7b G5: a member backdated node flips the winner on every peer
  (residual)"; `SECURITY_MODEL.md`, G5). The op field `at` (§3) orders
  nothing.
- Rate limiting is a writer-local token bucket (vault-ld §8.5 ancestry —
  never a global window): each writer's bucket gains 1 token per accepted
  op *authored by any indexer*, capped at that writer's `rateCeiling`.
  Buckets start full (at ceiling) at admission, and the genesis indexer's
  bucket starts full at its first op — the accept/reject partition is
  pinned, not implementation-chosen. A writer's ceiling is the
  `rateCeiling` of its `gov/writer` record (`SetWriterPolicy`), else the
  pinned `rate.defaultCeiling`, which is 1024 unless the metadata at
  `init` sets another value (`okf/store/lib/metadata.js:52-59`,
  `okf/core/lib/apply.js:491-494`). So a writer that is not an indexer has
  a budget of 1024 ops by default, and only accepted indexer ops refill
  it. An indexer's accepted op takes one token and adds one to every
  bucket, its own too (`okf/core/lib/apply.js:473-482`, `:496-512`).
  Test: "I10: token buckets refill from accepted indexer ops".
- `encryptionKey` (+ `encrypted: true`) supported end to end: autobee
  encrypts the writer cores, the system and the view (autobee@2.12.1
  `README.md:308-320`, `index.js:52`, `:219`, `:263`). The view needs
  corestore 7.12.6 or later (§1).

## 9. Faces

**materialize(dir)** — walk `c/` and emit an OKF-v0.1-conformant bundle:
- One markdown file per live concept at its path (`<path>.md`), frontmatter
  per §6 ordering, body = head revision text. Conflicted copies per §7.
- **`index.md` per directory** (derived, never authored): OKF §6 structure —
  frontmatter only at bundle root (`okf_version: "0.1"`). Structure,
  normative: optional root frontmatter, then a single section heading
  `# Contents`, then one bullet per child:
  `* [<title frontmatter, else terminal path component>](<entry>) - <description>`
  — the ` - <description>` clause omitted entirely when `description` is
  absent. `<entry>` is the child's path relative to the directory (concept:
  `<name>.md`; subdirectory: `<name>/`). Concepts first, then
  subdirectories, each group in canonical byte order of the link target.
- **`log.md` per bundle root** (derived, never authored): OKF §7 structure —
  shape pinned: one `# Update Log` title, then `## YYYY-MM-DD` UTC date
  headings (OKF §7 MUST), newest first, entries
  generated from the `log/` family: creations, renames (old → new),
  deletions, undeletions, conflict resolutions and path collisions
  (`okf/core/lib/apply.js` events, `okf/faces/lib/materialize.js:618-648`).
  A generation writes no entry (§10). The narration is a
  *projection of the actual op log* — auto-okf's structural upgrade over
  hand-maintained convention. Dates come from each op's `at` field (§3),
  truncated to UTC `YYYY-MM-DD` (informational, never used for merge);
  entries are deterministic given a converged view (I9). Entries group by
  UTC date, headings descending; within a heading, ordinal descending;
  entry links are absolute bundle-relative. Forged-future dates are an
  accepted cosmetic consequence of informational timestamps.
- YAML emission is pinned: scalars double-quoted iff YAML would otherwise
  reinterpret them; flow-style lists; LF line endings; trailing newline.
  Cross-implementation byte-identity and OKF §9(1) parseability depend on
  this.
- Materialize reconciles the directory to the view **through an emission
  manifest**, never by blind mirroring: it records, in peer-local state
  outside the view, the (path, content-hash) set it last emitted. After
  emission, the only removal candidates are manifest-tracked files not
  produced by this run whose current bytes still match their manifest
  entry (prior conflicted copies, prior paths of renamed concepts,
  per-directory `index.md` for directories that ceased to exist); empty
  directories are then removed. A `.md` file whose current bytes differ
  from its manifest entry — or that has no entry (human-authored, not yet
  ingested) — is **never deleted or overwritten**: it is left in place,
  reported as pending-ingest (an ingest candidate, surfaced on the CLI as
  a `notice:`, never an `error:`), and the run exits 3 — pending-only:
  everything owned was projected; a clean run exits 0, a real failure
  (I/O, corrupt vault, bad args, an unsafe path) exits 1 (ADR-004) —
  unless ingest is run first (`materialize --force-mirror` restores
  unconditional mirroring for operator use). Stale files (derived faces a
  human edited) are likewise a notice accompanying exit 0/3. Deletion honors the same containment checks as writes.
  The ingest watcher treats manifest-gated reconciliation deletions as
  materialize-authored (in-flight-lock coordination), never as human
  deletes. Converged-peer I9 is judged on the emitted set; pending-ingest
  files are transient local state that becomes ops.
- Atomic writes (temp + fsync + rename), containment checks, per-path
  in-flight locks (vault-ld §9.4 ancestry).
- Byte-deterministic: converged peers emit identical bundles (I9).

**Ingest watcher** — human edits re-enter as minimal ops:
- Frontmatter diff per key against view state (never whole-file ops):
  changed key → `SetField`/`AddTag`/`RemTag`; removed key → `SetField`
  with empty array; body diff → one `SetBody` citing the file's `_rev`.
  Ingest strips `_id`/`_rev` from the frontmatter diff before op
  generation (they are identity and derived output, never fields — §5),
  and translates a *removed* `tags` key into `RemTag` ops citing every
  currently observed token (never `SetField` on `tags`).
- `_id` rules: known `_id` at a new path → `SetPath` (a real move); same
  `_id` seen at two paths → copy detection is deterministic: the file at
  the `_id`'s current view path (if present) is the original; otherwise
  the casefolded-lexicographically-first path is; every other file is a
  copy (mint fresh via `CreateConcept`). **Delivered:** the split is
  surfaced as a `'copy'` watcher event, **not** a `flag/copydetect` view
  row — the 12-op wire contract (§3) has no op that writes a `copydetect`
  flag, and recording one would require a new core op (out of v1 scope).
  The identity outcome is exactly as designed: the copy gets a fresh `_id`,
  the original keeps its path.
  Missing `_id` → mint (`CreateConcept`); the minted `_id` is **not**
  rewritten into the just-read file by the watcher (an echo hazard
  mid-settle) — it lands on the next `materialize`, which regenerates the
  file with the deterministic `_id`/`_rev` stamped in (bytes match the
  emission manifest, so the overwrite is permitted, not blocked as
  pending-ingest). Net effect is identical: the file ends up carrying its
  `_id`. `_id` present but
  unknown to this vault → **adopt** it (`CreateConcept` with the supplied
  id, subject to the §6 seen-id and mint-collision rules) — the
  generation contract (§10: import adopts every `_id` of the face).
- Conflict-copy awareness: a file whose terminal component matches
  `\.conflict-[0-9a-f]{8,}$` ingests at the **suffix-stripped path**.
  Known `_id` whose view path equals the stripped path → no `SetPath`
  (the file is the loser's materialized face; body/frontmatter diffs
  ingest normally). Unknown `_id` → `CreateConcept` at the stripped path;
  the collision re-manifests under §7's ordinary rules, and the loser
  re-flags and re-materializes at a conflict path. The import of a face
  (§10) takes no conflicted copy: it refuses a face that holds one, so a
  collision is resolved in the face before a generation.
- File deleted on disk → `DeleteConcept`, behind a confirmation guard
  (default on). **Exception (delivered):** a deleted file whose terminal
  component matches `\.conflict-[0-9a-f]{8,}$` is **not** a
  `DeleteConcept` — a conflicted copy is a transient materialized face, not
  the concept's canonical location, so the watcher skips deletion (emitting
  a `'delete-skipped'` narration, reason `conflict-copy`); otherwise
  removing a loser's face would delete a live concept the next
  `materialize` immediately re-emits. Deleting the winner's canonical file
  still deletes the concept behind the confirmation guard.
- **Live-watcher deletion ordering (issue #30).** A vanished path MUST NOT
  emit `DeleteConcept` from the event that noticed it: it is queued and
  drained only once the watcher is quiet (no pending debounce timers, no
  in-flight ingest). A moved file's new path therefore ingests first, and
  its `SetPath` vacates the old `path/` claim, so the drained delete finds
  no holder and emits nothing — `scan()`'s ingest-before-delete order,
  event-driven. A file that truly vanished still deletes (behind the
  guard) one quiet window later.
- **Tombstoned `_id` on disk is intent-to-keep (issue #30).** A file whose
  known `_id` resolves to a tombstoned concept MUST make ingest emit
  `UndeleteConcept` before any other op for that file, so the follow-on
  `SetPath`/`SetBody` land on a live concept; apply records the permanent
  `flag/undelete` audit row. Conflict copies are exempt — a transient face
  never resurrects the concept it mirrors (same rationale as the deletion
  skip above). The deterministic core is deliberately unchanged: apply
  never auto-resurrects on `SetPath` (any straggler rename from any writer
  would make deletion impossible to make stick, and replay semantics of
  existing logs would shift); a write to a tombstone still
  lands-and-flags (§8). Intent-to-keep is decided at the ingest layer
  because that is where the evidence — the file's presence on disk —
  lives.
- **Directory watch events MUST rescan, never drop.** A non-`.md` watch
  path that stats as a directory — or no longer exists (renamed away) —
  schedules one coalesced `scan()`: macOS delivers a subtree move as
  directory-rename events only, never the nested new `.md` paths, so
  dropping non-`.md` events loses the move entirely (issue #30). `scan()`
  is lossless by construction (ingest-first, then vacated-path deletes).
- Links: standard markdown links per OKF §5 (absolute bundle-relative
  preferred); extraction feeds `link/`, `bl/`, and `wanted/`. **A link
  whose target path does not resolve goes to `wanted/` — the ranked demand
  index — and never to `flag/`** (OKF §5.3; Cunningham's Incremental
  principle; owner decision). `wanted/` is queryable ("what does the graph
  want written?"), ranked by referrer count via `wantedrank/` (§4), and an
  entry clears when a concept lands on that path.
- Link resolution is **late-binding and recomputed**: on every op that
  changes any concept's current path or liveness (`SetPath`,
  `DeleteConcept`, `UndeleteConcept`, collision win/loss), apply
  re-resolves affected `link/` edges — edges to a vacated path demote from
  `bl/` back to `wanted/`; edges to a newly occupied path promote. I8 is
  the definition; any event narration is an optimization of it.
- Extraction, normative: CommonMark inline and reference links only (no
  autolinks, no images), skipping fenced/indented code and inline code
  spans. Targets with a URI scheme or protocol-relative form are
  citations, ignored. `/`-prefixed targets are bundle-relative; other
  targets resolve against the source concept's current path directory with
  `.`/`..` normalization; a resolution escaping the bundle root is
  ignored. Strip one trailing `.md`, strip any fragment (`#...`),
  NFC-normalize; the result keys `link/`. A `SetPath` on a concept re-runs
  resolution of its own relative-form edges.
- **Oversize preflight (ADR-005).** A file whose body would exceed the §3
  `maxOpBytes` limit is refused at ingest, by name, with the limit and the
  actual size, before any op for that file is appended; sibling files in
  the same run are unaffected. Apply's `oversize-op` reject stays
  untouched — validate at the boundary, defend in depth.
- **Pending files (D-055 Q2, D-060 F04).** A file with no `_id` of its
  own (a note without `_id`, or a copy) gets its concept from its ingest,
  and its `_id` only when materialize stamps it, after the ingest
  completes. An ingest that core rejects in part, or that throws, leaves
  the file pending. So ingest records the concept of each pending file in
  the peer-local file `<bundle>/.okf-pending.json`: the file's path, the
  sha256 of the bytes of that ingest, and the concept's path in the view
  then (`at`). A later ingest takes the recorded concept where it would
  mint or split a copy only on evidence that the file is the same: the
  file at the recorded path, or a file at another path with the same
  bytes while the recorded path is gone from the disk (a rename: the
  ingest moves the concept). It never takes a concept that is not live at
  `at`. A record whose file a delete pass found gone, and that deleted
  nothing, takes back only the same bytes at its path. The record of a
  concept goes when an ingest of its file or of the concept completes, or
  when the delete of the file takes effect. `scan()` tries the delete of
  each path that the emission manifest or the pending record lists and
  the disk no longer holds, and the delete of a pending path deletes the
  recorded concept, behind the confirmation guard.
- **Path-scoped one-shot ingest (ADR-001).** The one-shot scan set is the
  whole bundle, restricted to the argument set when trailing
  bundle-relative paths are given (concurrent-writer politeness: one
  agent's ingest never sweeps up another's mid-write pending file). A
  named path that does not exist, or that resolves outside the bundle
  root, is an error — exit 1, path named, zero ops appended. The
  zero-path form is byte-identical in behavior to the full scan.
- Debounce, write-settle, in-flight-lock coordination with materialize.
- `index.md`/`log.md` are reserved: edits to them are ignored (regenerated
  faces), with a single narrated log entry.

**Per-file state vocabulary (ADR-002)** — the states implicit in the
materialize/ingest rules above are named contract, reported read-only by
the CLI `status` command (appends no ops, writes no files, touches no
manifest): `in-log` (on-disk bytes match the log's canonical projection —
hash match), `pending-ingest` (hand-authored, not yet in the log; ingest
would establish a concept), `dirty` (in the log but on-disk bytes diverge
from the projection — a hand edit ingest folds in as diffs, or a log that
moved past the last materialize), `absent` (in the log, missing from disk;
materialize would restore), `foreign` (not in the log, not
manifest-tracked, not establishable by ingest — e.g. another writer's
mid-write WIP).

## 10. Generations: materialize, then import (the CouchDB homage, part two)

Byte reclamation is an **operator act via the face**, never an op. A
generation is two commands:

1. `auto-okf materialize <dir> <face-dir>` writes the face of the live
   vault (live heads + `_id`/`_rev`; tombstoned concepts suppressed; a
   path-collision loser as a conflicted copy, §7). For an encrypted vault
   the face is the plaintext export, and materialize says so (decision 8).
   It also marks that face: before its first plaintext write it writes the
   file `.okf-encrypted` at the root of `<face-dir>`, and it never removes
   it.
2. The operator resolves in the face what must not cross. Each conflicted
   copy gets a path of its own, or is merged and removed. A note can be
   removed. The face shows only the head body of each concept, so an open
   body conflict is resolved in the vault before step 1 (`auto-okf flags
   <dir> conflict`, then `auto-okf resolve`).
3. `auto-okf import <face-dir> <new-dir> [--encryption-key <hex64>]
   [--metadata <okf-vault.json>] [--predecessor <vault-key>]` creates a
   fresh vault in `<new-dir>` with the rules of `init`, and fills it from
   the notes of the face with **`_id` adoption** (§6, §9). The face is
   inert source: import reads it once, writes nothing to it and opens no
   predecessor vault. So no stage, no verification copy and no live
   predecessor exist.
4. The old vault is archived or destroyed out-of-band.

Within a generation the log only grows (§8). So a generation is also the
one way to redact. The new vault holds only what the face holds. The old
log stays on every replica of the old vault until each replica is
destroyed.

Rules of import (`okf/faces/lib/import.js`, `IngestWatcher.importNote` in
`okf/faces/lib/ingest.js`):

- **Refusals, before any write, each by name.** A `<new-dir>` that is
  pinned, not empty, or not a directory (a store there would take the
  import or the key). A face that holds a `.conflict-<hex>` note (a
  collision is still open), a note at a reserved `.okf-` name, or an entry
  that is not a regular file or a directory, such as a symlink. A
  missing `--encryption-key` for a face that holds `.okf-encrypted`, or
  with `--metadata` of an encrypted predecessor
  (`IMPORT_ENCRYPTION_KEY_REQUIRED`): a generation of an encrypted vault is
  never unencrypted (decision 8). The mark is in the face, so the refusal
  needs no `--metadata`, and no flag turns it off.
- **One import holds `<new-dir>`.** Before it creates the vault, import
  creates the claim file `okf-import-claim` in `<new-dir>` with an
  exclusive open, and it removes the claim when it ends. A second import
  into the same `<new-dir>` refuses by name (`IMPORT_DIR_CLAIMED`) and
  removes nothing (`okf/faces/lib/import.js:42`, `:91-94`; test
  "G3-P8 F01 (T24): a second import into the same <dir> refuses by name
  before its initBundle and deletes nothing; the vault, pin and files of
  the first import stay, for an absent and an existing empty <dir>").
- **Import-mode ingest.** import reads every regular `.md` file of the
  face at any depth, dot segments included, except the regenerated faces
  `index.md` and `log.md`. It ignores the emission manifest of the face:
  the manifest is materialize's peer-local echo suppression, and a check
  against it would skip every note as a self-echo. It ignores the pending
  record of ingest (`.okf-pending.json`, §9) too: that is state of a live
  directory, not of a generation. It treats every `_rev`
  as absent: in the fresh vault no base exists, so each head is the
  concept's first revision (`base: null`), the only flag-free fresh start
  (§5), and `_rev` re-derives (§14). After one generation every head is
  `base: null` already, so a later generation keeps `_rev` too. Each op
  is checked against `maxOpBytes` as encoded, before it is appended, and
  an op that core rejects fails the import by name.
- **Fresh writer keypairs.** A writer keypair MUST NOT recur across
  generations. Otherwise adoption of the predecessor's mint-shaped ids is
  rejected `mint-collision-risk` (§6) and I11 is unachievable. The store
  derives writer cores under a per-generation corestore namespace recorded
  in vault metadata (`generation`), and import needs a new or empty
  directory.
- **Metadata.** `--metadata` carries `limits`, `rate` and `schemaVersion`
  from the predecessor's `okf-vault.json`, so a note that fitted the
  predecessor's limits fits the new vault's. It never carries the `swarm`
  allowlist (`okf/faces/lib/import.js:44`, `:380-390`): a generation is
  the eviction point. The new vault's invite lists only the swarm key of
  the peer that ran the import, and an indexer admits each writer again
  (`add-writer --swarm-key`). `--predecessor` records
  `predecessorKey`, the generation chain. The generation id is `'root'`
  without a predecessor, else `sha256(predecessorKey bytes)`. A joiner
  needs the new `okf-vault.json` as its invite metadata to derive the same
  namespace. The chain is the operator's claim: it is unsigned, okf never
  verifies it, and it is provenance metadata, not proof. Consumers MUST
  treat cross-generation identity as trusted-operator scope. No generation
  entry is written to the new vault: the chain is `predecessorKey`, and
  the new `log.md` narrates creations only.
- **The fidelity check.** After the import, the notes that a materialize
  of the new vault would write (its byte plan, in memory) must equal the
  notes read from the face, byte for byte, without each `_rev` frontmatter
  line. `index.md` and `log.md` are regenerated faces that import never
  reads, so the check leaves them out. A difference fails the import by
  name (`IMPORT_FIDELITY`, each difference listed). No verification copy
  is written to disk.
- **Cleanup on a failure.** Some failures come once the new vault exists:
  `IMPORT_FIDELITY`, `IMPORT_OVERSIZE`, `IMPORT_REJECTED` and
  `IMPORT_NOT_ENCRYPTED`. On each, import closes the new vault. It removes
  what it created while it held the claim, and then the claim. A `<new-dir>` that
  import made is removed. An existing empty `<new-dir>` stays, empty
  (`okf/faces/lib/import.js:96-104`; test "T13 (T24): a truncated note
  fails the import by name with IMPORT_FIDELITY, and import removes the
  new directory").
- **Encryption.** `--encryption-key` encrypts the new vault. import reads
  plaintext and writes none, so it prints no plaintext warning.

Effect: live state and identity survive; history (old revisions, per-op
attribution, clocks) is shed by design. State- and identity-fidelity
across a generation is an acceptance criterion (§14).

**`materialize` reports every value that the face cannot hold. An
operator fixes those values before `import`.** The face cannot hold some
values that the view can: a scalar `null` is omitted, only the first
`type` value is written, and a reference or an object is written as a
string. import cannot see such a change, because it reads only the face.
So materialize parses each note that it renders back, reads each field the
way ingest reads it, and compares it with the view. Each difference is in
`report.lossy` as `{ id, path, key, before, after }`. A path is such a
value too. Two spellings that fold together (NFC, then lowercase), such as
the directories of `Notes/a` and `notes/b`, are one directory on a
case-insensitive file system, such as APFS, the macOS default. There the
import gives each note the spelling that was written first, and
materialize writes in byte order. So materialize groups the directory
prefixes and the note paths by their folded form. For each note whose
path changes under the first spelling in byte order, `report.lossy` holds
an entry with the key `path`: `before` the concept's path, `after` the
path that the note gives back. The report reads no disk, so it is the same
on a case-sensitive file system. `auto-okf materialize` prints a warning
for each entry and exits 1. The operator changes the value in the vault
to one that the face can hold, and materializes again, before the import
(`okf/faces/lib/materialize.js` `lossyFields`, `lossyPaths`).

## 11. Invariants (the test suite maps to these)

- **I1 Determinism:** apply is a pure function of the linearized op
  sequence. No wall clock, no randomness, no map-iteration order, no
  peer-local reads.
- **I2 Convergence:** peers that exchanged all ops have bit-identical views
  (full range-scan hash).
- **I3 Rebuild equivalence:** from-scratch rebuild equals incremental view.
- **I4 No silent loss:** no op's effect disappears without a flag
  (clobber/staletag/conflict/pathcollision/writeafterdelete/rejected).
  `wanted/` entries are NOT loss (they are demand).
- **I5 OR-set law** (tags): concurrent add + remove-of-unobserved → present.
- **I6 LWW law:** register outcome depends only on linearized order.
- **I7 Conflict lifecycle:** same-non-null-base siblings persist until
  `ResolveConflict`; `wanted/` entries clear when their path materializes;
  pathcollision flags clear when the loser gets a free path.
- **I8 Index coherence:** `path/`, `link/`, `bl/`, `wanted/`,
  `wantedrank/`, `revbybase/` are exactly derivable from `c/` at every
  quiescent point — `path/` winner selection uses the `ord` recorded in
  `c/<id>/path`, so derivability requires no information outside `c/`.
- **I9 Face determinism:** converged peers emit byte-identical bundles
  (including `index.md`, `log.md`, conflicted copies).
- **I10 Governance:** ops from a writer with no `gov/writer/<key>` record,
  revoked-writer ops after the causal revocation point, unauthorized
  governance ops, and policy-violating ops never mutate `c/`; the
  applied/rejected partition is replay-stable.
- **I11 Roundtrip:** materialize, then import into a fresh vault (a
  generation, §10), preserves every live concept's `_id`, `type`, fields,
  tags, path, and head body byte-for-byte. `materialize` reports every
  value that the face cannot hold, a path that a case-insensitive file
  system cannot hold too, and an operator fixes those values before
  `import` (§10).

## 12. Non-goals (v1)

No RDF/Turtle/SPARQL. No per-key merge policy. No subtree-move atomicity.
No text CRDT for bodies. No HTTP API. No vlurp codebase changes. No
`viz.html`.

**Known limitations (v1)** — determinism (I1/I2/I10) holds throughout; these
are honest scale/edge caveats recorded by the delivery (`DELIVERY.md`,
`../orchestration/BACKLOG.md`), not correctness gaps:

- **C1 — soak memory/liveness under sustained flood (scale limit, not a
  determinism issue).** Under a ~22-min sustained lossy flood with
  backpressure on, RSS grew without plateau (~3.1 GB) and a lagging peer
  failed to converge inside a 5-min heal window. Liveness/throughput is the
  affected axis — caught-up peers stay byte-identical, no divergent view
  hash, FDs flat, no crash. It is substrate-entangled (autobee under
  flood; UNVERIFIED against the autobee@2.12.1 source, which states
  nothing about memory under load); the okf-attributable lead is
  uncoalesced OR-set add-tokens (§5 `tags`). A fix is architectural and
  risks determinism on green code, so it is deliberately deferred;
  sign-off pending. These figures come from the v1 milestone of
  2026-07-14 (`DELIVERY.md`), on the substrate release of that milestone.
  This document states no figure for autobee 2.12.1.
- **P4 — empty-string `type` on ingest.** Apply already rejects an empty
  `type` register at the op level (§5, reason `empty-type`); the ingest edge
  around an empty-string `type` in an authored file is a documented
  minor.

## 13. Deliverables

```
okf/core       ops, wire codec, apply, keyspace (copied), canonical (copied),
               revhash (copied), memview test double
okf/store      vault lifecycle on autobee, metadata pinning (incl. the
               append-only constant + generation chain), governance plumbing,
               swarm replication, backpressure option
okf/faces      materialize (bundle + index.md + log.md), ingest watcher,
               wanted index, the import of a face into a new vault (§10)
okf/cli        init, join, add-writer, remove-writer, materialize, ingest
               (optionally path-scoped, ADR-001), watch, status (ADR-002),
               wanted, flags, resolve, undelete, import
okf/root       the `auto-okf` root placeholder package (published as
               auto-okf@0.0.1 alongside the scope — intent D7)
okf/test       unit + invariant suite (I1..I11 each ≥ 1 test)
examples/agent-session/    flagship: multi-agent findings/determinations/RFC
                           bundle, partitioned + healed, ThreadMode→DocumentMode
examples/slop-archive/     durable LLM-output archive (append-only shown off)
examples/vlurp-library/    one script: vlurpfile → staging → _id-stamped bundle
```

Node 20+, plain JS, pnpm workspace (`vault-ld/*` + `okf/*`), **node:test
only** (owner mandate — the Node core test runner `node --test`; the
Holepunch brittle/bare convention is not used, and library packages import
no test runner, so substrate compatibility is unaffected),
usage-first READMEs per package plus example READMEs. Package names
`auto-okf` (root) and `@auto-okf/{core,store,faces,cli}`.

## 14. Acceptance

Complete when: I1..I11 each pass; the multi-process harness matrix (fault
proxy, partitions, permutation replay — retargeted from `/harness`) is green
at clean/lossy/partitioned; a generation (materialize, then import) round-trips a non-trivial bundle
with identity-fidelity and byte-fidelity **modulo the `_rev` frontmatter
lines and the regenerated `log.md`** (both necessarily re-derive in the
new generation; I11's property list is the normative fidelity set) including a
drained conflict; all three
examples run from committed scripts and regenerate their committed output
byte-identically; every emitted bundle passes an independent OKF v0.1
conformance check (frontmatter parses, `type` present, reserved files
structured per OKF §6/§7); and `wanted/` demonstrably ranks unwritten
concepts by referrer count in the flagship example.
