# @auto-okf/store

**auto-okf on [autobee](https://github.com/holepunchto/autobee)** — the
substrate package of the auto-okf stack. It runs
[@auto-okf/core](../core)'s deterministic apply over a real multiwriter
log: one hypercore per writer, folded into a shared hyperbee2 view,
consistent across peers once they replicate. No autobase anywhere —
autobee@2.12.1 is a standalone multiwriter Hyperbee on hyperbee2 +
hypercore 11.

## Usage

Init a vault, append an op, admit a second writer:

```js
import { Bundle } from '@auto-okf/store'

const tick = () => new Promise((resolve) => setTimeout(resolve, 50))

const a = await Bundle.init('./storage-a')

// mint a concept — the returned tag is its _id (SPEC §6)
const { tag: id } = await a.createConcept('guides/getting-started', 'guide')
await a.setBody(id, null, 'Read the [architecture](/guides/architecture) first.')

// a second peer joins by key and replicates directly
const b = await Bundle.join('./storage-b', a.key)
const s1 = a.replicate(true)
const s2 = b.replicate(false)
s1.pipe(s2).pipe(s1)

// b writes nothing until an indexer admits it: until b has folded its
// admission, b.writable is false and every append fails VAULT_NOT_WRITABLE
await a.writers.add(b.localKey) // the genesis indexer admits b (an in-log governance op)
while (!b.writable) {
  await b.update()
  await tick()
}

await b.addTag(id, 'p2p') // b writes; every peer folds the same view

// a folds b's op once replication delivers it
while ((await a.snapshotHash()) !== (await b.snapshotHash())) await tick()
console.log(await a.snapshotHash() === await b.snapshotHash()) // true
await a.close()
await b.close()
```

Or over a private hyperswarm instead of a pipe. `b` joins with the invite
(`{ metadata: a.metadata }`), which lists `a`'s swarm key, and `a` admits
`b`'s swarm key with `writers.add(b.localKey, { swarmKey: b.swarmKey })`.
Then `await a.swarm({ bootstrap })` / `await b.swarm({ bootstrap })`, with
the nodes of a private DHT (see [Replication](#replication)).

## Install

```sh
npm install @auto-okf/store
```

Two packages in the store's dependency tree require a package that they do
not declare. autobee@2.12.1 requires `hypercore-crypto`, which it lists
only as a dev dependency. bogon@1.3.0 (hyperswarm → hyperdht → bogon)
requires `b4a`. The store loads only where both resolve from those
packages. A package manager that links only declared dependencies, such as
pnpm with `hoist=false`, must hoist both publicly. This workspace does that
with `publicHoistPattern: [hypercore-crypto, b4a]` in `pnpm-workspace.yaml`,
and `okf/test/store-deps.test.js` checks it.

## Vaults this release opens

- This release writes vault metadata version 2 (`METADATA_VERSION`), and
  it opens only vaults with metadata version 2. `loadMetadata` refuses a
  document with any other version (`unsupported vault metadata version:
  <n>`), so `Bundle.init`, `Bundle.open` and `Bundle.join` refuse that
  directory.
- Vaults that an earlier release made are not carried over. There is no
  migration.
- `swarm()` announces the vault on the `auto-okf/2` topic,
  `sha256('auto-okf/2' ‖ discoveryKey)`, never on the bare discovery key.
  A peer that announces on another topic never finds the vault. The
  firewall admits only members' swarm keys (see [Replication](#replication)).
- A directory with no `okf-vault.json` is new storage. The store runs no
  check on what the directory already holds.

## What the store pins

**Vault metadata** (`okf-vault.json`, written at `init`, loaded at open,
byte-identical on every peer — `metadataHash` is the cross-peer pin):

- **`version: 2`** — see [Vaults this release opens](#vaults-this-release-opens).
- **`genesisKey`** — the vault key. A creator passes autobee no key, so
  the vault key is the creator's writer key, and that key is the §8
  genesis indexer.
- **`appendOnly: true`** — the SPEC §8 constant, immutable by
  construction: it lives outside the log (no op can flip it — the wire
  contract has no prune or byte-destroying op at all), nothing
  rewrites the file after init, and a tampered document refuses to open.
  `DeleteConcept` is a tombstone; bytes and `_id` remain.
- **Generation chain** (`predecessorKey`) — SPEC §10: the vault key of
  the predecessor whose face this vault imported
  (`auto-okf import --predecessor`), or `null` for a root vault. It is the
  operator's claim: unsigned, never verified, provenance and not proof.
- **`generation`** — the per-generation corestore namespace, derived purely from
  `predecessorKey` (`'root'` when null, else sha256 over the key bytes).
  A joiner passes the same `predecessorKey` in its invite metadata to
  derive it. Writer cores derive under
  it, so a writer keypair can never recur across generations, even in a reused
  directory (§10 freshness; adoption of predecessor mint ids stays safe).
- **`limits`** (`maxOpBytes`, `maxPathBytes`, `maxPathDepth`) and **`rate`**
  (`defaultCeiling`) — closed groups: `validateMetadata` refuses a key that
  metadata version 2 does not define. With `genesisKey` they are the
  `createApply` config slice (`applyConfig`), identical on every peer (I2).
- **`swarm`** (`allow`) — a closed group. `allow` is the static allowlist
  of the swarm firewall: swarm keys, 64 lowercase hex each, sorted, each
  key once. `createMetadata` takes 32 bytes or 64 hex characters in any
  case, and sorts the list. It refuses a value that is not an array, a bad
  key and a key listed twice, each with `VAULT_BAD_SWARM_ALLOW` and the
  field name. The empty list applies only when `allow` is absent. The
  creator of a vault always adds its own swarm key, after that check, and
  once also when the list names it. See [Replication](#replication). Apply
  does not read it, so `applyConfig` leaves it out.
- `schemaVersion`, `encrypted` — pinned with the rest. `encrypted` is
  `true` for a vault made with an `encryptionKey`.

## API

```js
const bundle = await Bundle.init(dir, opts)      // create (writes metadata)
const bundle = await Bundle.open(dir, opts)      // reopen from disk
const bundle = await Bundle.join(dir, key, opts) // join by vault key
```

All three run the same open. A directory that holds `okf-vault.json`
reopens under its pinned metadata, and a directory without one becomes a
new vault (or, with `key`, joins that vault). A `key` that differs from
the pinned vault key fails `VAULT_KEY_MISMATCH`. Invite metadata that
differs from the pinned document fails `VAULT_METADATA_MISMATCH`.

`opts`: `metadata` (invite overrides incl. `predecessorKey`),
`encryptionKey` (32 bytes, end to end — writer cores, system and view
encrypted at rest; autobee keeps the key in the local core's user data, so
a reopen needs no key), `keyPair`, `backpressure`.

### Bundle

| member | what |
| --- | --- |
| `id`, `key`, `keyHex`, `discoveryKey` | vault identity (autobee bootstrap core) |
| `localKey` | this peer's writer key (what an indexer passes to `writers.add`) |
| `swarmKey` | this peer's swarm key, the hyperswarm public key that `swarm()` listens and dials with: `createKeyPair('auto-okf/swarm')` of the peer's own corestore, the same across restarts |
| `writable` | autobee's `db.writable`: `true` once autobee has added this writer and not removed it |
| `isIndexer` | okf authority from `gov/`: a `gov/writer/<self>` record with `indexer: true` and no `gov/removed/<self>`, refreshed after every view update and at open. Never autobee's `isIndexer`, which is always false, because every writer stands at weight 0 |
| `metadata`, `generation` | the pinned document and the §10 namespace id |
| `append(type, payload, { backpressure })` | encode + append one §3 op; fills `clock` (see `clock()`) and `at`; resolves `{ seq, tag }` once the local core holds the op's node — `seq` is the node's position in the local core (§3). Errors: see [Appends and close](#appends-and-close) |
| `createConcept / setField / addTag / remTag / setBody / setPath / deleteConcept / undeleteConcept / resolveConflict` | content-op helpers (thin over `append`); `remTag` computes the §5 citation set from the view |
| `writers.add(key, { indexer, swarmKey })` | §8 governance op (apply enforces the indexer-issuer rule). `swarmKey` (32 bytes or 64 hex, optional) goes on `gov/writer/<key>`, and the swarm firewall of every peer then admits it. A bad key fails `VAULT_BAD_SWARM_KEY` before the append; core rejects a wire key that is not 32 bytes `bad-swarm-key` |
| `writers.remove(key)` | causal revocation — in-band, never positional; the emitted clock cites the target's last folded position (`seqAtRemoval`) |
| `writers.setPolicy(key, { namespacePrefixes, rateCeiling })` | per-writer namespace + token-bucket policy |
| `clock([seq])` | the §3/§8 clock of an op, `[[writerKeyHex, position], ...]` sorted by key: the last folded position of self and of each writer with a `gov/writer` record, and no other key; with `seq`, the self entry is `seq` |
| `view`, `get(key)`, `val(key)`, `scan(prefix)` | reads over the hyperbee2 view snapshot |
| `update()`, `updated()`, `flush()` | autobee lifecycle passthrough |
| `snapshotHash()`, `hash()` | I2/I3 full-range view hash, byte-compatible with core `MemView.hash()` (`hash()` is an alias) |
| `replicate(isInitiator \| stream)` | direct replication stream |
| `swarm({ bootstrap, allow, publicDht })`, `leaveSwarm()` | replication over a private hyperswarm that the Bundle owns, behind a firewall on members' swarm keys (see [Replication](#replication)). `allow` is a local list of swarm keys that this peer alone admits and dials |
| `revokePeer(swarmKey)` | take a swarm key out of this peer's allowlist, destroy its open connections, and `leavePeer` it, for the life of the Bundle |
| `close()` | closes autobee, settles every append that started before it, then closes the owned corestore |

### Substrate admission comes before the first write

The store constructs autobee with `optimistic: false`, `bootstrapWeight: 0`
and `fastForward: false`, and grants every writer at weight 0 (SPEC §8,
[DEVIATIONS.md](../DEVIATIONS.md)). So:

- `writable` signals substrate admission: autobee has added this writer
  (autobee@2.12.1 `index.js:196-198`). Until then `writable` is false, and
  `append` fails `VAULT_NOT_WRITABLE` (`err.writerKey` names the key)
  before the op takes a seq (`okf/store/lib/bundle.js:858-866`).
- `writable` is not okf membership. Core grants the key of every
  `add-writer` op that it folds at the substrate, a rejected one too
  (`okf/core/lib/apply.js:375`). So a writer that is not an indexer can
  make a joiner writable. Apply rejects its `writers.add` op
  `policy-governance` (`okf/core/lib/apply.js:411-412`), but the grant
  still adds the key. The appends of that joiner then resolve, and apply
  rejects each of its ops.
- okf membership comes only from `gov/`. Only an `add-writer` op that
  apply accepts writes the `gov/writer` record that admits a key
  (`okf/core/lib/apply.js:533-546`). Apply accepts that op only from an
  issuer that is an indexer at the op's linearized position
  (`okf/core/lib/apply.js:407-418`). Only the content ops of an admitted
  key take effect.
- A content op of a key with no `gov/writer` record is rejected
  `not-a-writer` (`okf/core/lib/apply.js:426`). The §3 limits, the
  `forged-clock` check and the revocation check come first, and each of
  them can reject it (`okf/core/lib/apply.js:361-403`). A governance op
  of such a key is rejected `policy-governance`, because the issuer is
  not an indexer, and that check comes first
  (`okf/core/lib/apply.js:407-412`).
- A node of a writer that autobee has not added reaches no apply on any
  peer.
- Every writer stands at weight 0, so nodes order by timestamp, then
  writer key.

### Appends and close

`append` resolves only once the local core holds the op's node. It fails
with one of these codes:

| code | when |
| --- | --- |
| `VAULT_NOT_WRITABLE` | autobee has not added this writer (see above) |
| `VAULT_REVOKED` | this writer's own revocation is in the view (see below) |
| `VAULT_CLOSED` | the append started after `close()` began; nothing reaches the local core |
| `VAULT_CLOSED_BEFORE_DURABLE` | `close()` ran before the node reached the local core. The op is not written, so a retry writes it once. `err.seq` is the op's position, or `null` if it took none |

`close()` closes autobee first, then waits for every append that started
before it, then closes the owned corestore.

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

### Replication

`replicate(isInitiator | stream)` returns a direct replication stream. It
passes no firewall: the caller chooses the peer at the other end.

At open, the store calls autobee's `db.wakeup` for each key with a
`gov/writer` record. So a peer that closed during a heal fetches the
blocks that it has not folded, also in a vault where nobody writes. A key
that only `seen/` holds is not woken.

`swarm({ bootstrap, allow, publicDht })` replicates over a private
hyperswarm. The vault key is not a capability to connect:

- **A swarm key per peer.** The swarm listens and dials with `swarmKey`,
  which the store derives from the peer's own corestore, so it stays the
  same across restarts.
- **A firewall on members' swarm keys.** The swarm rejects every remote
  key outside the allowlist, on an incoming handshake and before a dial
  (hyperswarm `firewall`). The allowlist is the keys of
  `metadata.swarm.allow`, the `swarmKey` of each `gov/writer` record
  that has no `gov/removed` record, and the keys of `allow`, this peer's
  local list. The swarm key of a removed writer is not in it, also when
  `metadata.swarm.allow` or `allow` lists the key, and also when another,
  live `gov/writer` record carries the same key. The store
  reads the allowlist again after every fold. A peer that holds the vault
  key and the invite, but no admitted swarm key, gets no connection, so it
  reaches neither the replication nor autobee's wakeup protocol (G44 in
  [SECURITY_MODEL.md](../SECURITY_MODEL.md)).
- **A bounded ban table.** hyperswarm bans each key that the firewall
  rejects, and keeps a record of it until the ban is lifted. The store
  keeps at most 64 such records, hyperswarm's default `maxPeers`. Past
  that bound it lifts the oldest ban and frees its record. The firewall
  still rejects that key at its next attempt. So a flood of fresh keys
  costs one handshake per attempt and at most 64 records (G44 in
  [SECURITY_MODEL.md](../SECURITY_MODEL.md)).
- **Revocation.** `revokePeer(swarmKey)` takes a key out of this peer's
  allowlist, destroys its open connections, and stops the direct dials to
  it (`leavePeer`), until this Bundle closes. A folded `remove-writer` has
  the same effect, on every peer that folds it, for the swarm key on the
  removed writer's record. Each peer cuts only its own connections.
- **A DHT by choice.** `bootstrap` is the list of the bootstrap nodes of a
  private DHT (`'host:port'` or `{ host, port }`), for example the node
  that `auto-okf bootstrap` runs. `publicDht: true` uses hyperdht's
  default bootstrap nodes, the public DHT that hyperdht describes as
  "publicly served on behalf of the commons". It is explicit opt-in: a
  call without exactly one of the two fails `VAULT_SWARM_DHT`.
- **A local list.** `allow` holds swarm keys, 32 bytes or 64 hex each,
  that this peer admits and dials (`joinPeer`), and no other peer. They
  are never written to the metadata, and no other peer reads them. A
  value that is not an array, a bad key or a key listed twice fails
  `VAULT_BAD_SWARM_ALLOW` before the swarm exists. A second `swarm()` call
  adds its keys. `saveLocalAllow(dir, keys)` and `loadLocalAllow(dir)`
  keep the list in `<dir>/okf-swarm-allow.json` (`LOCAL_ALLOW_FILE`), for
  `auto-okf join --swarm-allow` and `auto-okf watch --swarm`.
- **The Bundle owns the swarm.** `leaveSwarm()` and `close()` leave the
  topic and the listed peers, clear the local list, and destroy it.

Two shapes of membership use the same swarm:

1. **A pre-provisioned fleet.** The creator lists the swarm key of each
   peer in `metadata.swarm.allow`, and every peer joins with that invite.
   `swarm()` calls `joinPeer` for each listed key, so a pre-provisioned
   fleet needs no topic: its peers dial each other by key. A peer can read
   its swarm key before it holds a vault (`auto-okf keys <dir>`).
2. **A late joiner.** An indexer admits it with
   `writers.add(writerKey, { swarmKey })`. Each peer admits the swarm key
   when it folds the `add-writer`, and finds the joiner on the
   `auto-okf/2` topic, which `swarm()` still joins. A joiner folds no
   `gov/writer` record before it connects, so its firewall admits only
   the keys of the invite. That is why the creator always lists its own
   swarm key. So a late joiner needs a peer of the invite online, such as
   the creator, or it never learns its admission. When none is online,
   the indexer that admitted the joiner hands it its swarm key with the
   invite, and the joiner passes that key in `allow`
   (`auto-okf join --swarm-allow <hex64>`). Never admit a key that a
   discovery alone names.

## Tests

Integration tests run on real autobee + corestore instances (no stubs):

```sh
pnpm test:okf     # core unit/invariant suite + these store tests
```

two-writer convergence (view-hash equality), admission before the first
write (`VAULT_NOT_WRITABLE`, no seq used), durable appends and close
(`VAULT_CLOSED`, `VAULT_CLOSED_BEFORE_DURABLE`), the position ordinal
across empty blocks and restarts, the bounded clock, backpressure, writer
add/remove round trip with causal revocation, weight 0 for every writer,
the governance race (G9b), the substrate attack suite and its residuals,
encryptionKey open/read and encryption at rest, vault-metadata determinism
(version 2, appendOnly, closed `limits`, `rate` and `swarm`,
`predecessorKey`), generation-namespace freshness, restart-from-disk
rebuild equality, hyperswarm replication on the `auto-okf/2` topic over a
local testnet, the private swarm (the swarm key, the firewall against a
peer with the vault key and no admitted swarm key, the cut of a removed
writer and of `revokePeer`, the cut of a removed writer whose swarm key a
live record also carries, across a reopen, at most 64 ban records after a
flood of fresh keys, a pre-provisioned pair over `joinPeer`, a joiner
admitted after a ban, a late joiner whose creator is offline through
`allow`, and the refusal of a malformed `allow`), and the dependency
resolution of the store.

## License

Apache-2.0
