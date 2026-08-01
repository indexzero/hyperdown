# auto-okf: Implementation Specification

**Status:** Normative build instruction, v1.4 (2026-07-26). RFC 2119
keywords (MUST, SHOULD, MAY) apply.
**Changelog:** v1.4 closes the live-watcher directory-move
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
weight corrected to 2 (§8); optimistic onboarding resolved as store-side
DAG-level `host.ackWriter` with `hold/` full-payload folding — acked nodes
are NOT re-delivered, so no seq-dedup branch (§8); the per-writer seen-count
ordinal resolution settled against autobee@1.0.10 (§3); `flag/copydetect`
corrected to an ingest watcher event, not a view row (no core op writes it —
§4, §9); conflicted-copy face deletion skip and deferred `_id` write-back
documented (§9); the generation `log/` entry clarified as a filesystem artifact
and the compaction `_rev`-stripped staging step documented (§10); a "Known
limitations (v1)" note added (C1 soak scale limit, P7 double-conflict-suffix
ingest, P4 empty-`type` ingest, plus the live-watcher directory-move
data-preservation gap, issue #30); node:test mandate and autobee@1.0.10
verification pin confirmed. A source-driven review pass also corrected §7's
directory-move deferral rationale — a category error citing the TPDS-2021
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
   experimental ("expect breaking changes").
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
  read `index.js`) — the delivered stack verified the contract below against
  **autobee@1.0.10** (standalone multiwriter Hyperbee on hyperbee2 +
  hypercore 11, no autobase dependency), and the port mappings recorded in
  `DEVIATIONS.md` are pinned to that version: constructor
  `new Autobee(store, key, { apply, open,
  close, update, encryptionKey, encrypted, keyPair, optimistic })`; apply
  receives `(nodes, view, host)`, node = `{key, value, length, optimistic}`;
  host: `addWriter/removeWriter/ackWriter/interrupt/createAnchor/genesis`;
  view is hyperbee2-flavored (`view.get`, `view.write()` batches with
  `tryPut`/`flush`); instance: `update()/updated()/flush()`,
  `replicate(isInitiator)`, `db.view`, `db.key`, `db.discoveryKey`.
- hyperbee2 source (range iteration surface — verify, do not assume classic
  hyperbee's `createReadStream` signature).
- corestore, hyperswarm READMEs.
- Reference integration: `~/Git/indexzero/uppr2-worktrees/attempt-opus-1/lib/registry.js`
  (working autobee 1.0.x apply/view/write patterns).

## 2. Architecture: the log is the source of truth

- **Source of truth:** the autobee op log (one input core per writer).
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
AddWriter     { key, indexer: bool }              // governance (§8)
RemoveWriter  { key }
SetWriterPolicy { key, namespacePrefixes, rateCeiling }
```

- Every op carries `clock` (the writer's observed vector clock, op payload)
  — required for causal revocation (§8; vault-ld §8.3 ancestry).
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
  self-identifications. The per-writer ordinal fallback is the view-kept
  seen-count (top-level `seen/` family, incremented for every node
  regardless of disposition — vault-ld §8.2/§8.4 ancestry). **Resolved
  (delivery):** although autobee@1.0.10 does expose a per-node `length`,
  apply derives position from the view-kept `seen/` count rather than any
  transport-exposed seq — core is transport-agnostic, and §8's unforgeable-
  position rule (`seqAtRemoval`, `forged-clock`) MUST bind to the same
  ordinal apply uses for `flag/rejected`/`hold/` keys. Under autobee's
  per-writer FIFO delivery the seen-count equals the node seq; a future
  substrate exposing a stable per-writer index would be a new DEVIATIONS.md
  entry.
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
flag/conflict|clobber|staletag|pathcollision|writeafterdelete|undelete|rejected|optimistic|squat/...
                                (no `copydetect` family: no op writes one —
                                copy-splits surface as an ingest event, §9)
seen/<writerKey>                per-writer ordinal (bookkeeping)
gov/writer/<key>                { indexer, namespacePrefixes, rateCeiling }
gov/removed/<key>               revocation clock + seqAtRemoval (§8)
hold/<writerKey>/<seq>          full decoded payloads of unacked optimistic ops
rate/<writerKey>                token-bucket state
```

Bookkeeping families (`seen/`, `rate/`, `hold/`, `revbybase/`,
`wantedrank/`) are included in the I2 view hash and excluded from
materialize.

Flag lifecycle: `conflict` clears only via `ResolveConflict` (§5);
`pathcollision` clears whenever the loser's claim ceases to collide — its
own subsequent `SetPath`, or the competing holder vacating by rename,
deletion, or its own collision loss (§7; apply recomputes this on the same
events as §9's late-binding link resolution); `clobber`, `staletag`,
`writeafterdelete`, `undelete`, `rejected`, `optimistic`, and `squat` are
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
  writer's seen-count is rejected (`flag/rejected`, reason
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
  batch); the relevant prior art is multi-key / read-atomic transactions,
  not replicated-tree move CRDTs.

## 8. Governance and the append-only guarantee

- **Append-only is a vault-metadata constant**, written at `init`, loaded at
  open, identical on every peer, and **not representable as an op**. There
  is no prune op, no compaction op, no byte-destroying operation in the
  wire contract at all. `DeleteConcept` writes a tombstone: the concept
  disappears from materialize/`index.md`/`path/`, its bytes and `_id`
  remain. `UndeleteConcept` restores and writes `flag/undelete/<id>/<tag>`
  (audit). A write to a tombstoned concept lands and flags
  `flag/writeafterdelete` (I4).
- Governance ops (`AddWriter`, `RemoveWriter`, `SetWriterPolicy`) require an
  **indexer issuer**, checked in apply against `gov/writer/<issuer>` at the
  op's linearized position; violations are rejected (reason
  `policy-governance`), and `host.addWriter`/`removeWriter` are never called
  for unauthorized ops (vault-ld §8.0/B2 ancestry). A `RemoveWriter` that
  would leave zero indexers is rejected (reason `policy-governance`) — a
  vault can never become permanently ungovernable. Genesis: the vault
  creator's key is the first indexer, seeded deterministically.
- **Revocation is causal, in-band, never positional** (vault-ld B1
  ancestry, harness-proven): apply records `gov/removed/<key>` = the
  RemoveWriter's clock; a subsequent op from that writer whose clock does
  not strictly precede it is rejected (reason `revoked`).
  `host.removeWriter` is NEVER called — every node must keep linearizing on
  every peer so the clock rule can run uniformly. The revoked writer's own
  store refuses further local appends. The claimed clock is cross-checked
  against unforgeable position: `gov/removed/<key>` also records
  `seqAtRemoval` = the revocation clock's entry for the removed writer.
  Any node from that writer whose actual node position has
  `seq > seqAtRemoval` is rejected (reason `revoked`) **regardless of its
  claimed clock**; the claimed-clock strict-precedence test applies only
  to the (bounded) window of ops at `seq <= seqAtRemoval` still in flight.
  Additionally, apply rejects any op whose claimed self-clock entry does
  not equal its actual seq (reason `forged-clock`).
- Writers are admitted with an **explicit** uniform weight. The substance
  is *uniform* weight, not any particular value; the delivered value is
  **2**, pinning `host.addWriter(key, { isIndexer: op.indexer, weight: 2 })`
  on every admission. **Resolved (delivery):** autobee@1.0.10's GENESIS
  auto-add is uncontrollable from apply and always uses weight 2, so a
  literal `weight: 1` for later writers would re-create exactly the
  mixed-weight condition this rule exists to prevent (1.0.x topo
  comparators diverge under unequal concurrent weights). Pinning every
  writer at the genesis value 2 keeps all weights uniform. Side effect:
  autobee's cosmetic `isIndexer` getter (`weight === 2`) then reads true
  for all writers — immaterial, because §8 governance authority is decided
  from `gov/` by core, never from autobee writer state.
- Optimistic onboarding: construct with explicit `optimistic: true`.
  Unacked optimistic ops are held (`hold/`, full decoded payload). **The
  view-effect ack is the linearization of an indexer-authored `AddWriter`
  op naming the held writer's key**; at that position apply folds
  `hold/<key>/*` in seq order at the ack's linearized position, then
  deletes the holds. **Resolved (delivery):** acknowledged optimistic nodes
  are NOT re-delivered to apply — autobee@1.0.10 applies an unacked
  writer's optimistic batch exactly once at its linearized position, and a
  later `host.ackWriter()` flips writer state without replaying prior nodes
  — so `hold/` stores the **full decoded payload** and the fold (never a
  seq-dedup guard) is the mechanism. Two-level ack: autobee additionally
  requires the optimistic batch to anchor in its system during apply or it
  is rolled back and the writer dropped, so the **store's apply wrapper
  calls `host.ackWriter(node.key)` at the DAG level for every
  optimistic-flagged node** (deterministic — the flag is oplog-encoded, so
  every peer makes the same call). That DAG-level ack only keeps the node
  in the substrate; core's `hold/` buffer remains the sole VIEW-effect gate,
  so effects still land at the in-log `AddWriter`'s linearized position and
  peers converge to identical views even when the raw optimistic node
  linearized at different positions. `H_max = 512` held ops per writer;
  op 513+ from an unacked writer
  is rejected (`flag/rejected`, reason `hold-overflow`). Held ops are
  rate-checked at hold time; optimistic ops rejected at fold time write
  `flag/optimistic/<writerKey>/<seq>`. `RemoveWriter` of an unacked writer
  drops holds unfolded. Rate limiting is a writer-local token bucket
  (vault-ld §8.5 ancestry — never a global window): each writer's bucket
  gains 1 token per accepted op *authored by any indexer*, capped at that
  writer's `rateCeiling`; unacked writers use a fixed default ceiling (64)
  until admitted. Buckets start full (at ceiling) at admission and at
  first hold — the accept/reject partition is pinned, not
  implementation-chosen.
- `encryptionKey` (+ `encrypted: true`) supported end to end.

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
  deletions, conflict resolutions, generation notes. The narration is a
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
  generation-cycle contract (§10).
- Conflict-copy awareness: a file whose terminal component matches
  `\.conflict-[0-9a-f]{8,}$` ingests at the **suffix-stripped path**.
  Known `_id` whose view path equals the stripped path → no `SetPath`
  (the file is the loser's materialized face; body/frontmatter diffs
  ingest normally). Unknown `_id` (generation cycle) → `CreateConcept` at the
  stripped path; the collision re-manifests in the new vault under §7's
  ordinary rules, the loser re-flags and re-materializes at a conflict
  path — state, identity, and collision status all carry across. §10's
  `--force` enumeration lists old conflict path → new conflict path.
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

## 10. Compaction: generation cycling (the CouchDB homage, part two)

Byte reclamation is an **operator act via the hydrated face**, never an op:

1. `materialize` the bundle (live heads + `_id`/`_rev`; tombstoned concepts
   suppressed; open conflicts as conflicted copies).
2. The operator optionally deletes files on disk.
3. `init` a fresh vault; ingest the directory with **`_id` adoption** (§9).
   The fresh vault MUST use freshly generated writer keypairs: a writer
   keypair MUST NOT recur across generations (corestore-derived keys MUST be
   namespaced by generation). Otherwise adoption of the predecessor's
   mint-shaped ids is rejected `mint-collision-risk` and I11 is
   unachievable. `init` MUST enforce this by deriving writer cores under
   a per-generation namespace recorded in vault metadata.
   **Delivered — staging step:** a materialized bundle cannot be ingested
   in place. Its emission manifest makes the ingest watcher skip every
   file as a self-echo (zero ops), and a materialized `_rev` cites a base
   absent from the fresh vault (the head flags `flag/conflict` and
   materializes bodyless). compact therefore copies each concept note into
   a **sibling** staging dir (a nested dir would be cleared by
   `new Corestore(vaultDir)` on init) with its `_rev` line **stripped**, so
   each head re-roots at `base: null` — the only flag-free fresh start
   (§5) — the body survives, and `_rev` re-derives (§14). Once a bundle has
   cycled once, every body is already `base: null`, so further cycles
   preserve `_rev` too.
4. New vault metadata records `{ predecessorKey, predecessorCheckpoint }` —
   the generation chain. `predecessorCheckpoint = { viewHash: <the I2 full-range
   hash>, writerLengths: [[key, len], ...] }`, signed by the operator key
   that ran compact; the chain is provenance metadata, not proof —
   consumers MUST treat cross-generation identity as trusted-operator scope.
5. The old vault is archived or destroyed out-of-band.

Effect = CouchDB compaction: live state and identity survive; history (old
revisions, per-op attribution, clocks) is shed by design. The compact
command MUST refuse (without `--force`) while `flag/conflict` **or
`flag/pathcollision`** is non-empty; with `--force`, it MUST enumerate in
the new vault's generation `log/` entry every conflicted copy carried across,
old conflict path → new conflict path (carry-across works because ingest
strips the conflict suffix and lets the collision re-manifest — §9
conflict-copy awareness; because `_id` and path both survive, a carried
copy re-manifests at the **same** path, so these enumerations legitimately
record `from === to`). It MUST record a generation entry in the new vault's
`log/`. **Delivered:** the wire contract has no generation op, so this entry
cannot be a view `log/<ordinal>` record — it is written as a filesystem
artifact `<vaultDir>/log/generation.json`
(`{ kind:'generation', generation, predecessorKey, predecessorCheckpoint,
conflictCopies, at, note }`); it satisfies "an entry in the new vault's
`log/`" literally and does not appear in the regenerated `log.md` (§14
excludes `log.md` from I11 fidelity). State- and identity-fidelity across
a cycle is an acceptance criterion (§14).

## 11. Invariants (the test suite maps to these)

- **I1 Determinism:** apply is a pure function of the linearized op
  sequence. No wall clock, no randomness, no map-iteration order, no
  peer-local reads.
- **I2 Convergence:** peers that exchanged all ops have bit-identical views
  (full range-scan hash).
- **I3 Rebuild equivalence:** from-scratch rebuild equals incremental view.
- **I4 No silent loss:** no op's effect disappears without a flag
  (clobber/staletag/conflict/pathcollision/writeafterdelete/rejected/
  optimistic). `wanted/` entries are NOT loss (they are demand).
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
- **I10 Governance:** revoked-writer ops after the causal revocation point,
  unauthorized governance ops, and policy-violating ops never mutate `c/`;
  the applied/rejected partition is replay-stable.
- **I11 Roundtrip:** materialize → ingest into a fresh vault (generation cycle)
  preserves every live concept's `_id`, `type`, fields, tags, path, and
  head body byte-for-byte.

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
  hash, FDs flat, no crash. It is substrate-entangled (autobee under flood);
  the okf-attributable lead is uncoalesced OR-set add-tokens (§5 `tags`). A
  fix is architectural and risks determinism on green code, so it is
  deliberately deferred; sign-off pending.
- **P7 — double `.conflict-<hex>` suffix ingest.** A file carrying two
  stacked `.conflict-<hex>` suffixes lands in a permanent pending-ingest
  state (GitHub issue #28).
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
               wanted index, generation-cycle compact command
okf/cli        init, join, add-writer, remove-writer, materialize, ingest
               (optionally path-scoped, ADR-001), watch, wanted, flags,
               resolve, undelete, compact
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
at clean/lossy/partitioned; a generation cycle round-trips a non-trivial bundle
with identity-fidelity and byte-fidelity **modulo the `_rev` frontmatter
lines and the regenerated `log.md`** (both necessarily re-derive in the
new generation; I11's property list is the normative fidelity set) including a
drained conflict; all three
examples run from committed scripts and regenerate their committed output
byte-identically; every emitted bundle passes an independent OKF v0.1
conformance check (frontmatter parses, `type` present, reserved files
structured per OKF §6/§7); and `wanted/` demonstrably ranks unwritten
concepts by referrer count in the flagship example.
