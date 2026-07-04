# P3-1 Build Report — CORE package (D-010)

**Status:** DONE
**Branch:** `2/core` (not pushed, per dispatch)
**Spec:** SPEC-FINAL v5 (`prompts/01-implementation-spec-prompt.v5.md`)
**Date:** 2026-07-03

## What was built

### 1. Workspace scaffolding
- `pnpm-workspace.yaml` (`packages/*`); root `package.json`: private, `type: module` retained, `engines.node >= 20`, `test` runs `node --test "test/*.test.js"` (the node core runner, user mandate). All dependency operations via pnpm only.

### 2. `/packages/core` (SPEC-FINAL §13 scope)
- **Op schema + encodings (§3):** `schema/build.js` defines the 15 op structs
  in hyperschema and their hyperdispatch commands; generated code is committed
  under `packages/core/spec/{hyperschema,hyperdispatch}` with `dispatch.json`
  / `schema.json` pinning ids and field orders (append-only wire contract,
  §3.3). Polymorphic `o`/`def`/`clock` fields use the compact-encoding `json`
  type; `tag`/`tags`/`key` are typed buffers. Wrapper `lib/ops.js` provides
  `encodeOp`/`decodeOp` (decode never throws garbage: deterministic
  `unknown-msgid`/`undecodable` mapping), tag helpers, clock normalization.
- **Deterministic apply (§5–§8 complete):** `lib/apply.js` — op/kind table
  with keyword-term pre-resolution (§5.2, §5.8), OR-set citation contract with
  staletag audit (§5.3), canonical-array LWW registers (§5.1), clobber flags
  incl. body/path/@id (§5.4), shadowing + kind-change migration both
  directions with kindcollapse audit (§5.5), unmapped accumulation +
  host-allowlist keys + promotion (§5.6), kind pinning with epoch flags
  (§5.7), body revisions/conflicts/ResolveConflict/ClearFlag with the
  clearable-vs-structural split (§6), dangling mint/coalesce/dual-takeover
  with retarget audit (§7), governance authority (§8.0), hold buffer with
  full decoded payload + H_max + fold-at-ack (§8.2), causal revocation clocks
  (§8.3), writer/seq-keyed rejection namespace with fixed-order limits
  (§8.4), writer-local token bucket replenished by accepted indexer ops
  (§8.5), segment-prefix namespace policy (§8.6), plus the apply-time parts
  of §9.2 (tombstones/undelete/writeafterdelete), §9.4 (SetPath rejection),
  §10.1 (layer/scope/IRI binding), §10.3 (bounded backfill). Triple indexes
  (`idx/spo|pos|osp`) and backlinks maintained in the same apply pass.
  Core is pure: no wall clock, no randomness, no `signedLength`/`heads()`
  reads (enforced by a source-scan test).
- **Keyspace codec (§4):** `lib/keyspace.js`, escaping mandatory; user
  components round-trip losslessly; reserved-family collisions resolved
  (`hold` re-escape; `ctx/d|t` sub-layout — see DEVIATIONS.md).
- **Canonical forms (§3.1, §10.2):** `lib/canonical.js` — NFC, XSD canonical
  integer/decimal/double/dateTime/date/boolean, lowercased language tags,
  byte-form total order, canonical arrays.
- **revHash (§6):** `lib/revhash.js`, exact `SHA-256(len(base)||base||
  len(text)||utf8(NFC(text)))` construction.
- `lib/memview.js`: hyperbee-surface in-memory view (byte-ordered keys, JSON
  values) used by the unit suite; exported for later phases.

### 3. `/test` invariant unit suite (59 tests, all green)
- I1 determinism (identical hashes + banned-API source scan) — `i01`
- I2 convergence under batching variance — `i02`
- I3 incremental vs from-scratch rebuild — `i03`
- I4 no silent loss (unmapped, kindmismatch, clobber, staletag, epoch,
  undecodable/oversize/depth writer-seq-keyed rejections) — `i04`
- I5 OR-set add-wins + citation contract — `i05`
- I6 LWW law + canonical array atomicity — `i06`
- I7 flag lifecycle: dangling same-IRI AND different-IRI takeover, conflict
  persistence until ResolveConflict, audit-drain vs structural-reject — `i07`
- I8 index coherence (expected-vs-actual idx rebuild checker) incl. deferred
  DefineTerm backfill, kind-change migration both directions, host promotion,
  delete/undelete — `i08`
- I9 canonical forms (§3.1/§10.2 vectors, NFC subject identity) — `i09`
- I10 governance: §8.0 non-indexer rejection (host.addWriter never called,
  ctx/gov untouched), §8.3 causal revocation + triple-replay
  (incremental/from-scratch/forced-reorg) partition identity, §8.2 hold/fold/
  H_max/unacked-revoke, §8.5 bucket + tighten-only policy, §8.6 namespace
  (segment matching, replay stability) — `i10`
- Spec-mandated adversarial: `../escape` keyspace containment + SetPath
  `unsafe-path` rejection + shared-ordinal check — `keyspace.test.js`
- revHash construction vectors — `revhash.test.js`

### 4. DEVIATIONS.md (repo root)
Records: (a) node:test (user mandate), (b) pnpm (user mandate), (c) the
§8.2/§8.4 seen-count ordinal resolution (autobase README exposes no per-writer
seq on apply nodes → option (b)) and every §10.1 layer/scope inference note
the spec instructs recording, (d) all other resolutions: ctx/ sub-layout,
n/hold reservation, six bookkeeping key families (rate/, gseq/, iri/, fidx/,
hostidx/, scopeidx/), kindmismatch single-record, UnsetField-on-unmapped,
host-key AddMember/RemMember, SetWriterPolicy-on-unknown-key, rateCeiling
clamp, re-admission, empty-clock, synthetic migration tags, hyperdispatch-not-
autobee choice, json-typed fields, held-op raw bytes, rev `at` source, token
consumption point, host.removeable guard (UNVERIFIED), rootBase/percent-
encoding (UNVERIFIED vs vault-ld §4.5 char set), I9 unit scoping.

## Source-driven method
Fetched before writing framework code (2026-07-03): autobase README (full,
verbatim — apply/host contract, optimistic writes, indexers, signedLength),
hyperdispatch README + example.js + builder/codegen sources (README is one
sentence; example and installed-package sources are the API ground truth),
hyperschema README (builder API, append-only versioning, `json` in
SupportedTypes verified in `lib/types.js` of the installed package),
compact-encoding README (state pattern, built-ins), hyperbee README
(get/put/del/createReadStream surface mirrored by MemView). URLs are cited in
code comments at each framework-specific decision; two UNVERIFIED items are
marked in code and DEVIATIONS.md.

## Commits (branch 2/core, atomic, no AI attribution)
- `24e168c` chore: pnpm workspace scaffolding with node:test runner
- `5778760` feat(core): vault op wire contract via hyperschema + hyperdispatch
- `c0f8b8a` feat(core): deterministic apply, keyspace codec, canonical forms, revHash
- `f303473` fix(core): store declared @id before subject creation; drop dead params
- `d3b6fb1` test: I1..I10 invariant unit suite driving apply directly
- `f167d33` docs: DEVIATIONS.md for the core build

## Verification
- `pnpm install` from repo root: succeeds ("Done in 235ms").
- `pnpm test`: full suite green — **59 tests, 59 pass, 0 fail**.
- Working tree clean after final commit.

### Raw tail of the final `pnpm test` run

```
✔ I8: kind-changing redefinition migrates state and keeps indexes well-formed (§5.5) (3.5ms)
✔ I8: host-key promotion migrates host/ state into f/ and backfills (§5.6) (0.93225ms)
✔ I8: deletion suppresses a subject from idx/* and bl/*; undelete restores (§9.2) (2.138625ms)
✔ §10.2: xsd:integer — no decimal point, no leading zeros, no plus sign (0.589667ms)
✔ §10.2: xsd:decimal canonical mapping (0.182791ms)
✔ §10.2: xsd:double canonical mapping, never platform toString (0.145291ms)
✔ §10.2: xsd:dateTime/date canonical ISO-8601 with explicit Z (1.784708ms)
✔ §10.2: language tags lowercased; typed literals canonicalized (0.172666ms)
✔ §3.1: NFC and NFD spellings are the same subject (3.299125ms)
✔ §10.2: byte forms give a total, type-discriminated order (0.090208ms)
✔ I10/§8.0: a non-indexer AddWriter{indexer:true} never reaches host.addWriter and never mutates ctx/gov (2.348584ms)
✔ I10/§8.6: an agent op outside its namespace never mutates n/ (3.064167ms)
✔ I10/§8.3: revocation is causal (clock-based), not positional (1.417667ms)
✔ I10/§8.3: triple replay — incremental, from-scratch, forced-reorg partitions identical (4.351166ms)
✔ I10/§8.2: unacked optimistic ops are held, folded at ack position, never early-applied (2.080208ms)
✔ I10/§8.2: H_max caps the hold buffer of an unacked writer (0.439833ms)
✔ I10/§8.2: RemoveWriter for an unacked writer drops holds without folding (0.401875ms)
✔ I10/§8.5: token bucket — default ceiling applies from the first op; indexer ops replenish (1.056166ms)
✔ I10/§8.5: SetWriterPolicy may only tighten below the default; override audited (0.460042ms)
✔ I10/§8.6: namespace partition is stable across replay shapes (1.859666ms)
✔ I10: governance ops from a writer with no record at all are rejected (0.187333ms)
✔ §4: components round-trip through escaping; separators cannot be injected (0.596459ms)
✔ §4: a subject named 'hold' can never collide with the n/hold/ family (0.127625ms)
✔ §9.4: an op naming '../escape' is contained in the keyspace on any peer (4.759584ms)
✔ §9.4: apply rejects SetPath values that escape root (1.358334ms)
✔ §9.4: isSafePath is strict on traversal, absolute paths, and drive letters (0.129333ms)
✔ §8.6: prefix matching is per path segment, never byte-prefix (0.071458ms)
✔ §8.2/§8.4: hold, rejection, and optimistic families share one ordinal source (1.210792ms)
✔ §6: root revision (null base) matches the reference construction (0.882791ms)
✔ §6: chained revision includes the 64-hex base bytes (0.214041ms)
✔ §6: text is NFC-normalized before hashing (§3.1) (0.10225ms)
✔ §6: malformed base is refused (0.256375ms)
ℹ tests 59
ℹ suites 0
ℹ pass 59
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 185.880917
```

## Notes for downstream phases
- `createApply(config)` needs `genesisKey`; `rootBase`, `hostAllowlist`,
  `rate {tokensPerIndexerOp, capacity, holdMax}`, `limits` are vault-metadata
  constants the store package must pin.
- Apply expects nodes shaped `{ from: { key }, value: Buffer }` and a
  hyperbee-like view (`get/put/del/createReadStream` with gt/gte/lt/lte);
  `MemView` documents the exact surface. `host.addWriter/removeWriter` are
  only invoked after §8.0 checks; `host.ackWriter` is not yet used (ack is via
  in-log AddWriter) — store phase should decide whether optimistic autobase
  blocks additionally need `host.ackWriter` calls at fold time.
- Interruption note: this dispatch was cut off mid-suite by a server 529 and
  resumed; one incident-log commit from the coordinator (`c3ef7c5`) sits
  between this build's commits on the branch.
