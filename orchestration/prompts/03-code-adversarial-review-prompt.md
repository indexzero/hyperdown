# Adversarial Codebase Review: Vault-LD-on-Autobase, Grounded in an E2E Harness

**Audience:** Claude Code, acting as hostile reviewer and test engineer against an existing implementation.
**Prime directive:** no repro, no finding. Every claimed defect MUST ship with a failing test in the harness described below, or a deterministic script that demonstrates it. Static suspicion goes in a separate "unproven concerns" appendix, clearly labeled.

This document stands alone. Context: the system under review is a multi-writer wiki storage backend. Source of truth is an Autobase op log (one Hypercore per writer, AI agents included); a deterministic `apply` folds the linearized ops into a Hyperbee view (subjects, field state, body revisions, triple indexes, backlinks, flags); merge semantics per predicate are chosen from the composed JSON-LD context (`@container: @set` terms are observed-remove sets, scalars are LWW registers under linearization order); Markdown vault and Turtle export are generated faces. Primary sources if API questions arise: `https://github.com/holepunchto/autobase`, `https://github.com/holepunchto/autobee`, `https://github.com/holepunchto/hyperbee`, `https://github.com/The-Knowledge-Graph-Guys/vault-ld`.

The implementation's own spec defines invariants I1..I10 (determinism, convergence, rebuild equivalence, no silent loss, OR-set law, LWW law, flag lifecycle, index coherence, export determinism, governance). Read them from the repo's spec first; every harness assertion below maps to one.

---

## 1. Harness architecture (build this first if it does not exist)

- **Real processes, not in-process fakes.** Each writer is a separate OS process (`child_process.spawn`), with its own Corestore directory, communicating with the test controller over a control channel (IPC or a local socket) that accepts commands: `append(op)`, `pause-replication`, `resume-replication`, `snapshot-view-hash`, `crash` (SIGKILL, no cleanup), `restart`.
- **Deterministic replication topology.** Do not use public DHT infrastructure in tests. Either use the Hyperswarm/hyperdht testnet utilities the Holepunch ecosystem provides, or pipe replication streams directly between processes through a **fault proxy** you control.
- **Fault proxy.** A duplex stream shim between every peer pair supporting, per direction: fixed latency, jitter, bandwidth cap, byte-level stall, drop (partition), and kill-mid-frame. All parameters seeded, all schedules logged, so every run is replayable from its seed.
- **Barriers.** The controller can hold N writers at a barrier, release them simultaneously to stimulate a race window, and then heal partitions. Races are stimulated by construction (pause replication, write concurrently, resume), never by hoping the scheduler cooperates.
- **Convergence oracle.** `snapshot-view-hash` performs a full ordered range scan of the view and returns a single hash. Convergence assertions compare hashes across all peers after quiescence (define quiescence as: all cores fully replicated and view processing drained, per the current autobase API for update/drain).
- **Permutation replay.** The controller can replay a recorded op set into fresh peers in different arrival orders. Same linearized log MUST yield the same hash (I1/I2); this is the single highest-value test in the suite.

## 2. Mandatory scenario matrix

Each scenario names the invariant it validates. Run every scenario at three fault profiles: clean (0ms), lossy (200ms +/- 150ms jitter, 5% stalls), and partitioned (write during partition, heal after).

- **S1 (I6) LWW arrival independence.** Writers A and B set the same scalar on the same subject during a partition. Heal. Assert all peers agree, and assert the winner is a pure function of linearization by replaying the same log permuted.
- **S2 (I5) OR-set add/remove race.** A removes member M (citing the tags it observed); concurrently B adds M. Heal. M MUST be present everywhere. Also test remove citing a tag that never replicated to the applying peer.
- **S3 (I7) Dangling flag lifecycle.** A links to nonexistent note X during partition; B creates X during the same partition. Heal in both orders (via permutation replay). Final state MUST have no dangling flag, deterministically.
- **S4 (I4) Body conflict detection.** A and B both `SetBody` citing the same base revision, concurrently. Assert both revisions retained, one deterministic head, exactly one conflict flag, on every peer.
- **S5 (I1) Policy epoch reorder.** A `DefineTerm` flipping a term between scalar and `@set`, concurrent with field writes to that term, healed such that linearization order differs from any writer's local perception. Assert convergence holds regardless of semantic surprise, and assert the semantics match the spec's stated apply-time-policy rule.
- **S6 (I10) Revocation race.** Indexer removes writer C while C has unreplicated ops in flight behind a partition. Heal. Assert C's post-revocation-point ops (as defined by the spec in linearization terms) touched nothing outside `flag/`, and assert all peers agree on exactly which of C's ops landed.
- **S7 (I3) Crash and rebuild.** SIGKILL a peer mid-apply under load; restart; assert its recovered view hash matches the others. Separately: rebuild a view from scratch from the log and diff against an incrementally built one, key by key.
- **S8 (I9) Face determinism.** After convergence, run `materialize` and Turtle export on two different peers; byte-diff the outputs. Then ingest a human edit (modify a materialized file on disk), and assert the emitted ops are minimal (field-level, not whole-file) by inspecting the log.
- **S9 (I8) Index coherence under churn.** Random rename/relink workload; at every quiescent point, verify by full scan that `idx/*` and `bl/*` are exactly derivable from `n/*` (write the checker as an independent reimplementation, not by calling the code under test).
- **S10 Fuzz.** Seeded generator producing random op schedules (including malformed ops, oversized subjects, unknown op types, garbage base hashes) across 3 to 7 writers with random partition schedules. After every heal: convergence hash check plus the I8 coherence check. On failure, shrink the schedule to a minimal repro and commit it as a regression test.

## 3. Code review targets (each suspicion must graduate to a scenario or be filed as unproven)

- **Purity of apply (I1).** Grep apply and everything it calls for `Date.now`, `Math.random`, object/map iteration used for ordering, `JSON.stringify` of objects feeding hashes, float formatting, locale-dependent `sort`, Unicode-unnormalized subject keys. Any hit becomes a permutation-replay test designed to expose it.
- **Async discipline in apply.** Missing `await` on a view `put`/`del` inside apply is the classic Autobase corruption bug: it manifests as rare rebuild divergence. Review every promise in the apply path; stress with S7.
- **Keyspace injection.** Subjects and terms are attacker-controlled strings embedded in Hyperbee keys. Attempt traversal: a subject named to collide with the `flag/` or `ctx/` prefix, embedded separators, empty string, 1 MB key. Assert the keyspace codec escapes all of it.
- **Backpressure and resource leaks.** Long-running lossy-profile soak (30+ minutes, sustained writes): watch RSS, open FDs, and Corestore directory growth per process. Unbounded revision retention is a known design decision; unbounded memory is a bug.
- **Replication trust boundary.** Autobase/Hypercore verify writer signatures; the app layer must still treat op *content* as hostile. Confirm decode failures are contained per-op (flagged, skipped) and cannot abort apply wholesale, or a single poison op from one agent halts every peer's view forever: test exactly that with a hand-crafted poison op.
- **Governance plumbing.** Verify indexer/non-indexer status and optimistic-write handling against the current autobase API, in the harness, not by reading docs: spin up an agent as non-indexer and confirm the indexer set makes progress with the agent offline.
- **Quiescence definition.** If the code's own "synced" signal is wrong, every convergence test is vacuous. Validate the quiescence check independently: after reported quiescence, force a further update round and assert the hash did not move.

## 4. Output format

Produce `CODE-REVIEW.md`:

1. **Verdict paragraph.**
2. **Findings table**: ID, severity (blocker / major / minor), invariant violated, scenario or script that reproduces it, one-line title.
3. **Findings detail**: repro instructions (seed, fault profile, scenario), observed vs expected, root cause in the code (file and line), and a proposed fix sketch.
4. **Unproven concerns appendix**: static-analysis suspicions you could not reproduce, each with the scenario you tried.
5. **Harness deliverables**: the harness itself, the scenario suite S1..S10 wired into CI (clean profile on every push, lossy and partitioned profiles nightly), and every shrunk fuzz repro committed as a named regression test.

Severity discipline: a blocker is a reproduced violation of I1, I2, I3, or I10. Divergent view hashes anywhere, under any seed, is always a blocker.