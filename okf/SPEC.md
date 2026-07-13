# auto-okf: Implementation Specification

**Status:** Normative build instruction, v1.0-draft (2026-07-13). RFC 2119
keywords (MUST, SHOULD, MAY) apply.
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
CreateConcept { id, path, type, tag }             // mints or adopts _id (§6)
SetField      { id, key, value, tag }             // LWW-array register (§5)
AddTag        { id, value, tag }                  // OR-set add on `tags`
RemTag        { id, value, tags: [tag, ...] }     // OR-set remove by observed tags
SetBody       { id, base: revHash | null, text }  // immutable revision (§5)
SetPath       { id, path, tag }                   // rename: LWW register (§7)
DeleteConcept { id, tag }                         // tombstone only (§8)
UndeleteConcept { id, tag }
ResolveConflict { id, keep: revHash, supersede: [revHash...], text? }
AddWriter     { key, indexer: bool }              // governance (§8)
RemoveWriter  { key }
SetWriterPolicy { key, namespacePrefixes, rateCeiling }
```

- Every op carries `clock` (the writer's observed vector clock, op payload)
  — required for causal revocation (§8; vault-ld §8.3 ancestry).
- `tag` (opId) = `writerKey || seq`, the OR-set observation token and audit
  handle. The per-writer ordinal fallback is the view-kept seen-count
  (top-level `seen/` family, incremented for every node regardless of
  disposition — vault-ld §8.2/§8.4 ancestry; record the resolution in
  DEVIATIONS.md after checking what autobee's node actually exposes).
- Strings are NFC-normalized before keying, hashing, or comparison (§3.1 of
  the vault-ld spec is copied semantics; `canonical.js` is the copied code).
- Pre-decode limits with fixed check order and single recorded reason:
  op ≤ 64 KiB, path ≤ 1024 bytes, depth ≤ 64. Undecodable/oversize ops are
  rejected into `flag/rejected/<writerKey>/<seq>` — apply MUST NOT throw.

## 4. View keyspace

One keyspace-encoded view (copied `keyspace.js`; escaping mandatory; user
strings never concatenate raw into keys):

```
c/<id>/meta                     { type, created: tag, deleted?: tag }
c/<id>/f/<key>                  frontmatter field state (LWW-array or OR-set element map)
c/<id>/path                     current path (LWW register + history tag)
c/<id>/body                    head revision pointer (revHash)
c/<id>/rev/<revHash>            immutable revision { base, text, writer, at }
c/<id>/revbybase/<base>/<rev>   base-keyed revision index (M1 ancestry: no O(R²) scans)
path/<path>                     path -> id (current holder; collision losers flagged)
link/<from-id>/<to-path>        outbound links (extracted from body, §9)
bl/<to-id>/<from-id>            backlinks (resolved links only)
wanted/<path>/<referrers>       ranked demand index: links whose target path
                                does not resolve (NOT a flag — §9; Special:WantedPages)
log/<ordinal>                   append-only narration records -> log.md (§9)
flag/conflict|clobber|staletag|pathcollision|writeafterdelete|undelete|rejected|optimistic/...
seen/<writerKey>                per-writer ordinal (bookkeeping)
gov/writer/<key>                { indexer, namespacePrefixes, rateCeiling }
gov/removed/<key>               revocation clock
hold/<writerKey>/<seq>          full decoded payloads of unacked optimistic ops
rate/<writerKey>                token-bucket state
```

Bookkeeping families (`seen/`, `rate/`, `hold/`, `revbybase/`) are included
in the I2 view hash and excluded from materialize.

## 5. Merge semantics: fixed defaults

There is no per-key policy dial (owner decision; the vault-ld policy-epoch
saga is the cautionary tale). The rules are frozen:

- **`tags`** (the OKF frontmatter key, and only it): **OR-set**. Concurrent
  adds union. `RemTag` cites every observed tag mapped to the value (client
  computes; a cited-but-absent tag is ignored for effect and recorded once
  under `flag/staletag`). Concurrent add wins over remove-of-unobserved
  (SU-Set semantics; I5).
- **Every other frontmatter key**: **LWW-array register** under
  linearization order. Values are canonical arrays (possibly length 1),
  superseding atomically; one materialized YAML scalar when length is 1.
  A cross-writer supersession with a different value writes
  `flag/clobber/<id>/<key>/<tag>` (I4: the loser is auditable).
- **Bodies**: every `SetBody` creates an immutable revision keyed by
  `revHash = SHA-256(len(base)||base||len(text)||utf8(NFC(text)))` (copied
  `revhash.js`). Head pointer is LWW under linearization. Two revisions
  citing the same **non-null** base are true siblings: both retained, head
  deterministic, exactly one `flag/conflict/<id>/<a>/<b>`, cleared only by
  `ResolveConflict`. A null base is "no base cited": no mutual conflicts
  among independent creations (M1 ancestry — no N-choose-2 blowup).
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
- **`_rev`** is the body-head revHash at materialization time, emitted into
  frontmatter. On ingest, an edited file's `_rev` is the `base` its
  `SetBody` cites — the file carries its own causal context. A stale `_rev`
  produces siblings + `flag/conflict`, never a rejection (we keep both;
  CouchDB would 409). Missing `_rev` (hand-authored): cite the current head.
- Frontmatter emission order: `_id`, `_rev`, `type`, then remaining keys
  canonically sorted. OKF-conformant (§4.1 arbitrary producer keys; §9
  consumers must not reject).

## 7. Paths, renames, collisions (the Kleppmann rules)

- `path` is an **LWW register on the concept**, not identity (Kleppmann,
  PaPoC 2020: move-as-delete+reinsert duplicates under concurrency; position
  must be a register on stable identity).
- Paths are NFC-normalized, bundle-relative, forward-slash, no `.md` suffix
  stored; `index` and `log` as terminal filename components are reserved by
  OKF §3.1 and rejected (`flag/rejected`, reason `reserved-path`).
- **Rename + concurrent edit → merge** (the edit targets `_id`; it follows).
- **Rename + concurrent rename → linearization winner**, loser recorded in
  `flag/clobber` (audit, clearable).
- **Two concepts on one path**: `path/<path>` holds the linearization
  winner; the loser keeps its path value but materializes at a
  **deterministic conflicted-copy path**:
  `<path>.conflict-<first-8-hex-of-_id>` — byte-deterministic (I9), flagged
  `flag/pathcollision/<path>/<loser-id>`, narrated in `log.md`. The flag
  clears when a subsequent `SetPath` gives the loser a free path.
- Path safety (vault-ld M5 ancestry): before any file write, materialize
  MUST verify lexical + realpath containment in the bundle root; a path
  that escapes, is absolute, or collides case-insensitively on a
  case-insensitive filesystem is skipped with `flag/rejected` reason
  `unsafe-path` at apply time where detectable, `flag/pathcollision` at
  materialize time otherwise.
- **Subtree/directory moves do not exist in v1** (concurrent-move cycle
  problem; TPDS 2021 is the documented v2 path). A directory "move" is N
  per-concept `SetPath` ops with no atomicity claim.

## 8. Governance and the append-only guarantee

- **Append-only is a vault-metadata constant**, written at `init`, loaded at
  open, identical on every peer, and **not representable as an op**. There
  is no prune op, no compaction op, no byte-destroying operation in the
  wire contract at all. `DeleteConcept` writes a tombstone: the concept
  disappears from materialize/`index.md`/`path/`, its bytes and `_id`
  remain, `UndeleteConcept` restores. A write to a tombstoned concept lands
  and flags `flag/writeafterdelete` (I4).
- Governance ops (`AddWriter`, `RemoveWriter`, `SetWriterPolicy`) require an
  **indexer issuer**, checked in apply against `gov/writer/<issuer>` at the
  op's linearized position; violations are rejected (reason
  `policy-governance`), and `host.addWriter`/`removeWriter` are never called
  for unauthorized ops (vault-ld §8.0/B2 ancestry). Genesis: the vault
  creator's key is the first indexer, seeded deterministically.
- **Revocation is causal, in-band, never positional** (vault-ld B1
  ancestry, harness-proven): apply records `gov/removed/<key>` = the
  RemoveWriter's clock; a subsequent op from that writer whose clock does
  not strictly precede it is rejected (reason `revoked`).
  `host.removeWriter` is NEVER called — every node must keep linearizing on
  every peer so the clock rule can run uniformly. The revoked writer's own
  store refuses further local appends.
- Writers are admitted at **uniform autobee weight** (vault-ld finding:
  1.0.x topo comparators diverge under unequal concurrent weights).
- Optimistic onboarding: unacked optimistic ops are held (`hold/`, full
  payload) and folded at the ack's linearized position; hold-time
  rate-check + `H_max` cap; `RemoveWriter` of an unacked writer drops holds
  unfolded. Rate limiting is a writer-local token bucket replenished by
  accepted indexer ops (vault-ld §8.5 ancestry — never a global window).
- `encryptionKey` (+ `encrypted: true`) supported end to end.

## 9. Faces

**materialize(dir)** — walk `c/` and emit an OKF-v0.1-conformant bundle:
- One markdown file per live concept at its path (`<path>.md`), frontmatter
  per §6 ordering, body = head revision text. Conflicted copies per §7.
- **`index.md` per directory** (derived, never authored): OKF §6 structure —
  frontmatter only at bundle root (`okf_version: "0.1"`), a listing of child
  concepts/subdirectories with one-line descriptions from the `description`
  field where present. Deterministic ordering (canonical byte order).
- **`log.md` per bundle root** (derived, never authored): OKF §7 structure —
  ISO-8601 date headings, newest first, entries generated from the `log/`
  family: creations, renames (old → new), deletions, conflict
  resolutions, epoch notes. The narration is a *projection of the actual op
  log* — auto-okf's structural upgrade over hand-maintained convention.
  Dates come from op-carried writer timestamps (informational, never used
  for merge); entries are deterministic given a converged view (I9).
- Atomic writes (temp + fsync + rename), containment checks, per-path
  in-flight locks (vault-ld §9.4 ancestry).
- Byte-deterministic: converged peers emit identical bundles (I9).

**Ingest watcher** — human edits re-enter as minimal ops:
- Frontmatter diff per key against view state (never whole-file ops):
  changed key → `SetField`/`AddTag`/`RemTag`; removed key → `SetField`
  with empty array; body diff → one `SetBody` citing the file's `_rev`.
- `_id` rules: known `_id` at a new path → `SetPath` (a real move); same
  `_id` seen at two paths → second is a copy (mint fresh via
  `CreateConcept`, flag); missing `_id` → mint and write back into the
  file; `_id` present but unknown to this vault → **adopt** it
  (`CreateConcept` with the supplied id) — the epoch-cycle contract (§10).
- File deleted on disk → `DeleteConcept`, behind a confirmation guard
  (default on).
- Links: standard markdown links per OKF §5 (absolute bundle-relative
  preferred); extraction feeds `link/`, `bl/`, and `wanted/`. **A link
  whose target path does not resolve goes to `wanted/` — the ranked demand
  index — and never to `flag/`** (OKF §5.3; Cunningham's Incremental
  principle; owner decision). `wanted/` is queryable ("what does the graph
  want written?"), sorted by referrer count, and an entry clears when a
  concept lands on that path.
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
   the epoch chain.
5. The old vault is archived or destroyed out-of-band.

Effect = CouchDB compaction: live state and identity survive; history (old
revisions, per-op attribution, clocks) is shed by design. The compact
command MUST refuse (without `--force`) while `flag/conflict` is non-empty,
and MUST record an epoch entry in the new vault's `log/`. State- and
identity-fidelity across a cycle is an acceptance criterion (§14).

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
- **I8 Index coherence:** `path/`, `link/`, `bl/`, `wanted/`, `revbybase/`
  are exactly derivable from `c/` at every quiescent point.
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
               watch, wanted, flags, compact
okf/test       unit + invariant suite (I1..I11 each ≥ 1 test)
examples/agent-session/    flagship: multi-agent findings/determinations/RFC
                           bundle, partitioned + healed, ThreadMode→DocumentMode
examples/slop-archive/     durable LLM-output archive (append-only shown off)
examples/vlurp-library/    one script: vlurpfile → staging → _id-stamped bundle
```

Node 20+, plain JS, pnpm workspace (`vault-ld/*` + `okf/*`), node:test only,
usage-first READMEs per package plus example READMEs. Package names
`@auto-okf/{core,store,faces,cli}`.

## 14. Acceptance

Complete when: I1..I11 each pass; the multi-process harness matrix (fault
proxy, partitions, permutation replay — retargeted from `/harness`) is green
at clean/lossy/partitioned; an epoch cycle round-trips a non-trivial bundle
with byte- and identity-fidelity (I11) including a drained conflict; all
three examples run from committed scripts and regenerate their committed
output byte-identically; every emitted bundle passes an independent OKF v0.1
conformance check (frontmatter parses, `type` present, reserved files
structured per OKF §6/§7); and `wanted/` demonstrably ranks unwritten
concepts by referrer count in the flagship example.
