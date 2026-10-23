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

**okf §3 per-writer ordinal: `seen/` view counter, after checking autobee's
node.** As §3 instructs, autobee@1.0.10 was checked before resolving:
`lib/writers.js` `createNode()` does expose a per-node `length` (and
`_applyBatch` hands those nodes to apply), so a transport-side seq exists.
Core nevertheless derives position from the stream itself via the
view-kept `seen/<writerKey>` count (incremented for every node regardless
of disposition), because core is transport-agnostic and the §8 unforgeable-
position rule (`seqAtRemoval`, forged-clock) must bind to the same ordinal
apply uses for `flag/rejected`/`hold/` keys. Under autobee@1.0.10's
per-writer FIFO delivery the seen-count equalled the node seq.

On autobee@2.12.1 the two can differ, and `seen/` is the one that counts.
autobee@2 appends empty "ack" nodes to a writer's core (`index.js`
`_appendAck`), and apply never sees an empty node (`index.js`
`_applyBatch` passes only non-empty values), so `node.length` can run
ahead of the seen-count. The store therefore seeds its next local seq
from `seen/<self>` after an `update()`, never from `local.length`, and
sets `ackThreshold: Infinity` so autobee appends no threshold acks. The
one ack autobee appends after a reindex is still possible; the seed
covers it.

**okf §8 hold buffer stores full payloads: acked optimistic nodes are NOT
re-delivered to apply.** §8 requires verifying re-delivery before choosing
between payload-holding and seq-dedup. autobee@1.0.10 `index.js`
`_optimisticBatch()` applies an unacked writer's optimistic batch exactly
once at its linearized position (rolling back only when
`system.canApply()` fails); a later `host.ackWriter()`
(`lib/apply-calls.js`) flips writer state without replaying prior nodes
into apply. Therefore `hold/<writerKey>/<seq>` stores the full decoded
payload (JSON-safe hydration) and the ack's `AddWriter` folds holds in seq
order at its own linearized position, as specified for this branch.

**okf §8 uniform topo weight is 2, not the literal `weight: 1`.** §8
mandates `host.addWriter(key, { isIndexer: op.indexer, weight: 1 })` to
avoid autobee's mixed defaults, but autobee@1.0.10's GENESIS auto-add is
uncontrollable from apply and uses the defaults (`index.js`
`_processApplyBatch` → `lib/apply-calls.js` `weight = isIndexer ? 2 : 1`
with `isIndexer` defaulting true): the genesis writer is always weight 2.
A literal `weight: 1` for admitted writers would therefore re-create
exactly the mixed-weight condition §8 exists to prevent (`lib/topo.js`:
`isOrderedBefore()` breaks the walk on `node.weight < link.weight` while
`cmp()` sorts higher weight first — divergent linearizations under
concurrency). §8's substance is the UNIFORM weight; the store's
HostAdapter (`okf/store/lib/vault.js`) pins every `addWriter` at the
genesis value `weight: 2` (the vault-ld harness-proven resolution),
overriding the `weight: 1` core passes. Side effect: autobee's cosmetic
`isIndexer` getter (`lib/writers.js`: `weight === 2`) reads true for all
writers; §8 governance authority is decided from `gov/` by core, never
from autobee state.

**okf §8 optimistic nodes are acked at the DAG level inside the store's
apply wrapper.** §8 places the ack at the linearization of the indexer's
`AddWriter` (core calls `host.ackWriter` there), but autobee@1.0.10 rolls
an unacked writer's optimistic batch back entirely unless the writer is in
its system after apply (`index.js` `_optimisticBatch`: post-apply
`system.get(key)` check, else view rollback + `removePending()`), which
would discard the batch before any `AddWriter` could fold it. The store's
`_apply` therefore calls `host.ackWriter(node.key)` for every
optimistic-flagged node before folding (deterministic: the flag is
oplog-encoded, so every peer makes the same call); core's `hold/` buffer
remains the only VIEW-effect gate, so the §8 semantics (effects land at
the in-log ack's linearized position) are unchanged. Same resolution as
vault-ld §8.2 (harness-proven).

**okf core fix required by T4 (out of store scope, minimal):
`opFromJson`/`opToJson` hold hydration corrupted held `SetField` ops.**
`okf/core/lib/ops.js` hex-converted any field named `key` when rehydrating
a held op (`Buffer.from('status', 'hex')` → empty buffer), so an unacked
writer's held `set-field` folded under an empty frontmatter key on every
peer — converged (I2 held) but wrong, and unreachable by core's unit suite
(its hold tests held only `create-concept`/`set-body`). Since governance
ops (the only ops with a buffer `key`) are rejected before the hold branch,
a held op can never carry a buffer: hydration is now a plain
null-normalizing copy. View bytes are unchanged for every previously
passing case (string fields always serialized as-is); the store's
optimistic-onboarding integration test is the regression test. Full suite
(114 vault-ld + 62 okf-core + 15 store) green after the fix.

**okf §10 epoch namespace derivation (spec-silent detail).** §10 requires
writer cores namespaced per epoch and "recorded in vault metadata" but not
HOW the id is minted. The store derives it purely:
`epoch = 'genesis'` when the chain fields are null, else
`sha256(predecessorKey bytes || stableStringify(predecessorCheckpoint))`
— so every peer of one vault computes the same namespace from the same
pinned metadata, a joiner reconstructs it from the invite's chain fields
alone, and a reused corestore directory still yields fresh writer keypairs
across epochs. Recorded as `metadata.epoch` and validated against the
chain fields at every load.

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

## okf §10 — epoch-cycle compaction (T6)

**okf §10 epoch `log/` entry is a filesystem artifact, not a view `log/`
record.** §10 requires compact to "record an epoch entry in the new vault's
`log/`." The view's `log/<ordinal>` family is written only by `apply` from
ops, and §3's wire contract is append-only with NO epoch op (and none may be
added — core is a fixed built interface here). compact therefore writes the
epoch entry as a durable JSON artifact at `<vaultDir>/log/epoch.json`
(`{ kind:'epoch', epoch, predecessorKey, predecessorCheckpoint, conflictCopies,
at, note }`). This satisfies "an entry in the new vault's `log/`" literally;
the entry does NOT appear in the regenerated `log.md` (which re-derives from
the view — §14 excludes `log.md` from I11 fidelity anyway).

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
at the SAME path in the new vault. The enumeration in `log/epoch.json`
therefore records `{ from, to }` with `from === to` (deterministic
identity-preserving carry-across, §9 conflict-copy awareness); it is truthful
(the `from` list is the actual on-disk conflict files of the materialized
predecessor bundle).
