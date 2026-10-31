# auto-okf security model

This is the trust story for auto-okf: who the adversaries are, which
defenses stand between them and the [view](GLOSSARY.md#view), and where the
guarantees stop. Terms are pinned in [GLOSSARY.md](GLOSSARY.md). Spec §
references cite [SPEC.md](SPEC.md).

## The trust model

**Membership is total trust for the life of a generation.** A member is a
key that autobee has added (point (d) below). Three paths add one:
genesis, each key that an `AddWriter` op granted, and each key that an
approval on a folded node named. Any member can do these things, and okf
cannot stop them without changing autobee:

- halt every peer that folds its node (G2),
- choose where its writes sort, and so pick the winner of a race (G5),
- make every peer open writer cores (G44).

The owner accepted that (decision 1, and the decision of G1 on G44). A
generation is one vault, one key
set and one log. The next generation starts with one member, the peer
that ran its import (the eviction ladder below).

**Revocation stops cooperating clients only. A revoked key with a
modified client can keep writing until the next generation. Quorum-signed
revocation epochs are the planned fix.**

- A `RemoveWriter` records `gov/removed/<key>`
  (`core/lib/apply.js:590-611`). apply rejects each op of the key that
  sorts after that record and lies past `seqAtRemoval`
  (`core/lib/apply.js:399-403`). The store of the revoked key refuses its
  own appends (`VAULT_REVOKED`), so a cooperating client stops. Test:
  `test/store-writers.test.js` "writer add/remove round trip: causal
  revocation, uniform on every peer".
- A modified client does not stop. It stamps its node below the
  timestamp of the `RemoveWriter`, and it leaves the removal out of the
  node's links. The node then sorts before the removal on every peer
  (autobee `lib/topo.js:168-179`), where no `gov/removed/<key>` record
  exists yet. So its op takes effect, and no `flag/rejected` entry
  records it. autobee bounds a timestamp two hours ahead
  (`lib/writers.js:15`, `:595`), and never in the past.
- The key also keeps its substrate standing, because okf never calls
  `host.removeWriter` (G34 below). So its `AddWriter` ops still grant keys
  at the substrate: the grant (`core/lib/apply.js:375`) comes before the
  revocation check (`:399-403`).
- okf cannot reject such an op without changing autobee. apply runs in
  the order that autobee sorts, after autobee has sorted the node (point
  (e) below).

### The eviction ladder

1. **Cut the delivery.** `Bundle.revokePeer(swarmKey)` takes the key out
   of this peer's allowlist, destroys its open connections and calls
   `leavePeer` (`store/lib/bundle.js:1265-1271`, `:1345-1354`). A folded
   `RemoveWriter` does the same on each peer that folds it, for the bound
   swarm key of the removed writer (`store/lib/bundle.js:1305-1342`). That
   is the key on its record, and for the creator the key that the invite
   binds to `genesisKey` (`metadata.swarm.genesis`). A writer that an
   indexer admitted with no swarm key has no bound key, so its removal
   cuts nothing that the invite or a local list grants. `auto-okf
   add-writer` refuses such an admission. Tests in
   `test/store-swarm.test.js`: "revokePeer cuts a live connection, leaves
   the peer, and keeps the key out across later folds (T25)", "a removed
   writer's connection is destroyed when the removal folds, though the
   invite lists its key (T25)", and "a folded RemoveWriter of the creator
   cuts the creator's swarm key, which the invite binds to genesisKey,
   also after a reopen and on a fresh joiner (D-060 F01, D-061 R01)".
2. **Evict.** A new generation is the full eviction: `materialize`, then
   `auto-okf import` into a new directory. The new vault has a new vault
   key and new writer keys (test `test/i11-roundtrip.test.js` "I11 (T24):
   materialize, then import, round-trips a non-trivial bundle with
   identity and byte fidelity"). Its only member is the peer that ran the
   import. `--metadata` carries `limits`, `rate` and `schemaVersion`, and
   never the `swarm` allowlist (`faces/lib/import.js:44`, `:380-390`). The
   invite of the new vault lists only the swarm key of the peer that ran
   the import (`store/lib/bundle.js:348-365`). An indexer admits each
   writer again with `add-writer --swarm-key`, and leaves the evicted key
   out.

Step 1 retracts nothing. A block of the cut key that a member already
holds stays in that member's store. Members still replicate it to each
other. Every admitted connection runs `db.replicate`, which replicates
the cores of the store (`store/lib/bundle.js:1213-1214`, DEVIATIONS "The
store session, replication and close"). okf never removes the key at the
substrate. Each peer cuts only its own connections, so a peer that has not
folded the removal still admits the key. The old vault stays on each
replica that holds it, until that replica is destroyed (SPEC §10).

**The planned fix.** Quorum-signed revocation epochs give retroactive
containment inside a generation. This release does not build them.
Decision 9 makes them a dedicated follow-up run.

### When every indexer directory is lost

Only an indexer can admit, revoke or set the policy of a writer. apply
rejects a governance op whose issuer is not an indexer at the op's
linearized position (`core/lib/apply.js:407-412`). Test:
`test/i10-governance.test.js` "I10: governance requires an indexer
issuer; an unauthorized AddWriter still grants at weight 0 and never
admits". An indexer's writer key lives in its vault directory. The store
derives the writer core from the directory's corestore, under the
generation namespace (`store/lib/bundle.js:292`, `:304-316`). The
exception is a caller that passes its own `keyPair`. So if every indexer
directory is lost, nobody can admit a writer in that generation. Back up
an indexer directory, or admit two indexers. A new generation has a new
genesis indexer.

## The adversaries

There are two, because okf has two doors.

The first is the log adversary: a [writer](GLOSSARY.md#writer) that
bypasses client libraries entirely and appends arbitrary bytes to its own
core. Every defense against it lives in [`apply`](GLOSSARY.md#apply), where
all effects flow (§8). Nothing that skips apply can reach the view, and
apply runs identically on every peer.

The substrate still decides two things that apply cannot: which nodes
reach apply, and in which order. "What the substrate decides, and what okf
decides" below states what that leaves open, with the measurement of each
case.

The second is the disk adversary: anyone who can write files into the
watched bundle directory. [Ingest](GLOSSARY.md#ingest) turns on-disk edits
into ops, so the watched tree is untrusted input by design (§9).

## Defenses, all in apply

- **Governance authority (§8):** `AddWriter`/`RemoveWriter`/`SetWriterPolicy`
  require an [indexer](GLOSSARY.md#indexer) issuer, checked in apply against
  `gov/writer/<issuer>` at the op's linearized position. An unauthorized op
  is rejected `policy-governance` and changes no `gov/` key, so it confers
  no okf membership. It still grants its key at the substrate, because the
  grant follows every `AddWriter` op that apply folds (point (f) below). A
  `RemoveWriter` that would leave zero indexers is rejected, and so is an
  `AddWriter` that would demote the last live indexer
  (`core/lib/apply.js:563-567`, `:592-596`): a vault cannot become
  permanently ungovernable.
- **Causal revocation (§8):** after `RemoveWriter`, an op from the removed
  writer applies only if its clock strictly precedes the revocation. The
  claimed clock is cross-checked against unforgeable position. The actual
  seq of a node is its position in its writer's core (§3). Any node past
  the recorded `seqAtRemoval` is rejected regardless of its claim, and an
  op whose self-clock entry disagrees with that position is rejected as
  `forged-clock`. These checks bind only the ops that sort after the
  removal (`core/lib/apply.js:399-403`). A modified client sorts its ops
  before the removal ("The trust model" above).
- **Admission before effect (§8):** a writer's ops take effect only once an
  indexer-authored `AddWriter` has admitted it, at that op's linearized
  position. A content op from a writer with no `gov/writer` record is
  rejected `not-a-writer` (`core/lib/apply.js:426`). Each earlier check can
  reject it first (`core/lib/apply.js:361-403`). A governance op from that
  writer is rejected `policy-governance`, because the indexer-issuer check
  comes first (`core/lib/apply.js:407-412`). Neither op reaches the content
  pipeline or changes a `c/` key. There is no hold buffer: apply rejects
  such an op, and it never holds one. A joiner that only holds the vault
  key changes nothing in the view. Its store refuses every append until
  autobee reports the local writer writable (`VAULT_NOT_WRITABLE`, test
  `test/store-writers.test.js` "an append from a writer that is not
  writable fails fast"). A modified client of such a key can still append
  nodes to its own core. A peer that connects to it downloads those nodes
  and drops them before apply (point (a), tests "A1 G3" and "A4 G1" to
  "A7 G5"). The firewall of `swarm()` gives such a key no connection
  (point (b)). The store gate reads `db.writable`
  (`store/lib/bundle.js:915-923`), which is substrate state. So a key that
  a member admitted at the substrate alone passes it and does append. okf
  membership is a separate thing, and it is not retroactive. apply rejects
  every op of such a key and flags it ("What the substrate decides" points
  (a) and (d), G32).
- **Rate policy (§8):** a writer-local token bucket, enforced in apply. A
  writer earns tokens only from accepted indexer-authored ops, so a flooder
  cannot mint its own budget. The bucket meters admitted writers. An op
  that apply rejects earlier, such as `not-a-writer`, takes no token, so
  rejections themselves are unmetered (point (d) below, G32).
- **Append-only (§8):** the
  [append-only guarantee](GLOSSARY.md#append-only-guarantee) is a
  vault-metadata constant, fixed at init and unrepresentable as an op.
  There is no prune and no byte-destroying operation anywhere
  in the wire contract. `DeleteConcept` writes a tombstone; a write to a
  tombstoned concept lands and flags `flag/writeafterdelete`.
- **Path safety (§7):** paths are attacker-controlled. A path that escapes
  the bundle root or is absolute is rejected in apply; the generated-face
  names (`index`, `log`, casefolded) and the `.conflict-<hex>` pattern are
  reserved and cannot be squatted; casefold + NFC collision detection runs
  in apply on every peer, so no input makes two concepts share a file.
  Materialize re-checks lexical and realpath containment before any write.

Nothing is lost silently ([I4](GLOSSARY.md#invariant-i1i11)): every
rejected, superseded, or conflicting effect leaves a
[`flag/`](GLOSSARY.md#flag--flag-family) record.

## Trust boundaries and caveats

### The ingest boundary

Materialize never destroys human work. Reconciliation goes through an
emission manifest: a `.md` file whose current bytes materialize does not
recognize is never deleted or overwritten. It is left in place, reported as
pending-ingest, and the run exits nonzero (`--force-mirror` is the
operator override) (§9).

Ingest believes the disk, deliberately. An unknown `_id` is adopted — that
is the §10 generation contract — subject to the seen-id and mint-collision
rules; a file deleted on disk becomes `DeleteConcept` only behind a
confirmation guard, default on; edits to the generated `index.md`/`log.md`
are ignored.

This boundary is where okf's known defects were found, and that is
evidence, not coincidence. Both are repaired, and each repair has its
regression test:

- [#30](https://github.com/indexzero/hyperwiki2/issues/30) (**major**,
  repaired): a directory move through the live watcher lost data. `SetPath`
  on a tombstoned concept was a silent no-op, so the delete won. Three
  changes close it. A file on disk that bears a tombstoned `_id` is
  intent-to-keep, so ingest undeletes it before it moves it
  (`faces/lib/ingest.js:393-403`). A vanished path is never deleted from
  inside the event that noticed it: the delete waits for a quiet window, so
  the moved file's `SetPath` lands first (`:194-231`). A directory event
  schedules one coalesced rescan instead of being dropped (`:137-173`).
  Tests: `test/regressions/dirmove-dataloss.test.js` "#30(1)" to "#30(4)".
- [#28](https://github.com/indexzero/hyperwiki2/issues/28) (**minor**,
  repaired): a human-authored double `.conflict-` suffix became permanent
  pending-ingest. Ingest now strips every trailing reserved suffix
  (`faces/lib/ingest.js:374-382`). Test:
  `test/regressions/double-conflict-suffix-ingest.test.js` "P7 (#28)".

What remains at this boundary is a non-goal and not a defect. Subtree moves
do not exist in v1 (§7, §12). A directory "move" is N per-concept `SetPath`
ops with no atomicity claim, so an interrupted run leaves part of the
subtree moved. #30 was that gap observed from the disk side.

### What the substrate decides, and what okf decides

The substrate is autobee@2.12.1, pinned exactly, with autobee-wakeup@1.1.3
from the lockfile.
Every path reference below is a file and line of those releases, and every
test reference is a test name in `okf/test/`. The store configures autobee
with `optimistic: false`, `bootstrapWeight: 0` and `fastForward: false`,
and `HostAdapter` grants every writer at `weight: 0`
(`store/lib/bundle.js`).

The division of labour: the substrate decides which nodes reach apply and
in which order, and apply decides every effect on the view. An attack whose
mechanism sits inside the substrate has three dispositions. The
configuration keeps it out, okf's own code closes it, or this document
states it as a residual.

**(a) An outsider changes no view state.** An outsider is a key that
autobee has not added: no `AddWriter` op granted it, and no approval on a
folded node named it. Holding the vault key makes a peer an outsider, never
a writer. The reverse does not hold. A key that okf never admitted can
still be in autobee's writer set, because a member can put it there
(points (d) and (f)). Such a key is not an outsider. Point (d) measures
what its ops cost.

With `optimistic: false`, autobee drops every node of a writer it has not
added, before `_applyBatch` (`index.js:1357-1364`). A plain node of such a
writer stops earlier, in that writer's reader (`lib/writers.js:613-615`).
A node with the optimistic bit passes that check, as every outsider node
of the tests does (`test/attack-helpers.js` `outsiderAppend`). It enters
the pending buffer, and autobee resolves its weight
(`lib/writers.js:195`), with the witness read of G43, before the drop. A
dropped node's `approvals` add
nothing, because autobee reads approvals inside `_applyBatch`
(`index.js:1432-1441`), which the dropped node never reaches. Measured in
`test/store-substrate-attacks.test.js`: "A1 G3" (a forged approval that
names the sender), "A4 G1" (the stranger-driven livelock), "A5 G2" (an
approval at weight 1e9, in a child process), "A6 G43" (a forged witness
that cites a present writer length) and "A7 G5" (a backdated node that
links one side of a concurrent pair). Each one sends the forged node and
proves that every peer holds it. Then it shows four things on every peer.
No outsider node reaches apply, no `seen/` entry counts it, autobee records
no outsider key, and the view hash does not change.

**(b) The wakeup protocol (G44): the firewall keeps an outsider out, and
a member can still flood it.**

- The mechanism. A peer sends one wakeup announce of N keys that belong
  to nobody. A receiver hints every
  announced key (`autobee-wakeup/index.js:24-26`), and the drain turns each
  hint into an opened writer core (`index.js:807`, `:878-893`,
  `lib/writers.js:67-89`, `:239-294`).
- Only a peer with a replication connection reaches the protocol.
  `swarm()` connects only the swarm keys of its allowlist, on a private
  DHT and on the public DHT (`store/lib/bundle.js:1201-1205`). So an
  outsider that holds the vault key and the invite gets no connection.
  Test: `test/store-swarm.test.js` "a peer with the vault key and the
  invite, and a swarm key outside the allowlist, never connects (T25,
  G44)". A stream that a caller opens with `Bundle.replicate()` passes no
  firewall: the caller chooses the peer at the other end
  (`store/lib/bundle.js:60-63`). A member with a connection can send the
  announce.
- autobee's untrusted-writer cap does not bound it. The cap is skipped
  while the local writer is trusted (`lib/writers.js:262`), and with no
  `isTrusted` and no `mostRecentTrusted` hook every key is trusted
  (`lib/trusted.js:30-32`, `index.js:231-233`).
- The measured cost, test "A8 G44". The test connects the flooding peer
  with a direct stream, which passes no firewall. 200 announced keys open
  exactly 200 writer cores, which is past the default cap of 128
  (`lib/writers.js:13`). The vault grows on disk, and every sampled core is
  still in the store after a close and a reopen. Apply latency grows with
  the count, because every drain pass walks every active writer
  (`lib/writers.js:149-171`, called at `index.js:826`). The test records
  the ratio of 20 appends after the flood against 20 before it.
- The cost has no bound. The sender chooses N, and the cost grows with N.
  In "A8 G44", at N = 200, the vault still appends, reopens and folds. The
  suite measures no larger N, so this document claims nothing past that
  run.
- A second trigger needs no announce: a node whose links name keys that the
  receiver does not hold. The link check runs before the membership drop
  (`lib/writers.js:603-606` against `:613-615`). A witness link joins the
  link set (`:673-678`). The first missing link leaves a retained wait
  (`:706`), and every missing link is woken (`:719`). So one such node opens
  one core per missing link, and it leaves one wait per writer. The node
  itself reaches no apply while a link stays missing, so okf's rate check
  and its rejection flag never run for it. A member can send such a node.
  An outsider's node reaches the same check before the drop, on a
  connection that passes no firewall.
- **The suite does not measure that second trigger.** autobee's own local
  flush gate refuses to flush a node whose links are missing
  (`lib/writers.js:641-664`). A test attacker that appends through autobee
  therefore cannot publish that dependency graph. The gate binds a client
  that runs autobee's drain. It does not bind the log adversary of this
  document, which appends to the core it owns, as "A5c G2" does for G2
  (`test/attack-helpers.js` `forgeRawNode`).
- Only an attacker starts a flood, and an honest peer can pass it on. No
  okf code sends an announce, and no honest client invents writer keys. But
  autobee's wakeup answers a lookup with its active pending writers
  (`autobee-wakeup/index.js:18-22`, `:99-107`). That filter is `isPending`
  alone, never membership in the responder's own system. So a
  peer that already took the flood announces those same keys to the next
  peer that sends it a lookup. It does that after the attacker disconnects.
  The flood reaches one hop past the peers the attacker spoke to. The flood
  itself comes from a modified client, which the test writes itself
  (`test/attack-helpers.js` `announce`).
- A members-only `wakeupCapability` is **not adopted**. It is a
  constructor option that autobee reads at `index.js:543-547`, and the
  README does not list it, as it does not list `bootstrapWeight`. It
  would put a peer without the shared secret on another wakeup topic.
  The firewall of `swarm()` already gives an outsider no connection, and
  every member would hold the secret. So it would not bound the member
  trigger, which is the residual.

**(c) Ordering is uniform, and no honest peer approves.** Every writer
stands at weight 0, genesis included, so nodes sort by timestamp, then
writer key, then length (`lib/topo.js:168-179`). Three consequences, each
from the source:

- No peer collects an approval. `_collectApprovals` returns while standing
  is 0 or less (`index.js:1250-1255`), and standing is the writer's current
  weight (`index.js:1223-1226`, `lib/witness.js:8-12`).
- No writer climbs. A witness claim verifies only with an approver whose
  standing is at least the claimed weight (`lib/witness.js:33-51`), and
  genesis qualifies only up to `bootstrapWeight`, which the store sets to 0
  (`lib/witness.js:47`).
- So no resolved weight depends on a node's own position, which was the
  mechanism of the apply-loop livelock.

Measured in `test/store-writers.test.js` "every writer stands at weight 0
on every peer, and no honest node carries approvals or a witness", and in
`test/store-substrate-attacks.test.js` "A2 G4", "A3 G1", "G35" and "G50".
autobee's own `isIndexer` is therefore always false
(`lib/writers.js:352-354`). `Bundle.isIndexer` reads `gov/` instead
(`test/store-writers.test.js` "isIndexer answers from gov/").

**(d) What a member, or a key a member approves, can still do.** A member
is a key that autobee has added. Three paths add one, and okf never removes
a key again (G34 below):

- genesis, at `bootstrapWeight` 0.
- Every key that an `AddWriter` op granted, whatever apply decided about
  the op (point (f)).
- Every key that an approval on a folded node named, with no `AddWriter` op
  at all. autobee reads the approvals of a node inside `_applyBatch` and
  calls `system.addWriter` for each one (`index.js:1432-1441`,
  `lib/system.js:66-93`). Tests "A2 G4" and "G32" measure that path.

Every row below is open to any key in that set, with no okf membership
needed.

| Attack | Trigger | Effect, as measured | Evidence |
|---|---|---|---|
| G2, an approval at an unbounded weight | a member | every peer that folds the node walks one tier per unit of weight in `system.flush` (`lib/system.js:424`, `lib/promotions.js:132-144`). `_applyBatch` calls that flush after okf's apply has run (`index.js:1447-1455`, then `:1462`), and nothing that apply returns stops it. Above V8's `Set` limit that peer dies with `Set maximum size exceeded`, and it appends no more. Below the limit the cost stays on every peer for good. At weight 0 nobody approves (point (c)), so the pending promotion at weight W never clears (`lib/promotions.js:111-126`). Each flush writes a digest of W entries into the system info record (`lib/promotions.js:143-144`, `lib/system.js:449-460`, `:456`). Each later flush that carries a grant or a pending update walks the W tiers again (`lib/promotions.js:76-87`, `:132-144`). Every `AddWriter` grant is such a flush, because a host grant carries `pending` 0 (`lib/system.js:78`). The named key lands in the system of the peer that folds it, with no okf op | "A5c G2" (delivery proved first, then the victim), "A5b G2" (the sender arm, both weights). Both in a child process |
| G5, a node whose timestamp the attacker chooses | a member, a revoked member too | it reorders concurrent writes and picks the LWW winner on every peer. The reorder is uniform, so the peers still converge: a consistent rewrite, never a split. autobee bounds the future by two hours (`lib/writers.js:15`, `:595`, `:649`) and does not bound the past. A revoked member writes past its revocation the same way: a node stamped below the `RemoveWriter`, which does not link it, sorts before the removal, and its op takes effect with no `flag/rejected` entry (`core/lib/apply.js:399-403`, `lib/topo.js:168-179`, "The trust model" above) | "A7b G5" for the reorder. The revocation bypass: the cited lines. No test in this suite sends it |
| G32, unmetered growth through free identities | a member, or any key a member approves | one `flag/rejected` entry per op on every peer, no rate token (the op is rejected before the bucket), and no change in `c/`: the test compares the whole ordered `c/` range, keys and values, against the range before the attack, on every peer. Its `AddWriter` ops grant more autobee writers at weight 0, so the identity supply is free | "G32" |
| G34, a revoked member keeps its substrate standing | a revoked member | okf never calls `host.removeWriter`, so the key stays an autobee writer. Its ops that sort after the `RemoveWriter` reach apply and are rejected `revoked`, each with a flag (I4). Its ops that sort before the removal take effect (the G5 row): revocation stops cooperating clients only, until the next generation (decision 9). Its `AddWriter` ops still grant keys at the substrate, because the grant (`core/lib/apply.js:375`) comes before the revocation check (`:399-403`). A folded `RemoveWriter` takes its bound swarm key out of the allowlist of each peer that folds it: the key on its record, and for the creator the key that the invite binds (the eviction ladder). Calling `removeWriter` would be worse: `canApply` turns false for a removed writer (`lib/system.js:242-251`), so its node reaches the system of some peers and the apply of others, which is the split that point (f) exists to prevent | `test/store-writers.test.js` "writer add/remove round trip", "G32", and `test/store-swarm.test.js` "a removed writer's connection is destroyed when the removal folds, though the invite lists its key (T25)" and "a folded RemoveWriter of the creator cuts the creator's swarm key, which the invite binds to genesisKey, also after a reopen and on a fresh joiner (D-060 F01, D-061 R01)" |
| G43, a forged witness | a member. An outsider's node with the optimistic bit reaches the same read before the drop (point (a)), on a connection that passes no firewall | measured inert on the claimant's weight, because the claim never verifies at weight 0 (point (c)). The resolution is not free: autobee resolves the weight of a pending node before the drop (`lib/writers.js:195`), and again before apply (`index.js:1374`). A claim makes it open the cited core and read one block (`lib/witness.js:33-41`, `:53-62`). That read takes no rate token | "A3 G1" sends a member's forged witness, and the claimant stays at weight 0. "A6 G43" is the outsider arm: its node reaches no apply |
| G44, a node whose links are missing, and the wakeup flood of point (b) | a member. An outsider, a peer with the vault key and no admitted swarm key: **Close (T25)**, on a private DHT (`--bootstrap`) and on the public DHT (`--public-dht`). The firewall does not depend on the DHT. `swarm()` gives hyperswarm the same `keyPair` and `firewall` for both choices (`okf/store/lib/bundle.js:1201-1205`). The firewall admits only the keys of `metadata.swarm.allow`, the swarm keys of live `gov/writer` records and the keys of the peer's own local list (`swarm({ allow })`), minus the bound swarm key of every removed writer, the creator's key that the invite binds included (`:1213`, `:1305-1342`). So the outsider gets no connection and reaches neither trigger. A stream that a caller opens with `replicate()` passes no firewall (point (b)). The outsider costs a peer three things, on either DHT, and nothing else. First, the topic announcement: the outsider can look it up, and it names the swarm keys of the announcing peers and the DHT nodes that relay to them. Second, one handshake per attempt: hyperdht reads the first Noise message of each attempt before the firewall rejects it (hyperdht `lib/server.js:242-262`). Third, a bounded ban table: hyperswarm bans each rejected key and keeps its record in `swarm.peers` (hyperswarm `index.js:315-319`, `:418-424`, `lib/peer-info.js:113-115`). The store keeps at most 64 such records and lifts the oldest ban past that bound (`MAX_BANNED_PEERS`, `bundle.js:137`, `_recordBan` at `:1389`). The firewall still rejects a key whose ban was lifted, at its next attempt. Test: `test/store-swarm.test.js` "a flood of fresh swarm keys leaves at most 64 ban records, and the firewall still rejects every key (G3-P9 F02)" | the receiver opens one writer core per missing link and keeps one retained wait, before the membership drop (`lib/writers.js:603-606`, `:673-678`, `:706`, `:719` against `:613-615`). The node reaches no apply while a link stays missing, so it takes no rate token and leaves no flag | point (b), which also states why the suite does not measure the member trigger. The outsider: `test/store-swarm.test.js` "a peer with the vault key and the invite, and a swarm key outside the allowlist, never connects (T25, G44)". The test runs on a private testnet, and the same code runs on the public DHT |

Two notes on the G2 row. First, the sender's own cost is not a bound on the
attack. autobee folds a local node (`index.js:818`) before the drain
flushes it to the core (`:824`). So at weight 1e9 a sender that appends
through autobee dies before its node leaves its core. That is "A5b G2". A
client that writes the oplog block to the core it owns skips that order.
Its block is durable at once, and it replicates. "A5c G2" measures that
arm. It proves delivery to a victim on stock autobee first. The victim then
dies folding the approval, and it appends no more. The reopen is no repair.
In one measured branch the boot drain folds the stored block again, and the
peer dies inside `Bundle.open` (`index.js:620`, then `:818`). In the other
the peer reopens with the attack core still in its store.

Second, a member needs no forged node for the substrate part of G32. One
`AddWriter` op adds the named key to every peer's autobee system, whatever
apply decides about the op (point (f)).

**(e) okf cannot close those without changing autobee.** Each mechanism in
the table runs before or outside okf's apply:

- weights resolve in `prepareBatch` and in `nextPendingNode`
  (`index.js:1374`, `lib/writers.js:195`), before any node reaches apply.
- A node enters the system, and its approvals apply, in `_applyBatch`
  before `apply` runs (`index.js:1430-1455`).
- A wakeup announce opens cores in the drain (`index.js:807`, `:878-893`),
  with no node and no op involved.
- autobee sorts each node by its timestamp before apply sees it
  (`lib/topo.js:168-179`). apply folds in that order, so it cannot reject
  an op of a revoked member that sorts before the `RemoveWriter`
  (`core/lib/apply.js:399-403`).

apply has no veto over any of it. autobee executes an approval, resolves a
witness and takes a timestamp, all before apply runs. It offers the
application no hook to undo that work. The approval is already in the
system when apply starts, and nothing apply returns puts it back.

apply does SEE those fields. autobee hands the original node objects of the
batch to the application, every node that carries a value
(`index.js:1444`), and it projects nothing away. The store forwards them
unwrapped (`store/lib/bundle.js:508-510`). So an approval, a witness and a
timestamp are visible and inert, which is a lack of control and not a lack
of visibility. A wakeup hint reaches apply in no form at all, as the last
bullet above states.

okf's product code uses autobee's constructor options,
its documented instance API and the host API passed to apply, and nothing
else, so the remedy for every row above is a change inside autobee. The
owner accepted these residuals: a vault trusts its members for the life
of a generation (decision 1, decision 9), and G44 with the cost in point
(b).

**(f) An autobee grant follows every `AddWriter` op, and okf membership
comes only from `gov/`.** apply calls `host.addWriter(key, { weight: 0 })`
for every `AddWriter` op it folds, whether it accepts or rejects the op,
right after a successful decode and before every check that can reject it
(§8).

- Why: those checks read the op's linearized position, and a reorder can
  flip their outcome. The grant reads the op bytes alone, so every peer
  makes it in every order, and no reorder undoes it. Without the rule, a
  grant that a concurrent revocation undid left the writer's consumed node
  in the system of some peers and not in others. The mechanism has three
  steps. The undone tip goes back on the batch stack without the drop
  filter (`index.js:1405-1408`). The system records the node before
  `canApply` decides (`index.js:1430` against `:1447`). The stale record
  then lets that writer's next node through on those peers alone
  (`lib/writers.js:526-533`, `lib/system.js:249-250`), and the views split
  for good. Test:
  `test/store-governance-race.test.js` "G9b: the governance race converges,
  and every op of the race writer leaves a flag (I2, I3, I4)".
- The cost: a granted key with no `gov/writer` record reaches apply on
  every peer, and every op of it is rejected with a flag. That is the G32
  row of the table, and nothing silent (I4).
- The limit: only a 32-byte key is granted, and always at weight 0, never
  at autobee's `isIndexer ? 2 : 1` default (`lib/apply-calls.js:33`).
- okf membership is `gov/` alone. A weight, an approval, an autobee system
  record and a writable local writer confer none of it. The tests "A1 G3",
  "A2 G4" and "G32" read `gov/writer/<key>` next to the substrate state, so
  the two cannot be confused.

### The generation chain is provenance, not proof

A generation is an operator act via the face, never an op (§10):
`materialize`, then `auto-okf import` into a new directory. The new vault
records `predecessorKey` in its metadata, from `--predecessor`
(`faces/lib/import.js`, `carriedMetadata`).

**That record is the operator's claim.** No signature and no record of the
predecessor's state exist: import opens no predecessor vault, and the
operator gives the key.
Nothing in okf checks it against a vault. So the chain is a recorded
claim, and not an attestation.

Consumers MUST treat cross-generation identity as trusted-operator scope.
Within one generation, identity is checked by apply. Across generations,
you are trusting the operator who ran the import, and you have only the
bytes of the face that the import read.

History is shed by design: old revisions, per-op attribution, and clocks
do not survive a generation. [I11](GLOSSARY.md#invariant-i1i11) is the
counterpart guarantee: every live concept's `_id`, type, fields, tags,
path, and head body survive byte-for-byte. materialize reports every
value that the face cannot hold, and the operator fixes those values
before import (§10). import refuses a face that holds a conflicted copy,
so an open path collision is resolved in the face before a generation.

### Privacy

The privacy boundary is the vault: one shared `encryptionKey` end to end
(§8). There are no per-writer read ACLs; a vault's readership is its key's
holdership.

## Guaranteed versus best-effort

Measured. [I1–I11](GLOSSARY.md#invariant-i1i11) each map to at least one
test. The multi-process fault harness runs its scenario matrix at three
fault profiles: `pnpm test:okf-harness:clean`, `:lossy` and
`:partitioned`. On autobee 2.12.1 each profile passes, and every scenario
asserts convergence. Its S8 revocation scenario converges where
vault-ld's analogous B1 run originally diverged. The generation roundtrip
(I11, S9) is an acceptance criterion (§14). No harness writer chooses
the timestamp of a node (`okf/harness/` holds no such code), so the
harness does not show the revocation bypass of the trust model.

Best-effort, and open. **C1** (**major**, awaiting sign-off): under a
22-minute sustained lossy multi-writer flood with backpressure on, RSS grew
from ~85 MB to ~3.1 GB with no plateau, and a third peer failed to converge
within the 5-minute heal window. These figures come from the v1 milestone
of 2026-07-14 ([DELIVERY.md](DELIVERY.md)), on the substrate release of
that milestone. This document states no figure for autobee 2.12.1. What
that run verified is liveness and throughput degrading. What it did not touch is determinism: caught-up peers
stayed byte-identical under every seed, file descriptors stayed flat,
nothing crashed. Per the glossary's [severity](GLOSSARY.md#severity)
definition that is a major, not a blocker — a scale concern, no invariant
falsified. Tracked in `orchestration/BACKLOG.md`; repro:
`node okf/harness/soak/soak.js`.

C1 is the only open item in this class. The ingest defects above are
repaired, and the regression test of each repair is named there.

## Non-goals (v1)

From §12, the security-relevant ones: no per-key merge policy, no
subtree-move atomicity, no text CRDT for bodies, no HTTP API. And from the
privacy boundary above: no read ACLs finer than the vault. The missing
subtree-move atomicity is what #30 observed from the disk side. The
data-loss failure of #30 is repaired, as the ingest boundary above states.
