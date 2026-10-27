# auto-okf security model

This is the trust story for auto-okf: who the adversaries are, which
defenses stand between them and the [view](GLOSSARY.md#view), and where the
guarantees stop. Terms are pinned in [GLOSSARY.md](GLOSSARY.md). Spec §
references cite [SPEC.md](SPEC.md).

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
  `RemoveWriter` that would leave zero indexers is rejected: a vault cannot
  become permanently ungovernable.
- **Causal revocation (§8):** after `RemoveWriter`, an op from the removed
  writer applies only if its clock strictly precedes the revocation. The
  claimed clock is cross-checked against unforgeable position. The actual
  seq of a node is its position in its writer's core (§3). Any node past
  the recorded `seqAtRemoval` is rejected regardless of its claim, and an
  op whose self-clock entry disagrees with that position is rejected as
  `forged-clock`.
- **Admission before effect (§8):** a writer's ops take effect only once an
  indexer-authored `AddWriter` has admitted it, at that op's linearized
  position. An op from a writer with no `gov/writer` record is rejected
  `not-a-writer`. It never reaches the content pipeline and changes no `c/`
  key. There is no hold buffer and no optimistic onboarding. A joiner that
  only holds the vault key writes nothing at all. The store refuses every
  append until autobee reports the local writer writable
  (`VAULT_NOT_WRITABLE`, test `test/store-writers.test.js` "an append from
  a writer that is not writable fails fast"). That gate reads `db.writable`
  (`store/lib/bundle.js:734-747`), which is substrate state. So a key that
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
  There is no prune, no compaction, no byte-destroying operation anywhere
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

This boundary is where okf's known defects live, and that is evidence, not
coincidence:

- [#30](https://github.com/indexzero/hyperwiki2/issues/30) (**major**,
  open): a directory move through the live watcher loses data. `SetPath` on
  a tombstoned concept is a silent no-op, so the delete wins. Subtree moves
  do not exist in v1 (§7): a directory "move" is N per-concept `SetPath`
  ops with no atomicity claim, and #30 is that gap observed from the disk
  side.
- [#28](https://github.com/indexzero/hyperwiki2/issues/28) (**minor**): a
  human-authored double `.conflict-` suffix becomes permanent
  pending-ingest.

### What the substrate decides, and what okf decides

The substrate is autobee@2.12.1 with autobee-wakeup@1.1.3, both pinned.
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
added, before `_applyBatch` (`index.js:1357-1364`), and that writer's own
reader stops earlier (`lib/writers.js:613-615`). A dropped node's
`approvals` add
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

**(b) An outsider still reaches the wakeup protocol (G44, accepted).** The
configuration does not close this one, and the owner accepted it as a
residual for every vault.

- The trigger is possession of the vault key. An outsider sends one wakeup
  announce of N keys that belong to nobody. A receiver hints every
  announced key (`autobee-wakeup/index.js:24-26`), and the drain turns each
  hint into an opened writer core (`index.js:807`, `:878-893`,
  `lib/writers.js:67-89`, `:239-294`).
- autobee's untrusted-writer cap does not bound it. The cap is skipped
  while the local writer is trusted (`lib/writers.js:262`), and with no
  `isTrusted` and no `mostRecentTrusted` hook every key is trusted
  (`lib/trusted.js:30-32`, `index.js:231-233`).
- The measured cost, test "A8 G44": 200 announced keys open exactly 200
  writer cores, which is past the default cap of 128
  (`lib/writers.js:13`). The vault grows on disk, and every sampled core is
  still in the store after a close and a reopen. Apply latency grows with
  the count, because every drain pass walks every active writer
  (`lib/writers.js:149-171`, called at `index.js:826`). The test records
  the ratio of 20 appends after the flood against 20 before it.
- It is a cost, never a brick. In "A8 G44" the vault still appends, and it
  still reopens and folds.
- A second trigger needs no announce: a node whose links name keys that the
  receiver does not hold. The link check runs before the membership drop
  (`lib/writers.js:603-606` against `:613-615`). A witness link joins the
  link set (`:673-678`). The first missing link leaves a retained wait
  (`:706`), and every missing link is woken (`:719`). So one such node opens
  one core per missing link, and it leaves one wait per writer. The node
  itself reaches no apply while a link stays missing, so okf's rate check
  and its rejection flag never run for it. A member can send such a node,
  and an outsider's node reaches the same check before the drop.
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
- **Public-swarm caveat.** `Bundle.swarm()` and `auto-okf watch --swarm`
  announce the vault on the public hyperswarm DHT, so any peer that learns
  the vault key can connect from anywhere and reach the wakeup protocol.
  An operator that never joins the swarm, and that replicates over streams
  it opens itself (`Bundle.replicate()`), limits the trigger to the peers
  it connects to.
- The mitigation that was measured is **not adopted**: a members-only
  `wakeupCapability` (`index.js:543-547`) puts an outsider on a different
  wakeup topic, so its announce reaches no member. It needs a shared
  secret that an outsider lacks, which a public vault does not have, and
  the option is outside autobee's documented surface.

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
| G2, an approval at an unbounded weight | a member | every peer that folds the node walks one tier per unit of weight (`lib/system.js:424`, `lib/promotions.js:137`, `:144`), inside `_applyBatch` and before any okf apply (`index.js:1432-1441`, `:1462`). Above V8's `Set` limit that peer dies with `Set maximum size exceeded`, and it appends no more. Below the limit every peer pays the walk, and the named key lands in the system of the peer that folds it, with no okf op | "A5c G2" (delivery proved first, then the victim), "A5b G2" (the sender arm, both weights). Both in a child process |
| G5, a node whose timestamp the attacker chooses | a member | it reorders concurrent writes and picks the LWW winner on every peer. The reorder is uniform, so the peers still converge: a consistent rewrite, never a split. autobee bounds the future by two hours (`lib/writers.js:15`, `:595`, `:649`) and does not bound the past | "A7b G5" |
| G32, unmetered growth through free identities | a member, or any key a member approves | one `flag/rejected` entry per op on every peer, no rate token (the op is rejected before the bucket), and no change in `c/`: the test compares the whole ordered `c/` range, keys and values, against the range before the attack, on every peer. Its `AddWriter` ops grant more autobee writers at weight 0, so the identity supply is free | "G32" |
| G34, a revoked member keeps its substrate standing | a revoked member | okf never calls `host.removeWriter`, so the key stays an autobee writer. Its later ops keep reaching apply and keep being rejected, each with a flag (I4). Calling `removeWriter` would be worse: `canApply` turns false for a removed writer (`lib/system.js:242-251`), so its node reaches the system of some peers and the apply of others, which is the split that point (f) exists to prevent | `test/store-writers.test.js` "writer add/remove round trip", "G32" |
| G43, a forged witness | a member | measured inert on the claimant's weight, because the claim never verifies at weight 0 (point (c)). The resolution is not free: autobee resolves a node's weight before any drop (`index.js:1374`, `lib/writers.js:195`), and a claim makes it open the cited core and read one block (`lib/witness.js:33-41`, `:53-62`). That read takes no rate token | "A2 G4", "G50", "A6 G43" |
| G44, a node whose links are missing | a member, and an outsider's node reaches the same check | the receiver opens one writer core per missing link and keeps one retained wait, before the membership drop (`lib/writers.js:603-606`, `:673-678`, `:706`, `:719` against `:613-615`). The node reaches no apply while a link stays missing, so it takes no rate token and leaves no flag | point (b), which also states why the suite does not measure this trigger |

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

apply has no veto over any of it. autobee executes an approval, resolves a
witness and takes a timestamp, all before apply runs. It offers the
application no hook to undo that work. The approval is already in the
system when apply starts, and nothing apply returns puts it back.

apply does SEE those fields. autobee hands the original node objects of the
batch to the application, every node that carries a value
(`index.js:1444`), and it projects nothing away. The store forwards them
unwrapped (`store/lib/bundle.js:357-366`). So an approval, a witness and a
timestamp are visible and inert, which is a lack of control and not a lack
of visibility. A wakeup hint reaches apply in no form at all, as the last
bullet above states.

okf's product code uses autobee's constructor options,
its documented instance API and the host API passed to apply, and nothing
else, so the remedy for every row above is a change inside autobee. The
owner accepted these residuals: a vault trusts its members with liveness,
and G44 with the cost in point (b).

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

Compaction is an operator act via the hydrated face, never an op (§10).
The new vault records `{ predecessorKey, predecessorCheckpoint }`, signed
by the operator key that ran compact; consumers MUST treat cross-generation
identity as trusted-operator scope. Within one generation, identity is checked
by apply. Across generations, you are trusting the operator.

History is shed by design: old revisions, per-op attribution, and clocks
do not survive a cycle. [I11](GLOSSARY.md#invariant-i1i11) is the
counterpart guarantee: every live concept's `_id`, type, fields, tags,
path, and head body survive byte-for-byte. Compact refuses to run over
open `flag/conflict` or `flag/pathcollision` without `--force`, and a
forced run must enumerate every conflicted copy it carries across.

### Privacy

The privacy boundary is the vault: one shared `encryptionKey` end to end
(§8). There are no per-writer read ACLs; a vault's readership is its key's
holdership.

## Guaranteed versus best-effort

Measured. [I1–I11](GLOSSARY.md#invariant-i1i11) each map to at least one
test; the multi-process fault harness runs the full scenario matrix at
three fault profiles (clean, lossy, partitioned) with no divergence, and
its S8 revocation scenario converges where vault-ld's analogous B1 run
originally diverged; the generation roundtrip (I11) is an acceptance criterion
(§14).

Best-effort, and open. **C1** (**major**, awaiting sign-off): under a
22-minute sustained lossy multi-writer flood with backpressure on, RSS grew
from ~85 MB to ~3.1 GB with no plateau, and a third peer failed to converge
within the 5-minute heal window. What that run verified is liveness and
throughput degrading. What it did not touch is determinism: caught-up peers
stayed byte-identical under every seed, file descriptors stayed flat,
nothing crashed. Per the glossary's [severity](GLOSSARY.md#severity)
definition that is a major, not a blocker — a scale concern, no invariant
falsified. Tracked in `orchestration/BACKLOG.md`; repro:
`node okf/harness/soak/soak.js`.

#30 above sits in the same class: measured data loss at the ingest
boundary, no hash divergence. A major, documented here until dispositioned.

## Non-goals (v1)

From §12, the security-relevant ones: no per-key merge policy, no
subtree-move atomicity (the #30 gap), no text CRDT for bodies, no HTTP
API. And from the privacy boundary above: no read ACLs finer than the
vault.
