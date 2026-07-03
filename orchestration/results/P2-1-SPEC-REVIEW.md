# SPEC-REVIEW: Vault-LD on Autobase, v2 (P2 iteration 1)

**Artifact under review:** `prompts/01-implementation-spec-prompt.v2.md` (v2.0, 2026-07-03)
**Reviewer posture:** hostile, per `prompts/02-spec-adversarial-review-prompt.md`
**Primary sources fetched and read (2026-07-03):**

- vault-ld `SPEC.md` — https://raw.githubusercontent.com/The-Knowledge-Graph-Guys/vault-ld/main/SPEC.md (534 lines, read in full; normative for format semantics)
- autobase README — https://raw.githubusercontent.com/holepunchto/autobase/main/README.md (331 lines, read in full)
- autobee README — https://raw.githubusercontent.com/holepunchto/autobee/main/README.md ("Still experimental and under heavy development. Expect breaking changes.")
- hyperbee README — https://github.com/holepunchto/hyperbee ("Sort order is based on the binary value of the keys"; `db.batch()` "is either fully processed or not processed at all"; `db.checkout(version)`)
- hyperdispatch README — https://raw.githubusercontent.com/holepunchto/hyperdispatch/main/README.md (**3 lines total**: "Generate operations/endpoints using Hyperschema" — see N1)

---

## 1. Verdict

**Do not ship as written; revise to v3 and re-review.** The v2 spec is a large, genuine improvement over v1 — 18 of the 20 prior findings are closed, the op/kind table (§5.2), the citation contract (§5.3), the clobber flag (§5.4), the writer/seq-keyed rejection namespace (§8.4), and the retention math (§11) are all sound and survive attack. But two prior findings are only nominally closed (F6, F8: the replacement mechanisms are unimplementable against the documented Autobase API as the spec itself defines API precedence), and fresh review finds a governance hole that defeats the spec's own adversary model (any confirmed agent can appoint indexers), plus an internal contradiction that makes I10 unachievable as literally specified (rate-window rejections cannot be reorg-stable). All three blockers have bounded, local fixes proposed below; none invalidates the architecture.

---

## 2. Closure verification of the P1 findings table

| ID | v1 sev | Status | Evidence / residual |
|----|--------|--------|---------------------|
| F1 | blocker | **CLOSED** | §3.1: NFC before keying/minting/hashing; ingest NFC-normalizes file names; equality defined on NFC-then-percent-encoded bytes. |
| F2 | blocker | **CLOSED** | §5.2 total table, every cell mandatory, reject-not-coerce frozen. Residual (narrower, new): keyword-aliased terms `@type`/`@id` have no row → M2; array values on non-`@set` terms → M3. |
| F3 | blocker | **CLOSED** | §8.4: `flag/rejected/<writerKey>/<seq>` needs no decode; pre-decode hard limits. Residual nit: `seq` availability in apply is not in the autobase README → m1. |
| F4 | blocker | **CLOSED** | §5.4: cross-writer LWW supersession writes `flag/clobber` with superseded value; extended to body head. I4 now literally true for scalars. |
| F5 | blocker | **CLOSED** | §10.1: layer materialized per subject, derived from `@type`, deviation recorded. Residual (distinct): scoped `@base` derivation is still unspecified → M4. |
| F6 | blocker | **OPEN — reopened in altered form (→ B1)** | §8.3 replaces the positional pin with a "causal clock" that `apply` has no documented way to obtain, plus a `signedLength`-at-apply-time disjunct that is peer-local state. The residual exploit is concrete: two peers replaying the same log partition the same op differently (see B1). |
| F7 | major | **CLOSED** | §10.2: XSD canonical mapping, fixed Turtle orderings, canonical YAML scalars, NFC strings, lowercased language tags. |
| F8 | major | **OPEN — reopened in altered form (→ M1)** | Epoch pinning now exists (§5.7) but as specified cannot be executed: a whole-subtree hash can neither identify which term diverged nor recover the cited epoch's term kind. |
| F9 | major | **CLOSED** | §5.3: cite-every-tag-mapped-to-v contract; stale tags ignored-for-effect + `flag/staletag`; add-wins law stated; SU-Set-not-C-Set identified correctly. |
| F10 | major | **CLOSED** | §5.6 store verbatim, §9.1 materialize emits unmapped into frontmatter, §10.3 backfill on later `DefineTerm` + I8 test. |
| F11 | major | **CLOSED** | §5.6 allowlist `{tags, aliases, cssclasses, publish, permalink}`, never emitted, never flagged, matching vault-ld §4.3. Residual (new): the promotion path leaves values stranded under `n/<s>/host/` → M8. |
| F12 | major | **CLOSED** | §7 mints in the data namespace (root `@base`); verified verbatim against vault-ld §4.4.1: "**MAY** still mint an IRI for the missing target **in the data namespace** so the edge is preserved". Takeover (same-IRI and retarget) is defined beyond what vault-ld requires. |
| F13 | major | **CLOSED** | §9.3 path capture + consumption, §10.4 emit-iff-differs-from-default, roundtrip flag; matches vault-ld §5.4 step 7 / §5.5 step 1. Residual (new): no op type exists to carry the captured path into the view → M5. |
| F14 | major | **CLOSED** | §8.5: default ceiling from first op, independent of policy ops; O(1) rejection record per rejected op; `SetWriterPolicy` may only tighten. Residual (distinct, new): the window makes I10's reorg-stability claim false → B3. |
| F15 | major | **CLOSED** | §11 accepts growth in writing with worked numbers (50×500×365 ≈ 9.1M ops/yr; ≈3.6 GB/yr bodies — arithmetic checks out), plus snapshots and logged `PruneRevisions`. |
| F16 | major | **CLOSED** | §8.6: op, storage key, LWW-under-linearization merge, audit flag, rejection reason, I10 test. Residual (distinct, new): issuer authority for governance ops themselves is unenforced → B2. |
| F17 | minor | **CLOSED** | §5.5 flags only structurally-differing redefinitions; identical redeclarations idempotent, per vault-ld §4.2. |
| F18 | minor | **CLOSED** | §8.2 pins do-not-apply-until-ack and owns the consequence. Residual (new): the hold/replay mechanism is missing its storage and ordering rules → M6. |
| F19 | minor | **CLOSED** | §9.4: atomic write+fsync+rename, mtime/hash skip, debounce, write-settle, in-flight lock. Residual nit → n2. |
| F20 | nit | **CLOSED** | §3.3: append-only wire contract, ids never reordered/removed, decoders kept forever, schema version in vault metadata. |

Per the assignment rule, F6 (prior blocker, still open) and the two reopened findings are carried into the findings table below as B1 and M1.

---

## 3. Findings table

| ID | Severity | Spec § | Title |
|----|----------|--------|-------|
| B1 | blocker | §8.3, I10, I1/I2 | Causal revocation is unimplementable via the documented Autobase API, and its `signedLength` disjunct is peer-local → divergent views (F6 reopened) |
| B2 | blocker | §8.1/§8.6, I10 | No issuer-authority check on `AddWriter`/`RemoveWriter`: any confirmed agent can appoint puppet indexers and capture the quorum |
| B3 | blocker | §8.5 vs I10 | Rate-window rejections are interleaving-dependent, so I10's "applied/rejected partition is reorg-stable" is unachievable as specified |
| M1 | major | §5.7 | `ctxEpoch` subtree hash cannot identify the diverged term nor recover the cited epoch's kind (F8 reopened) |
| M2 | major | §5.2, §3.2 | Keyword-aliased terms (`type`→`@type`, `id`→`@id`) have no kind-table row; explicit `@id` semantics (vault-ld §4.5 MUSTs) entirely unhandled |
| M3 | major | §5.1/§5.2 | The scalar/`@set` dichotomy misreads JSON-LD: non-`@set` terms may be multi-valued (vault-ld's own example vault fails roundtrip); `@container: @list` undefined |
| M4 | major | §10.1, §7, §9.1 | Scoped-`@base` machinery missing: no op declares a scope's `@base`; `n/<s>/base` derivation undefined; flat schema placement needs an ontology name that is underivable |
| M5 | major | §9.3, §3.2, §9.1 | No op carries the authored path into the view; and subject/path values are never validated against filesystem traversal — adversarial ops become arbitrary file writes on every replica |
| M6 | major | §8.2, §4 | Optimistic hold-and-replay has no storage or ordering rule: `flag/optimistic/<W>/<seq>` retains no payload, and Autobase does not re-deliver held blocks after ack |
| M7 | major | §5.4, §6, I7, §11 | No op type resolves conflicts or drains flags; I7's "explicit resolving op" is absent from the op schema; the flag namespace grows monotonically outside §11's pruning |
| M8 | major | §5.6, §10.3 | Host-key promotion strands existing values under `n/<s>/host/` (backfill scans only `n/*/f/`), and can emit duplicate YAML keys on materialize |
| M9 | major | §9.2, §3.2 | Field removal and note deletion are inexpressible: no op unsets a scalar or deletes a subject, so the human ingest path cannot represent deleting a frontmatter line or a file |
| M10 | major | §10.3, §5.5 | Kind-change on term redefinition (scalar↔`@set`) has no migration rule for existing view state |
| m1 | minor | §8.4 | `seq` in apply is asserted "available from node metadata" but the autobase README documents only `value` and `from.key` |
| m2 | minor | §5.2 | `AddMember` on an unmapped term silently overwrites the previously stored verbatim value (I4 in spirit) |
| m3 | minor | §6, §3.2 | Hash-input encodings unspecified: revHash over `base`+`text` (concatenation ambiguity), `ctxEpoch` tree-hash algorithm |
| m4 | minor | §9.2 vs vault-ld §4.4.1 | Wiki-link grammar (alias, fragment, path disambiguation, ambiguity warning) assigned to no component |
| m5 | minor | §10.3 | Backfill requires a full `n/` scan per `DefineTerm` (no term-keyed reverse index); repeated `DefineTerm` is a cheap apply-time DoS within the rate ceiling |
| m6 | minor | §11 | Snapshot trust model unspecified: signed by one indexer or a quorum? Verified how by a bootstrapping peer? |
| m7 | minor | §8.6 | `namespacePrefixes` matching undefined: byte-prefix vs path-segment prefix (`agents/alice` matches `agents/alicecooper`?) |
| n1 | nit | §1, §3.2 | hyperdispatch's README is one sentence; the spec directs required reading at documentation that does not exist |
| n2 | nit | §9.4 | mtime/hash check followed by rename is not atomic together; a narrow ingest/materialize TOCTOU window survives |

---

## 4. Findings detail

### B1 (blocker) — §8.3 revocation: unimplementable causal clock + peer-local `signedLength` disjunct

**Exploit narrative (implementability).** §8.3 requires: "`apply`, when it reaches a `RemoveWriter{key:W}` node, records `ctx/gov/removed/<W> = <this node's causal clock>`; any subsequent op from `W` whose causal clock does not strictly precede that node is rejected." The autobase README documents, inside `apply`, only `node.value` and `node.from.key` (usage: `const { value } = node`, `node.from.key`). It states "Autobase writer nodes explicitly reference previous nodes creating a causal directed acyclic graph (DAG)" — but exposes **no API by which `apply` can read a node's causal references**. `base.heads()` exists on the base object, outside apply, and reflects replication-time state, which the README's own IMPORTANT note forbids consuming: "the `view` argument is the only data structure being update[d] ... If any external data structures are used, these updates will not be correctly undone." The spec's own precedence rule (§0.2: "Where this document conflicts with the autobase/autobee READMEs on API signatures, the READMEs win") makes §8.3, as written, a specification of a function over inputs the function does not receive. F6 is therefore reopened: v1 pinned an index that wasn't reorg-stable; v2 pins a clock that doesn't exist at the point of use.

**Exploit narrative (determinism).** The fallback disjunct — "`RemoveWriter{key:W}` is at or before `signedLength` **at the time `x` is linearized** and `x` is beyond it" — quantifies over peer-local, wall-clock-dependent state. Concrete divergence: `RemoveWriter{W}` linearizes at position 100. Peer A is live; when `x` (position 150) is applied, A's `signedLength` = 120 ≥ 100 and `x` is beyond it → A rejects `x`. Peer B bootstraps a week later and replays the whole log in one pass with `signedLength` = 5000; at the moment B applies `x`, position 150 is *not* beyond 5000 → the disjunct fails → B accepts `x`. A and B have exchanged all ops and hold different views. This violates I1 ("apply is a pure function of the linearized op sequence") and I2 directly — a blocker by the spec's own definitions, independent of the implementability problem.

**Primary source.** autobase README: "Ordering ... Autobase writer nodes explicitly reference previous nodes"; "As new causal information comes in, existing nodes may be reordered"; apply signature `async function apply(nodes, view, host)` with nodes destructured as `{ value }` / `node.from.key` only; `base.signedLength`: "The index of the system core that has been signed by a quorum of indexers."

**Proposed replacement text (§8.3).**

> `RemoveWriter` is revocation. Because the documented Autobase API does not expose per-node causal references inside `apply`, causal revocation MUST be carried in-band: every op (§3.2) carries a `clock` field — the writer's observed vector clock, `[{writerKey, seq}, ...]`, captured at append time from the writer's local view of all writers' delivered lengths (writers MAY derive it from `base.heads()` at append time; it is op payload, so apply's determinism is unaffected). `apply` maintains `ctx/gov/clock/<writerKey>` = the per-writer max-seq vector as ops are applied. When `apply` reaches `RemoveWriter{key:W}`, it records `ctx/gov/removed/<W> = clock(RemoveWriter node)`. A subsequent op `x` from `W` is rejected (reason `revoked`) iff `x.clock` does **not** dominate strictly below the recorded clock — i.e. iff `x` did not causally precede the revocation, judged solely from op-embedded clocks. An op from `W` with a missing or malformed `clock` is rejected (reason `revoked`) once `ctx/gov/removed/<W>` exists. This is a pure function of op payloads and linearized order and is therefore reorg-stable. The "signedLength at the time x is linearized" clause of v2 is DELETED: no rule may consult `signedLength` inside `apply`, because its value at apply time is peer-local. The I10 test suite MUST include a test that replays the same log (a) incrementally and (b) from scratch and (c) under a forced reorg, asserting an identical applied/rejected partition in all three.

(Alternative, argued and rejected: define revocation purely positionally — "any op from W linearized after the RemoveWriter node is rejected." That is deterministic and trivially implementable, but the partition flips under pre-`signedLength` reorgs, so I10's reorg-stability claim would have to be weakened. The clock-in-op design preserves I10 at the cost of one small field per op; take that trade.)

### B2 (blocker) — §8.1/§8.6: governance ops have no issuer-authority check

**Exploit narrative.** The spec's whole premise (§0) is "untrusted-ish AI agents holding append rights." §8.6 makes `SetWriterPolicy` "indexer-only" and §11 makes `PruneRevisions` "indexer-only" — but **no clause anywhere restricts who may emit `AddWriter` or `RemoveWriter`**. §8.1's "onboarding is `AddWriter` from an existing indexer" is descriptive prose, not an apply-time check, and the autobase README's reference apply handler honors any writer's `addWriter` value unconditionally (`if (value.addWriter) { await host.addWriter(...) }`). Attack: agent `W` (confirmed non-indexer, inside its namespace, under its rate ceiling) appends `AddWriter{key: P1, indexer: true}`, `AddWriter{key: P2, indexer: true}`, `AddWriter{key: P3, indexer: true}`. `apply` processes them; the puppets are now indexers; the indexer quorum is captured. The puppets then emit `RemoveWriter{key: human}` (passes `host.removeable` — the human is no longer the last indexer), `SetWriterPolicy` for everyone else (passes "indexer-only" — the puppets *are* indexers), and control `signedLength` advancement. Every defense in §8 is routed around in four ops. I10 is not merely violated; it is vacuous against the spec's stated adversary. Additionally, "indexer-only" itself is unenforceable as specified: `ctx/gov/writer/<key>` stores `{namespacePrefixes, rateCeiling}` with **no indexer bit**, so `apply` has no view state from which to evaluate the issuer's role.

**Proposed replacement text (new §8.0, plus one §4 line).**

> **§8.0 Governance-op authority.** `AddWriter`, `RemoveWriter`, `SetWriterPolicy`, and `PruneRevisions` are governance ops. `apply` MUST evaluate the **issuing** writer's role against `ctx/gov/writer/<issuerKey>` at the op's linearized position and reject (reason `policy-governance`, under `flag/rejected/<issuer>/<seq>`) any governance op whose issuer is not a confirmed **indexer** at that position. `ctx/gov/writer/<key>` MUST additionally record `indexer: bool`, written by the `AddWriter` op that admitted the writer (and by genesis below). Genesis: the vault creator's key is the initial indexer, recorded in vault metadata and seeded into `ctx/gov` by the first `apply` invocation deterministically. `host.addWriter`/`host.removeWriter` MUST only ever be invoked for governance ops that passed this check. The I10 test suite MUST include: a non-indexer's `AddWriter{indexer:true}` never results in `host.addWriter` being called and never mutates `ctx/gov`.

Add to §4: `ctx/gov/writer/<key>` → `{indexer, namespacePrefixes, rateCeiling}`. Add `policy-governance` to §8.4's reason enum.

### B3 (blocker) — §8.5 vs I10: rate-window rejection is not reorg-stable

**Exploit narrative.** §8.5 defines the default ceiling as "`apply` counting per-writer ops within a linearized window (e.g., ≤ N ops per K linearized positions from that writer)." Which of `W`'s ops fall inside a window of K *global* linearized positions depends on how other writers' ops interleave. I10 asserts "the applied/rejected partition is reorg-stable," explicitly including "policy-violating ops (... rate ...)," and §8.3 mandates a test "that reorders the log and asserts the applied/rejected partition is invariant." Concrete break: N=10, K=100. `W` appends 15 ops; concurrently indexer `H` appends 90. Linearization L1 interleaves them so `W`'s 15 ops span two windows (8+7) → zero rejections. A late indexer node arrives, causal fork resolves the other way, linearization L2 packs `W`'s 15 ops into one window → 5 rejections. Both linearizations are legal Autobase outcomes for the same op set below `signedLength`. Each is internally deterministic (I1/I2 hold per-order), but the partition is not reorg-stable, so I10 **as specified** is unachievable — the spec's own mandated test fails against the spec's own mechanism.

**Proposed replacement text (§8.5 bullet 1 and I10).**

> - Rate ceilings MUST have a default that applies to every writer from its first op. The window MUST be defined in **writer-local** terms so that the accept/reject decision for `W`'s op depends only on `W`'s own op stream and prior accepted state, not on interleaving: `apply` maintains, per writer, a token bucket replenished by **accepted ops from indexer writers** observed in the linearized stream (rate: R tokens per indexer op, capacity C, both vault metadata constants); each of `W`'s ops consumes one token, and an op arriving to an empty bucket is rejected (reason `policy-rate`). Because indexer-op counts at each position are themselves a pure function of the linearized prefix, the partition remains a pure function of linearized order; and because a reorg cannot change the *multiset* of ops, only their order, the bucket bound degrades gracefully: I10's stability claim for rate rejections is scoped to the region at or below `signedLength` (where order is final by construction).
>
> I10 (amended sentence): "... the applied/rejected partition is reorg-stable for revocation (§8.3), optimistic gating (§8.2), namespace and size-limit policies, and — at or below `signedLength` — for rate policy (§8.5)."

(Position taken: full order-independence for a rate limit is impossible in principle — any budget over a shared timeline is interleaving-relative — so the honest fix is to scope the invariant and say so, rather than pretend a window can be made reorg-proof. The token formulation minimizes the exposed surface; the scoping sentence makes I10 achievable as specified.)

### M1 (major) — §5.7: `ctxEpoch` as specified cannot be evaluated (F8 reopened)

**Exploit narrative.** §5.7: "`apply` compares it to the `ctx/` state at the op's linearized position; if they differ **for the specific term the op touches**, `apply` MUST apply the op under the **writer-cited epoch's kind**." Two impossibilities: (1) `ctxEpoch` is "a hash of the `ctx/` sub-tree" — two unequal subtree hashes do not reveal *whether the specific term differs*; any unrelated `DefineTerm` (or a different scope's `@base`) changes the subtree hash, so every pinned op after any context activity would flag and be "reinterpreted" spuriously. (2) The writer-cited epoch's **kind** is not recoverable from a hash. The writer resolved against its local, possibly-unsigned view; that exact subtree state may never occur in the final linearization at all, so `apply` — which may not consult anything but the view and the op — has no mapping from hash to kind. As written, the MUST cannot be executed; the F8 mitigation is decorative.

**Proposed replacement text (§3.2 + §5.7).**

> §3.2: replace `ctxEpoch?: hash` with `ctxKind?: 'scalar' | 'set'` on `SetField`/`AddMember`/`RemMember` — the term kind the writer resolved against, cited directly.
>
> §5.7: When `ctxKind` is present and differs from the kind resolved from `ctx/` at the op's linearized position, `apply` MUST apply the op under the **cited** kind (`SetField` under cited `scalar` applies as LWW even if `ctx/` now says `@set`, storing into the register slot; `AddMember`/`RemMember` under cited `set` apply OR-set semantics into the element map) and write `flag/epoch/<s>/<term>/<tag>` recording `{citedKind, applyKind}`. When the kinds agree, no flag. Writers that omit `ctxKind` accept apply-time policy. `materialize`/`export` treat a field that holds both a register slot and an element map (possible only via epoch divergence) by emitting the element map and flagging `flag/kindmismatch` — this state is always accompanied by an epoch flag and is resolvable by a subsequent op. Pinning costs two bytes per op and SHOULD be the default for agent writers.

### M2 (major) — §5.2/§3.2: keyword aliases and explicit `@id` unhandled

**Exploit narrative.** vault-ld §4.3: "A conforming tool **MUST** honour keyword aliases declared in the composed context" — the example vault aliases `type: "@type"` and `id: "@id"`, so `type: "[[Recipe]]"` is the most common line in every instance note. In v2, `apply` resolves incoming terms to kinds {scalar, `@set`, unmapped} (§5.2). `@type` is none of these: it is a JSON-LD keyword admitting multiple values with set-like semantics, and it feeds §10.1's layer inference. Two reasonable implementers diverge observably: one stores `type` as an LWW scalar (concurrent `type` writes silently supersede, layer flips), the other as an OR-set (both types retained). Divergence is observable in the view and in `schema.ttl`/`data.ttl` partitioning → per review rule §5 this must be a MUST. Worse, explicit `id` is wholly absent from v2: vault-ld §4.5 — "the value **MUST** be a **full absolute IRI** ... used verbatim"; "An explicit `id` overrides name-based minting entirely: it disambiguates same-named notes"; §4.4.1 — two same-named participating notes "**MUST** warn"; §5.5 step 1 — an ingested IRI extending no known base "gets it as an explicit `id`". v2's subject key *is* the note name, so two notes distinguished only by `@id` collapse into one subject silently — a silent merge of distinct resources, violating vault-ld identity semantics on the axis where vault-ld is normative (precedence rule §0.1), and making foreign-RDF ingest (§5.5) unimplementable.

**Proposed replacement text (add §5.8).**

> **§5.8 Keyword terms.** Terms resolving (directly or via context alias) to `@type` get OR-set semantics with element tags, exactly as `@container: @set` terms (`AddMember`/`RemMember`; a `SetField` on `@type` is a kind mismatch). §10.1's layer rule reads the full `@type` element set; if any member resolves to a schema meta-type, the subject is `schema`. Terms resolving to `@id` are identity, not fields: `SetField` on `@id` with a non-absolute IRI value is rejected (`flag/rejected`, reason `bad-id`, per vault-ld §4.5); with an absolute IRI it is stored as `n/<s>/id` (LWW, cross-writer supersession flagged per §5.4) and overrides name-based minting in `idx/*`, export, and dangling-takeover matching. Two subjects whose minted-or-declared IRIs collide write `flag/idcollision/<iri>`; `apply` MUST NOT merge them. `materialize` emits `id:` into frontmatter verbatim. Ingest of a subject whose IRI extends no known `@base` creates the note with an explicit `id` (vault-ld §5.5).

### M3 (major) — §5.1/§5.2: non-`@set` terms are multi-valued in JSON-LD; the dichotomy breaks on vault-ld's own example

**Exploit narrative.** In JSON-LD/RDF, absence of `@container: @set` does not mean single-valued — multiple triples per predicate are the default. vault-ld's own Appendix A root context defines `domain` and `range` with `@type: @id` and **no** `@container`, and its example property note writes `domain: [ "[[Recipe]]" ]`, `range: [ "[[Ingredient]]" ]` (arrays). Under v2 §5.1, these terms are "scalar (single-valued, datatyped) → LWW register." The ingest watcher (§9.2) diffing `range: [ "[[Ingredient]]", "[[Spice]]" ]` must emit... what? A `SetField` whose `o` is an array (nothing forbids it; then export emits one triple with a serialized-array object — malformed RDF), or two `SetField`s (second clobbers first — data loss plus a spurious clobber flag), or `AddMember`s (kind mismatch → rejected). All three readings are "reasonable implementer" outcomes; all are observable in the view; the reference vault in the normative format spec fails to roundtrip. Separately, `@container: @list` (legal JSON-LD, ordered) maps to no row of §5.2 at all.

**Proposed replacement text (§5.1).**

> Term kinds are exactly: **or-set** (`@container: @set`), **lww** (everything else mapped, including terms with no `@container`), and **unmapped**. An **lww register's value is a canonical array** (possibly length 1): `SetField.o` MAY be a scalar or an array; `apply` stores the array in canonical element order (sorted by the §10.2 byte form) and export emits **one triple per element**. The whole array supersedes atomically under LWW; there is no per-element merge on lww terms — deployments wanting element-wise merge declare `@container: @set`. YAML materialization emits a scalar when length is 1 and a flow array otherwise; ingest diffs at whole-array granularity for lww terms. A `DefineTerm` carrying `@container: @list` (or any container other than `@set`) is rejected in v1 (`flag/rejected`, reason `unsupported-container`); `@list` support is a non-goal (§13).

### M4 (major) — §10.1/§7/§9.1: scoped-`@base` machinery is missing

**Exploit narrative.** vault-ld §4.5: "the IRI is the governing `@base` + the file name ... where the governing context is the nearest `context.jsonld` at or above the note's folder"; §4.2: "Each referenced ontology context also declares the **`@base` for its own namespace**." v2 stores `n/<subject>/base` ("governing scope/@base for IRI minting") and relies on it for export prefixes (§10.2) and dangling takeover (§7: "a schema note under an ontology `@base`") — but never says **how it is derived or set**. There is no op that declares a scope's `@base` (`DefineTerm{scope, term, def}` defines terms, not scope bases; `ctx/<scope>/<term>` has no slot for `@base`). Concrete failure: an agent creates note `Tempo` with `type: owl:Class` purely via ops (no path). §10.1 infers `layer = schema`. Which ontology's `@base` mints `Tempo`'s IRI — `culinary#` or `music#`? Undefined. Likewise §9.3's "flat schema placement per vault-ld §5.1" requires writing `Ontologies/{Name}/Classes/Tempo.md` — `{Name}` is underivable from `@type`. Two implementers pick differently; export IRIs and vault layouts diverge; I9 fails across implementations and conformance with vault-ld §4.5 fails within each.

**Proposed replacement text (§3.2, §4, §10.1).**

> Add op `DefineScope { scope: ontologyName, base: iri, prefix: string }` (indexer-only in the sense of §8.0? No — same authority as `DefineTerm`; it is content, not governance). `apply` stores `ctx/scope/<scope> = {base, prefix}`; redefinition follows §5.5 shadowing rules. `DefineTerm.def` MAY carry `scope` membership for the term. **Subject-scope binding:** a subject's governing scope is (a) the scope of its authored path's nearest context when `n/<s>/path` is present (computed at ingest, carried on the path-op of M5), else (b) the scope that defines the subject's primary `@type` term when that is unambiguous, else (c) the data namespace (root `@base`). The binding is stored in `n/<s>/base` at apply time by these rules and re-evaluated only by ops that change its inputs, so it is deterministic. `materialize` places a schema note with scope `S` at `Ontologies/<S>/Classes|Properties/<name>.md` per vault-ld §5.1; a schema subject with no derivable scope is placed under the data root, `layer = data`, and `flag/noscope/<s>` is written (I4). Record the (b)/(c) inference as a deviation from vault-ld's folder rule alongside the §10.1 layer deviation.

### M5 (major) — §9.3/§9.1: no path op; no traversal validation → arbitrary file write

**Exploit narrative (missing op).** §9.3: "The ingest watcher captures each note's authored context-relative path into `n/<subject>/path`." But the view is written **only** by `apply` folding ops (§2, §4), and §3.2 defines no op that carries a path. As specified, `n/<s>/path` can never be populated; §10.4's `vld:path` emission and §15's roundtrip acceptance criterion are unimplementable. (F13's closure is real at the semantic level but the transport is missing.)

**Exploit narrative (traversal).** Subjects and paths are attacker-controlled strings (the threat model is agents with append rights). §8.4 caps subject *length* only (≤ 1024 bytes) and never constrains its *content*. A subject or path of `../../../../home/user/.ssh/authorized_keys` (well under 1024 bytes) flows through `apply` into `n/<s>/path`, and §9.1 `materialize` writes it to disk. Every peer that materializes writes the attacker's file outside the vault root — a deterministic, replicated remote file-write on N machines from one op. The clobber/atomicity mechanisms of §9.4 protect *within* the vault; they do nothing about escaping it. This turns "materialize the vault" into arbitrary write primitive across the swarm.

**Proposed replacement text (§3.2, §9.3, §9.1/§9.4).**

> §3.2: add op `SetPath { s: subject, path: string }` (emitted by ingest and by `materialize`-driven placement). `apply` stores `n/<s>/path` (LWW under linearization; cross-writer supersession flagged per §5.4).
>
> §9.1/§9.4 (path safety, normative): before writing any file, `materialize` MUST validate that the NFC-normalized, resolved absolute target path is lexically contained within the vault root (no `..` segment escapes, no absolute-path override, no symlinked parent that resolves outside root — resolve with `fs.realpath` on the parent and re-check containment). A subject name or `path` value that (a) contains a path separator in the subject position, (b) escapes root, (c) is an absolute path, or (d) collides case-insensitively with another note on a case-insensitive filesystem, causes `materialize` to skip the file and record `flag/unsafepath/<s>` (I4); `apply` additionally rejects a `SetPath` whose value escapes root (reason `unsafe-path`, §8.4 enum). The reference implementation MUST include an adversarial test: an op naming `../escape` is contained and never writes outside root on any peer.

### M6 (major) — §8.2: optimistic hold-and-replay has no storage or ordering

**Exploit narrative.** §8.2 says unacked optimistic ops "are held under `flag/optimistic/<W>/<seq>` and become effective only after an indexer `AddWriter`/`ackWriter` for `W` linearizes, at which point apply replays them deterministically." Two gaps. (1) `flag/optimistic/<W>/<seq>` per §4 is a flag record; the spec never says it retains the **op payload**, so "replays them" has no source of the op to replay. (2) Autobase does not re-deliver already-seen nodes to `apply`; the README's reordering contract undoes and reapplies nodes when the *linearization* changes, but an `ackWriter` that linearizes later is a *new* node, not a reordering that re-presents `W`'s earlier blocks. So the held ops are, in the natural reading, never re-presented to `apply` and silently lost — an I4/I10 violation hiding inside the mitigation. Also unspecified: the order in which held ops replay relative to ops linearized between the hold and the ack.

**Proposed replacement text (§8.2).**

> Held optimistic ops MUST be stored **with their full decoded payload** under `n/hold/<W>/<seq> = <op>` (not merely flagged), plus `flag/optimistic/<W>/<seq>`. When an `AddWriter`/`ackWriter` for `W` linearizes, `apply` MUST, in the same pass, range-scan `n/hold/<W>/*` in ascending `seq` order and fold each held op through the normal §5 pipeline **at the ack's linearized position** (their effect is as if they occurred there; this is deterministic because both the held set and the pipeline are pure functions of the linearized prefix), then delete `n/hold/<W>/*` and clear the optimistic flags. Ops from `W` that arrive after the ack are applied normally. Because Autobase does not re-present earlier nodes, the payload MUST live in the view (`n/hold/`), never solely in Autobase node history. This retains v2's do-not-apply-until-ack guarantee (I10) without depending on re-delivery.

### M7 (major) — §5.4/§6/§11: no op resolves conflicts or drains flags

**Exploit narrative.** I7 states conflict flags "persist until an explicit resolving op," and §6 says reconciliation is "an agent consuming the flag queue." But §3.2 defines **no op** that resolves a `flag/conflict`, picks a body head, or clears any flag. An agent that "consumes the flag queue" can *read* flags but has no write vocabulary to *resolve* them: emitting a fresh `SetBody` creates a new revision citing some base but does not clear the sibling `flag/conflict/<s>/<revA>/<revB>` (that key is not a function of the new op). So conflict flags accumulate forever, unreachable by any op, and §11's `PruneRevisions` explicitly refuses to prune revisions "referenced by an open `flag/conflict`" — meaning an unresolvable conflict pins its revisions against GC permanently. The flag namespace is therefore monotonic and, for conflicts, uncollectable: a slow adversarial (or merely concurrent) stream of same-base `SetBody`s is an unbounded storage-growth vector that §11's mitigations do not touch.

**Proposed replacement text (§3.2 + §6).**

> Add op `ResolveConflict { s, keep: revHash, supersede: [revHash, ...], text?: string }` (any writer within its namespace). `apply` sets `n/<s>/body = keep` (or a new revision from `text` whose `base` is `keep`), and clears every `flag/conflict/<s>/<a>/<b>` where `{a,b} ⊆ {keep} ∪ supersede`. Superseded revisions become prunable (§11). Add general op `ClearFlag { flagKey }` restricted to flags whose semantics permit manual clearance (audit flags: `clobber`, `staletag`, `epoch`, `govoverride`, `danglingretarget`); structural flags (`unmapped`, `dangling`, `conflict`, `kindmismatch`) are cleared only by their defining resolution (a mapping, a target, a `ResolveConflict`, a corrected op) and reject a `ClearFlag` (reason `flag-not-clearable`). This makes I7's "explicit resolving op" real and bounds the flag namespace.

### M8 (major) — §5.6/§10.3: host-key promotion strands values

**Exploit narrative.** §5.6 stores allowlisted host keys under `n/<s>/host/<key>` and permits promotion "by adding a `DefineTerm` for it." But §10.3's backfill on a later `DefineTerm` "re-scan[s] `n/*/f/<term>`" — the **field** namespace, not `n/*/host/*`. So when `tags` is promoted, every historical `tags` value sits under `n/<s>/host/tags` and is never migrated into `idx/*`/`bl/*`; only *future* `tags` writes (which now route to `n/<s>/f/tags`) are indexed. The graph is silently split: pre-promotion tags invisible to queries and export, post-promotion tags visible — with no flag. Additionally, if any pre-promotion `tags` value was *also* written as a field before the allowlist decision (edge case across a deployment changing the allowlist), `materialize` (§9.1 emits `n/<s>/f/*` and §9.1 emits `n/<s>/host/*`) can emit the same YAML key twice → invalid YAML.

**Proposed replacement text (§5.6 promotion clause + §10.3).**

> When a `DefineTerm` promotes a formerly-allowlisted key `k` (i.e. `ctx/` gains a mapping for a key that was host-only), `apply` MUST, in the same pass, migrate every `n/<s>/host/k` into `n/<s>/f/k` under the newly-resolved kind (§5.2), delete the `host/` entries, and run the §10.3 backfill over the migrated fields. Conversely, a key added to the allowlist while mappings exist is a configuration error the loader MUST reject at startup. `materialize` MUST treat `f/` and `host/` as disjoint by construction (this migration guarantees it) and MUST error if a subject ever holds both `f/k` and `host/k`.

### M9 (major) — §9.2: field removal and note deletion are inexpressible

**Exploit narrative.** §9.2: ingest "diff[s] frontmatter against view state per field ... emit the minimal op set." A human deletes the `prepTimeMinutes:` line from `hummus.md`, or deletes `hummus.md` entirely. The op schema (§3.2) has `SetField` (assign), `AddMember`/`RemMember` (set elements), `SetBody` — but **no op unsets a scalar field or deletes a subject**. So the ingest watcher cannot represent either edit; the deleted field persists in the view and re-materializes on the next pass (the human's deletion is silently reverted — a data-integrity failure on the primary human-facing path, and arguably an I4 violation: the human's *removal* has no effect and no flag). Two implementers will invent incompatible conventions (a `SetField` with `o: null` vs a magic tombstone value), diverging observably.

**Proposed replacement text (§3.2 + §9.2).**

> Add ops `UnsetField { s, p, tag }` (clears the lww register / removes the term's field state; cross-writer removal of a present value flagged per §5.4) and `DeleteSubject { s, tag }` (writes a `n/<s>/deleted` tombstone that suppresses the subject from `materialize`, `idx/*`, `bl/*`, and export while retaining body revisions until pruned; a later op re-creating `<s>` clears the tombstone and is flagged `flag/undelete/<s>` for audit). Ingest emits `UnsetField` for a removed frontmatter line and `DeleteSubject` for a removed file (subject to a configurable "deletions require confirmation" guard, since a dropped file may be accidental). Deletion is LWW under linearization; a concurrent write to a deleted subject writes `flag/conflict`-style `flag/writeafterdelete/<s>/<tag>` (I4).

### M10 (major) — §10.3/§5.5: kind-change on redefinition has no view migration

**Exploit narrative.** §5.5 handles a *differing* `DefineTerm` by flagging shadow. But if the differing redefinition **changes the kind** — `prepTimeMinutes` from scalar to `@container: @set`, or `subClassOf` from `@set` to scalar — every existing `n/<s>/f/<term>` for that term is now stored in the wrong shape (a register where an element map is expected, or vice versa). §5.2 resolves kind "at the op's linearized position," so ops *after* the redefinition apply under the new kind while stored state from *before* is in the old shape; `materialize`/`export` (§10.2) then read a register as a set (or vice versa) → malformed output, and the mismatch is deterministic but silent. No section specifies migrating existing state on a kind-changing `DefineTerm`.

**Proposed replacement text (§5.5).**

> When a `DefineTerm` changes a term's **kind** (scalar↔`@set`, or mapped↔unmapped), `apply` MUST, in the same pass, migrate every existing `n/*/f/<term>`: scalar→set converts the register's value(s) to element-map entries under a synthetic tag `writerKey||seq` of the `DefineTerm` op; set→scalar collapses the element map to an lww register deterministically (the element whose tag is greatest in linearized order wins) and writes `flag/kindcollapse/<s>/<term>` per subject that had >1 element (I4: the collapse is lossy and audited). This is in addition to `flag/shadow`. The I8 test suite MUST include a kind-changing redefinition and assert `idx/*` and export remain well-formed.

### Minor findings (proposed text condensed)

**m1 — §8.4 `seq` availability.** The autobase README documents only `node.value` and `node.from.key` inside apply; `seq` (the per-writer index) is asserted "available from the Autobase node metadata" but not shown. *Fix:* §8.4 add: "Verify against the current autobase API that a per-writer sequence/index is exposed on the apply node; if only `from.key` is available, key rejections as `flag/rejected/<writerKey>/<lengthAtApply>` using the view-maintained per-writer applied count, which is a pure function of linearized order. Record the resolution in DEVIATIONS.md."

**m2 — §5.2 `AddMember` on unmapped overwrites verbatim.** The table stores `AddMember` on an unmapped term "as single-valued," overwriting a prior unmapped value with no flag beyond `unmapped`. *Fix:* accumulate unmapped multi-writes into an ordered list under `n/<s>/f/<term>` so a later `DefineTerm` backfill (§10.3) can recover all authored values; never overwrite silently.

**m3 — §6/§3.2 hash-input encodings.** "hash covers `base` and `text`" (§6) and "hash of the `ctx/` sub-tree" (§5.7) omit the exact byte construction (length-prefixing, separator, hash function). Two implementers produce different revHashes → I2 fails across implementations. *Fix:* specify `revHash = SHA-256(len(base)||base||len(text)||utf8NFC(text))`, hex lowercase; specify the ctx tree-hash as an ordered Merkle over `ctx/` entries in byte-key order.

**m4 — §9.2 wiki-link grammar unassigned.** vault-ld §4.4.1 (alias ignored, fragment discarded-with-optional-warning, path disambiguation, same-name ambiguity MUST-warn) is assigned to no component. *Fix:* §9.2 add: ingest parses `[[...]]` per vault-ld §4.4.1; resolution/ambiguity warnings surface as `flag/linkambiguous/<s>/<term>/<target>`.

**m5 — §10.3 backfill cost / DoS.** Backfill "re-scan[s] `n/*/f/<term>`" — a full note-space scan per `DefineTerm`, with no term-keyed reverse index. Repeated `DefineTerm` (allowed within the rate ceiling) is a super-linear apply-time cost amplifier. *Fix:* maintain `unmapped-idx/<term>/<s>` when writing `flag/unmapped`, so backfill is a bounded range scan, not a full walk.

**m6 — §11 snapshot trust.** "an indexer MAY publish a signed view snapshot" — signed by one indexer or a quorum? Verified how by the bootstrapping peer? *Fix:* require quorum co-signing matching `signedLength`'s quorum, and specify the peer verifies the snapshot hash chains to a signed system-core checkpoint before trusting it.

**m7 — §8.6 prefix matching.** `namespacePrefixes` matching mode is undefined; byte-prefix lets `agents/alice` match `agents/alicecooper`. *Fix:* define matching on **path segments** after NFC (`p` matches `s` iff `s == p` or `s` starts with `p + '/'`).

**Nits.**

**n1 — §1/§3.2 hyperdispatch.** The required-reading source `https://github.com/holepunchto/hyperdispatch` has a **one-sentence README** ("Generate operations/endpoints using Hyperschema"); the spec's §3.3 append-only-wire-contract claims cite semantics that the README does not document. *Fix:* cite Hyperschema directly and state that the append-only discipline is this spec's own requirement, not inherited from hyperdispatch docs.

**n2 — §9.4 TOCTOU.** The mtime/hash check and the subsequent `rename` are not atomic together; a write landing between check and rename is still clobbered. *Fix:* hold the per-path in-flight lock across check+rename, and re-stat under lock immediately before rename.

---

## 5. Conformance matrix (vault-ld SPEC.md MUST/SHOULD vs v2 spec)

| vault-ld requirement (verbatim topic, §) | v2 § | Status |
|---|---|---|
| Note MUST NOT carry own `@context` (§4.2) | — | **N/A** (ops carry no `@context`; materialize emits shared context only) — OK |
| SHOULD warn on *differing* term/prefix redefinition; identical redecl warrants no warning (§4.2) | §5.5 | **PASS** |
| MUST honour keyword aliases `type`/`id`, treat aliased+keyword identically (§4.3) | — | **FAIL → M2** |
| Host-tool keys: MUST NOT emit as triple, MUST NOT warn while unmapped (§4.3) | §5.6 | **PASS** |
| Promotion of a host key to a real term, then emitted/roundtripped/shadow-checked (§4.3) | §5.6 | **PARTIAL → M8** (promotion strands prior values) |
| Object properties/`@type` are ALWAYS wiki links (§4.4) | §3.2 `o.ref` | **PARTIAL** (ref marked; `@type`-as-set unhandled → M2) |
| Wiki-link resolution: alias ignored, fragment discarded, path disambiguates, same-name MUST warn (§4.4.1) | §9.2 | **FAIL → m4** |
| Dangling link MUST be flagged; MAY mint IRI **in the data namespace** (§4.4.1) | §7 | **PASS** (mint base correct; takeover exceeds spec, acceptably) |
| Identity mints from file name alone + governing `@base`; folders never enter IRI (§4.5) | §10.1, §7 | **PARTIAL → M4** (governing `@base` derivation missing) |
| Percent-encode non-IRI-safe chars per RFC 3987, after which equal names mint equal IRIs (§4.5) | §3.1 | **PASS** (NFC-then-percent-encode ordering specified) |
| Explicit `id` MUST be full absolute IRI, used verbatim; relative is non-conforming; overrides minting; disambiguates same-named notes (§4.5) | — | **FAIL → M2** (no `@id` handling; same-named notes silently merge) |
| Ingest SHOULD percent-decode names when choosing file names (§5.5) | §9.2 | **PARTIAL** (NFC covered; decode not stated) — fold into M2/M4 fix |
| Resource-per-file canonical placement; file name MUST equal resource name (§5.1) | §9.3 | **PARTIAL → M4** (ontology-name/scope underivable) |
| Hierarchy declared in frontmatter only; MUST NOT derive from folders (§5.2) | §5.1/§9 | **PASS** (log carries no folders; hierarchy is field state) |
| Export step 5: layer decided from folder (Ontologies/Vocabularies = schema) (§5.4) | §10.1 | **PASS-by-substitution** (derives layer from `@type`; deviation recorded; §10.1 mirrors step-5 intent without folders) |
| Export step 6: mint against governing `@base`, folders never enter IRI (§5.4) | §10.1 | **FAIL → M4** |
| Export step 7 / §5.5: `vld:path` emitted for non-reconstructable placement, consumed on ingest, never in frontmatter (§5.4/§5.5) | §9.3, §10.4 | **PARTIAL → M5** (semantics right; no op transports the path) |
| Export step 8: emit by layer to `schema.ttl`/`data.ttl` (§5.4) | §10.1 | **PASS** |
| Unmapped construct MUST be flagged, not dropped; recoverable by extending context (§5.6) | §5.6, §10.3 | **PASS** |
| Generated face is read-only; MUST preserve existing bodies, not clobber on regeneration (§5.6, §6) | §9.4, §6-analog | **PASS** (structural + on-disk atomicity) |
| Body never emitted as RDF (§5.3/§5.6) | §6 | **PASS** (bodies are revisions, never triples) |
| `id` collision (two same-named notes) MUST warn (§4.4.1/§4.5) | — | **FAIL → M2** |
| `@container: @set` semantics (subClassOf etc. in example context) (§Appendix A) | §5.1/§5.2 | **PASS** for `@set`; **FAIL → M3** for non-`@set` multi-valued terms |

Net: 12 PASS, 5 PARTIAL, 5 FAIL. Every FAIL/PARTIAL maps to B2, M2, M3, M4, M5, M8, or m4 above.

---

## 6. Prior-art summary (novelty stress test)

I ran a genuine prior-art pass against the SU-Set / RDF-CRDT and decentralized-graph-store literature. Sources read:

- **SU-Set** — Ibáñez, Skaf-Molli, Molli, Corby, "Live Linked Data: Synchronizing Semantic Stores with Commutative Replicated Data Types," *IJMSO* 8(2):119–133, 2013 (preprint https://inria.hal.science/hal-00686484). An observed-remove CRDT for RDF graphs under SPARQL Update 1.1; add-wins over concurrent remove-of-unobserved. **This is exactly the construction v2 §5.3 uses**, and the spec correctly cites it by name ("This is the SU-Set observed-remove construction, not C-Set"). Closest prior art to the OR-set half.
- **C-Set** — Aslan et al., 2011 (referenced within the SU-Set work): counter-per-element set CRDT; does not preserve concurrent delete-then-insert intent. v2 correctly distinguishes itself from C-Set.
- **m-ld** — "m-ld: Realtime Information Sharing with RDF," CEUR-WS Vol-2941 paper 1 (https://ceur-ws.org/Vol-2941/paper1.pdf). Synchronizes decentralized JSON-LD graph replicas with CRDT convergence and a json-rql (SPARQL-like) query API; explicitly motivates identifying shared data-type semantics *in the data* so consumers select an implementation. This is the nearest neighbor to v2's "context selects the CRDT per predicate" idea — m-ld already contemplates data-carried type identity driving merge behavior.
- **ComposeDB / Ceramic** — https://developers.ceramic.network/docs/composedb/core-concepts. GraphQL-SDL models are themselves immutable streams on the same network as the documents they type; nodes sharing a model synchronize. This is a schema-as-replicated-object precedent — but the schema is *immutable* and merge is anchor/event-ordering, not schema-selected per-predicate CRDT. (Note: js-ceramic/ComposeDB are being deprecated in favor of ceramic-one.)

**Closest three:** SU-Set (the OR-set mechanism, identical), m-ld (data-carried merge-type selection over RDF), ComposeDB (schema-as-replicated-object).

**What remains novel, honestly.** Per-predicate CRDT *selection* is not novel (SU-Set + schema-driven CRDT selection is anticipated by m-ld's motivation; the LWW/OR-set dichotomy is textbook). What no prior system in this pass does is make the **policy-selecting context a first-class, multi-writer-replicated object in the *same linearized op log* as the data it governs**, so that (a) policy changes are themselves ops ordered against data ops, and (b) the resulting merge is *deterministic-but-epoch-sensitive* — a `DefineTerm` reorder changes semantics deterministically (§5.7). ComposeDB co-locates schema and data on one network but freezes the schema (immutable models); m-ld carries type identity in data but does not linearize policy edits against data edits in a single totally-ordered log with an in-log epoch semantics. **v2's §14 narrowed claim is accurate as written** ("in-log reflexive merge policy ... itself a first-class, multi-writer-replicated object in the same linearized op log ... yielding deterministic-but-epoch-sensitive semantics"). I would only add one honest qualifier: the novelty is an *engineering composition* (SU-Set semantics + Autobase linearization + in-log mutable context), not a new CRDT; the README should say so plainly and stop short of implying a new merge theory. With that qualifier, the claim survives.

---

## 7. Summary for the coordinator

- **3 blockers (B1–B3):** all are prior-finding regressions or the spec's own-adversary-model holes, and all three are internal to §8 governance/determinism. B1 reopens F6; B3 reopens the reorg-stability half of I10; B2 is fresh and the most serious (four ops capture the vault). Each has a bounded, local fix.
- **10 majors, 7 minors, 2 nits**, each with proposed replacement text.
- **18 of 20 prior findings genuinely closed;** F6 open (→B1), F8 reopened altered (→M1).
- **Conformance:** 5 hard FAILs against vault-ld MUSTs, all traceable to two omissions — keyword-alias/`@id` handling (M2) and scoped-`@base` derivation (M4) — plus the JSON-LD multi-value misread (M3).
- **Novelty claim stands** as narrowed in §14, with one added "engineering composition, not new CRDT" qualifier.

Ship-with-changes is *not* the right call while B2 stands — a confirmed agent capturing the indexer quorum defeats the entire reason the system exists. **Do-not-ship; fix B1–B3 and the M-series, then re-review.**