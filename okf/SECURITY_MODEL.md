# auto-okf security model

This document states who can attack an auto-okf vault, which defense stops
each attack, and where each guarantee ends. [GLOSSARY.md](GLOSSARY.md)
defines the terms. A § number points at [SPEC.md](SPEC.md).

Two words carry the model. An autobee writer is a key that autobee
added, so its nodes reach apply. A member is a writer with a `gov/writer`
record, which only apply writes (§8). Every member is an autobee writer.
A member can make any key an autobee writer (point (d) below), so an
autobee writer is not always a member.

## The trust model

**Membership is total trust for the life of a generation.** A member can
do these things, and so can each key that a member makes an autobee
writer. okf cannot stop them without changing autobee:

- Halt every peer that folds its node (the unbounded approval).
- Choose where its writes sort, and so pick the winner of a race (the
  chosen timestamp).
- Make every peer open writer cores (the writer-core flood).

okf accepts these residuals: a vault trusts its members for the life of a
generation. A generation is one vault, one key set and one log. The next
generation starts with one member, the peer that ran its import (the
eviction ladder below).

**Revocation stops cooperating clients only. A revoked key with a
modified client can keep writing until the next generation. Quorum-signed
revocation epochs are the planned fix.**

SPEC §8 states the revocation rule. This is what the rule costs, and how a
modified client evades it:

- A `RemoveWriter` records `gov/removed/<key>` (`opRemoveWriter` in
  `core/lib/apply.js`). apply rejects each op of the key that sorts after
  that record and lies past `seqAtRemoval`. The store of the revoked key
  refuses its own appends (`VAULT_REVOKED`), so a cooperating client
  stops. Test: `store/test/writers.test.js` "writers.add and writers.remove
  round trip: the removal records the position that the store observed,
  every peer flags the later op revoked, and the next append of the removed
  writer fails VAULT_REVOKED".
- A modified client does not stop. It stamps its node below the timestamp
  of the `RemoveWriter`, and it leaves the removal out of the node's
  links. The node then sorts before the removal on every peer, where no
  `gov/removed/<key>` record exists yet. So its op takes effect, and no
  `flag/rejected` entry records it. This is the revocation bypass.
- autobee bounds a timestamp two hours ahead (`MAX_FORWARD_TIME_DRIFT`),
  and never in the past.
- The key also stays an autobee writer, because okf never calls
  `host.removeWriter` (the revoked autobee writer, below). So its
  `AddWriter` ops still grant keys: `applyNode` calls `grant` before the
  revocation check.
- okf cannot reject such an op without changing autobee. apply runs in
  the order that autobee sorts, after autobee sorted the node (point (e)
  below).

### The eviction ladder

1. **Cut the delivery.** `Bundle.revokePeer(swarmKey)` takes the key out
   of this peer's allowlist, destroys its open connections and calls
   `leavePeer`. A folded `RemoveWriter` does the same on each peer that
   folds it, for the bound swarm key of the removed writer
   (`_refreshAllowlistOnce` in `store/lib/bundle.js`). That is the key on
   its record, and for the creator the key that the invite binds to
   `genesisKey` (`metadata.swarm.genesis`). A writer that an indexer
   admitted with no swarm key has no bound key. Its removal cuts nothing
   that the invite or a local list grants. `auto-okf add-writer` refuses
   such an admission.
2. **Evict.** A new generation is the full eviction: `materialize`, then
   `auto-okf import` into a new directory. The new vault has a new vault
   key and new writer keys. Its only member is the peer that ran the
   import. `--metadata` carries `limits`, `rate` and `schemaVersion`, and
   never the `swarm` allowlist (`CARRIED` and `carriedMetadata` in
   `faces/lib/import.js`). The invite of the new vault lists only the
   swarm key of the peer that ran the import (`_withOwnSwarmKey`). An
   indexer admits each writer again with `add-writer --swarm-key`, and
   leaves the evicted key out.

The tests of step 1 are in `store/test/swarm.test.js`:

- "revokePeer cuts a live connection, leaves the peer, and keeps the key
  out across later folds"
- "a removed writer's connection is destroyed when the removal folds,
  though the invite lists its key"
- "a folded RemoveWriter of the creator cuts the creator's swarm key, which
  the invite binds to genesisKey, also after a reopen and on a fresh
  joiner"

The test of step 2 is `faces/test/generation.test.js` "I11: materialize,
then import, round-trips a non-trivial bundle with identity and byte
fidelity".

Step 1 retracts nothing:

- A block of the cut key that a member already holds stays in that
  member's store.
- Members still replicate that block to each other. Every admitted
  connection runs `db.replicate`, which replicates the cores of the store.
  See DEVIATIONS.md, "Substrate behaviour that okf relies on".
- okf never removes the key at the substrate.
- Each peer cuts only its own connections. A peer that did not fold the
  removal still admits the key.
- The old vault stays on each replica that holds it, until that replica
  is destroyed (§10).

**The planned fix.** Quorum-signed revocation epochs give retroactive
containment inside a generation. This release does not build them.

### When every indexer directory is lost

Only an indexer can admit a writer, revoke a writer or set its policy.
apply rejects a governance op whose issuer is not an indexer at the op's
linearized position (§8). Test: `core/test/apply/governance.test.js` "I10:
governance requires an indexer issuer; an unauthorized AddWriter still
grants at weight 0 and never admits".

An indexer's writer key lives in its vault directory. The store derives
the writer core from the directory's corestore, under the generation
namespace (`GENERATION_NS` in `store/lib/bundle.js`). The exception is a
caller that passes its own `keyPair`. So if every indexer directory is
lost, nobody can admit a writer in that generation.

Back up an indexer directory, or admit two indexers. A new generation has
a new genesis indexer.

## The adversaries

okf has two adversaries, because it has two doors.

The first is the log adversary. It is a [writer](GLOSSARY.md#writer) that
uses no client library and appends arbitrary bytes to its own core. Every
defense against it is in [`apply`](GLOSSARY.md#apply), which decides every
effect on the [view](GLOSSARY.md#view) (§8). Nothing that skips apply can
change the view, and apply runs the same way on every peer.

The substrate still decides two things that apply cannot: which nodes
reach apply, and in which order. "What the substrate decides, and what okf
decides" below states what that leaves open, with the measurement of each
case.

The second is the disk adversary: anyone who can write files into the
watched bundle directory. [Ingest](GLOSSARY.md#ingest) turns edits of
files into ops, so the watched directory is untrusted input by design
(§9).

## Defenses, all in apply

The SPEC states each rule. This table states what each rule stops.

| Defense | What it stops | Rule |
|---|---|---|
| Governance authority | a writer that is not an [indexer](GLOSSARY.md#indexer) admits, revokes or sets a policy. The op is rejected `policy-governance` and changes no `gov/` key | §8 |
| The last indexer stays | a `RemoveWriter` or a demoting `AddWriter` leaves the vault with no indexer | §8 |
| Causal revocation | a removed writer writes after its removal, with a true clock or a forged one (`revoked`, `forged-clock`) | §8, §3 |
| Admission before effect | a key with no `gov/writer` record changes a `c/` key (`not-a-writer`) | §8 |
| Rate policy | an admitted writer floods. Only accepted indexer ops refill its token bucket | §8 |
| Append-only | an op destroys bytes. The wire contract holds no such op | §8 |
| Path safety | a path escapes the bundle root, takes a reserved name, or shares a file with another concept | §7 |

These defenses have four limits:

- The revocation checks bind only the ops that sort after the removal
  (the revocation bypass, in "The trust model" above).
- apply has no hold buffer. It rejects an op of a key with no `gov/writer`
  record, and it never holds one. Membership is not retroactive.
- The store refuses an append until `db.writable` is true
  (`VAULT_NOT_WRITABLE`). `db.writable` is substrate state, and it is not
  membership. An autobee writer with no `gov/writer` record passes that
  gate, and apply rejects and flags each of its ops (the free identities).
- The rate policy meters members only. An op that apply rejects earlier,
  such as `not-a-writer`, takes no token.

apply loses nothing silently ([I4](GLOSSARY.md#invariant-i1i11)). Every
rejected, superseded or conflicting effect leaves a `flag/` record.

## Trust boundaries and caveats

### The ingest boundary

SPEC §9 states the rules of materialize and of ingest. These rules decide
what the disk adversary can do:

- Materialize never destroys human work. It never deletes or overwrites a
  `.md` file whose bytes its emission manifest does not hold. It leaves
  the file in place, reports it as pending-ingest and exits nonzero.
  `--force-mirror` is the operator's override.
- Ingest believes the disk, by design. It adopts an unknown `_id`, under
  the seen-id and mint-collision rules (§6, §10).
- A file deleted on disk becomes a `DeleteConcept` only behind a
  confirmation guard, which is on by default.
- Ingest ignores edits of the generated `index.md` and `log.md`.

Two cases at this boundary can lose data or block a file. Ingest handles
each one, and a test holds each rule:

- A directory move through the watcher loses no concept. A file on disk
  that bears a tombstoned `_id` is intent to keep, so ingest undeletes the
  concept before it moves it. Ingest never deletes a vanished path inside
  the event that noticed it. The delete waits for a quiet window, so the
  `SetPath` of the moved file lands first. A directory event schedules one
  rescan, and ingest never drops it. Tests: `faces/test/watcher.test.js`
  "a delete of the old path that lands before the ingest of the moved file
  loses no concept: the ingest undeletes it at the new path" to "the ingest
  of a file restored on disk undeletes its concept".
- A file name with two `.conflict-` suffixes does not stay pending.
  Ingest strips every trailing reserved suffix. Test:
  `faces/test/ingest.test.js` "a file with two .conflict- suffixes ingests
  at the base path with every suffix stripped, not at a reserved path that
  apply rejects".

One limit remains, and it is a non-goal. Subtree moves do not exist in v1
(§7, §12). A directory move is one `SetPath` op per concept, with no
atomicity. An interrupted run leaves part of the subtree moved.

### What the substrate decides, and what okf decides

The substrate is autobee@2.12.1, pinned exactly, with autobee-wakeup@1.1.3
from the lockfile. Each autobee symbol below belongs to those releases.
Each quoted test name is a test in `okf/*/test/`. The store configures
autobee with `optimistic: false`, `bootstrapWeight: 0` and
`fastForward: false`, and `HostAdapter` grants every writer at
`weight: 0`. DEVIATIONS.md, "Substrate behaviour that okf relies on",
states how autobee behaves under that configuration.

The substrate decides which nodes reach apply and in which order. apply
decides every effect on the view. An attack whose mechanism is inside the
substrate ends in one of three ways:

- The configuration keeps it out.
- okf's own code closes it.
- This document states it as a residual.

**(a) An outsider changes no view state.** An outsider is a key that
autobee did not add: no `AddWriter` op granted it, and no approval on a
folded node named it. Holding the vault key makes a peer an outsider,
never a writer. A key that okf never admitted can still be an autobee
writer, because a member can make it one (points (d) and (f)). Such a key
is not an outsider. Point (d) measures what its ops cost.

With `optimistic: false`, autobee drops every node of an outsider before
apply. The dropped node's approvals add no writer, and the system records
nothing. See DEVIATIONS.md, "Substrate behaviour that okf relies on".

An outsider's node with the optimistic bit costs one more step before the
drop. It enters the pending buffer, and autobee resolves its weight there
(`ActiveWriters.nextPendingNode`). That step can make the read of the
forged witness, below. Every outsider node of the tests carries the bit
(`outsiderAppend` in `store/test/attack-helpers.js`).

A modified client of an outsider key can still append nodes to its own
core. A peer that connects to it downloads those nodes and drops them
before apply. Five tests in `store/test/substrate-attacks.test.js` measure
that:

| Test | What the outsider sends |
|---|---|
| "a stranger cannot admit itself with a forged approval" | a forged approval that names the sender |
| "strangers put no node into apply, so they drive no livelock" | the nodes of the livelock attack |
| "an outsider approval at weight 1e9 reaches no apply (child process)" | an approval at weight 1e9 |
| "an outsider forged witness reaches no apply" | a forged witness that cites a present writer length |
| "an outsider backdated node flips no winner" | a backdated node that links one side of a concurrent pair |

Each test sends the forged node and proves that every peer holds it. Then
it shows four things on every peer:

- No outsider node reaches apply.
- No `seen/` entry counts an outsider node.
- autobee records no outsider key.
- The view hash does not change.

**(b) The writer-core flood: the firewall keeps an outsider out, and an
autobee writer can still flood.** Two triggers make a peer open writer
cores:

- A wakeup announce of N keys that belong to nobody. The receiver hints
  every announced key (autobee-wakeup's `onannounce`). The drain turns
  each hint into an opened writer core (`_applyWakeupHints`, then
  `ActiveWriters.wakeup`).
- A node whose links name keys that the receiver does not hold.
  `Writer._next` runs the link check (`_isLinked`) before the membership
  drop, and a witness link joins the link set. The first missing link
  leaves a retained wait, and `_isLinked` wakes every missing link. So one
  node opens one core per missing link and leaves one wait per writer.
  The node reaches no apply while a link stays missing, so it takes no
  rate token and leaves no flag.

Only a peer with a replication connection reaches either trigger. okf
closes both for an outsider, which here is a peer with the vault key, the
invite and no admitted swarm key:

- `swarm()` gives hyperswarm the same `keyPair` and `firewall` on a
  private DHT (`--bootstrap`) and on the public DHT (`--public-dht`).
- The firewall admits the keys of `metadata.swarm.allow`, the swarm keys
  of live `gov/writer` records and the keys of the peer's local list
  (`swarm({ allow })`). It subtracts the bound swarm key of every removed
  writer, the creator's key that the invite binds included.
- So the outsider gets no connection. Test: `store/test/swarm.test.js` "a
  peer with the vault key and the invite, and a swarm key outside the
  allowlist, never connects". The test runs on a private testnet, and the
  same code runs on the public DHT.
- A stream that a caller opens with `Bundle.replicate()` passes no
  firewall. The caller chooses the peer at the other end. On such a
  stream, an outsider's node reaches the link check before the drop.

The outsider costs a peer four things, on either DHT, and nothing else:

1. The topic announcement. The outsider can look it up. It names the
   swarm keys of the announcing peers and the DHT nodes that relay to
   them.
2. One handshake per attempt. hyperdht reads the first Noise message of
   each attempt before the firewall rejects it (`_addHandshake` of
   hyperdht's server).
3. hyperdht's record of each rejected attempt. The server keeps a
   handshake record and a map entry for 10 s (`HANDSHAKE_CLEAR_WAIT`),
   and then clears them. So a flood holds one record for each attempt of
   the last 10 s. The store does not bound them, and the suite does not
   measure them.
4. A bounded ban table. hyperswarm bans each rejected key and keeps its
   record in `swarm.peers` (`_handleFirewall`). The store keeps at most 64
   such records and lifts the oldest ban past that bound
   (`MAX_BANNED_PEERS`, `_recordBan`). The firewall still rejects a key
   whose ban was lifted, at its next attempt. Test:
   `store/test/swarm.test.js` "a flood of fresh swarm keys leaves at most
   64 ban records, and the firewall still rejects every key".

A peer with a connection can still send the announce, and an autobee
writer can send the node. That is the residual:

- Only an attacker starts a flood. No okf code sends an announce, and no
  honest client invents writer keys. The test writes its own modified
  client (`announce` in `store/test/attack-helpers.js`).
- An honest peer can pass a flood on. autobee-wakeup answers a lookup
  with its active pending writers (`onlookup`, `_getWakeupWriters`). That
  filter is `isPending` alone, never a record in the responder's own
  system. So a peer that took the flood announces the same keys to the
  next peer that sends it a lookup, also after the attacker disconnects.
  The flood reaches one hop past the peers that the attacker spoke to.
- autobee's untrusted-writer cap does not bound the flood.
  `ActiveWriters._add` skips the cap while the local writer is trusted.
  With no `isTrusted` and no `mostRecentTrusted` hook,
  `TrustedPeers.isTrusted` trusts every key.
- The test "an outsider wakeup flood opens one writer core per announced
  key (residual)" measures the cost. It connects the flooding peer with a
  direct stream, which passes no firewall. 200 announced keys open exactly
  200 writer cores, past the default cap of 128
  (`DEFAULT_MAX_UNTRUSTED_WRITERS`).
- The vault grows on disk, and every sampled core is still in the store
  after a close and a reopen.
- Apply latency grows with the count, because every drain pass walks
  every active writer (`ActiveWriters.refresh`). The test records the
  ratio of 20 appends after the flood against 20 before it.
- The cost has no bound. The sender chooses N, and the cost grows with N.
  At N = 200, the vault of that test still appends, reopens and folds.
  The suite measures no larger N, so this document claims nothing past
  that run.

**The suite does not measure the second trigger.** autobee's own local
flush gate refuses to flush a node whose links are missing
(`Writer._next`). So a test attacker that appends through autobee cannot
publish that dependency graph. The gate binds a client that runs
autobee's drain. It does not bind the log adversary, which appends to the
core that it owns (`forgeRawNode` in `store/test/attack-helpers.js`).

okf does not adopt a members-only `wakeupCapability`. autobee reads that
constructor option in `_bootUnsafe`, and the autobee README does not list
it. The option puts a peer without the shared secret on another wakeup
topic. The firewall already gives an outsider no connection, and every
member holds the secret. So the option does not bound the residual.

**(c) Ordering is uniform, and no honest peer approves.** Every writer
stands at weight 0, genesis included. So nodes sort by timestamp, then
writer key, then length. No peer collects an approval, and no writer
climbs to a higher weight. So no resolved weight depends on a node's own
position, and nobody can drive the apply loop into a livelock. See
DEVIATIONS.md, "Substrate behaviour that okf relies on".

autobee's own `isIndexer` is therefore always false. `Bundle.isIndexer`
reads `gov/` instead.

Tests in `store/test/writers.test.js`:

- "every writer stands at weight 0 on every peer, and no honest node
  carries approvals or a witness"
- "isIndexer answers from gov/: a live gov/writer record with indexer
  true"

Tests in `store/test/substrate-attacks.test.js`:

- "a key that a member names in a forged approval stays at weight 0"
- "a member drives no livelock"
- "no peer collects an approval, with more than 32 promotions pending"
- "no writer climbs, also when a member forges a higher-tier approval"

**(d) What an autobee writer can still do.** Three paths make a key an
autobee writer, and okf never removes a key again (the revoked autobee
writer):

- Genesis, at `bootstrapWeight` 0.
- Every key that an `AddWriter` op granted, whatever apply decided about
  the op (point (f)).
- Every key that an approval on a folded node named, with no `AddWriter`
  op at all. autobee reads the approvals of a node in `_applyBatch` and
  adds each named key to its system. The tests of point (c) and of the
  free identities measure that path.

Every residual below is open to any autobee writer. It needs no
`gov/writer` record.

| Residual | What the attacker sends | Who can send it |
|---|---|---|
| The unbounded approval | an approval at an unbounded weight | an autobee writer |
| The chosen timestamp | a node whose timestamp the attacker chooses | a member, a revoked member too |
| The free identities | ops of a key with no `gov/writer` record | an autobee writer with no `gov/writer` record |
| The revoked autobee writer | ops and grants after its removal | a revoked member |
| The forged witness | a witness claim that cites a core | an autobee writer, and an outsider on a connection that passes no firewall |
| The writer-core flood | a wakeup announce, or a node with missing links | an autobee writer. Point (b) states it whole |

**The unbounded approval.** A node carries an approval at weight W.

- Every peer that folds the node walks one tier per unit of weight in
  `Systembee.flush` (`Promotions.flushPending`). `_applyBatch` calls that
  flush after okf's apply ran, and nothing that apply returns stops it.
- Above V8's `Set` limit, that peer dies with `Set maximum size exceeded`,
  and it appends no more.
- Below the limit, the cost stays on every peer for good. At weight 0
  nobody approves (point (c)), so the pending promotion at weight W never
  clears.
- Each flush writes a digest of W entries into the system info record.
- Each later flush that carries a grant or a pending update walks the W
  tiers again. Every `AddWriter` grant is such a flush, because
  `Systembee.addWriter` gives a host grant a `pending` of 0.
- The named key becomes an autobee writer on each peer that folds the
  node, with no okf op.
- The sender's own cost does not bound the attack. `_drain` folds a local
  node before `_flushLocal` writes it to the core. So at weight 1e9 a
  sender that appends through autobee dies before its node leaves its
  core.
- A client that writes the oplog block to the core that it owns skips
  that order. Its block is durable at once, and it replicates. A victim
  on stock autobee dies when it folds the approval, and it appends no
  more.
- A reopen is no repair. In one measured branch, the boot drain folds the
  stored block again, and the peer dies inside `Bundle.open`. In the
  other, the peer reopens with the attack core still in its store.

Tests, both in a child process:

- "a member client that folds nothing delivers the weight 1e9 approval,
  and the victim dies (residual, child process)". It proves the delivery
  first, and then the death of the victim.
- "a member approval at weight 1e9 kills the sender that folds it first
  (residual, child process)". It measures the sender, at both weights.

**The chosen timestamp.** A writer stamps its own node. autobee bounds
the future by two hours (`MAX_FORWARD_TIME_DRIFT`) and does not bound the
past. SPEC §8 states the order.

- The attacker reorders concurrent writes and picks the LWW winner on
  every peer.
- The reorder is uniform, so the peers still converge. It is a consistent
  rewrite, never a split. Test: "a member backdated node flips the winner
  on every peer (residual)".
- A revoked member writes past its revocation the same way. This is the
  revocation bypass of "The trust model" above. No test in this suite
  sends it.

**The free identities.** An autobee writer with no `gov/writer` record
reaches apply on every peer.

- Each of its ops costs one `flag/rejected` entry on every peer, and
  nothing is silent (I4).
- The op takes no rate token, because apply rejects it before the bucket.
- No `c/` key changes. The test compares the whole ordered `c/` range,
  keys and values, against the range before the attack, on every peer.
- Its `AddWriter` ops grant more autobee writers at weight 0, so the
  supply of identities is free.
- A member needs no forged node for this. One `AddWriter` op makes the
  named key an autobee writer on every peer, whatever apply decides about
  the op (point (f)).

Test: "a key that a member approves costs one flag per op, no rate token
and no c/ change (residual)".

**The revoked autobee writer.** okf never calls `host.removeWriter`, so a
revoked member stays an autobee writer.

- Its ops that sort after the `RemoveWriter` reach apply. apply rejects
  them `revoked`, each with a flag (I4).
- Its ops that sort before the removal take effect (the revocation
  bypass).
- Its `AddWriter` ops still grant keys, because `applyNode` calls `grant`
  before the revocation check.
- A folded `RemoveWriter` takes its bound swarm key out of the allowlist
  of each peer that folds it (the eviction ladder).
- A call of `removeWriter` is worse. `canApply` then turns false for the
  removed writer. So its node reaches the system of some peers and the
  apply of others, which is the split that point (f) prevents. See
  DEVIATIONS.md, "Substrate behaviour that okf relies on".

"The trust model" and "The eviction ladder" above name the tests of the
revocation and of the cut connection. The test of the free identities
covers the grants.

**The forged witness.** A node claims a weight and cites a core as its
witness.

- The claim is inert on the claimant's weight. It never verifies at
  weight 0 (point (c)).
- The resolution is not free. autobee resolves the weight of a pending
  node before the drop (`ActiveWriters.nextPendingNode`), and again before
  apply (`prepareBatch`).
- A claim makes autobee open the cited core and read one block
  (`verifyClaim` in `lib/witness.js`). That read takes no rate token.
- An outsider's node with the optimistic bit reaches the same read before
  the drop (point (a)), on a connection that passes no firewall.

Tests: "a member drives no livelock" sends a member's forged witness, and
the claimant stays at weight 0. "an outsider forged witness reaches no
apply" sends an outsider's, and its node reaches no apply.

**(e) okf cannot close those without changing autobee.** Each mechanism
of point (d) runs before okf's apply or outside it:

- autobee resolves weights in `prepareBatch` and in `nextPendingNode`,
  before any node reaches apply.
- In `_applyBatch`, a node enters the system and its approvals apply
  before `apply` runs.
- A wakeup announce opens cores in the drain, with no node and no op.
- autobee sorts each node by its timestamp before apply sees it (`cmp` in
  `lib/topo.js`). apply folds in that order. So it cannot reject an op of
  a revoked member that sorts before the `RemoveWriter`.

apply has no veto over any of it. autobee offers the application no hook
to undo that work. The approval is already in the system when apply
starts, and nothing that apply returns takes it out.

apply does see those fields. `_applyBatch` hands the original node
objects to the application, every node that carries a value, and it
removes no field. The store forwards them unwrapped (`Bundle._apply`). So
an approval, a witness and a timestamp are visible and inert. okf lacks
control, and it does not lack visibility. A wakeup hint reaches apply in
no form at all.

okf's product code uses autobee's constructor options, its documented
instance API and the host API that apply receives, and nothing else. So
the remedy for every residual of point (d) is a change inside autobee.
okf accepts these residuals, the writer-core flood with the cost in point
(b) included: a vault trusts its members for the life of a generation.

**(f) An autobee grant follows every `AddWriter` op, and membership comes
only from `gov/`.** apply calls `host.addWriter(key, { weight: 0 })` for
every `AddWriter` op that it folds, accepted or rejected. SPEC §8 states
the rule, its place in apply and its limits.

- Without the rule, the views can split for good. A grant that a
  concurrent revocation undoes leaves the writer's consumed node in the
  system of some peers and not of others. `_processBatch` puts the undone
  tip back on the batch stack without the drop filter. `_applyBatch`
  records the node in the system before `canApply` decides. The stale
  record then lets that writer's next node through on those peers alone
  (`Writer.update`). Test:
  `store/test/writers.test.js` "the governance race converges, and every
  op of the race writer leaves a flag (I2, I3, I4)".
- The cost is the free identities.
- Membership is `gov/` alone. A weight, an approval, an autobee system
  record and a writable local writer give none of it.

Three tests read `gov/writer/<key>` next to the substrate state, so a
reader cannot confuse the two: "a stranger cannot admit itself with a
forged approval" (point (a)), the forged-approval test of point (c) and
the test of the free identities.

### The generation chain is provenance, not proof

A generation is an operator's act through the bundle, never an op (§10):
`materialize`, then `auto-okf import` into a new directory. The new vault
records `predecessorKey` in its metadata, from `--predecessor`
(`carriedMetadata` in `faces/lib/import.js`).

**That record is the operator's claim.** No signature and no record of the
predecessor's state exist. import opens no predecessor vault, and the
operator gives the key. Nothing in okf compares it with a vault. So the
chain is a recorded claim, and not an attestation.

A consumer must treat identity across generations as trusted-operator
scope. Within one generation, apply decides identity. Across generations,
the consumer trusts the operator who ran the import, and it has only the
bytes of the bundle that the import read.

A generation sheds history by design: old revisions, per-op attribution
and clocks do not survive it. [I11](GLOSSARY.md#invariant-i1i11) states
what does survive: the `_id`, type, fields, tags, path and head body of
every live concept, byte for byte. materialize reports every value that
the bundle cannot hold, and the operator fixes those values before import
(§10). import refuses a bundle that holds a conflicted copy. So the
operator resolves an open path collision in the bundle before a
generation.

### Privacy

The privacy boundary is the vault: one shared `encryptionKey`, end to end
(§8). okf has no read ACL per writer. Whoever holds the key of a vault can
read the vault.

## Guaranteed versus best-effort

Measured:

- Each of [I1 to I11](GLOSSARY.md#invariant-i1i11) maps to at least one
  test (§11).
- The multi-process fault harness runs its scenario matrix at three fault
  profiles: `pnpm test:okf-harness:clean`, `pnpm test:okf-harness:lossy`
  and `pnpm test:okf-harness:partitioned`. On autobee 2.12.1 each profile
  passes, and every scenario asserts convergence. The revocation scenario
  converges too.
- The generation roundtrip (I11) is an acceptance criterion (§14).

No harness writer chooses the timestamp of a node, and `okf/harness/`
holds no such code. So the harness does not show the revocation bypass.

Best-effort, and open: the memory growth under a sustained flood.

- The run was a 22-minute sustained lossy multi-writer flood, with
  backpressure on.
- RSS grew from about 85 MB to about 3.1 GB with no plateau.
- A third peer did not converge within the 5-minute heal window.
- These figures come from the v1 milestone of 2026-07-14
  ([DELIVERY.md](DELIVERY.md)), on the substrate release of that
  milestone. This document states no figure for autobee 2.12.1.
- The run showed that liveness and throughput degrade. It falsified no
  invariant: caught-up peers stayed byte-identical under every seed, file
  descriptors stayed flat, and nothing crashed. So it is a concern of
  scale.
- To reproduce it, run `node okf/harness/soak/soak.js`.

That item is the only open one in this class.

## Non-goals (v1)

From §12, the non-goals that bear on security:

- No merge policy per key.
- No atomic subtree move ("The ingest boundary" above).
- No text CRDT for bodies.
- No HTTP API.
- No read ACL finer than the vault ("Privacy" above).
