# Adversarial Review: Vault-LD-on-Autobase Specification

**Audience:** Claude Code, acting as a hostile specification reviewer. You did not write this spec. Your job is to break it on paper before a line of code exists.
**Input:** the implementation specification document for a multi-writer Vault-LD storage backend on the Holepunch stack (op-log source of truth, Hyperbee view built by a deterministic `apply`, context-driven merge semantics, OR-set/LWW hybrid, body revisions with conflict flags, indexer/non-indexer writer governance).

This document stands alone. If the spec under review is not provided alongside it, request it and stop.

---

## 0. Ground rules

- You MUST fetch and read the primary sources before reviewing, because the spec makes claims about them: `https://github.com/The-Knowledge-Graph-Guys/vault-ld` (SPEC.md is normative for format semantics), `https://github.com/holepunchto/autobase`, `https://github.com/holepunchto/autobee`, `https://github.com/holepunchto/hyperbee`, `https://github.com/holepunchto/hyperdispatch`.
- Every finding MUST cite the specific spec section it attacks and, where relevant, the primary-source text that contradicts or undermines it.
- No vague findings. Each finding needs an exploit narrative: a concrete sequence of ops, writers, or reorderings that produces the bad outcome.
- Steelman before you strike: if a section survives your best attack, say so in one line and move on. Do not pad.

## 1. Determinism attacks (the spec's I1/I2/I3 claims)

- **Policy epoch reordering.** The spec admits merge policy is read from view state at apply time, so a reorg that moves a `DefineTerm` across dependent field ops changes semantics. Attack the adequacy of "document it in the README" as a mitigation. Construct the worst concrete case: a term flipped from scalar to `@set` (or the reverse) with interleaved writes, across a reorg caused by a late indexer. Does the spec need epoch-pinned ops (ops that cite the context version they were written against)? Argue both sides, then take a position.
- **Hash and encoding stability.** The spec requires content-hash revision IDs and byte-deterministic export. Hunt for every place nondeterminism can leak: YAML serialization of floats and dates, JSON key ordering before hashing, Unicode normalization of subjects (does `Caf\u00e9` equal `Cafe\u0301` as a subject key?), locale-sensitive sorting in "canonical ordering".
- **Autobase reorg surface.** Verify against the autobase README exactly when linearization can reorder and what the view rebuild contract is. Does the spec's flag lifecycle (I7) survive a rebuild that replays ops in a different interleaving? Find a sequence where a dangling flag is cleared, then reappears or wrongly persists.

## 2. CRDT soundness

- **OR-set remove semantics.** `RemMember` removes by observed tags. Where do writers learn tags? If a writer reads tags from its own possibly stale view, construct the anomaly: writer removes member M citing tags {t1}, concurrent writer re-adds M as t2, a third writer's view flickers. Is the resulting behavior actually the OR-set the spec claims, or an approximation? Demand the spec state the exact citation the writer must make and what apply does with a `RemMember` citing unknown tags.
- **Tombstones and growth.** OR-sets need tombstones or observed-tag bookkeeping; the log grows forever by construction; every body revision is retained forever. The spec has no compaction, no garbage collection, no revision pruning story. Quantify the blowup for a plausible agent swarm (N agents, W writes/day, one year) and force the spec to either accept the number in writing or add a mechanism.
- **LWW is linearization-order, not intent-order.** Two agents write a scalar seconds apart; linearization may order them opposite to wall clock. The spec says this is fine. Is it, for a wiki? Attack with a scenario where the "older" write deterministically wins and a human user perceives data loss with no flag (does this violate I4 in spirit?).
- **Interacting semantics.** `SetField` on a term currently mapped as `@set`, and `AddMember` on a scalar term: the op schema permits both. The spec does not define them. Enumerate every op-type x term-kind mismatch and demand defined behavior for each.

## 3. Vault-LD conformance matrix

Build an explicit table: every MUST/SHOULD in the vault-ld SPEC.md on one axis, the spec section that satisfies it (or fails to) on the other. Pay particular attention to:

- Preservation of unmapped keys (the spec flags them; does it also roundtrip them back out through materialize and export, or are they trapped in the view?).
- Shadowing rules for term redefinition across ontology scopes.
- Dangling-link IRI minting: does the minted IRI match the spec's naming rules exactly, so a later real note takes over the same IRI?
- The export split between schema and data files: verify the spec's partitioning rule against the vault-ld text, not against intuition.
- The clobber rule: the spec claims structural immunity. Find the hole: what happens when the ingest watcher and materialize race on the same file on disk?

## 4. Adversarial writer model

The whole point is untrusted-ish AI agents holding append rights. The spec's defenses are indexer/non-indexer split, apply-level policy, and revocation. Attack each:

- **Malformed ops.** What does apply do with an op that fails decoding, cites a garbage revHash as base, uses a 10 MB subject name, or nests 10,000 levels of YAML in a literal? "Flag and skip" must be specified per case; find the cases where skipping silently violates I4.
- **Flag flooding.** Flags are writes to the view. An agent that emits millions of dangling refs turns the flag namespace into a DoS. Rate ceilings are checked in apply; can a writer inflate view size faster than policy can be updated, given policy updates are themselves ops in the same log?
- **Governance races.** `RemoveWriter` racing the removed writer's in-flight ops across a partition: which ops land, per autobase's actual semantics? Is I10's "after revocation point" even well-defined under reorg? Force the spec to define the revocation point in linearization terms.
- **Subject squatting and namespace policy.** Per-writer namespace restrictions are mentioned but not specified. Who assigns namespaces, via what op, with what merge semantics when two indexers disagree?
- **Optimistic onboarding.** An unconfirmed optimistic writer's ops: visible in the view before confirmation or not? Either answer creates problems; make the spec pick one and own the consequences.

## 5. Ambiguity hunt

Grep the spec for every SHOULD and MAY and every undefined error path. For each: state what two reasonable implementers would build differently, and whether the divergence is observable in the view (if yes, it is a convergence bug waiting to happen and must be promoted to MUST).

## 6. Novelty claim stress test

The spec claims context-driven merge policy (ontology declarations selecting CRDT semantics per predicate) as its core novelty. Do a genuine prior-art pass: OrbitDB stores, Ceramic/ComposeDB, DXOS ECHO, Braid/HTTP-state work, Yjs/Automerge-based RDF or triple-store experiments, SU-set and other RDF CRDT literature (e.g. work on SPARQL-update CRDTs). Report the closest three findings and state precisely what, if anything, remains novel. If the honest answer narrows the claim, write the narrowed claim.

## 7. Output format

Produce `SPEC-REVIEW.md`:

1. **Verdict paragraph** (ship, ship-with-changes, do-not-ship).
2. **Findings table**: ID, severity (blocker / major / minor / nit), spec section, one-line title.
3. **Findings detail**: for each, the exploit narrative, the primary-source citation where applicable, and **proposed replacement spec text** (findings without proposed text are not findings, they are complaints).
4. **Conformance matrix** from §3.
5. **Prior-art summary** from §6.

Severity discipline: a blocker is something that makes I1..I10 unachievable as specified. Do not inflate.