# SPEC-REVIEW.md — Adversarial Review of "Vault-LD on Autobase: Implementation Specification"

**Reviewer role:** hostile spec reviewer (did not write the spec).
**Artifact under review:** `prompts/01-implementation-spec-prompt.md`.
**Primary sources fetched and cited:** vault-ld `SPEC.md`, `README` (The-Knowledge-Graph-Guys/vault-ld); holepunchto `autobase`, `autobee`, `hyperbee`, `hyperdispatch` READMEs; SU-Set / Live Linked Data (Inria), m-ld, NextGraph, ElectricSQL Rich-CRDTs, protobuf schema-driven CRDTs (Atoms), DXOS ECHO, Ceramic ComposeDB.

---

## 1. Verdict

**Do-not-ship as written — ship-with-changes after the blockers below are closed.**

The architecture is sound and, in several places, genuinely well-defended: making the Autobase op-log the single source of truth and treating every serialization as a pure projection does give I3 (rebuild equivalence) and the clobber-immunity claim *for free by construction*, because Autobase itself rebuilds the view on reorg ("Any changes to the view will be undone and reapplied on top of the new ordering" — autobase README). The op-log-as-source-of-truth also means the totally-ordered log *is* the tombstone store, which quietly disarms half of the usual OR-set bookkeeping problem.

But the spec asserts ten invariants (I1–I10) as achievable and at least five of them are **not** achievable as written, because the spec leaves load-bearing behavior undefined or contradicts its own I4 ("no silent loss"). The failures cluster in three places: (a) determinism leaks that break I1/I2 across peers and implementations (Unicode subject normalization, YAML/Turtle literal formatting, undefined op×term-kind behavior); (b) I4 violations the spec explicitly accepts (LWW scalar overwrite with no flag; undecodable ops that cannot be flagged); and (c) vault-ld non-conformance that makes the acceptance criteria fail (the schema/data export split cannot be computed from the view; `vld:path` roundtrip triples are absent; host-tool keys are wrongly flagged). None of these are unfixable, and each finding below carries proposed replacement text.

---

## 2. Findings table

| ID | Sev | Spec § | Title |
|----|-----|--------|-------|
| F1 | **blocker** | §3, §9, I1/I2 | Subject-key Unicode normalization is unspecified; `Café` (NFC) ≠ `Café` (NFD) → divergent IRIs/keys across peers |
| F2 | **blocker** | §4, §5, §3, I2 | op-type × term-kind mismatches (`AddMember` on scalar, `SetField` on `@set`, `RemMember` on scalar) have no defined behavior → implementer divergence |
| F3 | **blocker** | §8, I4 | An op that fails *decoding* cannot be flagged (no subject to key on) → silent loss, I4 violated |
| F4 | **blocker** | §5, §6, I4/I6 | Losing LWW scalar write disappears with **no flag** → contradicts I4 as literally written |
| F5 | **blocker** | §10, §9, I9 | The schema-vs-data export split (vault-ld §5.4 step 5) is decided by *folder*, which the op-log/view does not carry → export cannot be partitioned conformantly |
| F6 | **blocker** | §8, I10 | "Revocation point" is undefined under reorg; if pinned to linearized index it is not reorg-stable → I10 not well-defined |
| F7 | major | §5, §10, I1/I9 | YAML/Turtle literal formatting (floats, dates, language tags, `xsd` lexical forms) is unspecified → byte-nondeterministic export |
| F8 | major | §5, README | Policy-epoch reordering is "documented, not fixed"; no epoch-pinning option offered even where cheap |
| F9 | major | §3, §5, I5 | `RemMember` citing **unknown/未observed tags** has no defined apply behavior; the "where do writers learn tags" citation contract is unstated |
| F10 | major | §5, §7, §9, vault-ld §5.6 | Unmapped values are stored + flagged but **never re-exported** (no predicate IRI → absent from `idx/spo`) → roundtrip loss |
| F11 | major | §9, vault-ld §4.3 | Host-tool keys (`tags`, `aliases`, `cssclasses`) will be flagged `unmapped`, violating vault-ld "MUST NOT warn" |
| F12 | major | §7, vault-ld §4.4.1/§4.5 | Dangling-IRI mint does not specify the governing `@base`; wrong base → later real note does not take over the IRI (I7 defeated) |
| F13 | major | §9, §10, vault-ld §5.4/§5.5 | `vld:path` roundtrip triples are never emitted or consumed → materialized vault is not roundtrip-faithful; placement is lost |
| F14 | major | §8 | Flag flooding: flags are view writes; rate ceilings are themselves ops in the same log → a burst linearizes ahead of the limiting op (view-bloat DoS) |
| F15 | major | §5, §6, §8 | No compaction / GC / revision pruning; unbounded growth is quantified below and must be accepted in writing or mitigated |
| F16 | major | §8 | Per-writer namespace restrictions are named but unspecified: no assigning op, no merge rule when two indexers disagree |
| F17 | minor | §5, vault-ld §4.2 | `flag/shadow` is written on *any* redefinition; vault-ld requires warning only on a **different** definition (identical redeclaration → no warning) |
| F18 | minor | §8 | Optimistic-writer op visibility before confirmation is unpinned; self-verification requirement from autobase README not reflected |
| F19 | minor | §9 | On-disk race between the ingest watcher and `materialize` writing the same file is not addressed (structural immunity is a view claim, not a filesystem claim) |
| F20 | nit | §1, §3 | hyperdispatch schema evolution (handlers must be append-only / never reordered) is not called out as a determinism constraint on the op wire format |

---

## 3. Findings detail

### F1 — Subject-key Unicode normalization unspecified (blocker, §3/§9, breaks I1/I2)

**Exploit.** Agent A creates note `Café.md` where `é` is a single NFC codepoint `U+00E9`. Agent B, running on macOS (which routinely hands back NFD from the filesystem), ingests a human-created `Café.md` where `é` is `U+0065 U+0301`. Both emit `SetField { s: "Café", ... }` but the two subject strings are **different byte sequences**. In the view they become two distinct keys `n/Café/...`; on export they mint two distinct IRIs. Peers that ingested from different OSes now have non-bit-identical views. **I2 fails**, and it fails silently.

**Primary source.** vault-ld `SPEC.md` §4.5 specifies *percent-encoding* of non-IRI-safe characters ("A tool MUST percent-encode the offending characters per RFC 3987, so `Red Lentil Soup.md` mints `.../Red%20Lentil%20Soup`") but says **nothing about Unicode normalization**. It is silent on NFC/NFD. Hyperbee sorts purely on "the binary value of the keys" (hyperbee README), so two normalizations sort and key differently. The spec's own I1 bans "map-iteration-order dependence" and float variance but omits the normalization hazard entirely.

**Proposed replacement text (add to §3 and §4).**
> Before a subject or term is used as a Hyperbee key, as an IRI-minting input, or as a hash input, it MUST be normalized to Unicode **NFC** (`String.prototype.normalize('NFC')`). Ingestion MUST NFC-normalize file names read from disk before diffing or emitting ops, because platform filesystems may deliver NFD. Percent-encoding per vault-ld §4.5 is applied **after** NFC normalization. Two subjects are the same subject iff their NFC-normalized, then percent-encoded, byte sequences are equal. This is an I1/I2 requirement, not a nicety.

---

### F2 — op-type × term-kind mismatch undefined (blocker, §3/§5, breaks I2)

**Exploit.** The op schema in §3 permits `AddMember { s, p, o }` regardless of how `p` is mapped. Sequence: `DefineTerm` maps `prepTime` as a scalar (datatype). Later `AddMember { s:"Hummus", p:"prepTime", o:25 }` linearizes. §5 defines OR-set semantics for `@set` terms and LWW for scalars, but says nothing about `AddMember` on a scalar term. Implementer X stores it as a degenerate one-element OR-set; implementer Y coerces to LWW and overwrites; implementer Z flags and skips. All three are "reasonable." Their views diverge on identical logs → **I2 fails across implementations**, and even a single implementation has no defined convergence target to test against. The reverse case (`SetField` on a `@container:@set` term) and `RemMember` on a scalar are equally undefined.

**Primary source.** This is an internal contradiction: §5 claims "MUST be implemented exactly" while enumerating only the matching cases. Nothing in the vault-ld field-naming contract (§4.3, datatype-property-is-scalar / object-property-is-wiki-link) forbids an author or agent from emitting the wrong shape.

**Proposed replacement text (new §5 subsection "Op/kind reconciliation table").**
> `apply` MUST resolve the term kind from `ctx/` at the op's linearized position and apply this total table. Every cell is mandatory; none may be left to the implementer.
>
> | incoming op | term kind = scalar | term kind = `@set` | term kind = unmapped |
> |---|---|---|---|
> | `SetField` | apply LWW | **coerce**: treat as `AddMember` that first clears the set? **No** — reject: write `flag/kindmismatch/<s>/<p>/<tag>`, do not mutate `n/` | store verbatim + `flag/unmapped` |
> | `AddMember` | reject: `flag/kindmismatch`, do not mutate | apply OR-set add | store verbatim + `flag/unmapped` (as single-valued) |
> | `RemMember` | reject: `flag/kindmismatch` | OR-set remove-by-observed-tags (see F9) | no-op + `flag/unmapped` |
>
> "Reject" means the op leaves a flag (satisfying I4) and never mutates `n/`, `ctx/`, or `idx/`. Choose one policy for each cell and freeze it; the choice is normative because it is observable in the view.

*(The table above intentionally rejects rather than coerces on mismatch; coercion is defensible but must be the single chosen rule. What is not defensible is leaving it open.)*

---

### F3 — undecodable op cannot be flagged → silent loss (blocker, §8, breaks I4)

**Exploit.** A malicious/buggy writer appends a block that fails hyperdispatch/compact-encoding decoding (truncated buffer, unknown message id, corrupt length prefix). `apply` receives it. §8 says violating ops are "recorded under `flag/` and not applied," and I4 says "no op's effect disappears without a flag." But **the flag key space is subject-indexed** (`flag/unmapped/<subject>/<term>`, etc.) and an undecodable op yields no subject, term, or tag to key the flag on. The effect (the fact that a writer attempted an op) vanishes with no record keyed anywhere retrievable. **I4 is violated for exactly the adversarial case the design exists to defend against.**

**Primary source.** hyperdispatch's purpose is "Generate operations/endpoints using Hyperschema"; unknown/removed message ids are a real decode-failure mode, which is why F20 (append-only schema) matters. autobase README requires apply to be "fully deterministic" — so the decode-failure handling must itself be deterministic, not a thrown exception that aborts the batch.

**Proposed replacement text (§8, new "Undecodable and structurally invalid ops").**
> `apply` MUST NOT throw on a malformed op; a throw would be nondeterministic across node versions and could stall the view. Instead: ops are flagged in a **writer/seq-keyed** namespace that requires no successful decode:
> `flag/rejected/<writerKey>/<seq>` → `{ reason, rawHashHex }`, where `reason ∈ {undecodable, oversize-subject, oversize-op, depth-exceeded, unknown-msgid, policy-namespace, policy-rate, kindmismatch, garbage-base}`.
> Because `<writerKey>/<seq>` is available from the Autobase node metadata **before** payload decode, every attempted op is flaggable, closing the I4 hole. Hard limits MUST be defined and enforced pre-decode: subject ≤ 1024 bytes, single op payload ≤ 64 KiB, literal nesting depth ≤ 64. Ops exceeding a limit are rejected under `flag/rejected` and never mutate `n/`.

---

### F4 — losing LWW scalar write vanishes with no flag → I4 contradiction (blocker, §5/§6, breaks I4)

**Exploit.** Human user sets `status: draft` on note `Recipe`. Two seconds later (wall clock) an agent sets `status: published`. Autobase linearization happens to order the human's op *after* the agent's (linearization is "never wall-clock" per §5, and the human's core was slow to gossip). The view shows `status: draft`; the agent's `published` is gone. Symmetrically, a human's correction can be silently reverted by a stale agent write. §5 says this is "fine" and §6 makes the body head "LWW under linearization." But **I4 states "no op's effect disappears without a flag"** and enumerates only unmapped/dangling/shadowed/conflicting/policy-rejected as the flagged cases — an overwritten LWW register is none of these. A losing scalar write's effect disappears with **no flag**. For a wiki with untrusted agents, this is exactly the perceived-data-loss scenario, and it is unauditable.

**Primary source.** Internal contradiction between §5/§6 ("this is fine," "no tie to break") and I4 ("no op's effect disappears without a flag"). Contrast m-ld, which under RDF *set* semantics unions concurrent property writes rather than dropping one (m-ld spec: array properties have Set semantics, "concurrent insertions naturally commutative"); m-ld reserves silent loss for genuine single-value registers and surfaces app-level invariants via `@agree`. The spec here silently drops on *every* scalar.

**Proposed replacement text.** Pick one and state it:
> **Option A (narrow I4 — cheapest):** Amend I4 to: "no op's effect disappears without a flag, *except a scalar LWW register write that a later-linearized write to the same (subject, term) supersedes; supersession is the defined semantics of a register and is not loss.*" Additionally, `apply` MUST retain, under `n/<s>/f/<term>/superseded`, the count and the `{writerKey, seq}` of the most recent superseded write, so the loss is auditable even though it is intended.
>
> **Option B (surface it — stronger):** On any `SetField` whose linearized predecessor for the same (subject, term) came from a **different writer** and carried a different value, write `flag/clobber/<s>/<term>/<tag>`. Human tooling drains this queue. This makes I4 literally true and gives agents a signal that they overwrote a human.

Do not leave I4 and §5 mutually contradictory.

---

### F5 — schema/data export split cannot be computed from the view (blocker, §10, breaks acceptance/I9-conformance)

**Exploit.** vault-ld `SPEC.md` §5.4 step 5 is explicit: "Decide layer from folder: `Ontologies/` and `Vocabularies/` = schema; everything else = instance," and §5.1 places schema resources under `Ontologies/{Name}/Classes/…` etc. **The op-log carries no folders.** A `SetField { s:"Recipe", p:"type", o:"owl:Class" }` and a `SetField { s:"Hummus", p:"type", o:"[[Recipe]]" }` are indistinguishable structurally in `n/`; the only signal that `Recipe` is schema and `Hummus` is data was the on-disk folder, which the source-of-truth design deliberately discarded (§2: "No component ever treats a generated face as authoritative"). Therefore `exportTurtle` (§10) **cannot** partition into `schema.ttl` / `data.ttl` as vault-ld §5.4 step 8 requires. The output will either lump everything into one file or guess by `rdf:type`, which vault-ld does not sanction. Acceptance criterion "`exportTurtle` … partitioned per the spec's schema/data split" fails.

**Primary source.** vault-ld `SPEC.md` §5.4 steps 5 & 8; §5.1. The layer is a *folder* fact, and §4.5/§5.2 insist "folders never enter the IRI" and "folder placement asserts nothing" *about the graph* — but layer partitioning of the *export* is nonetheless folder-derived, a subtlety the implementation spec missed.

**Proposed replacement text (§4 view layout + §10).**
> Layer is graph-relevant metadata for export and MUST be materialized into the view, since the log discards folders. Add a per-subject record `n/<subject>/layer` ∈ `{schema, data}`, derived deterministically: a subject is `schema` iff it carries `@type` resolving to `owl:Ontology|owl:Class|owl:ObjectProperty|owl:DatatypeProperty|rdfs:Class|rdf:Property|skos:ConceptScheme|skos:Concept`, else `data`. This mirrors vault-ld §5.4 step 5 without needing folders. `exportTurtle` partitions `schema.ttl` vs `data.ttl` by this record. Also materialize the governing scope/`@base` per subject (needed for F12) as `n/<subject>/base`. Note in DEVIATIONS.md that layer is inferred from `@type` rather than folder, and that a schema subject lacking a recognized meta-type defaults to `data`.

---

### F6 — revocation point undefined under reorg (blocker, §8, breaks I10)

**Exploit.** Indexer emits `RemoveWriter { key: Mallory }`. Concurrently (no causal reference between them) Mallory appends ops o1, o2. A partition heals; Autobase linearizes. On the first linearization `RemoveWriter` lands at index 100 and o1 at 101 (post-revocation → must be rejected). A later indexer's late block causes a reorg (autobase README: "existing nodes may be reordered when causal forks occur"); now `RemoveWriter` lands at 130 and o1 at 129 (pre-revocation → applied). The same op flips between applied and rejected across reorgs. I10 says removed-writer ops "after revocation point … never mutate `n/`," but "after" defined by mutable linearized index is not reorg-stable, so **I10 is not well-defined** and its test cannot converge (violating I3 for the governance sub-view).

**Primary source.** autobase README: reordering is intrinsic ("Any changes to the view will be undone and reapplied on top of the new ordering"); the README "does not specify whether removed writers' pending operations are applied or dropped," so the spec must define it, not defer to Autobase. `signedLength` gives a *finalized* prefix ("checkpoints after which the ordering of the graph will never change"), which is the only reorg-stable anchor.

**Proposed replacement text (§8).**
> The revocation point MUST be defined in **causal**, not index, terms: an op `x` from writer `W` is *post-revocation* iff the `RemoveWriter{key:W}` node causally precedes `x` in the Autobase DAG (i.e., `x` transitively references it), **or** `RemoveWriter{key:W}` is at or before `signedLength` at the time `x` is linearized and `x` is beyond it. Ops that are causally concurrent with the removal and both fall before `signedLength` are resolved once by the finalized linear order and never revisited. Formally: `apply`, when it reaches a `RemoveWriter{key:W}` node, records `ctx/gov/removed/<W> = <this node's causal clock>`; any subsequent op from `W` whose causal clock does not strictly precede that node is rejected under `flag/rejected/<W>/<seq>` (reason `revoked`). This is a pure function of the DAG and stable across reorg. Add an I10 test that reorders the log and asserts the applied/rejected partition is invariant.

---

### F7 — literal formatting nondeterminism (major, §5/§10, dents I1/I9)

**Exploit.** `prepTimeMinutes: 25.0` vs `25` vs `2.5e1`; a date `2026-07-03` vs `2026-07-03T00:00:00Z`; a float `0.1 + 0.2`. Two peers with byte-identical views but different YAML/Turtle emitters produce different `data.ttl` and different materialized frontmatter, so a full range-scan hash differs → **I9 fails** even though I2 (view identity) holds. The spec says "stable literal formatting" and "canonical … object ordering" but never pins the lexical form.

**Primary source.** I1 already bans "floating-point formatting variance"; §10 asserts byte-determinism without a canonicalization rule. hyperbee gives byte-sorted keys but says nothing about value *rendering*.

**Proposed replacement text (§10, "Canonical literal forms").**
> Literals MUST be stored and emitted in canonical lexical form: `xsd:integer` with no decimal point or leading zeros; `xsd:decimal`/`xsd:double` per the XSD canonical mapping (never platform `toString`); `xsd:dateTime`/`xsd:date` in canonical ISO-8601 with explicit `Z`; booleans as `true`/`false`; strings NFC-normalized (F1) with Turtle escaping applied in a fixed codepoint order; language tags lowercased. Turtle prefix order, subject order, predicate order (by IRI byte value), and object order (by term byte value) are all fixed ascending. YAML materialization emits scalars via the same canonical mapping, not the YAML library's default float/date rendering. This is an I1/I9 requirement.

---

### F8 — policy-epoch reordering merely documented (major, §5)

**Steelman first.** The spec is right that this stays *deterministic*: any two nodes with the same linearized log compute the same view (I1/I2 hold). Documenting the surprise is honest. So this is **not** a determinism blocker, and I downgrade it from the reflex "blocker."

**Exploit that survives.** `DefineTerm` maps `authors` as scalar. Agent A, reading a view where `authors` is scalar, does `SetField{authors:"Ada"}`. Indexer B concurrently does `DefineTerm` flipping `authors` to `@container:@set`, then `AddMember{authors:"Ada"}` and `AddMember{authors:"Bob"}`. A late indexer reorg places B's `DefineTerm` *before* A's op. Now A's `SetField` is reinterpreted under `@set` (per the F2 table, either coerced or rejected). The *human-observed* meaning of A's write changed although A never saw the new policy. Documenting "this is surprising" does not let A pin intent. For a wiki maintained by untrusted agents, silent semantic reinterpretation of an already-accepted write is a real hazard.

**Position.** Ship with the documented caveat **and** offer opt-in epoch pinning; do not make pinning mandatory (it costs a context read per op and most ops don't need it).

**Proposed replacement text (§3 op schema + §5).**
> Ops MAY carry an optional `ctxEpoch: <hash of the `ctx/` sub-tree the writer resolved against>`. When present, `apply` compares it to the `ctx/` state at the op's linearized position; if they differ for the specific term the op touches, `apply` MUST apply the op under the **writer-cited** epoch's kind and additionally write `flag/epoch/<s>/<term>/<tag>` recording both epochs, so the reinterpretation is auditable and, if desired, replayable. Writers that omit `ctxEpoch` accept apply-time policy (current behavior). The README MUST still state the caveat plainly for the omit-case.

---

### F9 — `RemMember` on unknown tags undefined; tag-citation contract unstated (major, §3/§5, I5)

**Exploit.** §3: `RemMember { s, p, tags:[opId,...] }`, "remove by observed tags." Where does a writer *learn* tags? From its own possibly-stale view. Writer C's view shows member `M` present via tag `t1`; C emits `RemMember{tags:[t1]}`. Concurrently writer D re-adds `M` as `t2`. Linearized: `AddMember(t1)`, `RemMember([t1])`, `AddMember(t2)`. Result: `M` present via `t2`. That *is* correct OR-set add-wins — good, the core claim holds. **But** the failure case is undefined: what does `apply` do with `RemMember{tags:[t99]}` where `t99` was never added (garbage, or a tag from a since-compacted branch)? Silently no-op? Flag? Two implementers differ → I2 across implementations. And the spec never states the *citation contract* — must a writer cite *all* currently-observed tags for `M`, or any subset? If a writer cites a strict subset, `M` survives via the uncited tag, which may astonish an author who "deleted" it.

**Primary source.** SU-Set (Inria "Live Linked Data") is precisely the observed-remove construction for RDF and specifies remove as "difference over pairs (triple, id)" against *observed* ids; C-Set is cited there as the *broken* predecessor that "does not preserve intention when a delete followed by an insert are executed concurrently." The spec must state which it implements.

**Proposed replacement text (§5).**
> The `RemMember` citation contract: to delete member value `v` from (s,p), a writer MUST cite **every** element-tag currently mapped to `v` in the writer's resolved view (`n/<s>/f/<p>` element map). Client libraries MUST compute this set, not accept a caller subset. `apply` removes exactly the cited tags that are present; a cited tag that is **not present** (never added, or already removed) is ignored *for effect* but recorded once under `flag/staletag/<s>/<p>/<tag>` (satisfies I4 auditability and does not mutate outcome). A concurrent `AddMember` of the same `v` under a new tag is by construction not cited and therefore survives — this is the OR-set add-wins law (I5). Because the totally-ordered Autobase log is retained, `apply` always has the full add/remove history and needs **no separate tombstone store** in the view.

---

### F10 — unmapped values stored but never re-exported (major, §5/§7/§10, vault-ld §5.6)

**Exploit.** vault-ld §5.6: "A construct with no short-name mapping is out of scope until it is added to the context, and a conforming tool MUST flag such a construct rather than silently drop it." The spec (§5) dutifully stores the value verbatim in `n/<s>/f/<term>` and writes `flag/unmapped`. But export (§10) range-scans **`idx/spo`**, and an unmapped term has **no predicate IRI**, so it was never inserted into `idx/spo` (§4: indexes are triple permutations, which require resolved IRIs). Therefore the unmapped value is *trapped in the view*: it is flagged, but it never round-trips back out through `materialize` or `exportTurtle`. If later a `DefineTerm` maps the term, does the previously-stored value retroactively appear in the index? The spec doesn't say. This is preservation-in-name-only.

**Primary source.** vault-ld §5.6 "flag … rather than silently drop"; §5.5 conforming-ingester clause "flag unmapped constructs, do not drop."

**Proposed replacement text (§9/§10).**
> `materialize` MUST walk `n/<s>/f/*` including terms with no `ctx/` mapping and emit them into frontmatter under their original key (they were authored, they round-trip on the Markdown face). `exportTurtle` MUST NOT emit unmapped terms as triples (no predicate IRI exists), matching vault-ld, but MUST NOT lose them: they persist on the Markdown face and in the view. When a later `DefineTerm` supplies a mapping, `apply` MUST re-scan `n/*/f/<term>` for that term and backfill `idx/*` and `bl/*` in the same pass, then clear the corresponding `flag/unmapped`. Add an I8 test that a deferred `DefineTerm` makes previously-unmapped values index-visible.

---

### F11 — host-tool keys wrongly flagged (major, §9, vault-ld §4.3)

**Exploit.** A human's Obsidian note carries `tags: [recipe, vegan]`, `aliases: [Hummus Dip]`, `cssclasses: [wide]`. The ingest watcher (§9) diffs frontmatter and emits `SetField` for each unmapped key → `apply` writes `flag/unmapped/Hummus/tags`, etc. vault-ld §4.3 is explicit: these keys "are unmapped editor affordances. Conforming tool MUST NOT emit as triples and **MUST NOT warn about them**." The spec's design *warns* (flags) on exactly the keys vault-ld says must not be warned. Every Obsidian vault would light up the flag queue with false positives, and worse, agents draining the flag queue would try to "fix" author affordances.

**Primary source.** vault-ld §4.3 "Host-Tool Keys": MUST NOT emit as triples, MUST NOT warn; deployment MAY promote via context.

**Proposed replacement text (§9 ingest + §5 apply).**
> `apply` and the ingest watcher MUST maintain a configurable **host-key allowlist** (default `{tags, aliases, cssclasses, publish, permalink}`). Keys on the allowlist are neither emitted as triples nor flagged `unmapped`; they are preserved on the Markdown face only (stored under `n/<s>/host/<key>` for lossless materialization, never in `idx/*`). A deployment MAY remove a key from the allowlist by adding a `DefineTerm` for it, which promotes it to a real predicate. Only keys that are *neither* mapped *nor* on the allowlist get `flag/unmapped`.

---

### F12 — dangling-IRI mint base unspecified (major, §7, vault-ld §4.4.1/§4.5)

**Exploit.** §7: a `ref` to a nonexistent subject "mints the IRI, writes the triple, and writes `flag/dangling`," and when the target later materializes the flag clears "order-independent in effect." For the takeover to work, the *minted* IRI must equal the IRI the real note will later mint. vault-ld §4.5 mints identity as `governing @base + filename`; instances use the root `@base`, schema notes use the ontology's `@base`. But at dangling time there is **no note**, hence no known governing `@base` — the spec doesn't say which base to use. If dangling mints against the root `@base` but the target later appears as a *schema* note under an ontology `@base`, the two IRIs differ and the dangling flag never clears (I7 fails); worse, the graph carries a phantom instance IRI plus a real schema IRI for the same name.

**Primary source.** vault-ld §4.4.1: dangling link "MAY still mint an IRI for the missing target **in the data namespace**." That phrase resolves the ambiguity — data namespace, i.e., root `@base` — but the implementation spec never states it, so an implementer could pick the referrer's namespace instead.

**Proposed replacement text (§7).**
> A dangling `ref` MUST mint the target IRI in the **data namespace** (root `@base`) per vault-ld §4.4.1, regardless of the referrer's scope, and record `flag/dangling/<s>/<p>/<target>` plus the minted IRI under `n/<target>/mintedAs`. When any op later creates `<target>`: if the new note mints the **same** IRI (an instance at root), `apply` clears the flag and reuses the IRI; if the new note mints a **different** IRI (e.g., a schema note under an ontology `@base`), `apply` MUST NOT silently merge — it rewrites the referring triple to the new IRI, clears `flag/dangling`, and writes `flag/danglingretarget/<s>/<p>/<target>` for audit. Add an I7 test covering both the same-IRI and different-IRI takeover.

---

### F13 — `vld:path` roundtrip triples absent (major, §9/§10, vault-ld §5.4/§5.5)

**Exploit.** vault-ld §5.4 step 7 requires a roundtrip-face export to emit `vld:path "<context-relative path>.md"` for "each note whose actual location an ingester could not reconstruct from the graph"; §5.5 step 1 consumes it on ingest ("written to exactly that path … the triple is consumed — it never appears in frontmatter"). The implementation spec's `materialize` (§9) and `exportTurtle` (§10) never mention `vld:path`. Because the view discards folders (F5), `materialize` cannot know a note's authored subfolder, so it will flatten every instance to the vault root. A human who filed `Recipes/Hummus.md` in a subfolder, ingested it, then re-materialized, gets `Hummus.md` at root — placement lost. And `exportTurtle`, lacking `vld:path`, is not a conforming roundtrip face.

**Primary source.** vault-ld §5.4 step 7, §5.5 step 1, §5.6 "File placement round-trips too … travels with a `vld:path` triple," Conformance Checklist rows 7–8.

**Proposed replacement text (§4 view + §9/§10).**
> Add `n/<subject>/path` = the authored context-relative path, captured by the ingest watcher from the on-disk location (NFC-normalized). `materialize` MUST write each note to `n/<s>/path` when present, else to the vault-ld default reconstructable location (unpinned instance at context root; flat schema placement per §5.1). `exportTurtle`, when producing a **roundtrip** face, MUST emit `vld:path "<path>.md"` for every note whose `n/<s>/path` differs from its reconstructable default, and MUST omit it for defaults and for query-only exports (config flag `roundtrip: bool`). On ingest, a `vld:path` triple is consumed into `n/<s>/path` and never stored as a field. This is required for the "opens cleanly in Obsidian" + roundtrip acceptance criteria.

---

### F14 — flag flooding via same-log rate policy (major, §8)

**Exploit.** §8: "per-writer rate ceilings are checked in apply … Because all effects flow through apply, this is airtight." But the *policy that sets the ceiling is itself an op in the same log*. An agent that is not yet rate-limited appends 2,000,000 `ref`s to distinct nonexistent subjects in one burst. These linearize; each writes a `flag/dangling` entry → 2M view keys, before any indexer's tightening `RemoveWriter`/policy op linearizes ahead of the burst. Even if a policy op exists, Autobase may order the burst *before* it. The flag namespace is the DoS surface, and "airtight in apply" does not bound *pre-policy* bursts. View size can outrun policy because both live in one totally-ordered log.

**Primary source.** autobase README: apply is deterministic over the linearized order; a writer's blocks land wherever linearization places them, which the tightening op cannot preempt.

**Proposed replacement text (§8).**
> Rate ceilings MUST have a **default that applies to every writer from its first op**, enforced by `apply` counting per-writer ops within a linearized window (e.g., ≤ N ops per K linearized positions from that writer), independent of any explicit policy op. Ops beyond the default ceiling are rejected under `flag/rejected/<W>/<seq>` (reason `policy-rate`) and, critically, a rejected op writes **one** rejection record, not a per-target flag, bounding view growth to O(rejected-ops) with tiny constant. Dangling flags MUST be coalesced: `flag/dangling/<target>` keyed by target with a referrer **count**, not one row per (s,p,target), so a fan-out to distinct targets is bounded by distinct-target count, and a fan-out to one target is O(1). An explicit indexer policy op may only *tighten* below the default, never a prerequisite for protection.

---

### F15 — unbounded growth, no compaction story (major, §5/§6/§8)

**Exploit / quantification.** The spec has no compaction, GC, or revision pruning, and §6 makes every `SetBody` revision "immutable … retained forever." Plausible agent swarm: **N = 50** agents, **W = 500** writes/agent/day, one year. Op-log growth ≈ 50 × 500 × 365 ≈ **9.1M ops/year**, each an Autobase block (input core append) — never collectible because Autobase needs history to relinearize on reorg. Body revisions: if 10% of writes are `SetBody` averaging 4 KB → 912K revisions × 4 KB ≈ **3.6 GB/year of body blobs alone**, all retained by §6. The view itself (triples + backlinks + flags) scales with live triples but the *log* and *revision store* grow monotonically. After three years a fresh peer must replay ~27M ops to build the view. The spec must either accept these numbers in writing or add a mechanism.

**Primary source.** autobase relinearizes from history ("existing nodes may be reordered … undone and reapplied"), so naive log truncation is unsafe below `signedLength`. DXOS ECHO solves the analogous Automerge-history-growth problem with **epochs** ("epochs manage the ever-growing history … peers periodically agreeing to create a new Epoch as a 'new beginning'") — a proven pattern the spec ignores.

**Proposed replacement text (§6 + new §"Compaction").**
> v1 MUST state the retention numbers above in the README as accepted cost, **and** MUST define a snapshot/epoch mechanism even if pruning is deferred: at `signedLength` checkpoints, an indexer MAY publish a signed **view snapshot** (a Hyperbee checkout hash) so new peers bootstrap from the snapshot rather than replaying the whole log; ops below the snapshot's `signedLength` become archival. Body revisions MUST support a `pruneBefore(revHash)` op (indexer-only) that removes non-head revisions older than a cutoff except those referenced by an open `flag/conflict`; pruning is itself a logged op so it is deterministic and auditable (I1/I4). Absent this, DXOS-style epochs are the documented future direction.

---

### F16 — namespace restrictions unspecified (major, §8)

**Exploit.** §8 mentions "per-writer namespace restrictions … checked in apply" but defines no op to assign a namespace, no representation, and no merge rule. Two indexers concurrently `DefineNamespace`-equivalent Mallory to disjoint prefixes (indexer P: `agent-mallory/*`; indexer Q: `sandbox/*`). Which wins? Under what CRDT policy? If it's LWW, a race silently narrows or widens Mallory's rights; if union, Mallory gets both. Meanwhile subject-squatting: nothing stops agent Mallory from `SetField{s:"Recipe", ...}` overwriting the human's schema class unless a namespace rule forbids it — but the rule is vapor. **I10** ("policy-violating ops never mutate `n/`") cannot be tested because "policy" is undefined.

**Proposed replacement text (§8, new "Namespace governance").**
> Add op `SetWriterPolicy { key, namespacePrefixes: [string], rateCeiling: int }`, indexer-only. `apply` stores it under `ctx/gov/writer/<key>` with **LWW-under-linearization** merge (governance is intentionally centralized; last indexer decision wins, and the loser is auditable via `flag/govoverride`). A writer W may only mutate a subject whose NFC-normalized name has a prefix in W's `namespacePrefixes` (empty ⇒ unrestricted, for indexers/humans); a violating op is rejected under `flag/rejected/<W>/<seq>` reason `policy-namespace`. Two indexers disagreeing resolve by linearization; document that namespace policy is deliberately not a mergeable CRDT because it is a security boundary. Add an I10 test: an agent op outside its namespace never mutates `n/`.

---

### F17 — shadow flag over-fires (minor, §5, vault-ld §4.2)

**Exploit.** §5: "Term redefinitions that shadow an existing definition MUST write `flag/shadow`." But vault-ld §4.2 requires a warning only when a later context "redefines a term or prefix with a **different** definition"; "Identical redeclarations warrant no warning." Composed contexts legitimately re-declare the same term identically across ontology `context.jsonld` files. The spec would flood `flag/shadow` on benign identical re-declarations.

**Primary source.** vault-ld §4.2 "Term Shadowing" + "Identical redeclarations warrant no warning."

**Proposed replacement text (§5).**
> `apply` writes `flag/shadow/<scope>/<term>` **only** when a `DefineTerm` for `<term>` in a later-linearized scope resolves to a term definition that is **not structurally equal** (after canonical JSON-LD term-definition normalization) to the one already in `ctx/`. Identical redefinitions are idempotent and MUST NOT flag, per vault-ld §4.2.

---

### F18 — optimistic-writer visibility unpinned (minor, §8)

**Exploit.** §8 permits optimistic writes "if the current autobase version supports" them but never says whether an unconfirmed optimistic writer's ops are *visible in the view before confirmation*. autobase README: "writers can append an `optimistic` block even when they are not a writer" and "Optimistic blocks **should self verify in the `apply` handler** to prevent unintended writers from appending blocks," and application requires `host.ackWriter(key)`. If apply applies optimistic ops pre-ack, an unconfirmed agent mutates `n/` (I10 pressure); if it doesn't, the agent's UI shows nothing and it may re-emit. Either is defensible but must be chosen.

**Primary source.** autobase README optimistic-writes section (`optimistic`, `host.ackWriter`, "should self verify in the apply handler").

**Proposed replacement text (§8).**
> Optimistic ops MUST self-verify in `apply` (autobase README) — apply MUST check the op's writer against `ctx/gov` and MUST NOT mutate `n/`, `ctx/`, or `idx/` for a writer that is neither confirmed nor acked; such ops are held under `flag/optimistic/<W>/<seq>` and become effective only after an indexer `AddWriter`/`ackWriter` for `W` linearizes, at which point apply replays them deterministically. Choose this (do-not-apply-until-ack) over apply-then-maybe-discard, because the latter can transiently violate I10.

---

### F19 — on-disk materialize/ingest race (minor, §9)

**Exploit.** §9 claims the clobber rule is "satisfied structurally … regeneration is a pure projection." True *for the view*. But two OS processes — the file watcher reading `Hummus.md` mid-write, and `materialize` rewriting `Hummus.md` — can interleave on the actual filesystem: the watcher reads a half-written file and emits garbage ops, or `materialize` overwrites a human's unsaved buffer. Structural immunity is a claim about the view, not about POSIX file I/O.

**Proposed replacement text (§9).**
> `materialize` MUST write atomically (write to a temp file, `fsync`, `rename`) and MUST skip files with unsaved external modifications (compare on-disk mtime/hash against last-materialized hash; if changed, treat as an ingest event first). The watcher MUST debounce and read only after write-settle (size-stable for one interval) and MUST ignore files currently being written by `materialize` (a per-path in-flight lock). Document that clobber-immunity is a view property; on-disk safety is a separate, explicitly-handled concern.

---

### F20 — hyperdispatch schema evolution as a determinism constraint (nit, §1/§3)

**Exploit.** hyperdispatch generates encoders from a schema ("Generate operations/endpoints using Hyperschema"). If, across versions, an op message id is reordered or removed, an old block decodes to the wrong op or fails to decode (feeding F3). Because the log is replayed forever, the op wire schema must be strictly append-only for the life of the vault. The spec names hyperdispatch but never states this constraint.

**Proposed replacement text (§3).**
> The hyperdispatch/Hyperschema op definitions are an append-only wire contract for the life of a vault: message ids and field orders MUST NOT be reordered or removed; new op types are added with new ids; deprecated ops keep their decoder forever. Record the schema version in the vault metadata. This is an I1 requirement (the log is replayed indefinitely).

---

## 4. Conformance matrix (vault-ld SPEC.md → implementation spec)

Legend: ✅ satisfied · ⚠️ partial/at-risk · ❌ not satisfied · finding IDs where relevant.

| vault-ld requirement (SPEC.md §) | Norm | Impl-spec section | Status |
|---|---|---|---|
| No per-note `@context`; single composed context (§4.2) | MUST NOT | §4 `ctx/`, §9 `context.jsonld` | ✅ |
| Context array applied left-to-right, later overrides (§4.2) | — | §5 policy read at linearized point | ⚠️ ordering is *linearization*, not context-array order; see F8 |
| Warn on shadowing only when definition differs; identical → no warning (§4.2) | SHOULD | §5 `flag/shadow` | ❌ F17 (over-fires) |
| Honor keyword aliases on input; write aliased on output (§4.3) | MUST/SHOULD | §9 materialize | ⚠️ not explicitly handled; add to materialize |
| Object props & `@type` are wiki links; datatype props scalar (§4.3) | — | §3 `o.ref` marks refs | ⚠️ enforced only if ingest classifies correctly; interacts with F2 |
| Host-tool keys not emitted, not warned (§4.3) | MUST NOT (×2) | §5 unmapped handling | ❌ F11 |
| Unmapped construct flagged, not dropped (§4.3/§5.6) | MUST | §5 `flag/unmapped`, verbatim store | ⚠️ flagged+stored but not re-exported → F10 |
| Dangling link flagged (§4.4.1) | MUST | §7 `flag/dangling` | ✅ |
| Dangling MAY mint IRI in **data namespace** (§4.4.1) | MAY | §7 mint | ⚠️ minting done but base unspecified → F12 |
| Ambiguous bare link warned (§4.4.1) | MUST | — | ❌ not addressed; add `flag/ambiguous` |
| Non-participating note (no `@type`) excluded from graph (§4.4.1) | — | §9 ingest | ⚠️ ingest must skip type-less notes; not stated |
| Identity from file name alone; folders never in IRI (§4.5) | MUST | §3 subject = note name | ✅ (log has no folders — consistent) |
| Percent-encode non-IRI-safe chars per RFC 3987 (§4.5) | MUST | — | ❌ not stated; add; also F1 (NFC first) |
| Explicit `id` is absolute IRI, verbatim; relative non-conforming (§4.5) | MUST | — | ⚠️ op schema has no `id` override path; add |
| Collision: same name+base → same IRI (§4.5) | — | §7 takeover relies on this | ✅ (deterministic mint) |
| Hierarchy only in frontmatter, never folder (§5.2) | MUST NOT | inherent (no folders in log) | ✅ |
| Schema vs data layer decided by folder (§5.4 step 5) | — | §10 export split | ❌ F5 (folder signal lost) |
| Emit two files `schema.ttl` / `data.ttl` (§5.4 step 8) | — | §10 | ⚠️ files named, partition unimplementable w/o F5 fix |
| `vld:path` for non-reconstructable placement on roundtrip (§5.4 step 7) | — | §9/§10 | ❌ F13 |
| Percent-decode file names on ingest (§5.5 step 2) | SHOULD | §9 ingest | ❌ not stated |
| `vld:path` consumed on ingest, never in frontmatter (§5.5 step 1) | — | §9 | ❌ F13 |
| Body not populated from graph; starts empty on ingest (§5.5 step 6) | — | §6 revisions, §9 | ✅ |
| Generator MUST preserve bodies, not clobber (§5.3/§5.6) | MUST | §9 structural claim | ⚠️ view-true; on-disk race F19 |
| Body carries no triples, no Turtle representation (§5.6) | — | §6, §10 | ✅ |
| Unmapped flagged rather than dropped (§5.6, ingester) | MUST | §5 | ⚠️ F10/F11 |

**Summary:** 8 ✅, 10 ⚠️, 7 ❌. The ❌ rows are concentrated in export/roundtrip fidelity (F5, F13), host-key handling (F11), and IRI minting details (F1/F12, percent-encoding, ambiguity) — all fixable with the proposed text, none requiring architectural change.

---

## 5. Prior-art summary (novelty claim stress test)

**The claim under test:** "context-driven merge policy (ontology declarations selecting CRDT semantics per predicate)" as the core novelty.

**Closest three findings.**

1. **SU-Set / "Live Linked Data" (Inria; IJMSO 2013, hal-00686484 / hal-00903377).** An operation-based CRDT for RDF graphs under SPARQL Update, extending OR-Set from single-element add/remove to union/difference over `(triple, id)` pairs, giving eventual consistency for replicated triple stores — and explicitly noting its predecessor **C-Set** is "convergent but does not preserve intention" on concurrent delete-then-insert. This is the canonical OR-set-for-RDF result. **What it does NOT do:** select semantics *per predicate from the schema/context*. SU-Set applies one uniform OR-set discipline to all triples. NextGraph implements SU-Set today ("RDF available as a local-first CRDT model using OR-set logic formalized in the SU-Set paper").

2. **m-ld (spec.m-ld.org; CEUR Vol-2941).** Synchronizes decentralized JSON-LD replicas; array properties have **Set semantics by default** (add-wins, commutative) "unless qualified with the `@list` keyword," with `@agree` agreements as a coordination escape hatch. This is the *closest* to schema/keyword-driven merge selection: the JSON-LD keyword (`@set`-like default vs `@list`) chooses the merge behavior — exactly the mechanism this spec proposes, one step less granular (container-keyword-driven rather than per-predicate `@container` in a replicated context).

3. **Schema-declared per-field merge in protobuf CRDTs (Atoms tech blog) + ElectricSQL "Rich CRDTs" + RxDB CRDT schemas.** The protobuf approach declares merge strategy per field via schema options (`MERGE`/`REPLACE`/`COUNTER`/ID-lists) — a direct instance of "the schema table selects the CRDT per field." ElectricSQL frames the open problem ("getting the merge strategy and consistency semantics right … very challenging"). RxDB embeds CRDT options in the JSON schema. DXOS ECHO and Ceramic ComposeDB, by contrast, do **not** expose per-field merge declarations (ECHO delegates to Automerge's generic JSON CRDT; ComposeDB schemas govern structure only) — so they are *not* close prior art for the per-predicate claim, contrary to what one might assume.

**Narrowed novelty claim (the honest version).** Selecting a per-field CRDT from a schema is **not novel** (protobuf CRDTs, RxDB, m-ld's keyword-driven set/list). Applying OR-set/LWW to RDF is **not novel** (SU-Set, NextGraph, m-ld). What appears genuinely novel — and is exactly the source of this spec's F8 hazard — is the **reflexive** design: the CRDT policy table is *itself the replicated JSON-LD `@context`, stored as ordinary ops in the same totally-ordered Autobase log it governs*, so policy changes are themselves subject to linearization and can retroactively reinterpret already-accepted data ops ("policy epochs"). Neither SU-Set (fixed policy), m-ld (keyword-fixed at author time, agreements are out-of-band), nor the protobuf/RxDB approaches (schema is out-of-band, deployed separately) put the merge-policy table *inside the same CRDT log as the data*. 

**Proposed narrowed claim text for the README:**
> This system's contribution is not per-predicate CRDT selection (see SU-Set, m-ld, schema-driven protobuf CRDTs) but **in-log reflexive merge policy**: the JSON-LD `@context` that selects OR-set vs LWW per predicate is itself a first-class, multi-writer-replicated object in the same linearized op log as the data it governs, yielding deterministic-but-epoch-sensitive semantics (§5, policy-epoch caveat). Prior art fixes policy out-of-band; here policy is data.

State it that way, and the novelty survives — but only after F8's optional epoch-pinning gives writers a way to bound the reinterpretation the reflexivity introduces.

---

## 6. Severity discipline note

Six blockers, and each is a blocker under the stated bar ("makes I1..I10 unachievable as specified"): F1 (I2), F2 (I2), F3 (I4), F4 (I4), F5 (acceptance/vault-ld conformance for export), F6 (I10 not well-defined). The remaining findings are majors/minors that degrade conformance, auditability, or operability without, by themselves, making an invariant false. I did not inflate: F8 was demoted from a reflex blocker to major once I confirmed I1/I2 actually hold (the view still converges; only *meaning* shifts), and several tempting "gotchas" (I3 rebuild equivalence, OR-set add-wins in the happy path, clobber-immunity of the view) survived attack and are noted as steelmanned-and-standing.
