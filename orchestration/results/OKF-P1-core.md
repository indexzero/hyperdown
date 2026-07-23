# OKF-P1-core — @auto-okf/core + invariant suite (T2/T3)

**Branch:** `10/okf-core` · **Spec:** `okf/SPEC.md` (SPEC-FINAL v1.2) ·
**Status:** complete, full repo suite green (176/176).

## What was built

### `okf/core` (@auto-okf/core)

| file | content |
| --- | --- |
| `lib/keyspace.js` | copied from `vault-ld/core/lib/keyspace.js` @ 046d37f (provenance header); escaping helpers verbatim, families rewritten for §4 |
| `lib/canonical.js` | copied verbatim @ 046d37f (provenance header) |
| `lib/revhash.js` | copied verbatim @ 046d37f (provenance header); formula identical to vault-ld |
| `schema/build.js` + `spec/` | 12-op wire contract (§3) via hyperschema@1.21 + hyperdispatch@1.6; generated codec committed, command ids 0..11 pinned append-only |
| `lib/ops.js` | `encodeOp`/`decodeOp` (decode never throws → `unknown-msgid`/`undecodable`), tag helpers (`writerKeyHex‖minimal-hex-seq`), clock normalization, hold-buffer (de)hydration |
| `lib/apply.js` | `createApply(config)` — the complete deterministic §5–§8 apply (details below) |
| `lib/links.js` | pure §9-normative CommonMark link extraction + target resolution (inline/reference links, code-block/span skipping, scheme/protocol-relative citations ignored, `.`/`..` containment, `.md`/fragment stripping, NFC) |
| `lib/memview.js` | hyperbee2-surface in-memory view (get / `write()` batches with `tryPut`/`tryDelete`/`flush` / `createReadStream({gt,gte,lt,lte,reverse,limit})`) — surface verified against installed hyperbee2@2.10.3 sources |
| `index.js`, `README.md` | usage-first package docs |

`createApply` covers: tags OR-set with removed-token memory (SU-set,
staletag audit); LWW-array registers with cross-writer clobber audit;
bodies as immutable revisions (same-non-null-base siblings + one flag per
pair via `revbybase/`, fabricated-base containment per M5, null-base =
cite-head discipline, `ResolveConflict` with synthesis and replay
rejection); `_id` mint/adopt with the N1 squat-proof fallback mint
(`SHA-256(key‖seq‖k)`) + `flag/squat`, `duplicate-id`, `bad-id`,
`mint-collision-risk` (incl. exact-64-hex and unacked-writer cases via
`seen/`); path LWW register with `ord` (global apply ordinal), first-wins
collisions, casefold detection in apply on every peer, reserved
`index`/`log` terminals and `\.conflict-[0-9a-f]{8,}$` suffixes,
`unsafe-path` containment, path byte/depth limits in §3 fixed order;
governance (indexer gate, `host.addWriter(key, { isIndexer, weight: 1 })`
explicit weight, zero-indexer guard, causal revocation via
`gov/removed` clock + `seqAtRemoval` cross-check, `forged-clock`
self-entry rule, `host.removeWriter` never called); optimistic
hold/fold/ack (`hold/` full payloads, H_max 512, fold at the AddWriter
ack with `host.ackWriter`, fold-time rejections → `flag/optimistic`);
writer-local token buckets (start full at admission/first hold, +1 per
accepted indexer op, unacked ceiling 64); `wanted/` + `wantedrank/`
(16-digit inverted count) maintenance with late-binding promote/demote on
every occupancy/liveness change; `log/` narration records; `seen/`
ordinal; tombstone semantics (`writeafterdelete` lands-and-flags,
undelete with fresh claim ordinal).

Purity is enforced by a source-scan test (no `Date.now`, `Math.random`,
`hrtime`, `performance.now`, `process.env`, `signedLength`, `heads(`),
plus `stableStringify` on every view write so map order never leaks.

### `okf/test` (T3)

62 `node:test` cases, all driving `apply` directly against MemView:

| invariant | file | tests |
| --- | --- | --- |
| I1 determinism | `i01-determinism.test.js` | 3 (incl. purity source scan, `at`-independence) |
| I2 convergence | `i02-convergence.test.js` | 2 (bit-identical independent applies; OR-set byte-convergence across interleavings) |
| I3 rebuild | `i03-rebuild.test.js` | 1 (per-node vs chunked vs one-shot) |
| I4 no silent loss | `i04-no-silent-loss.test.js` | 6 |
| I5 OR-set law | `i05-orset.test.js` | 4 |
| I6 LWW law | `i06-lww.test.js` | 4 |
| I7 conflict lifecycle | `i07-lifecycle.test.js` | 5 |
| I8 index coherence | `i08-index-coherence.test.js` | 2 (re-derives `path/ link/ bl/ wanted/ wantedrank/ revbybase/` from `c/` alone) |
| I10 governance | `i10-governance.test.js` | 13 |
| adversarial (review-surfaced) | `adversarial.test.js` | 17 |
| §3 codec | `codec.test.js` | 5 |

Adversarial coverage as assigned: mint squat incl. future/unacked writer
(N1) and the unknown-future-writer fallback-mint path; SetField on
`tags`/`_id`/`_rev` (M4); fabricated-base SetBody with and without a head
(M5); casefold path collision (NFC + casefold, loser keeps
`path/<exact>`); revocation-race partition stability (in-flight
acceptance window, seq cross-check vs backdated clocks, replay-stable
partition); keyspace injection/escaping (hostile paths/keys/tag values
cannot escape their family).

**Deferred to faces (NOT this task):** I9 (byte-identical bundle
emission — needs materialize) and I11 (materialize → ingest epoch-cycle
roundtrip — needs both faces). Everything apply-side that I9/I11 depend
on (deterministic view, conflicted-copy inputs, adoption rules) is
covered at unit level here.

### Root wiring

`package.json` test script now runs both stacks:
`node --test "test/*.test.js" "okf/test/*.test.js"` (plus a `test:okf`
convenience script); `@auto-okf/core` added to root devDependencies;
pnpm workspace untouched (`okf/*` was already in `pnpm-workspace.yaml`).

## Deviations / judgment calls

Spec-mandated recordings appended to `DEVIATIONS.md`: revHash length
prefix (copied u64-BE code wins over §5's u32-LE prose); per-writer
ordinal = `seen/` count (checked autobee's node, which does expose
`length`); hold/ stores full payloads (verified autobee does NOT
re-deliver acked optimistic nodes — `_optimisticBatch`,
`lib/apply-calls.js`).

Code-comment resolutions where the spec is silent (per §0 rule 4):
`ord/global` + `pcl/<casefold>/<id>` bookkeeping families backing §4's
`ord` and §7's casefold recompute (both co-derived from `c/`, I8-clean);
`.md` suffix stripped case-insensitively in apply path normalization;
rejection reasons named for spec-silent cases (`unknown-id`, `bad-base`,
`bad-id`, `policy-namespace`, `oversize-path`, `depth-exceeded`);
non-minimal hex suffixes are not mint-shaped (spec-literal, tested);
undelete re-claims its path at the undelete position (fresh ord) so a
deletion-vacated concept cannot evict an interim holder; AddWriter
re-admission clears `gov/removed`; `strictlyPrecedes` equality rejects
(spec-literal "does not strictly precede"); governance ops from unacked
writers reject (`policy-governance`) rather than hold; fold runs without
re-rate-checking (held ops were rate-checked at hold time, §8).

## Verification (raw tail of `pnpm test`, full repo)

```
✔ restart from disk: reopened view equals the pre-close view (I3) (860.577959ms)
✔ fresh peer rebuild from the log equals the restarted view (576.9865ms)
✔ two vaults replicate over hyperswarm (discoveryKey join) (456.9375ms)
✔ writer add/remove round trip (1186.898666ms)
ℹ tests 176
ℹ suites 0
ℹ pass 176
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 22808.541958
```

Split verified independently: `node --test "test/*.test.js"` → 114 pass
(vault-ld count unchanged); `node --test "okf/test/*.test.js"` → 62 pass.
`pnpm install` clean.
