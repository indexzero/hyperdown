# @auto-okf/store

**auto-okf on [autobee](https://github.com/holepunchto/autobee)** — the
substrate package of the auto-okf stack. It runs
[@auto-okf/core](../core)'s deterministic apply over a real multiwriter
log: one hypercore per writer, folded into a shared hyperbee2 view,
consistent across peers once they replicate. No autobase anywhere —
autobee is a standalone multiwriter Hyperbee on hyperbee2 + hypercore 11.

## Usage

Init a vault, append an op, converge a second writer:

```js
import { initVault, joinVault } from '@auto-okf/store'

const a = await initVault('./vault-a')

// mint a concept — the returned tag is its _id (SPEC §6)
const { tag: id } = await a.createConcept('guides/getting-started', 'guide')
await a.setBody(id, null, 'Read the [architecture](/guides/architecture) first.')

// a second peer joins by key and replicates directly
const b = await joinVault('./vault-b', a.key)
const s1 = a.replicate(true)
const s2 = b.replicate(false)
s1.pipe(s2).pipe(s1)

// the genesis indexer admits b as a writer (an in-log governance op)
await a.writers.add(b.localKey)
await b.update()

await b.addTag(id, 'p2p') // b writes; every peer folds the same view

console.log(await a.snapshotHash() === await b.snapshotHash()) // true, once folded
await a.close()
await b.close()
```

Or over the DHT instead of a pipe: `await a.swarm()` / `await b.swarm()`
(hyperswarm on `discoveryKey`).

## Install

```sh
npm install @auto-okf/store
```

## What the store pins

**Vault metadata** (`okf-vault.json`, written at `init`, loaded at open,
byte-identical on every peer — `metadataHash` is the cross-peer pin):

- **`appendOnly: true`** — the SPEC §8 constant, immutable by
  construction: it lives outside the log (no op can flip it — the wire
  contract has no prune/compact/byte-destroying op at all), nothing
  rewrites the file after init, and a tampered document refuses to open.
  `DeleteConcept` is a tombstone; bytes and `_id` remain.
- **Generation chain** (`predecessorKey`, `predecessorCheckpoint`) — SPEC §10:
  which vault this one was compacted from, with the predecessor's I2 view
  hash and writer lengths (operator-signed; provenance, not proof).
- **`generation`** — the per-generation corestore namespace, derived purely from the
  predecessor fields (`'root'` when null). Writer cores derive under
  it, so a writer keypair can never recur across generations, even in a reused
  directory (§10 freshness; adoption of predecessor mint ids stays safe).
- `limits`, `rate`, `schemaVersion`, `encrypted` — the `createApply`
  config slice, identical on every peer (I2).

## API

```js
const vault = await initVault(dir, opts)        // create (writes metadata)
const vault = await openVault(dir, opts)        // reopen from disk
const vault = await joinVault(dir, key, opts)   // join by vault key
```

`opts`: `metadata` (invite overrides incl. generation-chain fields),
`encryptionKey` (32 bytes, end to end — writer cores, system and view
encrypted at rest; persisted so reopen needs no key), `keyPair`, `swarm`,
`backpressure`.

### Vault

| member | what |
| --- | --- |
| `id`, `key`, `discoveryKey` | vault identity (autobee bootstrap core) |
| `localKey`, `writable`, `isIndexer` | this peer's writer |
| `metadata`, `generation` | the pinned document and the §10 namespace id |
| `append(type, payload, { optimistic, backpressure })` | encode + append one §3 op; fills `clock` (observed vector clock, self entry pinned to the op's seq) and `at`; returns `{ seq, tag }` |
| `createConcept / setField / addTag / remTag / setBody / setPath / deleteConcept / undeleteConcept / resolveConflict` | content-op helpers (thin over `append`); `remTag` computes the §5 citation set from the view |
| `writers.add(key, { indexer })` | §8 governance op (apply enforces the indexer-issuer rule) |
| `writers.remove(key)` | causal revocation — in-band, never positional; the emitted clock cites the target's observed position (`seqAtRemoval`) |
| `writers.setPolicy(key, { namespacePrefixes, rateCeiling })` | per-writer namespace + token-bucket policy |
| `view`, `get(key)`, `val(key)`, `scan(prefix)` | reads over the hyperbee2 view snapshot |
| `update()`, `updated()`, `flush()` | autobee lifecycle passthrough |
| `snapshotHash()` | I2/I3 full-range view hash, byte-compatible with core `MemView.hash()` |
| `checkpoint()` | §10 `{ viewHash, writerLengths }` for the next generation's metadata |
| `replicate(isInitiator \| stream)` | direct replication stream |
| `swarm([hyperswarm])`, `leaveSwarm()` | DHT replication on `discoveryKey` |
| `close()` | closes autobee and the owned corestore |

### Backpressure (opt-in)

By default `append` is fire-at-caller-rate. With `{ backpressure: true }`
(vault-level or per-append; or `{ maxInflight, ackTimeout }`) each append
self-throttles behind two gates on one watermark: the writer's own fold,
and the fold progress peers demonstrate through the §3 clocks their ops
carry — bounded by `ackTimeout`, so silent or partitioned peers degrade
throughput instead of deadlocking the writer.

### Revocation semantics

A removed writer's post-revocation ops still linearize on every peer
(`host.removeWriter` is never called) and are uniformly rejected by
core's §8 clock rule — the applied/rejected partition is replay-stable
(I10). The removed writer's own store refuses further local appends
(`VAULT_REVOKED`).

## Tests

Integration tests run on real autobee + corestore instances (no stubs):

```sh
pnpm test:okf     # core unit/invariant suite + these store tests
```

two-writer convergence (view-hash equality), optimistic onboarding
(hold → ack-anchored fold), backpressure, writer add/remove round trip
with causal revocation across a partition, encryptionKey open/read,
vault-metadata determinism (appendOnly + generation chain), generation-namespace
freshness, restart-from-disk rebuild equality, hyperswarm replication
over a local testnet.

## License

Apache-2.0
