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

The second is the disk adversary: anyone who can write files into the
watched bundle directory. [Ingest](GLOSSARY.md#ingest) turns on-disk edits
into ops, so the watched tree is untrusted input by design (§9).

## Defenses, all in apply

- **Governance authority (§8):** `AddWriter`/`RemoveWriter`/`SetWriterPolicy`
  require an [indexer](GLOSSARY.md#indexer) issuer, checked in apply against
  `gov/writer/<issuer>` at the op's linearized position; the autobee host is
  never called for an unauthorized op. A `RemoveWriter` that would leave
  zero indexers is rejected: a vault cannot become permanently
  ungovernable.
- **Causal revocation (§8):** after `RemoveWriter`, an op from the removed
  writer applies only if its clock strictly precedes the revocation. The
  claimed clock is cross-checked against unforgeable position: any node past
  the recorded `seqAtRemoval` is rejected regardless of its claim, and an op
  whose self-clock entry disagrees with its actual seq is rejected as
  `forged-clock`.
- **Optimistic gating (§8):** unacked writers' ops are held, never applied,
  and capped at `H_max = 512`; the ack is the linearization of an
  indexer-authored `AddWriter` naming the held writer. `RemoveWriter` of an
  unacked writer drops the holds unfolded.
- **Rate policy (§8):** a writer-local token bucket, enforced in apply. A
  writer earns tokens only from accepted indexer-authored ops, so a flooder
  cannot mint its own budget; unacked writers run under a fixed default
  ceiling.
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
