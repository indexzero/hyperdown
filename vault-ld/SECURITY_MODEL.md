# Vault-LD security model

This is the trust story for Vault-LD: who the adversary is, which defenses
stand between that adversary and the [view](GLOSSARY.md#view), and where the
guarantees stop. Terms are pinned in [GLOSSARY.md](GLOSSARY.md). Spec §
references cite the build spec,
[`../prompts/01-implementation-spec-prompt.v5.md`](../prompts/01-implementation-spec-prompt.v5.md).

## The adversary

The adversary is a [writer](GLOSSARY.md#writer) that bypasses client
libraries entirely and appends arbitrary bytes to its own core.

Every defense therefore lives in [`apply`](GLOSSARY.md#apply), where all
effects flow. Nothing that skips apply can reach the view, and apply runs
identically on every peer.

## Defenses, all in apply

- **Governance authority (§8.0):** `AddWriter`/`RemoveWriter`/policy ops
  from non-indexers are rejected; a confirmed agent cannot mint puppet
  indexers.
- **Causal revocation (§8.3):** after `RemoveWriter`, only ops that
  causally preceded the revocation (judged from op-embedded clocks) still
  apply. Reorg-stable by construction.
- **Optimistic gating (§8.2):** unacked writers' ops are held, never
  applied, and capped (`H_max`); revoked-before-ack holds are dropped.
- **Namespace and rate policy (§8.5/§8.6):** per-writer path-segment
  namespaces and a default-on token-bucket rate ceiling, both enforced in
  apply; rejections are single audit rows, so flooding the flag queue is
  bounded.
- **Malformed input (§8.4):** undecodable/oversize ops are flagged, never
  thrown on. The view cannot be stalled.
- **Path safety (§9.4):** subjects and paths are attacker-controlled;
  materialize contains every write lexically and via realpath under the
  vault root (an op naming `../escape` is a test fixture, not a primitive).
- **Privacy:** a shared vault `encryptionKey` end to end; there are **no**
  per-writer read ACLs inside a vault (v1 non-goal, §13).

Nothing is lost silently (I4): every rejected, superseded, dangling,
unmapped, or conflicting effect leaves a
[`flag/`](GLOSSARY.md#flag--flag-family) record.

## Trust boundaries and caveats

### The policy-epoch caveat (read this before trusting a reorg)

Merge policy is read from the composed context in the view **at apply
time**. A reorg that reorders a `DefineTerm` relative to dependent field
ops can change the merged result. This is still deterministic — any two
peers with the same linearized log produce identical views — but it can be
semantically surprising: the same op may merge as an
[LWW register](GLOSSARY.md#lww-register) in one linearization epoch and as
an [OR-set](GLOSSARY.md#or-set) add in another. The opt-in mitigation is
**kind pinning**: field ops may carry `ctxKind: 'scalar' | 'set'` (the
kind the writer resolved against); a pinned op is applied under the cited
kind and any divergence is audited under `flag/epoch`. Pinning costs two
bytes per op and should be the default for agent writers: the ingest
watcher always pins, and the recipe-book agents pin every field op.

## Guaranteed versus best-effort

Measured. The invariant suite maps each of
[I1–I10](GLOSSARY.md#invariant-i1i10) to at least one test; the
multi-process fault harness drives the scenario matrix at three fault
profiles against real per-writer OS processes; final verification ran on an
independent clean clone (FINAL-PASS, recorded in `DELIVERY.md`).

Best-effort, by explicit trade. Retention is the accepted cost of
determinism and auditability: the log is never truncated in v1 (see
"Retention" in the [README](./README.md)). Sustained-flood scale behavior
(M2/L1) was backlogged, not guaranteed (`orchestration/BACKLOG.md`).

## Non-goals (v1)

No per-writer read ACLs inside a vault: the privacy boundary is the shared
vault `encryptionKey`, so a vault's readership is its key's holdership
(§13). Authority inside a vault is the governance regime above; there is no
finer-grained permission system.
