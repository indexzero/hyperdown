# SPEC-REVIEW.md — Adversarial Review of Vault-LD-on-Autobase Implementation Spec v3.0

**Reviewer role:** hostile specification reviewer. I did not author this spec.
**Artifact under review:** `prompts/01-implementation-spec-prompt.v3.md` (v3.0, 2026-07-03).
**Primary sources fetched and read (via WebFetch) before review:**

- vault-ld `SPEC.md` — `https://github.com/The-Knowledge-Graph-Guys/vault-ld` (raw main). Sections cited below: §2, §3, §4.1–§4.5, §5.1–§5.6, §6.
- Autobase README — `https://github.com/holepunchto/autobase` (raw main).
- Autobee README — `https://github.com/holepunchto/autobee` (raw main).
- Hyperbee README — `https://github.com/holepunchto/hyperbee` (raw main).
- Hyperdispatch README — `https://github.com/holepunchto/hyperdispatch` (raw main): the entire README is the single sentence "Generate operations/endpoints using Hyperschema", confirming §1's own characterization.

Prior-art sources (§6) fetched via WebSearch, cited in the prior-art section.

---

## 1. Verdict

**Ship-with-changes.**

This is a strong revision. Every prior blocker (B1–B3) is genuinely closed, and the closures are correct against the Autobase README, not merely plausible-sounding: causal revocation is carried in-band via an op-payload clock (§8.3), governance authority is checked against `ctx/gov` at linearized position (§8.0), and rate limiting is rebuilt on a writer-local token bucket replenished by indexer ops (§8.5). The determinism story (I1/I2/I3) is now airtight in the places it was leaky: NFC normalization (§3.1), fixed hash construction (§6), canonical literal forms (§10.2), no-throw apply (§8.4), no peer-local reads inside apply (I1). I could not construct a surviving determinism attack against the frozen apply pipeline.

I am **not** raising any new blocker: I could not find a case where an invariant I1–I10 is *unachievable as specified*. What remains are three **major** findings where the spec's mitigation rests on an Autobase behavior the README does not actually document (and which, if false, silently degrades an invariant rather than making it unachievable), plus a cluster of minors and nits. The single most important pre-implementation action is **F1**: the entire optimistic-onboarding mechanism (§8.2) and the per-writer-seq flag keying (§8.4, §8.5, §8.6, all `flag/rejected/<W>/<seq>` and `n/hold/<W>/<seq>`) depend on facts about Autobase's `apply` node objects that the README does not confirm — the README documents only `value` and `from.key` on a node. The spec already hedges this in §8.4 ("Verify against the current autobase API… if only `from.key` is available…"), which is why this is major and not a blocker, but the hedge needs to be propagated to §8.2 and the keyspace, and one branch of it is currently under-specified.

Ship once F1–F3 are dispositioned and the minor convergence-observable ambiguities (m-prefixed below) are promoted or pinned.

---

## 2. Findings table

| ID | Severity | Spec § | Title |
|----|----------|--------|-------|
| F1 | major | §8.2, §8.4, §4 (keyspace) | Per-writer `seq` inside apply is undocumented in Autobase; `n/hold/<W>/<seq>` ordering and the `from.key`-only fallback are under-specified |
| F2 | major | §8.2 | Held optimistic ops folded "at the ack's position" reorder relative to already-applied confirmed ops → LWW/OR-set outcome depends on when the ack lands, and a never-acked writer's holds accumulate unbounded |
| F3 | major | §5.7, §8.5 | Kind-pinning (`ctxKind`) is OPTIONAL and rate-bucket replenishment is scoped only "at/below `signedLength`", so I6/I10 stability is conditional on writer opt-in and on a peer-local checkpoint — the spec should state the residual explicitly as an invariant carve-out, not bury it |
| M-a | major | §10.1 vs vault-ld §5.4 step 5 | Layer inference from `@type` meta-types diverges from vault-ld's normative folder rule; a valid vault where a schema note carries no recognized meta-type exports to the wrong file |
| m1 | minor | §5.6 | Host-key allowlist default includes `publish`/`permalink`, which are NOT in vault-ld §4.3 (only `tags`,`aliases`,`cssclasses`); over-broad allowlist silently swallows two keys vault-ld would treat as unmapped-and-flagged |
| m2 | minor | §8.4 | `flag/rejected` reason enum omits `depth-exceeded`'s sibling limits' interaction; oversize-op vs oversize-subject precedence undefined for an op that violates both |
| m3 | minor | §5.2, §5.6 | Unmapped `AddMember` "append to ordered list" has no defined element ordering or dedup rule → two implementers diverge on the verbatim list, observable after a later `DefineTerm` backfill |
| m4 | minor | §9.2 | `flag/linkambiguous` resolution is assigned to ingest, but ambiguity is a function of view state which changes under linearization; whether ingest or apply owns it is unspecified |
| m5 | minor | §11 | Snapshot quorum "same quorum that signs signedLength" is not a stable set under Autobase's advancing-checkpoint model; verification contract needs the indexer-set-at-checkpoint pinned |
| n1 | nit | §1, §3.2 | hyperdispatch README confirmed one sentence; §1 already redirects to Hyperschema — closed, noting for the record |
| n2 | nit | §5.1, §5.2 | `ctxKind` values are `'scalar'\|'set'` but term kinds are named `lww\|or-set\|unmapped`; the scalar↔lww / set↔or-set mapping is left implicit |

---

## 3. Findings detail

### F1 (major) — Per-writer `seq` inside apply is undocumented; hold-buffer ordering and fallback under-specified

**Spec claims.** §8.2 stores held optimistic ops at `n/hold/<W>/<seq>` and later "range-scan `n/hold/<W>/*` in ascending `seq` order". §8.4 keys every rejection at `flag/rejected/<writerKey>/<seq>` and asserts "`<writerKey>/<seq>` is available from the Autobase node metadata **before** payload decode". §8.5/§8.6 reuse `<W>/<seq>` for rate and namespace rejections. The view keyspace (§4) hard-codes `<seq>` into five key families.

**Primary-source contradiction.** The Autobase README documents exactly two fields on the node object handed to `apply`: `value` (the block content) and `from.key` (the writer's key). The example is `for (const { value } of nodes)` and `host.ackWriter(node.from.key)`. There is **no** documented `node.seq`, `node.length`, per-writer index, or any per-node sequence exposed inside `apply`. The README's node contract is silent on ordinal identity.

**Exploit narrative.** Implementer A finds `node.seq` on the concrete object (it may exist undocumented) and keys `n/hold/W/5`, `n/hold/W/6`. Implementer B, reading only the README, takes the §8.4 fallback and keys everything by `ctx/gov/clock/<W>` (the view-maintained applied count). Now two "conforming" peers produce **different view keys** for the same held op and the same rejection — a direct I2 violation (bit-identical views) and I3 (rebuild equivalence) the moment either the hold buffer or any `flag/rejected` is non-empty. The spec's own hash-the-full-range-scan convergence test (I2) fails across the two implementations.

The fallback is also self-inconsistent for the hold buffer specifically: §8.4's fallback (`lengthAtApply` = the view-maintained per-writer *applied* count) counts **applied** ops, but held optimistic ops are by definition **not applied** (§8.2 forbids mutating anything but `n/hold/`). So `ctx/gov/clock/<W>` does not advance for a held op, and two successive holds from the same unacked writer would collide on the same fallback key, silently overwriting the first held payload — data loss of a held op with no flag (I4 violation) and a wrong replay when the ack lands.

**Why major not blocker.** If the concrete Autobase object *does* expose a stable per-writer monotonic index inside apply (plausible — `from` likely carries more than `key`), the mechanism works and I2 holds. The spec cannot be *shown* unachievable from the README alone; it is under-specified against it. The spec already flags the risk in §8.4 for `flag/rejected`; the defect is that §8.2's hold buffer needs its own resolution and the fallback is wrong for the not-yet-applied case.

**Proposed replacement text (§8.2, append):**
> The hold-buffer key MUST use a per-writer monotonic ordinal that is a pure function of linearized order and is defined for *unapplied* ops. Implementations MUST NOT key the hold buffer by `ctx/gov/clock/<W>` (which counts applied ops and does not advance for held ops). Determine the ordinal as follows and record the choice in DEVIATIONS.md: (a) if the current Autobase `apply` node exposes a stable per-writer sequence/index, use it; (b) otherwise maintain, inside apply, a per-writer *seen-count* `ctx/gov/seen/<W>` incremented for **every** node from `W` (applied, held, or rejected) in linearized order, and key holds/rejections by it. Option (b) is a pure function of the linearized prefix and is therefore reorg-stable. `flag/rejected` (§8.4) and namespace/rate rejections (§8.5/§8.6) MUST use the **same** ordinal source as the hold buffer so that no two families disagree on a writer's op ordinals.

**Proposed replacement text (§8.4, replace the "if only `from.key` is available" sentence):**
> If the current Autobase node exposes no per-writer ordinal inside apply, key all `<seq>`-bearing families (`flag/rejected/`, `n/hold/`, and every namespace/rate rejection) by the view-maintained per-writer **seen-count** `ctx/gov/seen/<W>` (incremented for every node from `W` regardless of disposition), never by the *applied* count `ctx/gov/clock/<W>`. Record the resolution in DEVIATIONS.md.

---

### F2 (major) — Optimistic replay "at the ack's position" reorders held ops relative to confirmed ops, and unbounded holds accumulate

**Spec claims.** §8.2: when the ack linearizes, apply folds each held op "**at the ack's linearized position** (their effect is as if they occurred there)… this is deterministic because both the held set and the pipeline are pure functions of the linearized prefix." §8.1: "New agents MAY write optimistically before confirmation."

**Steelman.** The determinism argument is correct as stated: for a *fixed* linearized log, replaying the holds at the ack position is a pure function, so I1/I2/I3 hold. This is not a determinism bug. I withdraw any I1 attack.

**The residual defect is semantic, and it is real.** The held ops were *authored* at logical times before the ack (that is what "optimistic" means), but they take *merge effect* at the ack's position — after every confirmed op that linearized before the ack. Construct: agent W optimistically writes `SetField{s:Recipe, p:title, o:"Hummus", ctxKind absent}` at the very start. Human indexer H writes `SetField{s:Recipe, p:title, o:"Baba Ganoush"}`. Then an indexer acks W. Under §8.2, W's held title write folds **at the ack position**, i.e. *after* H's write — so W wins the LWW register, and H's "Baba Ganoush" is superseded. A human who typed the authoritative title watches an ephemeral agent's earlier-authored optimistic write clobber it, purely because confirmation happened to land later in linearization. §5.4 does write `flag/clobber`, so this is not silent (I4 survives), but it inverts the intuition the spec sells elsewhere ("Humans and at least one pinning/server node are indexer writers" — the human's write is expected to be authoritative).

**Second, sharper exploit — unbounded hold accumulation (I10-adjacent / DoS).** §8.5's rate ceiling rejects with `flag/rejected` and never mutates `n/`. But §8.2 says held optimistic ops are stored under `n/hold/` and are explicitly *not* subject to the normal pipeline until ack. Are held ops rate-limited? The spec does not say. A never-acked optimistic writer (an attacker who is never confirmed, exactly the §8.1 threat model — "an ephemeral agent swarm") can append optimistic ops forever; each one, on the README's semantics ("will not be applied because ackWriter isn't called"), is still a linearized node that apply sees. If apply dutifully writes each to `n/hold/<W>/<seq>`, the attacker inflates view size without bound and without ever being a confirmed writer — the rate ceiling (§8.5), which is the defense, is defined only for the accept/reject decision and its interaction with the hold buffer is undefined. This is the flag-flooding attack (§8.5 of the review prompt) reincarnated through the hold buffer.

**Why major not blocker.** I10 is about *removed* writers and *unacked* ops not mutating `n/` (other than `n/hold/`) — and the spec explicitly carves out `n/hold/`. So writing to `n/hold/` is *permitted* by I10's own text; the invariant is not violated as written. The defect is that the carve-out is a hole: it lets an unconfirmed adversary grow the view unboundedly, which is the exact DoS the governance section exists to prevent.

**Proposed replacement text (§8.2, append):**
> Held optimistic ops are subject to the §8.5 rate ceiling **at hold time**: apply MUST run the token-bucket check before writing `n/hold/<W>/<seq>`, and an over-ceiling optimistic op is rejected (`flag/rejected`, reason `policy-rate`) and MUST NOT be held. A writer that has never been acked has a hold-buffer cap of `H_max` ops (vault metadata constant); optimistic ops beyond `H_max` for an unacked writer are rejected (reason `policy-rate`) and not held. When a `RemoveWriter` for an unacked `W` linearizes, apply MUST delete `n/hold/<W>/*` and clear the optimistic flags without folding them (a revoked writer's speculative ops never take effect). Deployments SHOULD document that an optimistic write folded at its ack position merges *after* confirmed ops that linearized before the ack; agents that need authoring-time ordering MUST carry `ctxKind` and SHOULD obtain confirmation before writing to contended registers.

---

### F3 (major) — I6/I10 stability is conditional on optional `ctxKind` and on peer-local `signedLength`; state the carve-out as invariant text

**Spec claims.** §5.7: kind-pinning "SHOULD be the default for agent writers" but is OPTIONAL (`MAY carry ctxKind`). §8.5: the rate-rejection partition's stability "is scoped to the region at or below `signedLength`". I6 asserts "scalar outcome depends only on linearized order, never on arrival order at any peer." I10 asserts the applied/rejected partition is "reorg-stable… at or below `signedLength` for rate policy."

**Exploit / observation.** The spec is honest here — §8.5 states the `signedLength` scoping, §5.7 states epoch-sensitivity. The defect is that the invariant *statements* (I6, I10) read as unconditional in §12 but are actually conditional, and the conditions are load-bearing for the adversary model:

1. **`ctxKind` optional ⇒ epoch divergence is opt-out, not opt-in-safe.** An agent that omits `ctxKind` (permitted) writing across a `DefineTerm` reorg gets its `SetField` reinterpreted from LWW to OR-set (or vice-versa) depending on where linearization lands the `DefineTerm`. This is deterministic (I1 holds), but the *semantic* outcome differs between two legal linearizations of the same op multiset — which is precisely the "surprising" I6-in-spirit case the review prompt §1 targets. Because the mitigation is optional, a swarm of naive agents (the stated threat model) will not carry it.

2. **`signedLength` is peer-local (Autobase README: "The index of the system core that has been signed by a quorum of indexers").** So "reorg-stable at/below `signedLength`" is a stability guarantee whose *boundary* differs per peer until the checkpoint advances. Two peers at different `signedLength` disagree on which rate-rejections are "final." This is fine for eventual convergence (once the checkpoint advances the region freezes identically), but I10's text should not imply a globally-stable partition above the checkpoint.

**Why major not blocker.** Both behaviors are deterministic per fixed log (I1/I2/I3 hold), so no invariant is *unachievable*. The finding is that §12's invariant statements overclaim relative to §5.7/§8.5's honest body text, which is itself an I-level correctness issue (the test suite references I6/I10 as written).

**Proposed replacement text (I6, §12):**
> **I6 LWW law:** for a fixed linearized log, scalar outcome depends only on linearized order, never on arrival order at any peer. Where a term's kind changes across a reorg and an op omits `ctxKind`, the op is reinterpreted per the kind at its linearized position (deterministic but epoch-sensitive, §5.7); this is auditable via `flag/epoch` only when `ctxKind` is present. Agent writers SHOULD carry `ctxKind` to make the outcome authoring-stable.

**Proposed replacement text (I10, §12, final clause):**
> …and — for the region at or below each peer's current `signedLength`, which is peer-local and advances monotonically to a common value — for rate policy (§8.5). Above `signedLength` the rate partition MAY differ between peers until the checkpoint advances, at which point the frozen region's partition is identical on all peers.

---

### M-a (major) — Layer inference from `@type` diverges from vault-ld's normative folder rule

**Spec claims.** §10.1: "a subject is `schema` iff its `@type` element set contains any member resolving to `owl:Ontology | owl:Class | owl:ObjectProperty | owl:DatatypeProperty | rdfs:Class | rdf:Property | skos:ConceptScheme | skos:Concept`, else `data`. This mirrors vault-ld §5.4 step 5 without needing folders."

**Primary-source contradiction.** vault-ld §5.4 **step 5** reads verbatim: "Decide each note's **layer from its folder**: notes under `Ontologies/` and `Vocabularies/` are the schema layer, everything else is the instance layer." The partition is *folder*, not `@type`. The spec's claim to "mirror" step 5 is false: it substitutes a type-based heuristic for the normative folder rule. §10.1 itself concedes the gap ("a schema subject with **no derivable scope**… `flag/noscope`" and "a schema subject lacking a recognized meta-type defaults to `data`").

**Exploit narrative.** Author creates `Ontologies/Cooking/Classes/Recipe.md` whose frontmatter declares `type: [[Class]]` where `Class` is a *vault-local* class note (not aliased to `owl:Class`/`rdfs:Class` in the composed context — vault-ld permits local vocabularies). vault-ld exports this to `schema.ttl` (it is under `Ontologies/`). This spec's §10.1 finds no member of the `@type` set resolving to a recognized meta-type, sets `layer = data`, writes `flag/noscope`, and exports the note to `data.ttl`. Two conformant tools now disagree on the export partition for the same vault — a §10.1 / vault-ld §5.4 conformance failure, and (across two instances of *this* system that ingested the same vault via different folder contexts) potentially an I9 export-determinism surprise.

The spec's defense is that the op log "deliberately discards" folders (§10.1), so folder-based partition is impossible. That is a real design constraint — but it means the system **cannot** faithfully reproduce vault-ld's layer partition for the general case, only for the subset where meta-types are explicitly recognized. The spec should either (a) carry folder/layer as authored metadata on ingest (it already carries `path` via `SetPath` — layer is derivable from the authored path's top folder), or (b) narrow the conformance claim.

**Why major not blocker.** No I1–I10 invariant is about vault-ld layer fidelity per se (I9 is about *determinism* of export, which holds — the wrong partition is deterministically wrong on all peers). So it is a conformance/correctness major, not a blocker.

**Proposed replacement text (§10.1, replace the layer-derivation sentence):**
> A subject's layer is derived, in priority order: (1) if `n/<s>/path` is present, `schema` iff the authored path's top segment is `Ontologies/` or `Vocabularies/` (vault-ld §5.4 step 5, §5.1), else `data` — this reproduces vault-ld's normative folder partition exactly; (2) absent a path, `schema` iff the `@type` element set (§5.8) contains a recognized meta-type (`owl:Ontology|owl:Class|owl:ObjectProperty|owl:DatatypeProperty|rdfs:Class|rdf:Property|skos:ConceptScheme|skos:Concept`); (3) else `data`. Record in DEVIATIONS.md that folder-based partition is honored only when an authored path is present, and that type-based inference is a documented fallback that MAY diverge from a folder-only vault-ld tool for locally-typed schema notes.

---

### m1 (minor) — Host-key allowlist default over-broad vs vault-ld §4.3

**Spec claims.** §5.6: "configurable host-key allowlist (default `{tags, aliases, cssclasses, publish, permalink}`)."

**Primary-source contradiction.** vault-ld §4.3 names exactly three host keys: "`tags`, `aliases`, and `cssclasses` in Obsidian are the common cases." `publish` and `permalink` appear **nowhere** in the vault-ld SPEC.md (verified by targeted fetch). Treating them as host-only means a note carrying `publish: true` is silently kept off the graph and **not** flagged — whereas vault-ld §4.3 + §6 ("a term resolved by none of these is flagged, not dropped") would have an unmapped `publish` flagged. So the over-broad default suppresses a flag the spec's own I4 promises.

**Exploit.** Two writers, one deployment ships default allowlist, another removes `publish`. Same op `SetField{s, p:publish, o:true}`: peer A stores it under `n/s/host/publish` (no flag); peer B (publish not on allowlist, publish unmapped) writes `flag/unmapped/s/publish`. Divergent flag sets from the same op set. Because the allowlist is a loader-config input, not an op in the log, this is a *configuration*-induced divergence, not a log-determinism bug — but it is observable and the default is the culprit.

**Proposed replacement text (§5.6):**
> …configurable host-key allowlist (default exactly `{tags, aliases, cssclasses}`, the three keys named in vault-ld §4.3). Deployments MAY add editor-specific keys (e.g. `publish`, `permalink`) but MUST record the extension, because the allowlist is a convergence-relevant input: two peers with different allowlists produce different `flag/unmapped` sets for the same op. The allowlist SHOULD therefore be pinned in vault metadata and treated as append-only across a vault's life.

---

### m2 (minor) — Pre-decode limit precedence undefined

**Spec claims.** §8.4: limits are "subject ≤ 1024 bytes, single op payload ≤ 64 KiB, literal nesting depth ≤ 64", each with its own reason (`oversize-subject`, `oversize-op`, `depth-exceeded`).

**Exploit.** An op with a 2 KB subject *and* a 128 KiB payload violates two limits. Which reason is recorded? `flag/rejected/<W>/<seq>` holds one `{reason, rawHashHex}`. Two implementers pick different reasons → different flag *values* for the same op → I2 (bit-identical views) fails on the flag value. Also, subject-length can only be checked *after* partial decode (the subject is inside the payload), contradicting "enforced pre-decode"; only total payload size is truly pre-decode.

**Proposed replacement text (§8.4):**
> Limits are checked in a fixed order and the **first** violated determines the single recorded reason: (1) `oversize-op` (total payload > 64 KiB — the only truly pre-decode check), (2) `unknown-msgid`/`undecodable`, (3) `depth-exceeded`, (4) `oversize-subject`. This ordering is normative because the recorded reason is view-observable (I2).

---

### m3 (minor) — Unmapped `AddMember` list ordering/dedup undefined

**Spec claims.** §5.2 (AddMember × unmapped): "**append** verbatim to an ordered list under `n/<s>/f/<term>` (never overwrite a prior unmapped value silently)."

**Exploit.** "Append" implies insertion order, but apply sees ops in *linearized* order which reorders under reorg. Is the list keyed by linearized arrival (reorg-unstable *value*, though deterministic per log) or sorted canonically (§10.2)? Are duplicate identical values deduped? Two implementers: A stores `[b, a]` (linearized order), B stores `[a, b]` (canonical sort). Same log → different stored verbatim list → different §10.3 backfill result once a `DefineTerm` arrives (I8 index-coherence divergence). Determinism per-log holds for each implementer, but they disagree with each other (I2).

**Proposed replacement text (§5.2 / §5.6):**
> The unmapped accumulation list is stored in **canonical element order** (sorted by the §10.2 byte form), deduplicated (identical NFC-normalized byte sequences collapse to one entry, retaining the first-in-linearized-order tag for audit). This makes the stored list a pure function of the op *multiset*, independent of linearized order, so a later `DefineTerm` backfill (§10.3) is convergent (I2/I8).

---

### m4 (minor) — Ownership of `flag/linkambiguous` (ingest vs apply) unspecified

**Spec claims.** §9.2: "a same-name ambiguity that cannot be resolved MUST be surfaced as `flag/linkambiguous/<s>/<term>/<target>`." §4 lists it as a view flag written by apply.

**Exploit.** Ambiguity ("two participating notes share a file name", vault-ld §4.4.1) is a property of *view state* (how many subjects mint the same IRI), which changes as ops linearize — a second same-named note may appear *after* the link op. If ingest decides ambiguity at parse time (its local view), it may miss a later collision; if apply decides it, ingest must not pre-judge. The spec assigns the flag to a view key (apply's territory) but the prose puts the detection in ingest. Two implementers split the responsibility differently → divergent `flag/linkambiguous` sets (I4/I2).

**Proposed replacement text (§9.2):**
> Ambiguity is detected by **apply**, not ingest: apply writes `flag/linkambiguous/<s>/<term>/<target>` when, at the link op's linearized position, more than one non-deleted subject mints-or-declares the target IRI and the link carries no path qualifier (§5.8 `flag/idcollision` covers the identity collision itself). Ingest MAY emit a path-qualified target to pre-resolve, but MUST NOT itself decide ambiguity, since view state is authoritative and evolves under linearization.

---

### m5 (minor) — Snapshot quorum set not pinned under advancing checkpoints

**Spec claims.** §11: a snapshot "MUST be co-signed by the same quorum of indexers that signs `signedLength`."

**Primary-source note.** Autobase README: "checkpoints… advances continually, so long as a majority set of indexers are writing messages." The indexer set is itself mutable (AddWriter/RemoveWriter are ops). "The same quorum that signs signedLength" is not a fixed set — it is whatever majority held at the checkpoint. A bootstrapping peer verifying a snapshot must know *which* indexer set was authoritative at the snapshot's `signedLength`, or an attacker who was briefly a quorum member (then removed) could co-sign a poisoned snapshot.

**Proposed replacement text (§11):**
> A snapshot MUST be co-signed by a quorum of the indexer set **as recorded in `ctx/gov` at the snapshot's `signedLength` checkpoint** (not the current indexer set). A bootstrapping peer MUST (1) verify the snapshot hash chains to a quorum-signed system-core checkpoint, and (2) verify the co-signers were confirmed indexers in `ctx/gov` at that checkpoint's linearized position. This closes the removed-indexer replay: a key removed after the checkpoint cannot retroactively co-sign, and a key added after cannot either.

---

### n1 (nit) — hyperdispatch required-reading redirect: CLOSED, recorded

§1 already states hyperdispatch's README "is a single sentence" and redirects to the Hyperschema repo. I fetched hyperdispatch's README: it is exactly "Generate operations/endpoints using Hyperschema". The prior n1 finding ("required reading points at docs that do not exist") is closed by §1's redirect and the explicit statement that the append-only wire contract (§3.3) is "**this spec's own requirement**, not something inherited from hyperdispatch documentation." No change needed; recorded for the closure table.

### n2 (nit) — `ctxKind` value naming vs term-kind naming

§3.2/§5.7 use `ctxKind: 'scalar' | 'set'`; §5.1/§5.2 name kinds `lww | or-set | unmapped`. The scalar↔lww and set↔or-set correspondence is inferable but never stated, and there is no cited value for `unmapped` (correctly — you cannot pin unmapped). One line fixes it.

**Proposed replacement text (§5.7, first mention of `ctxKind`):**
> `ctxKind: 'scalar' | 'set'` where `'scalar'` pins the **lww** register kind (§5.1) and `'set'` pins the **or-set** kind. `unmapped` is not pinnable (there is no policy to cite); an op citing a kind for a term that resolves to `unmapped` is applied under the cited kind and flagged `flag/epoch` with `applyKind: unmapped`.

---

## 4. Prior-findings closure table

Each prior row (P2-1-FINDINGS-TABLE) is verified against v3. **CLOSED** cites the v3 section that resolves it; **OPEN** gives the residual exploit.

| Prior ID | Prior title (abbrev) | Status | v3 section / residual |
|----|----|----|----|
| **B1** | Causal revocation unimplementable via Autobase API; signedLength disjunct peer-local → divergent views | **CLOSED** | §8.3 replaces positional/`signedLength` revocation with an **in-band op-payload vector clock** (`clock` field, §3.2) and `ctx/gov/removed/<W>`; §8.3 explicitly forbids reading `signedLength` inside apply and mandates the triple-replay test (incremental/scratch/reorg identical). Verified against Autobase README: `base.heads()` is query-time only and `signedLength` is peer-local, so the in-band clock is the correct fix. The rejected positional alternative is documented. Closed. |
| **B2** | No issuer-authority check on Add/RemoveWriter: any agent can appoint puppet indexers | **CLOSED** | §8.0 makes AddWriter/RemoveWriter/SetWriterPolicy/PruneRevisions **governance ops**, evaluated against `ctx/gov/writer/<issuer>.indexer` at linearized position; non-indexer issuer → `flag/rejected` reason `policy-governance`, `host.addWriter` never called. Genesis indexer seeded deterministically. Mandatory I10 test. Closed. |
| **B3** | Rate-window rejections interleaving-dependent; I10 reorg-stable partition unachievable | **CLOSED (with residual noted in F3)** | §8.5 replaces the global-window with a **writer-local token bucket replenished by accepted indexer ops**, a pure function of the linearized prefix; the naive "N per K positions" window is explicitly forbidden. Reorg-stability is honestly scoped to at/below `signedLength`. The prior *blocker* (partition flips under legal reorg) is gone: the multiset is reorg-invariant and the frozen region is stable. Residual (F3, major not blocker): the `signedLength` scoping and its peer-locality should be reflected in I10's text. Not reopened as a blocker — the exploit (partition flip below the checkpoint) no longer exists. |
| **M1** | ctxEpoch subtree hash cannot identify diverged term/recover cited kind | **CLOSED** | §5.7 replaces subtree-hash epochs with **direct kind citation** (`ctxKind: 'scalar'\|'set'`); `flag/epoch/<s>/<term>/<tag>` records `{citedKind, applyKind}` — the diverged term and both kinds are named explicitly. Closed. |
| **M2** | Keyword aliases (type→@type, id→@id), explicit @id unhandled | **CLOSED** | §5.8 resolves keyword terms **before** the §5.2 table; `@type` = OR-set, `@id` = identity with absolute-IRI check (`bad-id`), `n/<s>/id` override, `flag/idcollision`. Matches vault-ld §4.3 aliasing and §4.5 absolute-IRI rule (verified). Closed. |
| **M3** | Non-@set terms may be multi-valued; vault-ld example fails roundtrip; @list undefined | **CLOSED** | §5.1 makes an lww register a **canonical array** (one triple per element), explicitly citing that vault-ld's `domain`/`range` carry arrays with no `@container` (verified: Appendix A defines them with `@type:@id` and no container, and example notes carry `[ "[[...]]" ]`). `@list` rejected (`unsupported-container`, §5.1/§13). Closed. |
| **M4** | Scoped-@base machinery missing; scope @base derivation undefined | **CLOSED** | §10.1 adds `DefineScope{scope, base, prefix}` op, `ctx/scope/<scope>`, `n/<s>/base`, and a deterministic (a)/(b)/(c) subject-scope binding. Matches vault-ld §4.2 scoped-base / nearest-context rule (verified). Closed. |
| **M5** | No op carries authored path; no traversal validation → arbitrary file write | **CLOSED** | §9.3 adds `SetPath{s, path}` → `n/<s>/path`; §9.4 mandates lexical containment + `fs.realpath` parent re-check, `flag/unsafepath`, apply-level `unsafe-path` rejection, and the mandatory `../escape` containment test (§15). Closed. |
| **M6** | Optimistic hold-and-replay no storage/ordering rule; Autobase doesn't re-deliver | **CLOSED as blocker; downgraded residual = F1/F2** | §8.2 now stores the **full decoded payload** at `n/hold/<W>/<seq>` (correctly recognizing Autobase does not re-present nodes — verified against README) and folds at ack position. The prior blocker (payload lost, no ordering) is closed. **Residual, major:** the `<seq>` ordinal is undocumented in Autobase (F1) and the fold-at-ack semantics + unbounded holds need bounding (F2). Not reopened as a blocker because the storage/ordering rule now *exists*; the residuals are under-specification, not impossibility. |
| **M7** | No op resolves conflicts/drains flags; conflict flags pin revisions forever | **CLOSED** | §6 adds `ResolveConflict` and `ClearFlag` with a clear audit-vs-structural flag split; §11 adds `PruneRevisions`. I7 now has a real "explicit resolving op." Closed. |
| **M8** | Host-key promotion strands values; duplicate YAML keys possible | **CLOSED** | §5.6 promotion migrates `n/<s>/host/k`→`n/<s>/f/k` in the same pass, deletes host entries, backfills; `materialize` MUST error if both `f/k` and `host/k` exist; allowlist-while-mapped is a startup config error. Closed. |
| **M9** | Field removal / note deletion inexpressible | **CLOSED** | §3.2/§9.2 add `UnsetField` and `DeleteSubject` (tombstone), declared the *only* removal vocabulary; `flag/writeafterdelete`, `flag/undelete`. Closed. |
| **M10** | Kind-change redefinition has no migration rule | **CLOSED** | §5.5 mandates in-pass migration (lww→or-set synthetic tag; or-set→lww deterministic collapse + `flag/kindcollapse`); mandatory I8 kind-change test (§15). Closed. |
| m1 (prior) | seq availability inside apply undocumented | **OPEN → promoted to F1 (major)** | The prior minor is *correct and unresolved*: Autobase README documents only `value` and `from.key` on the apply node (verified). v3 §8.4 hedges but §8.2's hold buffer depends on `<seq>` with a broken fallback. See F1. |
| m2 (prior) | AddMember on unmapped term silently overwrites | **CLOSED (with residual m3)** | §5.2/§5.6 now **append** to an ordered list, never overwrite. Residual (m3, minor): the list's ordering/dedup is undefined → cross-implementer divergence. |
| m3 (prior) | Hash-input encodings unspecified | **CLOSED** | §6 fixes `revHash = SHA-256(len(base)‖base‖len(text)‖utf8(NFC(text)))` with byte-exact construction; §10.2 fixes literal/hash canonical forms. Closed. |
| m4 (prior) | Wiki-link grammar assigned to no component | **CLOSED (with residual m4-new)** | §9.2 assigns `[[...]]` parsing to ingest per vault-ld §4.4.1. Residual (new m4): `flag/linkambiguous` ownership (ingest vs apply) still ambiguous. |
| m5 (prior) | Backfill full-scan per DefineTerm = apply-time DoS | **CLOSED** | §10.3 mandates `unmapped-idx/<term>/<s>` reverse index; backfill is a bounded range scan, never a full `n/` walk. Closed. |
| m6 (prior) | Snapshot trust model unspecified | **CLOSED (with residual m5-new)** | §11 requires quorum co-signature + hash-chain verification (not single indexer). Residual (new m5): "same quorum that signs signedLength" is not a pinned set under advancing checkpoints. |
| m7 (prior) | namespacePrefixes matching undefined | **CLOSED** | §8.6 defines **path-segment** prefix matching (byte-prefix explicitly forbidden: `agents/alice` ∌ `agents/alicecooper`); mandatory I10 test. Closed. |
| n1 (prior) | hyperdispatch README one sentence; required reading points at nonexistent docs | **CLOSED** | §1 states the one-sentence fact, redirects to Hyperschema, and clarifies §3.3 is this spec's own requirement. Verified README = one sentence. See n1. |
| n2 (prior) | mtime/hash check + rename not atomic (TOCTOU) | **CLOSED** | §9.4 requires the per-path in-flight lock held across the mtime/hash check **and** rename, with a re-stat under lock immediately before rename. Closed. |

**No prior blocker is left open or reopened in altered form.** B1, B2, B3 are all genuinely closed; the B3 residual (F3) is a documentation/invariant-text issue, not a partition-flip exploit, so it does not carry blocker severity into this table.

---

## 5. Conformance matrix (vault-ld SPEC.md MUST/SHOULD × spec section)

Built from the fetched vault-ld text. "Satisfied" = the spec implements the normative requirement; "Partial/Diverges" flagged with the finding.

| vault-ld rule (section, verbatim gist) | Level | Spec section | Status |
|----|----|----|----|
| §4.3 unmapped key: MUST NOT emit as triple, MUST NOT warn as unmapped *if it is a host key*; §6 a term resolved by none is **flagged, not dropped** | MUST | §5.6, §10.3, I4 | **Satisfied** — host allowlist suppresses flag+triple; genuinely-unmapped keys stored verbatim + `flag/unmapped` + `unmapped-idx`. |
| §4.3 host keys are `tags, aliases, cssclasses` | (examples) | §5.6 | **Diverges (m1)** — default allowlist adds `publish, permalink`, absent from vault-ld. |
| §4.3 keyword aliasing `type:@type`, `id:@id` honored | MUST | §5.8 | **Satisfied** — resolved before §5.2 table. |
| §4.5 explicit `id` = full absolute IRI, verbatim, overrides minting | MUST | §5.8 | **Satisfied** — non-absolute → `bad-id`; `n/<s>/id` overrides. |
| §4.5 identity minted from **file name alone**, never folder, against governing `@base`; non-IRI-safe chars percent-encoded | MUST | §3.1, §7, §10.1 | **Satisfied** — NFC then percent-encode; mint against `n/<s>/base`. |
| §4.4.1 dangling link MUST be flagged, MAY mint IRI **in the data namespace** | MUST/MAY | §7 | **Satisfied and extended** — mints in root/data `@base`, `flag/dangling` coalesced. |
| §4.4.1 dangling **takeover** when target later materializes | *(unspecified in vault-ld)* | §7 | **Extension beyond spec** — vault-ld is silent (verified); §7's same-IRI-clear / different-IRI-retarget rule is this spec's own invention. Sound, but label it a deviation, not conformance. |
| §4.4.1 same-named notes collide on one IRI unless one declares `@id`; tool MUST warn | MUST | §5.8 `flag/idcollision` | **Satisfied** — no merge, flag written. |
| §4.2 later context redefining a term with **different** definition SHOULD warn; identical redecl no warning | SHOULD | §5.5 | **Satisfied** — `flag/shadow` only on structurally-unequal redefinition. |
| §4.2 context composed left-to-right, later overrides; scoped `@base` per ontology | MUST | §10.1 `DefineScope`, `ctx/scope` | **Satisfied** — explicit scope declaration replaces folder-nearest-context. |
| §5.4 step 5 layer decided **from folder** (`Ontologies/`,`Vocabularies/`→schema) | MUST | §10.1 | **Diverges (M-a)** — inferred from `@type` meta-type; folder-typed-but-locally-typed schema notes mis-partition. |
| §5.4 export → `schema.ttl` + `data.ttl` by layer, standard `@prefix` | MUST | §10.1, §10.2 | **Satisfied** (partition subject to M-a). |
| §5.4 step 7 roundtrip face emits `vld:path "<path>.md"` only when placement unreconstructable | MUST(roundtrip) | §10.4 | **Satisfied** — emitted only when `n/<s>/path` ≠ default, `roundtrip` flag. |
| §5.5 `vld:path` consumed on ingest, never stored as frontmatter/field | MUST | §9.3 | **Satisfied** — consumed into `SetPath`, never a field. |
| §5.5 foreign IRI extending no known `@base` → note gets explicit `id`; names percent-**decoded** for file names | MUST | §5.8, §9.3 | **Satisfied**. |
| §5.6 generator MUST preserve existing bodies, not clobber on regeneration | MUST | §9.4, §2 | **Satisfied** — bodies live in view; regeneration is pure projection; on-disk mtime/hash guard + atomic rename. |
| §5.1 canonical reconstructable placement (flat form), other layouts via `vld:path` | MUST | §9.3, §10.4 | **Satisfied**. |
| §5.4 "do not edit the generated face"; source-of-truth per-deployment (§2) | MUST | §2 | **Satisfied** — log is source of truth; faces read-only; human edits re-enter as ops. |
| §5.4 step 4 hierarchy predicates (`subClassOf` etc.) from frontmatter, folder ignored for hierarchy | MUST | §5.1 (lww array), §9.2 | **Satisfied** — predicates are ordinary terms; folder not consulted for hierarchy. |
| §6 conformance: unmapped flagged not dropped | MUST | §5.6, I4 | **Satisfied**. |

Net: one MUST-level **divergence** (M-a, layer partition), one over-broad default (m1), one **extension** beyond spec (dangling takeover, §7 — sound but should be labeled a deviation). Everything else conforms.

---

## 6. Prior-art summary (novelty claim stress test)

The spec's §14 novelty claim is already narrowed and honest: it explicitly disclaims per-predicate CRDT selection as novel (citing "SU-Set, m-ld, schema-driven protobuf CRDTs") and claims only **in-log reflexive merge policy** — the `@context` selecting OR-set vs LWW per predicate being itself a first-class, multi-writer-replicated object *in the same linearized op log as the data it governs*, yielding "deterministic-but-epoch-sensitive semantics." It further concedes the contribution is an "engineering composition," not a new CRDT. I did a genuine prior-art pass; the three closest works:

1. **SU-Set (Ibáñez, Skaf-Molli, Molli, Corby, 2012/2013)** — "Live Linked Data: Synchronizing Semantic Stores with Commutative Replicated Data Types," IJMSO 8(2):119–133 ([HAL](https://inria.hal.science/hal-00903377), predecessor **C-Set** [CEUR Vol-737](https://ceur-ws.org/Vol-737/paper9.pdf)). SU-Set extends OR-Set insert/delete to SPARQL-Update union/difference over `(triple, id)` pairs, needing no tombstone store because operation history is retained. **This is exactly the merge core the spec uses** (§5.3 explicitly cites "SU-Set observed-remove construction, not C-Set"). Nothing in the spec's *set semantics* is novel; the spec correctly says so.

2. **m-ld** ([spec.m-ld.org](https://spec.m-ld.org/), [CEUR Vol-2941 paper](https://ceur-ws.org/Vol-2941/paper1.pdf)) — synchronizes decentralized JSON-LD replicas using SU-Set, and crucially handles *extended semantics* (single-valuedness, ordered lists) via **constraints** layered on top of the set CRDT. m-ld's "single-valued constraint" is the closest analog to this spec's LWW-register-vs-OR-set distinction: m-ld defaults every non-`@id` property to *multi-valued* and lets a schema constraint force single-valued. This is the single most important comparator, and it *narrows the claim further*: **per-property single-vs-multi/merge selection driven by a replicated schema is prior art (m-ld constraints).** What m-ld does *not* do: m-ld's constraints are engine/application config, not themselves a co-replicated object living in the same op log with the same multi-writer merge rules as the data. That specific reflexive property is where this spec's residual novelty actually sits.

3. **DXOS ECHO** ([docs.dxos.org/echo](https://docs.dxos.org/echo/introduction/), [decentralized schema migration](https://blog.dxos.org/decentralized-schema-changes-and-data-migrations/)) — P2P Automerge-based store with a **versioned, runtime-mutable schema registry per space** and **epoch**-based history compaction/migration. ECHO's "schema is replicated, versioned, and drives object visibility/migration" is strikingly close to the spec's "context is a first-class replicated object that drives merge and needs kind-change migration (§5.5)." ECHO even has the epoch concept the spec cites as future direction (§11). Difference: ECHO's schema versions are semver'd governance-controlled artifacts with explicit migration builders, *not* the same linearized op stream folded by one deterministic `apply`; ECHO uses Automerge (a state/text CRDT), not an Autobase-style single-total-order linearization with an in-log context selecting per-predicate CRDT kind.

Honorable mentions surveyed and excluded as farther: **OrbitDB** (per-store-type Merkle-CRDTs; store type is chosen at DB creation, not per-predicate from a replicated schema — [store-types](https://github.com/orbitdb/orbitdb)); **Ceramic/ComposeDB** (GraphQL-schema-defined mergeable composites, but schema is a deploy-time artifact and merge is stream-tip LWW, not per-predicate CRDT — [ComposeDB](https://blog.ceramic.network/composedb-using-ceramic-as-a-graph-database/)); the **W3C CRDT-for-RDF Community Group** ([w3.org/community/crdt4rdf](https://www.w3.org/community/crdt4rdf/)) confirms this is active, contested territory.

**Verdict on novelty:** the spec's narrowed claim survives, but *barely*, and should be narrowed one more notch to distinguish it from m-ld constraints and ECHO schema. Proposed replacement for the §14 / §366 novelty sentence:

> The contribution is neither per-predicate CRDT selection (SU-Set/C-Set; m-ld single-valued constraints; ECHO/ComposeDB schema-driven typing) nor a new CRDT. It is the specific reflexive composition: the `@context` that selects OR-set-vs-LWW *per predicate* is **itself an ordinary content object in the very same single-total-order Autobase op log, folded by the very same deterministic `apply`, under the very same multi-writer governance and merge rules as the data it governs** — so schema evolution and data evolution share one linearization and one determinism proof, at the cost of epoch-sensitivity (§5.7). Unlike m-ld (constraints are engine config) and ECHO (schema is a semver'd, separately-governed registry with explicit migration epochs), here the policy table has no privileged channel: it is data.

---

## 7. Reviewer's note on severity discipline

I steelmanned every candidate blocker before striking. The three items that *looked* like blockers on first read — optimistic replay determinism (F2), rate-partition stability (F3/B3-residual), and layer partition (M-a) — all survive as *deterministic* under a fixed log, so no I1–I10 invariant is *unachievable as specified*; they are majors (semantic/conformance/under-specification), not blockers. The one genuinely unresolved prior *minor* (seq-in-apply) is promoted to major (F1) because it now underpins load-bearing keyspace and a broken fallback, and can break I2 across two conforming implementations — but it too is "under-specified against an undocumented Autobase fact," not "impossible," so it stays major. **No blocker in this findings table.**
