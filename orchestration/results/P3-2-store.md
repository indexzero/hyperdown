# P3-2 build report: /packages/store on autobee

Status: DONE. Full repo suite green (72/72), three atomic commits on `3/store`
(`39b5cc8` feat, `49dfac4` test, `7c143f9` docs), no push, no PRs.

## What was built

`@hyperwiki/store` — Vault-LD storage on **autobee ^1.0.10** (standalone
multiwriter Hyperbee on hyperbee2 + hypercore 11; no autobase anywhere —
dependency replaced, description now "on autobee", lockfile regenerated via
pnpm). Everything verified source-first against the installed autobee 1.0.10
(`index.js`, `lib/apply-calls.js`, `lib/system.js`, `lib/writers.js`,
`lib/topo.js`, `lib/boot.js`, README) and hyperbee2 (`index.js`,
`lib/ranges.js`, `lib/write.js`), plus both reference codebases
(`attempt-opus-1/lib/registry.js`, `attempt-opus-2/lib/{peer,registry}.js`);
source paths/URLs cited in code comments.

- `packages/store/lib/vault.js` — Vault init/open/join/close lifecycle:
  corestore in, Autobee up (`new Autobee(store, key, { apply, open,
  encryptionKey, encrypted, keyPair, optimistic })`), core's `createApply`
  wired through adapters into autobee's apply. Node adapter
  (`{key,value,length}` → `{from:{key},value,length}`), host adapter
  (`addWriter(key,{indexer})` → `addWriter(key,{isIndexer,weight})`,
  `removeWriter` guarded by `removeable`). §8 op emission helpers: generic
  `append(type, payload, {optimistic})` filling the §3.2 `clock` (from DAG
  heads, the autobee analogue of the spec-blessed `base.heads()`) and opId
  `tag`; governance helpers (addWriter/removeWriter/setWriterPolicy/
  pruneRevisions); content helpers incl. `remMember` computing the full
  §5.3 citation set. Replication: `replicate(bool|stream)` and
  `joinSwarm()` (discoveryKey join, connections fed to `db.replicate`).
- `packages/store/lib/view.js` — deterministic ViewAdapter presenting
  core's `get/put/del/createReadStream` contract over the hyperbee2 view.
  Range iteration verified present in hyperbee2 source (`lib/ranges.js`
  supports gt/gte/lt/lte/reverse/limit in byte order), so core's
  consumption needed no adaptation; core was not modified. Buffer keys,
  JSON values (MemView-equivalent semantics), `view.write()` batches
  (tryPut/tryDelete/flush) per the attempt-opus-1 registry pattern.
- `packages/store/lib/metadata.js` — vault metadata pinning: genesisKey,
  rootBase, hostAllowlist, rate, limits, plus §3.3 `schemaVersion` and the
  `encrypted` bit. Written at init (`<dir>/vault-ld.json`), loaded at open,
  canonical (sorted-key) bytes + sha256 identity across peers; divergent
  invite / mismatched key refused at open. genesisKey == vault key by
  autobee's boot construction (creator's local core is the bootstrap), so
  the §8.0 genesis indexer needs no out-of-band transfer.
- `packages/store/lib/hash.js` — full-range-scan view hash,
  byte-compatible with core's `MemView.hash()`.
- `packages/store/README.md` — usage-first (working example → install →
  API per entry point → caveats → tests → Apache-2.0), framed "on autobee".

## Port decisions (recorded in DEVIATIONS.md)

1. **§13 port map** — apply node shape, host surface, and
   `signedLength`-scoped clauses onto autobee's flush/anchor finality
   (autobee reports `signedLength === length`; `host.createAnchor()` is the
   checkpoint primitive; §11 snapshot machinery deferred to P4). Also §8.3:
   autobee refuses to linearize a seen-revoked writer's non-optimistic
   nodes at all (teardown via `'error'`), strictly stronger than
   reject-in-apply; the in-log clock rule still covers racing ops.
2. **§8.2 optimistic onboarding** — decided against autobee's
   optimistic+ackWriter reality: the apply wrapper `host.ackWriter`s
   optimistic nodes (DAG-level anchor, deterministic on every peer) while
   core's `n/hold/` + `flag/optimistic` remain the only view-effect gate
   until an in-log indexer `AddWriter` folds the held range. Effects are
   ack-anchored, so views converge even when the raw optimistic node
   linearized at different positions on different peers (asserted in
   tests).
3. **Uniform topo weight 2 for all writers** — empirically discovered
   divergence: autobee 1.0.10's `lib/topo.js` comparators
   (`isOrderedBefore` vs `cmp`) disagree for concurrent nodes of unequal
   weight, leaving two peers with permanently different linearizations
   (fatal for I2 under core's order-sensitive apply; the reference apps
   dodge it with order-independent applies). All writers get the genesis
   weight (2); the indexer bit rides along for autobee bookkeeping and
   §8.0 authority stays in `ctx/gov` where core decides it.

## Tests (test/store-*.test.js, node:test, real autobee + corestore on disk)

Dirs unique-per-run under `sslop/013/tmp/` (never /tmp, handles closed, no
cleanup). Coverage: two-writer convergence by view-hash equality (I2);
optimistic hold/fold (§8.2); writer add/remove round trip incl.
post-revocation containment; encryptionKey init/write/reopen-read +
encrypted two-peer convergence; metadata determinism/pinning/refusal;
restart-from-disk equality and fresh-peer rebuild equality (I3 store
level); hyperswarm replication over a local hyperdht testnet.

## Verification

`pnpm install` clean; full repo suite (`pnpm test`, core invariant suite +
store suite) green. Raw tail:

```
✔ restart from disk: reopened view equals the pre-close view (I3) (976.954334ms)
✔ fresh peer rebuild from the log equals the restarted view (362.41125ms)
✔ two vaults replicate over hyperswarm (discoveryKey join) (836.8625ms)
✔ writer add/remove round trip (1446.909959ms)
ℹ tests 72
ℹ suites 0
ℹ pass 72
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1903.469167
```

## Notes for P4

- The multi-process fault harness (forced reorgs, partition/heal at scale,
  §11 snapshot machinery) is out of scope here per the dispatch.
- Remote-peer pre-ack visibility of optimistic holds depends on
  autobee-wakeup propagation of unknown writer cores; locally the hold is
  immediate and cross-peer effects are ack-anchored either way. Worth a
  harness probe.
- `Vault` forwards autobee `'error'` events; a revoked writer that keeps
  appending is torn down by autobee — harness should assert that teardown
  path under process kill/restart.
