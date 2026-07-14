# OKF-P2-store — T4 result: @auto-okf/store on autobee

**Branch:** `11/okf-store` (stacked on `10/okf-core`). **Spec:** okf/SPEC.md
v1.2 (§2 architecture, §8 governance/append-only, §10 epoch chain, §13
store scope). **Status: complete — full repo suite 191/191 green.**

## What was built

`okf/store` (@auto-okf/store, Apache-2.0), on **autobee ^1.0.10** (the
standalone multiwriter Hyperbee on hyperbee2 + hypercore 11; no autobase
dep/import/framing anywhere). Every autobee/hyperbee2 signature verified
against the installed sources (autobee@1.0.10, hyperbee2@2.10.3,
corestore@7.11.0) and cross-checked against the upstream README; citations
in the code headers.

- `lib/metadata.js` — vault-metadata pinning: `appendOnly: true` immutable
  by construction (§8: unrepresentable off in `createMetadata`, refused at
  load when tampered, never rewritten after init); epoch-chain fields
  `{ predecessorKey, predecessorCheckpoint }` (§10) with checkpoint shape
  validation (viewHash, writerLengths, optional operator signer/signature —
  carried, not verified: trusted-operator scope); `epoch` = pure function
  of the chain fields (`'genesis'` | sha256(predKey‖canonical(checkpoint)));
  canonical bytes + `metadataHash` as the cross-peer pin; `applyConfig`
  slice for core's `createApply`.
- `lib/view.js` — ViewAdapter presenting core's expected hyperbee2-view
  surface (string keys/values ⇄ buffers) over the real bee; range iteration
  is hyperbee2's `{gt,gte,lt,lte,reverse,limit}` RangeStream, verified — no
  classic-hyperbee assumptions.
- `lib/hash.js` — `viewHash`, byte-compatible with core `MemView.hash()`
  (raw stored value bytes), so substrate and unit-suite views of the same
  linearized prefix compare directly.
- `lib/vault.js` — the Vault: per-epoch corestore namespace (writer-keypair
  freshness §10, even in a reused directory), autobee up, core apply wired
  through the adapter; §8 governance emission (`writers.{add,remove,
  setPolicy}`) with store-built full observed clocks (remove-writer always
  cites the target's seen position → correct `seqAtRemoval`); causal
  revocation only (host.removeWriter never called; local revoked-append
  guard mirrors core's exact rule); uniform topo weight (2 — see
  deviations); DAG-level `ackWriter` for optimistic nodes with core's
  hold/ buffer as the sole view-effect gate; encryptionKey end to end;
  hyperswarm `swarm()/leaveSwarm()`; opt-in append backpressure (two-gate
  own-fold + peer-ack admission, ackTimeout-bounded); content-op helpers
  incl. `remTag` computing the §5 citation set; `snapshotHash()`,
  `checkpoint()` (§10 material for the next epoch); serialized appends so
  the §8 forged-clock rule can never be tripped by interleaved async
  appends.
- `index.js` — `initVault/openVault/joinVault` + re-exports.
- `okf/store/README.md` — usage-first, "on autobee".

## Autobee port notes (key mappings)

- Node shape passes through unwrapped: autobee hands apply
  `{ key, value, length, optimistic }` (lib/writers.js createNode) — exactly
  core's documented node contract.
- Genesis auto-add is uncontrollable and uses weight 2 → uniform weight is
  pinned at **2**, overriding both autobee's mixed defaults and §8's
  literal `weight: 1` (DEVIATIONS.md; topo.js comparator divergence is the
  reason §8 wants uniformity at all).
- Optimistic batches roll back unless the writer lands in autobee's system
  during apply (`_optimisticBatch`) → the store acks optimistic nodes at
  the DAG level inside apply; §8 view semantics unchanged (DEVIATIONS.md).
- Acked optimistic nodes are NOT re-delivered to apply → core's
  full-payload `hold/` design confirmed correct (already recorded by T2/T3).
- `db.close()` closes the store it was handed → the Vault hands it the
  per-epoch namespace session and closes the root corestore itself.

## Core fix required by T4 (one file, minimal, documented)

`okf/core/lib/ops.js` hold hydration hex-mangled the frontmatter `key`
field of a **held** `set-field` (`Buffer.from('status','hex')` → empty
buffer): the fold wrote `c/<id>/f/` under an empty key on every peer —
converged but wrong, unreachable by core's unit suite (its hold tests held
only create-concept/set-body). Governance ops (the only buffer-`key` ops)
reject before the hold branch, so hydration is now a plain
null-normalizing copy; view bytes unchanged for all previously passing
cases; okf-core's 62 tests stay green; the store's optimistic-onboarding
integration test is the regression test. Recorded in DEVIATIONS.md; called
out in the PR body. Isolation trace preserved at
`sslop/030/debug/optimistic-fold-trace.js`.

## Tests (okf/test, node:test, REAL autobee + corestore, dirs under sslop/030/tmp/)

15 new store tests across 5 files:

- `store-convergence.test.js` — two-writer convergence (view-hash equality
  after replication + OR-set/LWW/wanted checks), optimistic onboarding
  (hold on the writer's peer → ack-anchored fold → cross-peer hash
  equality), backpressure burst (throttles, degrades on ackTimeout, never
  deadlocks).
- `store-writers.test.js` — add/remove round trip with a partition-window
  post-revocation op rejected `revoked` on every peer (I10 partition
  stability + hash equality), local `VAULT_REVOKED` guard, last-indexer
  removal rejected, setWriterPolicy namespace enforcement.
- `store-encryption.test.js` — encrypted init → reopen WITHOUT the key
  (persisted) → read; invited peer with the key converges.
- `store-metadata.test.js` — metadata determinism across peers (bytes +
  hash, incl. appendOnly and epoch-chain fields), appendOnly tamper
  refusal + unrepresentability, mismatched-invite refusal, deterministic
  epoch derivation, fresh writer keypairs in a REUSED directory across
  epochs.
- `store-restart.test.js` — restart-from-disk hash + key-set equality with
  seq/clock continuity, fresh-peer rebuild equality.

## Verification (raw tail of `pnpm test` — vault-ld 114 + okf-core 62 + store 15)

```
✔ restart from disk: reopened view equals the pre-close view (I3) (738.92875ms)
✔ fresh peer rebuild from the log equals the restarted view (532.810416ms)
✔ two vaults replicate over hyperswarm (discoveryKey join) (607.966416ms)
✔ writer add/remove round trip (1207.814625ms)
ℹ tests 191
ℹ suites 0
ℹ pass 191
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14963.817084
```

`pnpm install` clean (lockfile updated for the new workspace package).

## Deviations recorded (DEVIATIONS.md)

1. Uniform topo weight 2 (not §8's literal 1) — genesis auto-add forces it.
2. DAG-level ackWriter for optimistic nodes (autobee rollback reality).
3. Core `opToJson/opFromJson` hold-hydration fix (T4-found core bug).
4. §10 epoch-namespace derivation rule (spec-silent detail, pure function
   of the chain fields).
