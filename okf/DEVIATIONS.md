# okf deviations

This document has two parts. The first two sections list each place
where the code differs from `SPEC.md`, or where the SPEC states no rule.
The last section lists each behaviour of the substrate that okf relies
on.

## @auto-okf/faces

### The conflicted-copy suffix (SPEC §7)

SPEC §7 extends the suffix of a conflicted copy to 64 hex when two losers
of one path collide on 8 hex. It adds that "an occupied fallback extends
the same way". `planBundle` in `okf/faces/lib/materialize.js` does not
probe for an occupied path. It groups the losers by path, and counts the
losers of each path per 8-hex prefix. Each loser whose prefix another
loser of that path shares takes the full 64 hex.

Distinct `_id`s never collide on the full hash, so materialize needs no
further probe. The result is a pure function of the loser set (I9). Apply
reserves the `.conflict-<hex8+>` component (SPEC §7), so only two losers
can collide.

### Pending files (SPEC §9)

SPEC §9, "Pending files", states the rule. The SPEC does not state one
limit. A rename and an edit in one step, while no watcher runs, mints
again. The disk cannot show that the two files are the same.

The tests of the rule are in `okf/faces/test/ingest.test.js`:

- "a later ingest of a pending new file reuses the concept that its first
  ingest created, also in a new watcher: core rejected a later op"
- "a later ingest of a new file whose ingest failed after its create
  reuses that concept"
- "a renamed pending file keeps its concept: scan() moves the concept
  with it and attaches no second one"
- "a stale pending record attaches no file: its concept moved with a note
  that carries its _id, or another writer moved it"
- "a pending record whose file a scan found gone attaches only the same
  bytes back, never a new note"

## okf §10 generations: materialize, then import

### The store checks the generation id at every load (SPEC §10)

SPEC §10 states how the generation id derives from `predecessorKey`. It
does not state the check. `validateGenerationChain` in
`okf/store/lib/metadata.js` compares `metadata.generation` with
`generationId(predecessorKey)` at every load. A metadata file whose two
values disagree does not load.

## Substrate behaviour that okf relies on (autobee@2.12.1)

This section goes with `SPEC.md` §1. Each entry states a behaviour of the
substrate that okf relies on, the okf rule that needs it, the symbol that
holds it, and the tests that cover it. The lockfile resolves autobee
2.12.1, corestore 7.16.1, hypercore 11.39.2 and hyperbee2 2.20.1. If a
later release changes one of these behaviours, the rule that the entry
names breaks.

okf reads no undocumented autobee property. The test is "the store, core,
faces and cli read no undocumented autobee property" in
`okf/store/test/ordinal.test.js`. Where an entry relies on a part of
autobee that the autobee README does not document, it says so.

A symbol with no package name is in the autobee package. "README" with no
package name is the autobee README, and the entry names its section.

| Symbol | File in the autobee package |
|---|---|
| `Autobee`, `DEFAULT_ACK_THRESHOLD` | `index.js` |
| `ActiveWriters`, `Writer`, `createNode` | `lib/writers.js` |
| `Systembee` | `lib/system.js` |
| `ApplyCalls` | `lib/apply-calls.js` |
| `ApplyView` | `lib/apply-view.js` |
| `Promotions` | `lib/promotions.js` |
| `TrustedPeers` | `lib/trusted.js` |
| `AutobeeEncryption` | `lib/encryption.js` |
| `cmp` | `lib/topo.js` |
| `currentWeight`, `resolveWeight`, `verifyClaim`, `approverQualified` | `lib/witness.js` |
| `boot` | `lib/boot.js` |
| `encodeSystemWriterKey` | `lib/encoding.js` |
| `DEFAULT_MANIFEST_VERSION` | `lib/constants.js` |

### The pins, and the corestore floor

`okf/store/package.json` pins `autobee` at exactly `2.12.1` and
`corestore` at exactly `7.16.1`, with no range. SPEC §1 states the pins.
This section relies on behaviour of these versions, and the autobee
README does not document all of it. A later release, a patch release
too, can change that behaviour and break a rule that an entry names. A
range lets such a release in with no change to okf, so okf pins each
version exactly.

autobee lists corestore only as a dev dependency in its `package.json`.
The store hands autobee a corestore session.

The corestore floor is 7.12.6. SPEC §8 needs it for an encrypted view.
Four behaviours set the floor:

- autobee asks for its system and view cores at manifest version 3.
  `Autobee._getCorePreload` passes `manifestVersion:
  DEFAULT_MANIFEST_VERSION`.
- corestore honours a per-core `manifestVersion` from 7.12.6 on (upstream
  commit `d109402a`, "support passing manifestVersion and name"). In
  7.16.1, `Corestore._preload` merges the preload options, and
  `Corestore._auth` reads `opts.manifestVersion` for the manifest.
- Up to 7.12.5, `Corestore._auth` builds every new manifest at the
  store-wide `manifestVersion`. The `Corestore` constructor sets that to
  1 by default.
- autobee's view encryption refuses a view core below version 3
  (`AutobeeEncryption.encrypt`).

So 7.12.6 is the floor, and the exact pin `7.16.1` is above it.

Tests: `okf/store/test/pins.test.js` (the exact pins and the resolved
versions) and `okf/store/test/encryption.test.js` (the floor). The pin
tests are "the store pins ${name} at exactly ${version}" and "the store
resolves ${name} ${version}", one of each per package. The entry
"Genesis, the vault key and the stored encryption key" names the
encryption tests.

### The apply contract

autobee calls `apply(nodes, view, host)` (README section `Apply`,
`ApplyView.apply`). `view` is what the `open` handler returns (README,
`new Autobee(store, [key], [options])`, and `ApplyView.open`). The `Autobee`
constructor opens both its working view and `db.view` through that
handler. So apply and every read use the same `ViewAdapter` surface.

A node has `key`, `value` and `length` (README section `Apply`), plus
the other fields of `createNode`. Core takes the nodes unwrapped. A throw
from apply closes autobee (README, `db.append`, and `Autobee._onError`). So
core records a failed op as a rejection. Only a node that breaks the
transport contract throws (SPEC §3).

Tests: "an op whose handling throws is rejected apply-error at its
position" and "a node without a positive integer length breaks the
transport contract, so apply throws" in
`okf/core/test/apply/position.test.js`.

### `optimistic: false`: a node of a writer that autobee has not added reaches no apply

SPEC §8 needs this for its rule that admission comes before effect: an
outsider puts no op and no approval into apply.

The `Autobee` constructor reads `handlers.optimistic`. The default is
`true` (README, `new Autobee(store, [key], [options])`). With `false`,
autobee processes a batch only when its writer is added
(`Autobee._bumpPendingWriters`). The one exception is a removed writer
that a pending node of another writer links (`Writer.hasReferrals`). okf
never calls `host.removeWriter` (see "`host.removeWriter` is never
called").

autobee drops every other batch before `Autobee._applyBatch`. So the
batch reaches no apply, its approvals add no writer, and the system
records nothing. A plain node of such a writer stops earlier, in
`Writer._next`. autobee still reads such a node and checks its links
before the drop, also in `Writer._next`. `SECURITY_MODEL.md`, "What the
substrate decides, and what okf decides", states what the wakeups of an
outsider cost.

The tests are in `okf/store/test/substrate-attacks.test.js`:

- "strangers put no node into apply, so they drive no livelock"
- "an outsider approval at weight 1e9 reaches no apply (child process)"
- "an outsider forged witness reaches no apply"
- "an outsider backdated node flips no winner"

### `bootstrapWeight: 0` and grants at weight 0: every writer stands at weight 0

SPEC §8 needs this for the uniform weight of its order rule and its
grant rule.

`bootstrapWeight` is a constructor option that the `Autobee` constructor
reads, with a default of 2. The README does not list it. autobee adds the
bootstrap writer on its first node at this weight
(`Autobee._processBatch`). okf makes every other grant with
`host.addWriter(key, { weight: 0 })`. The README lists only `isIndexer`
for that call (README, `host.addWriter(key, [options])`).
`ApplyCalls.addWriter` takes the `weight` option, with the default
`isIndexer ? 2 : 1`.

Weight 0 gives okf these results:

- A grant at weight 0 changes no weight. The carrier node is at 0, so the
  effective weight is 0, and it is not above the current ceiling
  (`Systembee.addWriter`). The grant writes no promotion request, because
  the wanted weight 0 is not above the anchored weight
  (`Promotions.flushPending`).
- Nodes sort by weight, then timestamp, then writer key, then length
  (`cmp`). Every weight is 0, so nodes sort by timestamp, then key.
- No honest peer approves. An append collects approvals only when the
  standing of its writer is above 0 (`Autobee._collectApprovals`). The
  standing is the current weight of the writer (`Autobee._standing`,
  `currentWeight`).
- No honest node cites a witness. An append cites one only when the grant
  hint of its writer is above its current weight (`Autobee.append`). A
  host grant sets no hint: `Systembee.addWriter` sets one only with
  `anchor`.
- No writer climbs. A witness raises a weight only when the approver
  stands at the claimed weight or above (`resolveWeight`, `verifyClaim`,
  `approverQualified`). Genesis qualifies only up to `bootstrapWeight`
  (`approverQualified`).
- autobee's `isIndexer` is always false. It means a ceiling of 2 or more
  (the getters `Autobee.isIndexer` and `Writer.isIndexer`, and
  `Writer.update`). So `Bundle.isIndexer` reads `gov/`.

A member can still forge a node with approvals. autobee then adds each
named key at weight 0, because the weight of the carrier caps the grant
(`Autobee._applyBatch`, `Systembee.addWriter`). `SECURITY_MODEL.md` lists
this residual.

Tests:

- "every writer stands at weight 0 on every peer, and no honest node
  carries approvals or a witness" in `okf/store/test/writers.test.js`
- "no peer collects an approval, with more than 32 promotions pending" in
  `okf/store/test/substrate-attacks.test.js`
- "no writer climbs, also when a member forges a higher-tier approval" in
  `okf/store/test/substrate-attacks.test.js`

### The grant at every `AddWriter` op

SPEC §8 states the grant rule: `Applier.grant` in `okf/core/lib/apply.js`
grants the key of every `AddWriter` op that core folds. The rule relies
on four behaviours:

- The grant records the key as an added writer in the system. After the
  flush, every peer adds the writer (`Autobee._applyBatch`).
- The nodes of a granted key pass the filter of
  `Autobee._bumpPendingWriters`. That filter reads `isAdded`, which
  `Writer.update` sets from the system record. They also pass
  `Systembee.canApply`. So they reach apply on every peer, where
  `Applier.applyNode` decides each op by `gov/` (SPEC §8).
- After an undo, autobee applies the batches again
  (`Autobee.prepareBatch`, `Autobee._processBatch`), so core grants
  again. A repeated grant changes no weight. It only records the writer
  as added again (`Systembee.addWriter`).
- autobee copies a writer key into a fixed 34-byte system key
  (`encodeSystemWriterKey`). So core grants only a 32-byte key.

Test: "the governance race converges, and every op of the race writer
leaves a flag (I2, I3, I4)" in `okf/store/test/writers.test.js`.

### The `update` handler

The constructor option `update (view, changes)` is in the README
(`new Autobee(store, [key], [options])`). autobee calls it after apply,
once `db.view` holds the new state (`Autobee._drain`, `Autobee._update`).
The Bundle refreshes `isIndexer` from `gov/` there, and once at open.
SPEC §8 needs this: okf membership comes only from `gov/`.

Test: "isIndexer answers from gov/: a live gov/writer record with indexer
true" in `okf/store/test/writers.test.js`.

### `fastForward: false`: every peer folds every op through its own apply

I2 and I3 need this (SPEC §11).

The `Autobee` constructor reads `handlers.fastForward`. The README shows
only an object value (`new Autobee(store, [key], [options])`). The source
comment in the constructor states what `false` does. A fast-forward moves
the system and the view onto a head that another writer stamped, with no
apply for that prefix (README section `Fast-forward`,
`Autobee._applyFastForward`).

With `false`, autobee does these three things:

- It boots from no head: the constructor sets `bootFrom` to null.
- It runs no network boot (`Autobee._isReindexing`).
- It queues no fast-forward from a wakeup hint
  (`Autobee._queueFastForward`).

okf never calls `moveTo` (`Autobee.moveTo`).

Test: "a joiner folds every op through its own apply, never a stamped
view (I2/I3)" in `okf/store/test/convergence.test.js`.

### The position is the per-writer ordinal

SPEC §3 needs this for its position rule, and for the gaps in the seqs of
a writer.

The README documents `node.length` as the "position in the writer's
core" (README section `Apply`). autobee sets it to the length of the core
after the node. For a block that it reads from the core, `Writer._next`
does that. For a local node, `Writer.append` takes it from `appendLength`,
which the `Writer` constructor starts at the core length plus one. So
`node.length - 1` is the same on every peer.

Every node of a batch enters the system. Apply gets only the nodes with a
non-empty value. `Autobee._applyBatch` does both. So an empty node takes
a position and reaches no apply.

Tests:

- "the seq of an op is its node's position in the local core, also after
  an empty block and a restart" in `okf/store/test/ordinal.test.js`
- "an empty block does not inflate seqAtRemoval, so an op made after the
  revocation is rejected (I10)" in `okf/store/test/ordinal.test.js`
- "the actual seq of an op is node.length - 1, also after a gap in its
  writer's positions" in `okf/core/test/apply/position.test.js`
- "flag/rejected keys a rejected op by its position" in
  `okf/core/test/apply/position.test.js`
- "an empty block at the tail of the local core takes a position, so the
  seq after restart skips it (§3, §8 forged-clock)" in
  `okf/store/test/restart.test.js`

### The length of the local core gives the next position

SPEC §3 needs this: the store takes the seq of a new op from `db.local`
before it encodes the op.

The README documents `db.local` as the local writer Hypercore (README,
`db.local`). The local writer appends through that core: `Autobee._open`
sets `db.local`, the `ActiveWriters` constructor hands it to the local
`Writer`, and `Writer.flush` appends to it. Three behaviours hold the
rule:

- The Bundle serializes its appends. A plain `db.append` resolves with
  the drain that applies its node and writes it to the core
  (`Autobee.append`, `Autobee._bump`, `Autobee._drain`,
  `ActiveWriters.flushLocal`, `Writer.flush`). So the length counts every
  earlier node, unless a node waits.
- A local node that links a node missing from the system waits in memory
  (`Writer._next`). Then the length is behind, and the store takes one
  past the seq of its last append.
- autobee appends no other local node in this configuration. Its only
  other local append is the empty ack (`Autobee._appendAck`).

The empty ack has two causes, and neither occurs here:

- The threshold ack needs a system head that is not trusted
  (`Autobee._appendAck`, `Autobee._allHeadsTrusted`). okf passes no
  `isTrusted` and no `mostRecentTrusted` hook, so every key is trusted
  (`TrustedPeers.isTrusted`, and README, `isTrusted(key, reference)`). The
  README section `Acking` states the threshold alone, and the source adds
  the trust condition. `ackThreshold` stays at its default of 32
  (`DEFAULT_ACK_THRESHOLD`).
- The ack after a reindex needs `_reindexed`. `Autobee.compactMaybe` sets
  it only for a system or view core below manifest version 3
  (`Autobee._isReindexed`, `Autobee._shouldReindex`). This release makes
  both cores at version 3 (see the corestore floor).

Between the read of the length and the append inside `db.append`, autobee
awaits (`Autobee.append`). If a later autobee appends a local node in
that window, the op lands one position later. Every peer then rejects it
`forged-clock`, and the views stay equal.

Tests: "after a crash that loses the boot record, each next op takes its
own position, never a used seq" and "with autobee's default ackThreshold,
a writer that falls 40 flushes behind appends no empty block" in
`okf/store/test/ordinal.test.js`.

### An append returns only once its node is durable

`Bundle.append` resolves only once `db.local` holds the position of its
node. `okf/store/README.md` states this rule for a caller. The rule
relies on five behaviours:

- A new local node lives only in memory, in the pending list of the local
  writer (`Writer.append`). Only `Writer.flush` writes it to the core.
  Only the drain calls that (`Autobee._drain`, `Autobee._flushLocal`,
  `ActiveWriters.flushLocal`).
- The close of autobee calls no flush. `Autobee._close` sets
  `_interrupting`. `Autobee._teardown` closes the writers, `db.local` and
  the store, and then awaits the drain in flight.
- A reopen starts the local writer with no pending node, at the core
  length (the `Writer` constructor). No code reads a pending node back.
- A node that waits behind a missing link never reaches apply, so no
  system or view state holds it (`Writer._next`). autobee stores its boot
  record only after a drain that was not interrupted (`Autobee._drain`).
- The wait listens to the hypercore events `append` and `close` on
  `db.local` (hypercore README, `core.on('append')` and
  `core.on('close')`). A flush that passed the closed check in
  `Hypercore.append` can still commit after `close` (hypercore
  `SessionState.append`, `SessionState.onappend`). The closed session
  then gets no `append`.
  Once closed, `db.local.length` reads 0 (the hypercore getter `length`).
  So the store decides only after `db.close()` resolves, from the length
  in storage, through its root corestore.

An append that the close stops fails `VAULT_CLOSED_BEFORE_DURABLE`, and
it wrote nothing.

The tests are in `okf/store/test/append.test.js`:

- "a close during an append returns no tag for a node that is missing
  after a reopen, and an append that it rejects wrote nothing, in 50 of 50
  runs"
- "close() cuts each append that waits in the append chain
  VAULT_CLOSED_BEFORE_DURABLE, and each append that returned is in the
  core after a reopen"
- "close() during an append that waits in the ack gate, before db.append,
  fails it VAULT_CLOSED_BEFORE_DURABLE, and no node of it reaches the
  core"
- "an append that waits behind a missing link fails
  VAULT_CLOSED_BEFORE_DURABLE when close() runs, and after a reopen its op
  is not in the view"
- "close() resolves only after every in-flight append has settled: each
  append whose node waits for the local core fails
  VAULT_CLOSED_BEFORE_DURABLE before close() resolves, and none is in the
  core after a reopen"
- "close() returns while an append waits for a drain that reads an absent
  block, and the append fails VAULT_CLOSED_BEFORE_DURABLE"

### `db.writable` is the substrate admission signal

SPEC §8 needs this: the store refuses an append until `db.writable` is
true.

`db.writable` is `true` once autobee has added this writer (README,
`db.writable`). autobee sets it from the system record of the local
writer: added and not removed (the getter `Autobee.writable`,
`ActiveWriters._updateLocalState`). Its own `append` refuses only a
removed writer (`Autobee.append`). A writer that autobee has not added
fails the local flush with `Not writable` (`Writer._next`), and then
autobee closes (`Autobee._onError`). So the store checks `db.writable`
before every append, and refuses with `VAULT_NOT_WRITABLE`.

`db.writable` is not okf membership. The grant comes with every folded
`AddWriter` op, a rejected one too (see "The grant at every `AddWriter`
op"). So a key can be writable with no `gov/writer` record (SPEC §8).

Test: "an append from a writer that is not writable fails fast:
VAULT_NOT_WRITABLE, autobee stays open, no seq used" in
`okf/store/test/writers.test.js`.

### `host.removeWriter` is never called

SPEC §8 revocation is causal, in okf's apply. Its clock rule needs every
node of a revoked writer to reach apply on every peer. A substrate
removal breaks that, and it is not a complete apply filter either.

A removal at the substrate records the writer as removed
(`ApplyCalls.removeWriter`, `Systembee.removeWriter`). Then
`Systembee.canApply` is false for its ordinary nodes, the nodes without
the optimistic bit, and they reach no apply (`Autobee._applyBatch`).

A node with the optimistic bit is the exception. `Systembee.canApply`
returns true for it before it reads the removal record. The constructor
option `optimistic: false` does not close that path for a removed writer.
autobee applies the option only to its filter in
`Autobee._bumpPendingWriters`. A writer with a system record stays added
there, also when removed (`Writer.update`). `Autobee._processBatch` then
passes the node's own bit to `Autobee._applyBatch`, and from there to
`canApply`.

So `HostAdapter` in `okf/store/lib/bundle.js` exposes only `addWriter`. A
revoked member stays an autobee writer. `SECURITY_MODEL.md`, "The trust
model", states what that costs.

### Genesis, the vault key and the stored encryption key

SPEC §8 needs this for the genesis indexer and for `encryptionKey`.

A creator passes no vault key. autobee then takes the key of the local
writer core as the vault key (`boot`). So `metadata.genesisKey` equals
`db.key` on every peer. Core's genesis indexer is then autobee's
bootstrap writer (`Autobee._processBatch`).

autobee keeps the encryption key in the user data of the local core, as
`autobee/encryption` (`boot`). So a reopen needs no key. `encryptionKey`
encrypts the writer cores, the system and the view (README section
`Encryption`, the `Autobee` constructor, `Autobee._getCorePreload`,
`Autobee._open`, `ActiveWriters._add`).

Tests: "at rest: no stored block of the system, writer or view core holds
plaintext, and the same scan finds it in an unencrypted vault" and "an
encrypted vault reopens from disk without the key, and a peer that joins
with the key reads it" in `okf/store/test/encryption.test.js`.

### The store session, replication and close

SPEC §10 needs the namespace: a writer key pair does not recur across
generations.

The Bundle hands autobee a per-generation namespace of its root corestore
(corestore README, `store.namespace(name)`). `db.replicate(stream)`
passes its arguments to `store.replicate`, and adds the stream to the
wakeup protocol (`Autobee.replicate`). The README documents only
`isInitiator` (README, `db.replicate(isInitiator)`). corestore's
`replicate` also takes a stream (corestore README,
`store.replicate(optsOrStream)`).

`db.close()` closes the store that it was handed (`Autobee._teardown`).
So the Bundle closes its root corestore itself, after `db.close()`.

### A reopen wakes each writer with a `gov/writer` record

I2 needs this (SPEC §11): a peer that reopens in a quiet vault must still
converge.

At boot, autobee restarts only the writers that are system heads, and the
boot hints since the last drain that applied hints
(`Autobee._bootOnline`, `Autobee._drainBootHints`,
`Autobee._applyWakeupHints`). A peer that closed during a heal can hold
new blocks of a writer that is no head, and that it has not folded. Its
caught-up peers announce no pending writer (autobee-wakeup,
`WakeupHandler.onlookup`), and no new length reaches it. So the peer
stays behind until somebody writes.

The Bundle open calls the documented `db.wakeup({ key, length: 0 })`
(README, `db.wakeup({ key, length })`) for each key with a `gov/writer`
record. It wakes no key that only `seen/` holds. Each wakeup opens a
core, and a member can make any number of such keys (`SECURITY_MODEL.md`,
"What the substrate decides, and what okf decides").

Tests: "a peer that closes during a heal, and reopens in a quiet vault,
converges: open wakes each writer with a gov/writer record" and "open
wakes each key with a gov/writer record, and never a key that only seen/
holds" in `okf/store/test/restart.test.js`.
