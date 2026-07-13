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
  `keyPair`, `swarm` (shared Hyperswarm instance).

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

- `await vault.append(type, payload, { optimistic })` — generic §3.2 op
- governance (apply rejects these unless the issuer is a confirmed indexer,
  §8.0): `addWriter(key, { indexer })`, `removeWriter(key)`,
  `setWriterPolicy(key, { namespacePrefixes, rateCeiling })`,
  `pruneRevisions(s, before)`
- content: `setField(s, p, o)`, `addMember(s, p, o)`,
  `remMember(s, p, value)` (computes the full §5.3 citation set from the
  resolved view — callers never pass tag subsets), `setBody(s, base, text)`,
  `defineTerm(scope, term, def)`, `defineScope(scope, base, prefix)`

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
restart-from-disk and fresh-peer rebuild equality (I3), and hyperswarm
replication over a local DHT testnet.

## License

Apache-2.0
