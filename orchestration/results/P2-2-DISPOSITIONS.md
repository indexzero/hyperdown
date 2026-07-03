# P2-2 DISPOSITIONS: Spec v2 → v3

**Input findings:** `orchestration/results/P2-1-SPEC-REVIEW.md` (B1–B3, M1–M10, m1–m7, n1–n2)
**Output spec:** `prompts/01-implementation-spec-prompt.v3.md` (Version 3.0 — 2026-07-03)
**Rule applied:** every blocker's proposed replacement text applied; MAJORs preferred FIXED; minors/nits applied when trivial; no invariant weakened except where a blocker's text explicitly amends one (B3 amends I10's rate-policy scope, recorded below — never silently).

## Blockers (all applied)

| ID | Disposition | Where in v3 | Notes |
|----|-------------|-------------|-------|
| B1 | **FIXED** | §3.2 (`clock` field on every op), §8.3 (rewritten: in-band vector clocks, `ctx/gov/clock/`, `ctx/gov/removed/` = clock of the RemoveWriter node, missing/malformed-clock rejection), §4 (new `ctx/gov/clock/` key), I1 (no peer-local replication state inside apply), §15 (triple-replay test) | The v2 `signedLength`-at-apply-time disjunct is DELETED. Reviewer's argued-and-rejected alternative (purely positional revocation) is rejected as the reviewer chose: it would force weakening I10's reorg-stability; the clock-in-op design is taken instead, and the rejected alternative is recorded in §8.3's closing parenthetical. |
| B2 | **FIXED** | New §8.0 (governance-op authority: issuer must be a confirmed indexer at the op's linearized position; `policy-governance` rejection; genesis indexer seeding; `host.addWriter`/`removeWriter` gated on the check), §4 (`ctx/gov/writer/<key>` now `{indexer, namespacePrefixes, rateCeiling}`), §8.1 (onboarding now references the apply-time check), §8.4 (`policy-governance` in the reason enum), §8.6 (`SetWriterPolicy` routed through §8.0), §11 (`PruneRevisions` marked governance), §15 (non-indexer `AddWriter{indexer:true}` test) | Applied verbatim in substance, including the mandated I10 test. |
| B3 | **FIXED** | §8.5 bullet 1 (writer-local token bucket replenished by accepted indexer ops, R/C as vault metadata constants; naive global-position windows explicitly forbidden), §12 I10 (amended exactly per the reviewer's sentence: reorg-stability for rate policy scoped to at-or-below `signedLength`) | **Explicit invariant amendment (not silent):** I10's stability claim for rate rejections is now scoped to the region at or below `signedLength`, per the blocker's proposed text. All other I10 clauses (revocation, optimistic gating, governance, namespace, size limits) remain unconditionally reorg-stable. Reviewer's position (full order-independence for a rate limit is impossible in principle; scope honestly rather than pretend) is taken. |

## Majors

| ID | Disposition | Where in v3 |
|----|-------------|-------------|
| M1 | **FIXED** | §3.2: `ctxEpoch?: hash` replaced by `ctxKind?: 'scalar' \| 'set'`. §5.7 rewritten as kind pinning: apply under the cited kind on divergence, `flag/epoch` records `{citedKind, applyKind}`, materialize/export rule for dual register+element-map state, pinning SHOULD be default for agent writers. §4 flag comment updated. The unimplementable subtree hash is gone entirely (which also moots the ctx-tree-hash half of m3). |
| M2 | **FIXED** | New §5.8 (keyword terms): `@type` gets OR-set semantics and feeds §10.1's layer rule over the full element set; `@id` is identity — `bad-id` rejection for non-absolute IRIs, `n/<s>/id` storage (LWW, §5.4-flagged), overrides name-based minting in `idx/*`/export/dangling takeover, `flag/idcollision/<iri>` with no merge, `materialize` emits `id:`, foreign-IRI ingest creates explicit-`id` notes with percent-decoding per vault-ld §5.5. §5.2 notes keyword terms resolve before the table; §7 takeover text references explicit `@id`; §4 adds `n/<subject>/id` and `flag/idcollision`. |
| M3 | **FIXED** | §5.1 rewritten: term kinds are exactly {or-set, lww, unmapped}; lww registers hold canonical arrays (scalar-or-array `SetField.o`, canonical element order, one triple per element, whole-array atomic supersession, YAML scalar/flow-array rule, whole-array ingest diffing); `@container: @list` rejected with reason `unsupported-container` and listed as a §13 non-goal — the reviewer's scoping (no `@list` in v1) is taken, not expanded. §5.2 table headers renamed scalar→lww. |
| M4 | **FIXED** | §3.2 adds `DefineScope { scope, base, prefix }` with the reviewer's authority answer recorded (same authority as `DefineTerm`; content, not governance). §10.1 rewritten: `ctx/scope/<scope>` storage with §5.5 shadowing on redefinition; the three-step subject-scope binding rule (authored path → primary-`@type`-defining scope → data namespace) stored in `n/<s>/base` deterministically; `materialize` schema placement `Ontologies/<S>/...`; `flag/noscope/<s>` for underivable scope with data-root fallback; deviations recorded. §4 adds `ctx/scope/<scope>` and `flag/noscope`. |
| M5 | **FIXED** | §3.2 adds `SetPath { s, path }`; §9.3 rewritten so the path travels only as an op (LWW, §5.4-flagged) and `vld:path` ingest emits `SetPath`. §9.4 gains the normative path-safety block: NFC-resolved containment inside vault root, `fs.realpath` on the parent, the four unsafe conditions (separator-in-subject, root escape, absolute path, case-insensitive collision) → skip + `flag/unsafepath/<s>`; `apply` rejects escaping `SetPath` (reason `unsafe-path`); mandatory adversarial `../escape` test carried into §15. §4 adds `flag/unsafepath`. |
| M6 | **FIXED** | §8.2 rewritten: held optimistic ops stored with full decoded payload under `n/hold/<W>/<seq>` plus the flag; on ack, same-pass ascending-seq range scan folded through the §5 pipeline at the ack's linearized position, then hold entries deleted and flags cleared; payload MUST live in the view because Autobase does not re-present earlier nodes. §4 adds `n/hold/`; I10's mutation prohibition carves out `n/hold/`. |
| M7 | **FIXED** | §3.2 adds `ResolveConflict { s, keep, supersede, text? }` and `ClearFlag { flagKey }`; §6 specifies resolution semantics (head set, conflict-flag clearance over `{keep} ∪ supersede`, superseded revisions prunable) and the clearable-audit-flag vs structural-flag partition with `flag-not-clearable` rejection; §11 marks `ResolveConflict`-superseded revisions prunable; I7 now names the resolving ops. |
| M8 | **FIXED** | §5.6 promotion clause: same-pass migration of every `n/<s>/host/k` into `n/<s>/f/k` under the newly-resolved kind, deletion of host entries, §10.3 backfill over the migrated fields; loader MUST reject allowlisting a key that has mappings; `materialize` MUST error on simultaneous `f/k` + `host/k`. §10.3 cross-references the migration. I8 mentions promotion migration. |
| M9 | **FIXED** | §3.2 adds `UnsetField { s, p, tag }` and `DeleteSubject { s, tag }`; §5.2 table gains an `UnsetField` row; §9.2 specifies ingest emission for removed frontmatter lines and removed files, the `n/<s>/deleted` tombstone (suppresses materialize/`idx`/`bl`/export, retains revisions until pruned), `flag/undelete` on re-creation, the deletions-require-confirmation guard, LWW deletion with `flag/writeafterdelete`, and the explicit prohibition on alternative conventions (null/magic values). §4 adds `n/<subject>/deleted` and both flags; §15 adds the deletion-survives-roundtrip acceptance criterion. |
| M10 | **FIXED** | §5.5 gains the kind-change migration rule: lww→or-set converts register values to element-map entries under the `DefineTerm` op's synthetic tag; or-set→lww collapses deterministically (greatest linearized tag wins) with `flag/kindcollapse` per lossy subject; mandated I8 kind-change test carried into §15. §4 adds `flag/kindcollapse`; I4 and I8 updated. |

## Minors (all applied — none deferred)

| ID | Disposition | Where in v3 |
|----|-------------|-------------|
| m1 | FIXED | §8.4: verify per-writer seq exposure against the current autobase API; fallback keying via the view-maintained per-writer applied count (`ctx/gov/clock/`); resolution recorded in DEVIATIONS.md. |
| m2 | FIXED | §5.2 table: `AddMember` on unmapped **appends** to an ordered list, never silently overwrites; §5.6 restates accumulation. |
| m3 | FIXED (half moot) | §6: `revHash = SHA-256(len(base)||base||len(text)||utf8(NFC(text)))`, hex lowercase, with `len` and null-base encodings pinned. The ctx-subtree-hash half is moot: M1's fix removed `ctxEpoch` hashing entirely. |
| m4 | FIXED | §9.2 wiki-link grammar paragraph per vault-ld §4.4.1; `flag/linkambiguous/<s>/<term>/<target>` added to §4. |
| m5 | FIXED | §10.3 + §4: `unmapped-idx/<term>/<subject>` reverse index; backfill is a bounded range scan; full-walk DoS explicitly forbidden. Also reused by §5.5's migration. |
| m6 | FIXED | §11: snapshots quorum-co-signed (same quorum as `signedLength`); bootstrapping peer verifies chaining to a quorum-signed system-core checkpoint. |
| m7 | FIXED | §8.6: path-segment prefix matching after NFC (`s == p` or `s` starts with `p + '/'`); byte-prefix matching explicitly forbidden. |

## Nits (all applied)

| ID | Disposition | Where in v3 |
|----|-------------|-------------|
| n1 | FIXED | §1: hyperdispatch's one-sentence README acknowledged; Hyperschema repo cited directly; §3.3's append-only discipline identified as this spec's own requirement. |
| n2 | FIXED | §9.4: per-path in-flight lock held across mtime/hash check **and** rename, with re-stat under lock immediately before rename. |

## Reviewer positions adopted (argued-and-rejected alternatives)

- **B1:** positional revocation rejected (would weaken I10); clock-in-op taken. Recorded in spec §8.3.
- **B3:** "make the window reorg-proof" rejected as impossible in principle; honest I10 scoping taken. Recorded in spec §8.5/I10.
- **M3:** `@container: @list` support rejected as a v1 non-goal (spec §5.1, §13) rather than adding an ordered-container op family.
- **M4:** `DefineScope` carries `DefineTerm` authority (content, not governance), per the reviewer's own answer. Recorded in spec §3.2.
- **Novelty (review §6):** the "engineering composition, not a new CRDT / merge theory" qualifier added to §14's mandatory README claim.

## Invariant changes (per assignment rule 4)

- **I10** — amended exactly as B3's proposed text: rate-policy reorg-stability scoped to at-or-below `signedLength`; all other clauses unweakened, and the clause list expanded (governance authority per §8.0, `n/hold/` carve-out per §8.2/M6).
- **I1** — strengthened, not weakened: adds "no reads of peer-local replication state inside apply" (consequence of B1's deletion of the `signedLength` disjunct).
- **I4, I7, I8** — extended with the new flags/ops (kindcollapse, idcollision, unsafepath, undelete/writeafterdelete; ResolveConflict/ClearFlag; promotion and kind-change migrations). No clause removed or relaxed.
- I2, I3, I5, I6, I9 — unchanged.

## BACKLOG CANDIDATES

None. All minors and nits were trivially applicable and are in v3.
