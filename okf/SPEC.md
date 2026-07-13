# auto-okf: Implementation Specification

**Status:** Normative build instruction, v1.1 (2026-07-13). RFC 2119
keywords (MUST, SHOULD, MAY) apply.
**Changelog:** v1.1 applies adversarial review round 1
(`orchestration/results/OKF-SPEC-REVIEW-1.md`): blockers B1–B4 fixed,
majors M1–M15 fixed, minors m1–m15 applied. Dispositions:
`orchestration/results/OKF-SPEC-DISPOSITIONS-1.md`. v1.0-draft is the
prior revision in git history.
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
  read `index.js`): constructor `new Autobee(store, key, { apply, open,
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
CreateConcept { id, path, type }                  // mints or adopts _id (§6)
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
  regardless of disposition — vault-ld §8.2/§8.4 ancestry; record the
  resolution in DEVIATIONS.md after checking what autobee's node actually
  exposes).
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
c/<id>/revbybase/<base>/<rev>   base-keyed revision index (M1 ancestry: no O(R²) scans)
path/<path>                     path -> id (current holder; collision losers flagged)
link/<from-id>/<to-path>        outbound links (extracted from body, §9)
bl/<to-id>/<from-id>            backlinks (resolved links only)
wanted/<path>/<from-id>         demand index: one key per unresolved referrer
                                (count = subkey count; NOT a flag — §9;
                                Special:WantedPages)
wantedrank/<inv-count>/<path>   derived rank index, rewritten on referrer-count
                                change (inv-count = zero-padded (MAX − count),
                                so an ascending scan yields most-wanted first)
log/<ordinal>                   append-only narration records -> log.md (§9)
flag/conflict|clobber|staletag|pathcollision|writeafterdelete|undelete|rejected|optimistic/...
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
`pathcollision` clears when a subsequent `SetPath` gives the loser a free
path (§7); `clobber`, `staletag`, `writeafterdelete`, `undelete`,
`rejected`, and `optimistic` are permanent audit records — no op or rule
clears them.

## 5. Merge semantics: fixed defaults

There is no per-key policy dial (owner decision; the vault-ld policy-epoch
saga is the cautionary tale). The rules are frozen:

- **`tags`** (the OKF frontmatter key, and only it): **OR-set**. Concurrent
  adds union. `RemTag` cites every observed tag mapped to the value (client
  computes). The view keeps a removed-token set per (id, value): a citation
  of an already-removed token is a silent no-op (benign concurrent removes
  of the same tag never flag); a citation of a never-observed token is
  ignored for effect and recorded once under `flag/staletag`. Concurrent
  add wins over remove-of-unobserved (SU-Set semantics; I5).
- **Every other frontmatter key**: **LWW-array register** under
  linearization order. Values are canonical arrays (possibly length 1),
  superseding atomically; one materialized YAML scalar when length is 1.
  A cross-writer supersession with a different value writes
  `flag/clobber/<id>/<key>/<tag>` (I4: the loser is auditable).
- **Reserved field keys**: `SetField` with `key` ∈ {`tags`, `_id`, `_rev`}
  (post-NFC, exact) is rejected (`flag/rejected`, reason `reserved-key`).
  Tag mutations travel only as `AddTag`/`RemTag`; identity and revision
  are never fields (§6; ingest obligations in §9).
- **Bodies**: every `SetBody` creates an immutable revision keyed by
  `revHash = SHA-256(len(base)||base||len(text)||utf8(NFC(text)))` (copied
  `revhash.js`), where `len()` is u32 LE and a null base encodes as
  `len(0)` with zero bytes (distinct from any real hash) — this normative
  text mirrors the copied code; on discrepancy the copied code wins and
  DEVIATIONS.md records it. Head pointer is LWW under linearization. Two
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
- **`ResolveConflict`** is valid only if `keep` and every `supersede` entry
  exist under `c/<id>/rev/` and at least one cited flag is open; otherwise
  it is rejected (`flag/rejected`, reason `bad-resolve`). Effect: head :=
  `keep` (LWW-pinned at this position); cited `flag/conflict` entries
  clear. With `text` present, apply synthesizes one revision with
  `base = keep`, and that revision becomes head. A later `ResolveConflict`
  over the same (now-cleared) flags is rejected `bad-resolve`; resolution
  races converge by linearization: the first valid resolve wins, the loser
  flags.
- **`type`** (OKF's one required key): LWW-array like any other key, but
  materialize emits the first element as the scalar `type` (OKF requires
  non-empty; an empty state materializes `type: unknown` and flags).
- **`_id` and `_rev` are never merged**: `_id` is identity (§6); `_rev` is
  derived output, never stored as a field.

## 6. Identity: `_id` and `_rev` (the CouchDB homage)

- **`_id`** is the concept's stable identity: minted exactly once, opaque,
  never path- or content-derived. Mint = the creating op's `tag`
  (`writerKey || seq`, hex). Adopted, not minted, when `CreateConcept`
  carries an id the vault has never seen (ingest supplies it — §9, §10;
  this is what makes epoch cycling identity-preserving). `_id` is unique
  per vault; equality asserts same concept, nothing else. It survives
  deletion (tombstones keep it).
- **Seen-id rule**: a `CreateConcept` whose `id` is already present in `c/`
  is **rejected** (`flag/rejected`, reason `duplicate-id`) — creation never
  updates. Only `SetField`/`AddTag`/`RemTag`/`SetPath`/`SetBody`/
  `DeleteConcept`/`UndeleteConcept`/`ResolveConflict` mutate an existing
  concept, and each is policy-checked against the concept's **current**
  path, never an op-claimed path. Adopted ids MUST match
  `^[0-9a-f]{2,128}$` after NFC. Because mint ids are `writerKey || seq`
  (both public, hence predictable), adoption of an id whose writerKey
  prefix equals any current or former writer's key with `seq >=` that
  writer's seen-count is rejected (`flag/rejected`, reason
  `mint-collision-risk`) — a squatter cannot pre-occupy a writer's future
  mints.
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
  `flag/clobber` (audit).
- **Two concepts on one path**: the concept whose current path-claim has
  the **lower `ord`** (§4 — the earlier claim under linearization) holds
  `path/<path>`; a later claimant is the loser (first-wins: a squatter
  cannot evict). The loser keeps its path value but materializes at a
  **deterministic conflicted-copy path**:
  `<path>.conflict-<first-8-hex-of-SHA-256(_id)>` (hash, not prefix: `_id`
  prefixes are shared by a writer's every mint) — byte-deterministic (I9),
  flagged `flag/pathcollision/<path>/<loser-id>`, narrated in `log.md`.
  The literal component pattern `\.conflict-[0-9a-f]{8}$` is **reserved**:
  `CreateConcept`/`SetPath` carrying it are rejected (`flag/rejected`,
  reason `reserved-path`), so conflict paths cannot be squatted. If two
  losers of the same path still hash-collide on 8 hex, extend to the full
  hash; materialize MUST NOT emit two concepts to one file under any
  input. The flag clears when a subsequent `SetPath` gives the loser a
  free path.
- Path safety (vault-ld M5 ancestry): a path that escapes the bundle root
  or is absolute is rejected in apply (`flag/rejected`, reason
  `unsafe-path`). Case-fold (plus NFC) collision detection is performed
  **in apply, on every peer, unconditionally** — when a path's casefolded
  form equals another live concept's casefolded path (or a generated-face
  filename, above), the linearization loser gets `flag/pathcollision`
  exactly as for exact-path collisions and materializes at the
  conflicted-copy path on every platform. Materialize itself never writes
  to the view. Lexical + realpath containment is re-checked at materialize
  time before any file write; a violation aborts that file's emission and
  is reported on the CLI only (it is unreachable if apply's path
  validation is correct, and is a bug, not state).
- **Subtree/directory moves do not exist in v1** (concurrent-move cycle
  problem; TPDS 2021 is the documented v2 path). A directory "move" is N
  per-concept `SetPath` ops with no atomicity claim.

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
- Writers are admitted with an **explicit** uniform weight:
  `host.addWriter(key, { isIndexer: op.indexer, weight: 1 })` — never rely
  on autobee's defaults, which are `isIndexer ? 2 : 1` and would mix
  weights the moment a non-indexer is admitted (vault-ld finding: 1.0.x
  topo comparators diverge under unequal concurrent weights).
- Optimistic onboarding: construct with explicit `optimistic: true`.
  Unacked optimistic ops are held (`hold/`, full payload). **The ack is the
  linearization of an indexer-authored `AddWriter` op naming the held
  writer's key**; at that position apply calls `host.ackWriter(key)` and
  folds `hold/<key>/*` in seq order at the ack's linearized position, then
  deletes the holds. Before building, verify against autobee source
  whether acknowledged optimistic nodes are re-delivered to apply; if they
  are, `hold/` stores only seqs (a dedup guard), not payloads, and folding
  is replaced by dedup — record which in DEVIATIONS.md with the source
  line. `H_max = 512` held ops per writer; op 513+ from an unacked writer
  is rejected (`flag/rejected`, reason `hold-overflow`). Held ops are
  rate-checked at hold time; optimistic ops rejected at fold time write
  `flag/optimistic/<writerKey>/<seq>`. `RemoveWriter` of an unacked writer
  drops holds unfolded. Rate limiting is a writer-local token bucket
  (vault-ld §8.5 ancestry — never a global window): each writer's bucket
  gains 1 token per accepted op *authored by any indexer*, capped at that
  writer's `rateCeiling`; unacked writers use a fixed default ceiling (64)
  until admitted.
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
  UTC `YYYY-MM-DD` date headings (OKF §7 MUST), newest first, entries
  generated from the `log/` family: creations, renames (old → new),
  deletions, conflict resolutions, epoch notes. The narration is a
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
- Materialize makes the directory an **exact mirror** of the view: after
  emission it deletes any `.md` file under the bundle root not produced by
  this run (including prior conflicted copies, prior paths of renamed
  concepts, and per-directory `index.md` for directories that ceased to
  exist), and removes empty directories. Deletion honors the same
  containment checks as writes. The ingest watcher treats mirror-deletions
  as materialize-authored (in-flight-lock coordination), never as human
  deletes.
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
  copy (mint fresh via `CreateConcept`, flag). Missing `_id` → mint and
  write back into the file; `_id` present but unknown to this vault →
  **adopt** it (`CreateConcept` with the supplied id, subject to the §6
  seen-id and mint-collision rules) — the epoch-cycle contract (§10).
- File deleted on disk → `DeleteConcept`, behind a confirmation guard
  (default on).
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
- Debounce, write-settle, in-flight-lock coordination with materialize.
- `index.md`/`log.md` are reserved: edits to them are ignored (regenerated
  faces), with a single narrated log entry.

## 10. Compaction: epoch cycling (the CouchDB homage, part two)

Byte reclamation is an **operator act via the hydrated face**, never an op:

1. `materialize` the bundle (live heads + `_id`/`_rev`; tombstoned concepts
   suppressed; open conflicts as conflicted copies).
2. The operator optionally deletes files on disk.
3. `init` a fresh vault; ingest the directory with **`_id` adoption** (§9).
4. New vault metadata records `{ predecessorKey, predecessorCheckpoint }` —
   the epoch chain. `predecessorCheckpoint = { viewHash: <the I2 full-range
   hash>, writerLengths: [[key, len], ...] }`, signed by the operator key
   that ran compact; the chain is provenance metadata, not proof —
   consumers MUST treat cross-epoch identity as trusted-operator scope.
5. The old vault is archived or destroyed out-of-band.

Effect = CouchDB compaction: live state and identity survive; history (old
revisions, per-op attribution, clocks) is shed by design. The compact
command MUST refuse (without `--force`) while `flag/conflict` **or
`flag/pathcollision`** is non-empty; with `--force`, it MUST enumerate in
the new vault's epoch `log/` entry every conflicted copy carried across,
old path → materialized path. It MUST record an epoch entry in the new
vault's `log/`. State- and identity-fidelity across a cycle is an
acceptance criterion (§14).

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
- **I10 Governance:** revoked-writer ops after the causal revocation point,
  unauthorized governance ops, and policy-violating ops never mutate `c/`;
  the applied/rejected partition is replay-stable.
- **I11 Roundtrip:** materialize → ingest into a fresh vault (epoch cycle)
  preserves every live concept's `_id`, `type`, fields, tags, path, and
  head body byte-for-byte.

## 12. Non-goals (v1)

No RDF/Turtle/SPARQL. No per-key merge policy. No subtree-move atomicity.
No text CRDT for bodies. No HTTP API. No vlurp codebase changes. No
`viz.html`.

## 13. Deliverables

```
okf/core       ops, wire codec, apply, keyspace (copied), canonical (copied),
               revhash (copied), memview test double
okf/store      vault lifecycle on autobee, metadata pinning (incl. the
               append-only constant + epoch chain), governance plumbing,
               swarm replication, backpressure option
okf/faces      materialize (bundle + index.md + log.md), ingest watcher,
               wanted index, epoch-cycle compact command
okf/cli        init, join, add-writer, remove-writer, materialize, ingest,
               watch, wanted, flags, resolve, undelete, compact
okf/root       the `auto-okf` root placeholder package (published as
               auto-okf@0.0.1 alongside the scope — intent D7)
okf/test       unit + invariant suite (I1..I11 each ≥ 1 test)
examples/agent-session/    flagship: multi-agent findings/determinations/RFC
                           bundle, partitioned + healed, ThreadMode→DocumentMode
examples/slop-archive/     durable LLM-output archive (append-only shown off)
examples/vlurp-library/    one script: vlurpfile → staging → _id-stamped bundle
```

Node 20+, plain JS, pnpm workspace (`vault-ld/*` + `okf/*`), node:test only,
usage-first READMEs per package plus example READMEs. Package names
`auto-okf` (root) and `@auto-okf/{core,store,faces,cli}`.

## 14. Acceptance

Complete when: I1..I11 each pass; the multi-process harness matrix (fault
proxy, partitions, permutation replay — retargeted from `/harness`) is green
at clean/lossy/partitioned; an epoch cycle round-trips a non-trivial bundle
with identity-fidelity and byte-fidelity **modulo the `_rev` frontmatter
line** (which necessarily re-derives in the new epoch; I11's property list
is the normative fidelity set) including a drained conflict; all three
examples run from committed scripts and regenerate their committed output
byte-identically; every emitted bundle passes an independent OKF v0.1
conformance check (frontmatter parses, `type` present, reserved files
structured per OKF §6/§7); and `wanted/` demonstrably ranks unwritten
concepts by referrer count in the flagship example.
