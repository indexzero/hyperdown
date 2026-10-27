## okf (auto-okf) deviations — okf/SPEC.md v1.2

**okf §5 `revHash` length prefix: copied code wins (u64 BE, not u32 LE).**
okf SPEC §5 describes `len()` as "u32 LE", but the same sentence pins the
resolution: "this normative text mirrors the copied code; on discrepancy
the copied code wins and DEVIATIONS.md records it." The copied
`vault-ld/core/lib/revhash.js` (provenance header in
`okf/core/lib/revhash.js`) uses an 8-byte big-endian length prefix over the
64-char lowercase-hex base string (empty for null). That formula is
byte-identical between the two stacks, which is exactly what the copy rule
exists to preserve; the u32-LE prose in §5 is the deviation being recorded.

**okf §10 generation namespace derivation (spec-silent detail).** §10
requires writer cores namespaced per generation and "recorded in vault
metadata" but not HOW the id is minted. The store derives it purely:
`generation = 'root'` when the chain fields are null, else
`sha256(predecessorKey bytes || stableStringify(predecessorCheckpoint))`
— so every peer of one vault computes the same namespace from the same
pinned metadata, a joiner reconstructs it from the invite's chain fields
alone, and a reused corestore directory still yields fresh writer keypairs
across generations. Recorded as `metadata.generation` and validated
against the chain fields at every load.

---

## @auto-okf/faces (T5)

**okf §9 conflicted-copy hash-collision extension is applied per-value,
order-independently.** §7 says two path-collision losers whose `_id` hashes
share the first 8 hex "extend to the full 64-hex hash, and an occupied
fallback extends the same way." Rather than probe-and-extend (order
dependent), materialize groups losers by path, counts how many share each
8-hex prefix, and any prefix shared by more than one loser makes *all* its
members emit the full 64-hex suffix. Distinct `_id`s never collide on the
full hash, so no further probing is possible or needed; the result is a pure
function of the loser set (I9). The `.conflict-<hex8+>` component is reserved
in apply, so no live concept can hold a conflict path and only loser-vs-loser
collisions are reachable.

**okf §9 `flag/copydetect` audit record is not emitted by ingest (no core
op writes it).** §9 says a copy-split records `flag/copydetect/<new-id>/
<original-id>`. The view is written only by core's apply folding ops, and the
12-op wire contract has no op that writes a `copydetect` flag (apply never
references the family). Faces therefore surfaces copy detection as its
observable effect — the copy is minted as a fresh `CreateConcept` (no `id`)
at its path, and a `'copy'` event is emitted on the watcher — but writes no
`flag/copydetect` row. Recording the flag would require a new core op
(out of T5 scope; core is imported unmodified). The identity outcome (copy
gets a fresh `_id`, original keeps its path) is exactly as specified.

**okf §9 minted `_id` write-back is deferred to the next materialize, not
written into the human file by the watcher.** §9 says a file with a missing
`_id` mints "and writes back into the file." Instead of the watcher rewriting
the just-read file (an echo hazard mid-settle), ingest records the ingested
bytes' hash in the emission manifest; the concept now exists in the view at
that path, so the next `materialize` regenerates the file with the
deterministic minted `_id`/`_rev` stamped in (its bytes already match the
manifest, so the overwrite is permitted, not blocked as pending-ingest).
Net effect is identical — the file ends up carrying its `_id` — with one
fewer write and no watcher/echo coupling. A minted id is taken to be the
create op's tag (`writerKey‖seq`); under the §6 squat fallback the true id
would differ, but that requires an adversary pre-occupying the tag id and is
unreachable through ordinary ingest.

**okf §9 materialize path-safety violations are reported, never written to
the view.** §7 notes a materialize-time containment violation "is reported on
the CLI only." Faces re-checks lexical + realpath containment before every
write (atomic temp+fsync+rename in the target's real parent) and collects any
violation in `report.unsafe`; it never writes a `flag/` row (materialize
never writes the view, §7). Same resolution as vault-ld §9.4.

**okf §9 deletion of a conflicted-copy face is a no-op, not a
`DeleteConcept`.** A conflicted copy is a transient materialized face, not the
concept's canonical location; removing it on disk would otherwise delete a
live concept that the next materialize immediately re-emits. The watcher
therefore skips `DeleteConcept` for any file whose terminal matches
`.conflict-<hex8+>` (emitting `'delete-skipped'` with reason
`conflict-copy`), consistent with "deletion is dangerous." Deleting the
winner's canonical file still deletes the concept behind the confirmation
guard.

---

## okf §10 — generation-cycle compaction (T6)

**okf §10 generation `log/` entry is a filesystem artifact, not a view
`log/` record.** §10 requires compact to "record a generation entry in the
new vault's `log/`." The view's `log/<ordinal>` family is written only by
`apply` from ops, and §3's wire contract is append-only with NO generation
op (and none may be added — core is a fixed built interface here). compact
therefore writes the generation entry as a durable JSON artifact at
`<vaultDir>/log/generation.json` (`{ kind:'generation', generation,
predecessorKey, predecessorCheckpoint, conflictCopies, at, note }`). This
satisfies "an entry in the new vault's `log/`" literally; the entry does
NOT appear in the regenerated `log.md` (which re-derives from the view —
§14 excludes `log.md` from I11 fidelity anyway).

**okf §10 compaction stages a manifest-free, `_rev`-stripped copy for ingest.**
Two facts about the built faces make a naive "materialize `toDir`, then ingest
`toDir`" impossible, both proven under `sslop/033` probes:
(1) `materialize` writes its emission manifest (`.okf-manifest.json`) into the
bundle dir; the ingest watcher reads that manifest and skips every file as a
self-echo — so ingesting `toDir` in place yields ZERO ops. (2) A materialized
`_rev` is the base an ingest `SetBody` cites (§6); in a fresh vault that base
does not exist, so the head is flagged `flag/conflict/<id>/-/<new>` and the
concept materializes BODYLESS. compact therefore copies each concept note into
a staging dir (default `<vaultDir>.compact-src`, a SIBLING of `vaultDir` —
`new Corestore(vaultDir)` clears the vault dir on init, so a nested staging
dir would be wiped before ingest reads it) with its `_rev` line stripped. Each
head then re-roots at `base:null` — the only flag-free fresh start (§5) — so
the body survives and `_rev` re-derives (§14: a former edit's revHash changes,
the body text does not). Once a bundle has cycled once, every body is already
`base:null`, so further cycles preserve even `_rev`.

**okf §10 `compact` injects the `@auto-okf/store` `Bundle.init` rather than
importing it.** Consistent with the rest of `@auto-okf/faces` ("the substrate
is injected — nothing here imports the substrate"), `compact(vault, opts)`
takes `opts.initBundle` (the store factory) instead of adding a hard
`@auto-okf/store` dependency to the faces package. The CLI (`okf/cli`) wires
the two together. The predecessor is never deleted by compact — its path is
returned for the operator to archive/destroy out-of-band (§10 step 5).

**okf §10 `--force` conflict-copy enumeration lists `from === to`.** Because
`_id` and path both survive the cycle and the conflict suffix is
`first-8-hex(SHA-256(_id))` (§7), a carried-across conflicted copy re-manifests
at the SAME path in the new vault. The enumeration in `log/generation.json`
therefore records `{ from, to }` with `from === to` (deterministic
identity-preserving carry-across, §9 conflict-copy awareness); it is truthful
(the `from` list is the actual on-disk conflict files of the materialized
predecessor bundle).

---

## Substrate behaviour that okf relies on (autobee@2.12.1)

This section goes with `SPEC.md` §1. Each entry names a behaviour
of autobee@2.12.1 that okf relies on, the okf rule that needs it, and the
installed source. A path such as `index.js:95` is relative to the autobee
package root. A citation of another package names it. The lockfile
resolves autobee 2.12.1, corestore 7.16.1, hypercore 11.39.2 and hyperbee2
2.20.1. If a later release changes one of these behaviours, the rule that
the entry names breaks. Each entry names the tests that cover it. okf
reads no undocumented autobee property (test: "the store, core, faces and
cli read no undocumented autobee property" in
`okf/test/store-ordinal.test.js`). Where an entry relies on a part of
autobee that the README does not document, it says so.

**The pins, and the corestore floor.** `okf/store/package.json` pins
`autobee` `^2.12.1` and `corestore` `^7.16.1`. autobee lists corestore
only as a dev dependency (`package.json`), and the store hands it a
corestore session.
autobee asks for its system and view cores at manifest version 3
(`index.js:213-221`, `lib/constants.js:3`). corestore honours a per-core
`manifestVersion` from 7.12.6 on (upstream commit `d109402a`, "support
passing manifestVersion and name"). In 7.16.1 the option reaches the
manifest through `_preload` and `_auth` (corestore `index.js:673-682`,
`:714`). Up to 7.12.5, corestore builds every new manifest at the
store-wide version (corestore 7.12.5 `index.js:670`), which is 1 by
default (corestore `index.js:258`). autobee's view encryption refuses a
view core below version 3 (`lib/encryption.js:83-86`). So 7.12.6 is the
floor, and the pin `^7.16.1` is above it. Test:
`okf/test/store-encryption.test.js`.

**The apply contract.** autobee calls `apply(nodes, view, host)`
(`README.md:74`, `:185-208`, `lib/apply-view.js:17-19`). `view` is what
the `open` handler returns (`README.md:75`, `lib/apply-view.js:8-10`).
autobee opens both its working view and `db.view` through that handler
(`index.js:93-94`, `:127-128`). So apply and every read use the same
`ViewAdapter` surface. A node has `key`, `value` and `length`
(`README.md:192-194`), plus the other fields of `createNode`
(`lib/writers.js:808-829`). Core takes the nodes unwrapped. A throw from
apply closes autobee (`README.md:140-141`, `index.js:669-690`). So core
records a failed op as a rejection. Only a node that breaks the transport
contract throws (SPEC §3).

**`optimistic: false`: a node of a writer that autobee has not added
reaches no apply.** autobee reads the option at `index.js:95`. The default
is `true` (`README.md:81`). With `false`, autobee processes a batch only
when its writer is added (`index.js:1357-1364`). The one exception is a
removed writer that a pending node of another writer links
(`lib/writers.js:382-388`). okf never calls `host.removeWriter` (below).
autobee drops every other batch before `_applyBatch`. So the batch reaches
no apply, its approvals add no writer (`index.js:1432-1441`), and the
system records nothing. A plain node of such a writer stops earlier, in
`Writer._next` (`lib/writers.js:613-615`). SPEC §8 needs this: an
outsider puts no op and no approval into apply. autobee still reads such a
node and checks its links before the drop (`lib/writers.js:547-618`). The
wakeup cost of an outsider is G44 in `SECURITY_MODEL.md`. Tests: `A4` to
`A7` in `okf/test/store-substrate-attacks.test.js`.

**`bootstrapWeight: 0` and grants at weight 0: every writer stands at
weight 0.** `bootstrapWeight` is a constructor option that autobee reads
at `index.js:49`, with a default of 2. The README does not list it.
autobee adds the bootstrap writer on its first node at this weight
(`index.js:1411-1413`). okf makes every other grant with
`host.addWriter(key, { weight: 0 })`. The README lists only `isIndexer`
for that call (`README.md:210-218`). The `weight` option is at
`lib/apply-calls.js:33`, with the default `isIndexer ? 2 : 1`. Weight 0
gives okf these results:

- A grant at weight 0 changes no weight. The carrier node is at 0, so the
  effective weight is 0, and it is not above the current ceiling
  (`lib/system.js:75-88`). The grant writes no promotion request, because
  the wanted weight 0 is not above the anchored weight
  (`lib/promotions.js:111-113`).
- Nodes sort by weight, then timestamp, then writer key, then length
  (`lib/topo.js:168-179`). Every weight is 0, so nodes sort by timestamp,
  then key. This is the uniform weight of SPEC §8.
- No honest peer approves. An append collects approvals only when the
  standing of its writer is above 0 (`index.js:1250-1255`). The standing is
  the current weight of the writer (`index.js:1223-1226`,
  `lib/witness.js:8-12`).
- No honest node cites a witness. An append cites one only when the grant
  hint of its writer is above its current weight (`index.js:1546-1553`). A
  host grant sets no hint (`lib/system.js:76-77`).
- No writer climbs. A witness raises a weight only when the approver
  stands at the claimed weight or above (`lib/witness.js:19-51`). Genesis
  qualifies only up to `bootstrapWeight` (`lib/witness.js:46-47`).
- autobee's `isIndexer` is always false. It means a ceiling of 2 or more
  (`index.js:188-190`, `lib/writers.js:352-354`, `:531-532`). So
  `Bundle.isIndexer` reads `gov/`.

A member can still forge a node with approvals. autobee then adds each
named key at weight 0, because the weight of the carrier caps the grant
(`index.js:1432-1441`, `lib/system.js:75`). `SECURITY_MODEL.md` lists this
residual. Tests: "every writer stands at weight 0 on every peer" in
`okf/test/store-writers.test.js`, and `G35` and `G50` in
`okf/test/store-substrate-attacks.test.js`.

**The grant at every `AddWriter` op (AD7).** Core grants the key of every
`AddWriter` op that it folds, at weight 0, whatever the outcome of the op
(SPEC §8). This relies on four behaviours:

- The grant records the key as an added writer in the system. After the
  flush, every peer adds the writer (`index.js:1462`, `:1474-1477`).
- The nodes of a granted key pass the filter at `index.js:1359`. That
  filter reads `isAdded` from the system record (`lib/writers.js:526-533`).
  They also pass `canApply` (`lib/system.js:242-251`). So they reach apply
  on every peer. Core rejects each op of a key with no `gov/writer`
  record. A content op that passes the earlier checks is rejected
  `not-a-writer` (`okf/core/lib/apply.js:426`). A governance op is
  rejected `policy-governance`, because the indexer-issuer check comes
  first (`okf/core/lib/apply.js:407-412`).
- After an undo, autobee applies the batches again (`index.js:1386-1392`,
  `:1405-1408`), so core grants again. A repeated grant changes no weight.
  It only records the writer as added again (`lib/system.js:80-88`).
- autobee copies a writer key into a fixed 34-byte system key
  (`lib/encoding.js:64-69`). So core grants only a 32-byte key.

Test: `okf/test/store-governance-race.test.js`.

**The `update` handler.** The constructor option `update (view, changes)`
is in the README (`README.md:77`). autobee calls it after apply, once
`db.view` holds the new state (`index.js:793-794`, `:840`,
`:1051-1058`). The Bundle refreshes `isIndexer` from `gov/` there, and once
at open. Test: "isIndexer answers from gov/" in
`okf/test/store-writers.test.js`.

**`fastForward: false`: every peer folds every op through its own apply.**
autobee reads the option at `index.js:105-108`. The README shows only an
object value (`README.md:86`). The source comment at `index.js:105`
states what `false` does. A fast-forward moves the system and the view
onto a head that another writer stamped, with no apply for that prefix
(`README.md:243-245`, `index.js:1722-1736`). With `false`, autobee boots
from no head (`index.js:111`), runs no network boot (`index.js:601-604`),
and queues no fast-forward from a wakeup hint (`index.js:922-923`). okf
never calls `moveTo` (`index.js:1607-1618`). I2 and I3 need this. Test: "a
joiner folds every op through its own apply" in
`okf/test/store-convergence.test.js`.

**The position is the per-writer ordinal (AD4).** The README documents
`node.length` as the "position in the writer's core" (`README.md:194`).
autobee sets it to the length of the core after the node. For a block
that it reads from the core, that is `lib/writers.js:571-579`. For a local
node, it is `appendLength`, which starts at the core length plus one
(`lib/writers.js:332`, `:748`). So the 0-based position is
`node.length - 1`, the same on every peer. Every node of a batch enters
the system (`index.js:1430`). Apply gets only the nodes with a non-empty
value (`index.js:1444`). So an empty node takes a position and reaches no
apply, and the seqs of the ops of a writer can have gaps (SPEC §3). Tests:
the position tests in `okf/test/store-ordinal.test.js`, and
`okf/test/store-restart.test.js`.

**The length of the local core gives the next position.** The store takes
the seq of a new op from `db.local` before it encodes the op. The README
documents `db.local` as the local writer Hypercore (`README.md:102-104`).
The local writer appends through that core (`index.js:257`,
`lib/writers.js:19`, `:37`, `:785`). Three behaviours hold the rule:

- The Bundle serializes its appends. A plain `db.append` resolves with the
  drain that applies its node and writes it to the core (`index.js:1575`,
  `:634-646`, `:824`, `lib/writers.js:137-147`, `:768-789`). So the length
  counts every earlier node, unless a node waits.
- A local node that links a node missing from the system waits in memory
  (`lib/writers.js:651`). Then the length is behind, and the store takes
  one past the seq of its last append.
- autobee appends no other local node in this configuration. Its only
  other local append is the empty ack (`index.js:1297-1314`). The
  threshold ack needs a system head that is not trusted
  (`index.js:1303-1305`, `:1316-1330`). okf passes no `isTrusted` and no
  `mostRecentTrusted` hook, so every key is trusted (`lib/trusted.js:30-32`,
  `README.md:251`). `README.md:304` states the threshold alone, and the
  source adds the trust condition. The ack after a reindex needs
  `_reindexed` (`index.js:1298`). `compactMaybe` sets it (`index.js:707`)
  only for a system or view core below manifest version 3
  (`index.js:692-693`, `:710-718`, `:738-751`). This release makes both
  cores at version 3 (see the corestore floor). `ackThreshold` stays at its
  default of 32 (`index.js:30`, `:134`).

Between the read of the length and the append inside `db.append`, autobee
awaits (`index.js:1529-1561`). If a later autobee appends a local node in
that window, the op lands one position later. Every peer then rejects it
`forged-clock`, and the views stay equal. Tests: `G10` and `G13` in
`okf/test/store-ordinal.test.js`.

**An append returns only once its node is durable.** `Bundle.append`
resolves only once `db.local` holds the position of its node. This relies
on five behaviours:

- A new local node lives only in memory, in the pending list of the local
  writer (`lib/writers.js:729-754`). Only `Writer.flush` writes it to the
  core (`lib/writers.js:768-789`). Only the drain calls that
  (`index.js:824`, `:1578-1605`, `lib/writers.js:137-147`).
- The close of autobee calls no flush. `_close` sets `_interrupting`
  (`index.js:392`). `_teardown` closes the writers, `db.local` and the
  store, and then awaits the drain in flight (`index.js:424`, `:439`,
  `:442`, `:446`).
- A reopen starts the local writer with no pending node, at the core
  length (`lib/writers.js:330-332`). No code reads a pending node back.
- A node that waits behind a missing link never reaches apply, so no
  system or view state holds it (`lib/writers.js:547-667`). autobee stores
  its boot record only after a drain that was not interrupted
  (`index.js:833-841`).
- The wait listens to the hypercore events `append` and `close` on
  `db.local` (hypercore `README.md:591-593`, `:759-761`). A flush that
  passed the closed check can still commit after `close` (hypercore
  `index.js:1150-1151`, `lib/session-state.js:780-786`). The closed
  session then gets no `append`. Once closed, `db.local.length` reads 0
  (hypercore `index.js:651-654`). So the store decides only after
  `db.close()` resolves, from the length in storage, through its root
  corestore.

An append that the close stops fails `VAULT_CLOSED_BEFORE_DURABLE`, and it
wrote nothing. Tests: `okf/test/store-append.test.js`.

**`db.writable` is the substrate admission signal.** `db.writable` is
`true` once autobee has added this writer (`README.md:114-116`). autobee
sets it from the system record of the local writer: added and not removed
(`index.js:196-198`, `lib/writers.js:208-216`). Its own `append` refuses
only a removed writer (`index.js:1531-1533`). A writer that autobee has not
added fails the local flush with `Not writable` (`lib/writers.js:633-638`),
and then autobee closes (`index.js:669-690`). So the store checks
`db.writable` before every append, and refuses with `VAULT_NOT_WRITABLE`.
`db.writable` is not okf membership. Core grants the key of every
`AddWriter` op that it folds, a rejected one too (AD7 above,
`okf/core/lib/apply.js:375`). So a key can be writable with no
`gov/writer` record, and apply then rejects each of its ops. Test: the
`G12` test in `okf/test/store-writers.test.js`.

**`host.removeWriter` is never called.** SPEC §8 revocation is causal, in
okf's apply. A removal at the substrate records the writer as removed
(`lib/apply-calls.js:49-52`, `lib/system.js:108-114`). Then `canApply` is
false for its nodes (`lib/system.js:242-251`, `index.js:1447`), and they
reach no apply. The §8 clock rule needs every node of a revoked writer to
reach apply on every peer. So `HostAdapter` exposes only `addWriter`. A
revoked member stays an autobee writer (G34 in `SECURITY_MODEL.md`).

**Genesis, the vault key and the stored encryption key.** A creator passes
no vault key. autobee then takes the key of the local writer core as the
vault key (`lib/boot.js:65-89`, `:86`). So `metadata.genesisKey` equals
`db.key` on every peer. Core's genesis indexer is then autobee's bootstrap
writer (`index.js:1411-1413`). autobee keeps the encryption key in the user
data of the local core (`lib/boot.js:108-131`), so a reopen needs no key.
`encryptionKey` encrypts the writer cores, the system and the view
(`README.md:308-320`, `index.js:52`, `:219`, `:263`, `lib/writers.js:269`).
Tests: `okf/test/store-encryption.test.js`.

**The store session, replication and close.** The Bundle hands autobee a
per-generation namespace of its root corestore (corestore
`README.md:88`). `db.replicate(stream)` passes its arguments to
`store.replicate`, and adds the stream to the wakeup protocol
(`index.js:454-458`). The README documents only `isInitiator`
(`README.md:155-163`). corestore's `replicate` also takes a stream
(corestore `README.md:62-81`). `db.close()` closes the store that it was
handed (`index.js:442`). So the Bundle closes its root corestore itself,
after `db.close()`.
