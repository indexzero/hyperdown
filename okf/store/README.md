# @auto-okf/store

`@auto-okf/store` is the substrate package of the auto-okf stack. It runs
the deterministic apply of [@auto-okf/core](../core) over
[autobee](https://github.com/holepunchto/autobee), a multi-writer log.
Each writer has one hypercore. autobee folds the cores into one shared
hyperbee2 view, and peers that replicate converge on it. The store uses
autobee@2.12.1, a standalone multi-writer Hyperbee on hyperbee2 and
hypercore 11. It does not use autobase.

## Usage

Init a vault, append an op, admit a second writer:

```js
import { Bundle } from '@auto-okf/store'

const tick = () => new Promise((resolve) => setTimeout(resolve, 50))

const a = await Bundle.init('./storage-a')

// mint a concept. The returned tag is its _id (SPEC §6)
const { tag: id } = await a.createConcept('guides/getting-started', 'guide')
await a.setBody(id, null, 'Read the [architecture](/guides/architecture) first.')

// a second peer joins by key and replicates directly
const b = await Bundle.join('./storage-b', a.key)
const s1 = a.replicate(true)
const s2 = b.replicate(false)
s1.pipe(s2).pipe(s1)

// b writes nothing until autobee adds it. Until b folds a's add-writer
// op, b.writable is false and every append fails VAULT_NOT_WRITABLE.
// a is an indexer, so apply also admits b (gov/writer), and b's ops
// take effect
await a.writers.add(b.localKey)
while (!b.writable) {
  await b.update()
  await tick()
}

await b.addTag(id, 'p2p') // b writes, and every peer folds the same view

// a folds b's op once replication delivers it
while ((await a.snapshotHash()) !== (await b.snapshotHash())) await tick()
console.log(await a.snapshotHash() === await b.snapshotHash()) // true
await a.close()
await b.close()
```

To replicate over a private hyperswarm instead of a pipe, do these steps:

1. Join `b` with the invite, `{ metadata: a.metadata }`. The invite lists
   `a`'s swarm key.
2. Admit `b`'s swarm key on `a`:
   `a.writers.add(b.localKey, { swarmKey: b.swarmKey })`.
3. Call `await a.swarm({ bootstrap })` and `await b.swarm({ bootstrap })`,
   with the nodes of a private DHT. See [Replication](#replication).

## Install

```sh
npm install @auto-okf/store
```

Two packages in the store's dependency tree require a package that they do
not declare:

- autobee@2.12.1 requires `hypercore-crypto`, which it lists only as a dev
  dependency.
- bogon@1.3.0 requires `b4a`. hyperswarm loads bogon through hyperdht.

The store loads only where both resolve from those packages. A package
manager that links only declared dependencies, such as pnpm with
`hoist=false`, must hoist both publicly. This workspace does that with
`publicHoistPattern: [hypercore-crypto, b4a]` in `pnpm-workspace.yaml`,
and `okf/store/test/pins.test.js` checks it.

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
  A peer that announces on another topic never finds the vault.
- The firewall admits only the keys of its allowlist. See
  [Replication](#replication).
- A directory with no `okf-vault.json` is new storage. The store runs no
  check on what the directory already holds.

## What the store pins

`okf/store/package.json` pins autobee, corestore and hyperswarm at exact
versions. SPEC §1 states the pins, and [DEVIATIONS.md](../DEVIATIONS.md),
"The pins, and the corestore floor", states why.

The store also pins the vault metadata, `okf-vault.json`. `init` writes
it, each open loads it, and it is byte-identical on every peer.
`metadataHash` is the cross-peer pin. The document is closed:
`createMetadata`, `validateMetadata` and `loadMetadata` refuse a top-level
key that version 2 does not define, by name (`metadata.<key> is not a
metadata version 2 field`). The keys:

- `version`: 2. See [Vaults this release opens](#vaults-this-release-opens).
- `genesisKey`: the vault key. A creator passes autobee no key, so the
  vault key is the creator's writer key. That key is the genesis indexer
  (SPEC §8).
- `appendOnly`: always `true`. No op can change it, nothing rewrites the
  file after `init`, and a tampered document refuses to open (SPEC §8,
  "Append-only").
- `predecessorKey`: the vault key of the predecessor whose bundle this
  vault imported (`auto-okf import --predecessor`), or `null` for a root
  vault. It is the operator's claim, unsigned and never verified (SPEC
  §10).
- `generation`: the corestore namespace of this generation, which the
  store derives from `predecessorKey` alone (SPEC §10). A joiner passes
  the same `predecessorKey` in its invite metadata to derive it.
- `limits` (`maxOpBytes`, `maxPathBytes`, `maxPathDepth`) and `rate`
  (`defaultCeiling`): closed groups. `validateMetadata` refuses a key that
  metadata version 2 does not define. With `genesisKey`, they are the
  configuration that `applyConfig` hands to `createApply`, identical on
  every peer (I2).
- `swarm` (`allow`, `genesis`): a closed group. Apply does not read it, so
  `applyConfig` leaves it out.
- `schemaVersion` and `encrypted`: pinned with the rest. `encrypted` is
  `true` for a vault made with an `encryptionKey`.

The `swarm` group has these rules:

- `allow` is the static allowlist of the swarm firewall: swarm keys, 64
  lowercase hex characters each, sorted, each key once.
- `createMetadata` takes each key as 32 bytes or 64 hex characters in any
  case, and sorts the list. It refuses a value that is not an array, a bad
  key and a key listed twice, each with `VAULT_BAD_SWARM_ALLOW` and the
  field name. The empty list applies only when `allow` is absent.
- The creator of a vault always adds its own swarm key, after that check.
  The list holds that key once, also when the input names it.
- `genesis` is the creator's swarm key, one key of `allow`, or `null`. The
  creator writes its own key there, and refuses another one
  (`VAULT_BAD_SWARM_GENESIS`). A peer that joins with the vault key alone
  pins `null`.
- The invite binds `genesis` to `genesisKey`, so a folded `remove-writer`
  of the creator cuts that swarm key on every peer (SPEC §8).
- A generation never carries the group (SPEC §10, "Rules of import"). An
  indexer admits each writer again with `writers.add(key, { swarmKey })`.

## API

```js
const bundle = await Bundle.init(dir, opts)      // create (writes metadata)
const bundle = await Bundle.open(dir, opts)      // reopen from disk
const bundle = await Bundle.join(dir, key, opts) // join by vault key
```

All three run the same open. A directory that holds `okf-vault.json`
reopens under its pinned metadata. A directory without one becomes a new
vault, or joins the vault of `key`. A `key` that differs from the pinned
vault key fails `VAULT_KEY_MISMATCH`. Invite metadata that differs from
the pinned document fails `VAULT_METADATA_MISMATCH`.

A join with the vault key alone pins metadata with an empty swarm group
(`allow: []`, `genesis: null`). That suits `replicate()`, but `swarm()`
then admits no key of the invite. Pinned metadata never changes, so such
a directory refuses the invite later with `VAULT_JOINED_WITHOUT_INVITE`.
To repair that, join again in a new directory, with the invite as
`metadata`. `auto-okf join` needs the invite for fresh storage.

`opts` has these keys:

- `metadata`: the invite, or the values that override the defaults,
  `predecessorKey` included.
- `encryptionKey`: 32 bytes, end to end. The writer cores, the system and
  the view are encrypted at rest. autobee keeps the key in the local
  core's user data, so a reopen needs no key.
- `keyPair`: the signing key pair of the local writer.
- `backpressure`: see [Backpressure](#backpressure-opt-in).

### Bundle

| member | what |
| --- | --- |
| `id`, `key`, `keyHex`, `discoveryKey` | the vault identity (autobee's bootstrap core) |
| `localKey` | this peer's writer key, which an indexer passes to `writers.add` |
| `swarmKey` | this peer's swarm key, which `swarm()` listens and dials with |
| `writable` | autobee's `db.writable`: `true` once autobee added this writer and did not remove it |
| `isIndexer` | okf authority from `gov/`, never autobee's `isIndexer` |
| `metadata`, `generation` | the pinned document and the §10 namespace id |
| `append(type, payload, { backpressure })` | encodes and appends one §3 op, and resolves `{ seq, tag }` |
| `createConcept`, `setField`, `addTag`, `remTag`, `setBody`, `setPath`, `deleteConcept`, `undeleteConcept`, `resolveConflict` | content-op helpers, thin over `append` |
| `writers.add(key, { indexer, swarmKey })` | admits a writer (§8) |
| `writers.remove(key)` | revokes a writer (§8) |
| `writers.setPolicy(key, { namespacePrefixes, rateCeiling })` | sets the namespace and token-bucket policy of a writer |
| `clock([seq])` | the §3 clock of an op |
| `view`, `get(key)`, `val(key)`, `scan(prefix)` | reads over the hyperbee2 view snapshot |
| `update()`, `updated()`, `flush()` | autobee lifecycle passthrough |
| `snapshotHash()`, `hash()` | the I2/I3 full-range view hash (`hash()` is an alias) |
| `replicate(isInitiator \| stream)` | a direct replication stream |
| `swarm({ bootstrap, allow, publicDht })`, `leaveSwarm()` | replication over a private hyperswarm that the Bundle owns |
| `revokePeer(swarmKey)` | cuts one swarm key on this peer, for the life of the Bundle |
| `close()` | closes autobee, settles every append, then closes the owned corestore |

Some members need more than a phrase:

- `swarmKey` is the hyperswarm public key of
  `createKeyPair('auto-okf/swarm')` on the peer's own corestore. It is the
  same across restarts.
- `isIndexer` is `true` when `gov/writer/<self>` holds `indexer: true` and
  no `gov/removed/<self>` record exists. The store refreshes it at open
  and after every view update. It is never autobee's `isIndexer`, which is
  always false, because every writer stands at weight 0.
- `append` fills `clock` and `at`. `seq` is the position of the op's node
  in the local core (§3). See [Appends and close](#appends-and-close).
- `remTag` computes the §5 citation set from the view.
- `clock([seq])` returns `[[writerKeyHex, position], ...]`, sorted by key.
  It holds the last folded position of self and of each writer with a
  `gov/writer` record, and no other key (SPEC §8). With `seq`, the self
  entry is `seq`.
- `snapshotHash()` is byte-compatible with core's `MemView.hash()`.

### Writers

The three `writers` calls append governance ops. Apply accepts each one
only from an indexer (SPEC §8, "Governance ops").

- `key` is the writer key, 32 bytes or 64 hex characters. Another value
  fails `VAULT_BAD_WRITER_KEY` before the append, in all three calls.
- `swarmKey` (32 bytes or 64 hex characters, optional) goes on
  `gov/writer/<key>`, and the swarm firewall of every peer then admits it.
  A bad key fails `VAULT_BAD_SWARM_KEY` before the append.
- Without `swarmKey` the writer has no bound swarm key. A later
  `writers.remove` then cuts no key that the invite or a local list grants
  it (see [Replication](#replication)). `auto-okf add-writer` refuses such
  an admission.
- `indexer` is `false` by default. Core rejects an `add-writer` with
  `indexer: false` that demotes the last live indexer `policy-governance`,
  as it rejects a `remove-writer` that removes it (SPEC §8).
- `writers.remove(key)` is a causal revocation, in-band and never
  positional. The clock of the op cites the last folded position of the
  target (`seqAtRemoval`).
- `rateCeiling` defaults to the pinned `metadata.rate.defaultCeiling`, so
  a `writers.setPolicy` call before open waits for open.

A modified client can skip the store's key checks. SPEC §8, "Governance
ops", states what apply does with a key that is not 32 bytes.

### Substrate admission comes before the first write

autobee must add a writer before that writer can append. Until `writable`
is true, `append` fails `VAULT_NOT_WRITABLE` before the op takes a seq,
and `err.writerKey` names the key (`_assertWritable` in
`okf/store/lib/bundle.js`). To wait, call `update()` until `writable` is
true, as in [Usage](#usage).

`writable` is not okf membership. A rejected `add-writer` or a forged
approval also makes a key writable. The appends of such a joiner then
resolve, and apply rejects each of its ops. Only an `add-writer` that
apply accepts from an indexer admits a key. See SPEC §8, "The grant, and
admission before effect", and [SECURITY_MODEL.md](../SECURITY_MODEL.md),
"What the substrate decides, and what okf decides".

### Appends and close

`append` resolves only once the local core holds the op's node. It fails
with one of these codes:

| code | when |
| --- | --- |
| `VAULT_NOT_WRITABLE` | autobee has not added this writer (see above) |
| `VAULT_REVOKED` | this writer's own revocation is in the view (see below) |
| `VAULT_CLOSED` | the append started after `close()` began. Nothing reaches the local core |
| `VAULT_CLOSED_BEFORE_DURABLE` | `close()` ran before the node reached the local core. The op is not written, so a retry writes it once. `err.seq` is the op's position, or `null` if it took none |

`close()` closes autobee first, then waits for every append that started
before it, then closes the owned corestore.

`append` reports durable, not accepted. Its `{ seq, tag }` says that the
local core holds the node (`_durable` in `okf/store/lib/bundle.js`). It
does not say that apply accepted the op.

Read the verdict from the view: a rejected op has
`flag/rejected/<writerKey>/<seq>` (`auto-okf flags <dir> rejected`). Read
it in your write loop, because a reorder can change it (SPEC §8). The
ingest watcher reads that verdict once, at its own fold. See
[@auto-okf/faces](../faces/README.md).

### One process per vault directory

One process at a time opens a vault directory. corestore takes a lock on
`<dir>/CORESTORE` when it opens the store. The `CorestoreStorage`
constructor of hypercore-storage 3.4.0 takes it. An open in a second process fails
with `File descriptor could not be locked` while the first process holds
the vault. So run each command from the process that replicates, or give
each process its own vault directory. `auto-okf watch` holds the directory
while it runs.

### Backpressure (opt-in)

By default, `append` runs at the rate of the caller. With
`{ backpressure: true }` or `{ backpressure: { maxInflight, ackTimeout } }`,
each append throttles itself. Set it for the vault in `opts`, or for one
append.

Each append waits behind two gates on one watermark. The first gate is
the writer's own fold. The second gate is the fold progress that peers
prove through the §3 clocks of their ops. The second gate waits at most
`ackTimeout`. So a silent or partitioned peer lowers the throughput, and
it never deadlocks the writer.

### Revocation semantics

The store of a removed writer refuses further local appends
(`VAULT_REVOKED`). The ops that a removed writer makes after its
revocation still linearize on every peer, because the store never calls
`host.removeWriter`. Core's §8 clock rule rejects each of them that sorts
after the removal, the same way on every peer. So the applied/rejected
partition is replay-stable (I10).

Revocation stops cooperating clients only. The cut of a swarm key (see
[Replication](#replication)) stops future delivery only, and a new
generation evicts a key fully. See SPEC §8, "Revocation", and
[SECURITY_MODEL.md](../SECURITY_MODEL.md), "The trust model" and "The
eviction ladder".

### Replication

`replicate(isInitiator | stream)` returns a direct replication stream. It
passes no firewall: the caller chooses the peer at the other end.

`swarm({ bootstrap, allow, publicDht })` replicates over a private
hyperswarm. The vault key is not a capability to connect:

- **A swarm key per peer.** The swarm listens and dials with `swarmKey`.
- **A DHT by choice.** `bootstrap` is the list of the bootstrap nodes of a
  private DHT, each `'host:port'` or `{ host, port }`. `auto-okf bootstrap`
  runs such a node. `publicDht: true` uses hyperdht's
  default bootstrap nodes, the public DHT that hyperdht describes as
  "publicly served on behalf of the commons". It is explicit opt-in: a
  call without exactly one of the two fails `VAULT_SWARM_DHT`.
- **A local list.** `allow` holds swarm keys, 32 bytes or 64 hex
  characters each. This peer admits and dials them (`joinPeer`), and no
  other peer does. They are never written to the metadata, and no other peer
  reads them. A value that is not an array, a bad key or a key listed
  twice fails `VAULT_BAD_SWARM_ALLOW` before the swarm exists.
- **A firewall on an allowlist.** The swarm rejects every remote key
  outside the allowlist, on an incoming handshake and before a dial
  (hyperswarm `firewall`). The allowlist is the keys of
  `metadata.swarm.allow`, the `swarmKey` of each `gov/writer` record that
  has no `gov/removed` record, and the keys of `allow`. So a key of the
  invite or of the local list passes, writer or not. The store reads the
  allowlist again after every fold. A peer that holds the vault key and
  the invite, but no admitted swarm key, gets no connection.
- **A bounded ban table.** hyperswarm bans each key that the firewall
  rejects, and keeps a record of it until the ban is lifted. The store
  keeps at most 64 such records, hyperswarm's default `maxPeers`. Past
  that bound it lifts the oldest ban and frees its record
  (`MAX_BANNED_PEERS`, `_recordBan`). The firewall still rejects that key
  at its next attempt. [SECURITY_MODEL.md](../SECURITY_MODEL.md) states
  what else a flood of fresh keys costs, under the writer-core flood.
- **Revocation.** The bound swarm key of a removed writer is not in the
  allowlist. That holds also when `metadata.swarm.allow` or `allow` lists
  the key, and also when another, live `gov/writer` record carries the
  same key. The bound key is the `swarmKey` on the writer's record, and
  for the creator also `metadata.swarm.genesis`. Every peer that folds the
  `remove-writer` cuts that key, also after a reopen.
- **The Bundle owns the swarm.** `leaveSwarm()` and `close()` leave the
  topic and the listed peers, clear the local list, and destroy the
  swarm.

The ban table reads hyperswarm state that the hyperswarm README does not
document: `PeerInfo.banned`, and banned records with no connection in
`swarm.peers`. The README describes `swarm.peers` as the connected peers.
In hyperswarm 4.17.0, `PeerInfo` is in `lib/peer-info.js`, and
`_handleFirewall` in `index.js` makes those records. So
`okf/store/package.json` pins hyperswarm at exactly `4.17.0`, and
`okf/store/test/pins.test.js` fails when the store declares or resolves
another version.

A second `swarm()` call before `leaveSwarm()` adds its keys to the local
list, and keeps the swarm and the DHT of the first call. It checks its own
`bootstrap` or `publicDht`, and then does not use it. To change the DHT,
call `leaveSwarm()` first.

`saveLocalAllow(dir, keys)` and `loadLocalAllow(dir)` keep the local list
in `<dir>/okf-swarm-allow.json` (`LOCAL_ALLOW_FILE`), for
`auto-okf join --swarm-allow` and `auto-okf watch --swarm`.
`saveLocalAllow` writes a new file and renames it over the old one. So a
reader or a crash finds the old list or the new one, whole.
`loadLocalAllow` refuses a file that is not JSON, or not
`{ "allow": [...] }` with valid, distinct keys, with
`VAULT_BAD_SWARM_ALLOW` and the file's path.

Two shapes of membership use the same swarm:

1. **A pre-provisioned fleet.** The creator lists the swarm key of each
   peer in `metadata.swarm.allow`, and every peer joins with that invite.
   A peer can read its swarm key before it holds a vault
   (`auto-okf keys <dir>`). `swarm()` calls `joinPeer` for each listed
   key, so the fleet needs no topic: its peers dial each other by key. The
   invite binds only the creator's key to a writer key. So admit each
   writer of the fleet with `writers.add(writerKey, { swarmKey })` too, or
   its removal cuts nothing that the invite grants.
2. **A late joiner.** An indexer admits it with
   `writers.add(writerKey, { swarmKey })`. Each peer admits the swarm key
   when it folds the `add-writer`, and finds the joiner on the
   `auto-okf/2` topic, which `swarm()` still joins. A joiner folds no
   `gov/writer` record before it connects, so its firewall admits only
   the keys of the invite. That is why the creator always lists its own
   swarm key. So a late joiner needs a peer of the invite online, such as
   the creator, or it never learns its admission.

When no peer of the invite is online, the indexer that admitted the late
joiner hands it its own swarm key with the invite. The joiner passes that
key in `allow` (`auto-okf join --swarm-allow <hex64>`). Never admit a key
that a discovery alone names.

To cut a peer, call `revokePeer(swarmKey)`. It takes the key out of this
peer's allowlist, destroys its open connections, and stops the direct
dials to it (`leavePeer`), until this Bundle closes. A folded
`remove-writer` does the same for the bound key, on every peer that folds
it. Each peer cuts only its own connections.

A writer with no bound key keeps what the invite or a local list grants
its swarm key after its removal. So admit each writer with `swarmKey`, or
cut such a key with `revokePeer` on each peer, or with a new generation.

## Tests

The tests are in `okf/store/test/`. They run on real autobee and
corestore instances, with no stubs. Run them from the root of the
repository:

```sh
pnpm test:okf                           # every okf package
node --test "okf/store/test/*.test.js"  # the store alone
```

## License

Apache-2.0
