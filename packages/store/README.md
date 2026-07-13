# @hyperwiki/store

Multiwriter Vault-LD storage **on [autobee](https://github.com/holepunchto/autobee)**:
opens a vault over a corestore, wires `@hyperwiki/core`'s deterministic
`apply` into autobee's apply cycle, pins the vault metadata every peer must
agree on, emits the §8 governance/content ops, and replicates over
hyperswarm.

```js
import { Vault } from '@hyperwiki/store'

// creator
const a = await Vault.init('./vault-a')
await a.defineTerm('core', 'title', { '@id': 'ex:title' })
await a.setField('Home', 'title', 'Welcome')

// second peer (share a.key out of band)
const b = await Vault.join('./vault-b', a.key)
const s1 = a.replicate(true)
const s2 = b.replicate(false)
s1.pipe(s2).pipe(s1)

// the creator (genesis indexer) admits b as a writer — an ordinary logged op
await a.addWriter(b.localKey, { indexer: false })
await b.update() // ... poll until b.writable
await b.setField('Home', 'title', 'Hello from b')

// converged peers hold bit-identical views
console.log(await a.hash() === await b.hash()) // true once replicated
console.log(await a.val('n/Home/f/title'))     // { reg: { values: ['Hello from b'], ... }, ... }

await a.close() // closes the corestore too
await b.close()
```

## Install

```sh
pnpm add @hyperwiki/store
```

## How it fits

The op log is the source of truth (SPEC-FINAL §2). Each peer appends encoded
ops to its own writer core; autobee linearizes all writers' nodes and calls
`apply`, which this package routes into `@hyperwiki/core`'s pure fold over a
view adapter. Nothing writes the view except that fold, so any set of peers
that exchanged all ops holds bit-identical views (I2), verified by
`vault.hash()`.

```
Vault ──ops──▶ autobee (writer cores, linearization, hyperbee2 view)
                 │ apply(nodes, view, host)
                 ▼
   node adapter + ViewAdapter + host adapter
                 │
                 ▼
   @hyperwiki/core createApply(metadata)   ←  pinned vault metadata
```

## API

### `Vault` (`@hyperwiki/store/vault`)

- `await Vault.init(storage, opts)` — create a brand-new vault. Writes the
  pinned metadata document to `<dir>/vault-ld.json`. `storage` is a
  directory (preferred) or a dedicated Corestore the vault takes ownership
  of (autobee closes the corestore it is handed).
- `await Vault.open(storage, opts)` — reopen a vault from disk; metadata is
  loaded from the pin, encryption is restored from the pinned `encrypted`
  bit (autobee persists the key itself in the local core's user data).
- `await Vault.join(storage, key, opts)` — join an existing vault by key.
  For non-default metadata or encrypted vaults, the invite is
  `{ key, metadata, encryptionKey }`.
- `opts`: `key`, `metadata` (overrides/invite), `encryptionKey` (32-byte
  Buffer, end to end: writer cores, system and view encrypted at rest),
  `keyPair`, `swarm` (shared Hyperswarm instance), `backpressure`
  (opt-in append admission control, `true` or `{ maxInflight, ackTimeout }`
  — see "Backpressure and the sustainable-rate envelope" below).

Identity and lifecycle: `vault.key` / `vault.keyHex` (vault key ==
genesis key), `vault.discoveryKey`, `vault.localKey` (this peer's writer
key — what an indexer passes to `addWriter`), `vault.writable`,
`vault.isIndexer`, `vault.metadata`, `await vault.update()`,
`await vault.updated()`, `await vault.close()`. Vaults are EventEmitters
and forward autobee `'error'` events.

Reads (over autobee's read-only view snapshot, §4 keyspace):

- `await vault.get(key)` → `{ key, value } | null`
- `await vault.val(key)` → value or `undefined`
- `vault.scan(prefix)` → async iterable of `{ key, value }` for a keyspace
  prefix (`'n/'`, `'flag/'`, `'ctx/gov/'`, ...)
- `await vault.hash()` — full-range-scan view hash (the I2/I3 check)

Op emission (§8 plumbing; every helper fills the §3.2 `clock` field from
the DAG heads at append time, and the opId `tag` where the op carries one):

- `await vault.append(type, payload, { optimistic, backpressure })` —
  generic §3.2 op; `backpressure` (`true` | `{ maxInflight }` | `false`)
  opts this one append in or out of the admission control described below
- governance (apply rejects these unless the issuer is a confirmed indexer,
  §8.0): `addWriter(key, { indexer })`, `removeWriter(key)`,
  `setWriterPolicy(key, { namespacePrefixes, rateCeiling })`,
  `pruneRevisions(s, before)`
- content: `setField(s, p, o)`, `addMember(s, p, o)`,
  `remMember(s, p, value)` (computes the full §5.3 citation set from the
  resolved view — callers never pass tag subsets), `setBody(s, base, text)`,
  `defineTerm(scope, term, def)`, `defineScope(scope, base, prefix)` — every
  convenience takes a trailing `opts` whose `optimistic` and `backpressure`
  keys are forwarded as append options

Optimistic onboarding (§8.2): an unadmitted writer may pass
`{ optimistic: true }`. The node is acknowledged at the autobee level so it
anchors in the log, but its **view effect is held** (`n/hold/`,
`flag/optimistic/`) until an indexer's `addWriter` op linearizes; the held
ops then fold at the ack's position on every peer.

Replication:

- `vault.replicate(isInitiatorOrStream)` — direct stream (pipe two vaults
  together as in the example)
- `await vault.joinSwarm([swarm])` — join `vault.discoveryKey` on
  hyperswarm; every connection is fed to `db.replicate`. Without a provided
  swarm the vault creates and owns one. `await vault.leaveSwarm()`.

### Metadata (`@hyperwiki/store/metadata`)

Every peer must run `createApply` with identical constants — they are
convergence-relevant inputs (core README, "Vault-metadata constants").
`createMetadata({ genesisKey, rootBase, hostAllowlist, rate, limits,
schemaVersion, encrypted })` fills the pinned defaults;
`canonicalMetadataBytes` / `metadataHash` give order-independent canonical
bytes for cross-peer comparison; `saveMetadata` / `loadMetadata` handle the
on-disk pin; `applyConfig(meta)` extracts the `createApply` slice. The §3.3
wire-contract `schemaVersion` is recorded here. A vault's `genesisKey` is
its vault key: autobee derives the creator's vault key from the creator's
local writer core, so the §8.0 genesis indexer and the bootstrap key
coincide on every peer.

### View adapter (`@hyperwiki/store/view`)

`new ViewAdapter(bee)` presents the classic
`get`/`put`/`del`/`createReadStream({ gt, gte, lt, lte, reverse, limit })`
surface core's apply expects over a hyperbee2 view (buffer keys/values,
`write()` batches). Range iteration is native hyperbee2 (verified against
its source), keys in UTF-8 byte order, values JSON round-tripped.

### `viewHash(view)` (`@hyperwiki/store/hash`)

Full-range-scan sha256 of any `{ key, value }` iterable view — byte-for-byte
the same construction as core's `MemView.hash()`, so store views and unit
MemViews are directly comparable.

## Backpressure and the sustainable-rate envelope

By default `vault.append` is **fire-at-caller-rate**: it never yields to or
waits on the local fold. Under sustained concurrent multi-writer load that
is a feedback loop (CODE-REVIEW.md finding M2): whichever writer gets ahead
keeps its event loop free and floods faster, while the peers drown applying
the growing concurrent DAG, fall further behind on their own appends, and
eventually stall.

The opt-in fix is store-level admission control:

```js
// per vault: every append from this peer self-throttles
const v = await Vault.open('./vault', { backpressure: true })

// or per op (true == { maxInflight: 1, ackTimeout: 1500 });
// false opts a single op out of a vault-level config
await v.setField('Home', 'title', 'hi', { backpressure: true })
```

With backpressure on, every append passes two admission gates on the same
`maxInflight` watermark before the op is issued:

1. **own fold** — if `maxInflight` ops are outstanding beyond the writer's
   last awaited fold, it awaits `update()` (a full fold of the linearized
   DAG, remote ops included), so it never builds a local append-vs-apply
   backlog;
2. **peer acknowledgment** — if `maxInflight` ops are beyond the highest
   length of this writer's core that any folded peer op's §3.2 `clock` has
   cited, the append waits (up to `ackTimeout` ms) for fresh acks. A peer's
   op clock cites exactly what that peer had linearized when it appended, so
   this pins a fast writer to its peers' *demonstrated* fold progress. This
   gate is the load-bearing one: under the M2 flood the leader's own fold
   stays cheap precisely because the drowning peers send little, so a
   local-fold-only throttle measurably fails to prevent the divergence.

The ack gate never engages on a vault that has not folded another writer's
op (single-writer vaults never wait), and on timeout the op is admitted
anyway — silent, idle or partitioned peers degrade a backpressured writer to
roughly `maxInflight` ops per `ackTimeout` instead of deadlocking it; pass
`backpressure: false` per op for deliberate offline/bulk writing. Default
behavior without the option is unchanged — enable it on any sustained-write
production path. The bound is per awaited caller: concurrent in-process
appends may overshoot by the concurrency degree.

Measured envelope (3-writer lossy-link soak, bounded O(1) ops —
setField/addMember): **unthrottled at ~12 ops/s/writer the run floods** —
op counts diverge (1,535 vs 101 vs 421) and an op on the flooding writer
stalls past a 120 s budget at ~4.5 min; **throttled to the fold rate
(~2.5 ops/s/writer with a per-op fold) the same workload sustains the full
30.5 min balanced** (final op counts 3,235 / 3,601 / 3,736), no op timeouts,
with RSS, heap and open FDs all bounded. With the `backpressure` option on,
the same 3-writer lossy workload *attempted* at ~12 ops/s/writer self-paces
to ~0.6–0.7 admitted ops/s/writer and stays balanced end to end (measured
6-minute runs: 245/243/246 and 253/237/248 final ops, no op timeouts) —
the writers absorb the excess demand instead of flooding the mesh. Only the
on-disk corestore grows (append-only log — a known design decision).
Post-load bulk catch-up of a large accumulated backlog remains limited by
the same fold-rate ceiling.

## Caveats

- **Policy epochs (§5.7):** merge policy is read from the in-log context at
  apply time; a reorg that moves a `DefineTerm` can change the merged result
  deterministically. Agent writers should pin `ctxKind` on field ops.
- **Writer topo weight:** all writers are admitted with equal autobee topo
  weight; the indexer bit lives in `ctx/gov` (see DEVIATIONS.md).
- A revoked writer that keeps appending non-optimistic ops is torn down by
  autobee (`'error'` event); its ops never reach any peer's view.

## Tests

From the repo root: `pnpm test` (Node's built-in runner). The store suite
(`test/store-*.test.js`) drives real autobee + corestore instances on disk:
two-writer convergence by view-hash equality, optimistic hold/fold, writer
add/remove round trip, encrypted open/read/replicate, metadata determinism,
restart-from-disk and fresh-peer rebuild equality (I3), append backpressure
(bounded in-flight watermark under concurrent load), and hyperswarm
replication over a local DHT testnet.

## License

Apache-2.0
