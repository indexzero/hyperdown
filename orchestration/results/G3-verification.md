# G3 Verification — clean-clone install + unit run (D-016)

- **Date:** 2026-07-03 (local: Jul 3 22:48)
- **Verifier context:** fresh clone only; no supervisor artifacts consulted beyond the clone itself.
- **Clone:** `git clone --branch 5/cli git@github.com:indexzero/hyperwiki2.git` into `sslop/016/clone-g3/`
- **HEAD:** `0c2700bd6f5e60b17a1ec63eb5bf6d63297f3077` (`docs(p3): dispatch D-016 G3 clean-clone verification`)
- **Toolchain:** node v24.16.0, pnpm 10.34.0 (darwin arm64)
- **No configuration performed** beyond clone + install (per dispatch step 2).

---

## Step 3 — `pnpm install` (raw output)

```
Scope: all 6 workspace projects
Lockfile is up to date, resolution step is skipped
Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +106
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 106, reused 106, downloaded 0, added 106, done

devDependencies:
+ @hyperwiki/cli 0.0.0 <- packages/cli
+ @hyperwiki/core 0.0.0 <- packages/core
+ @hyperwiki/faces 0.0.0 <- packages/faces
+ @hyperwiki/store 0.0.0 <- packages/store
+ n3 2.1.1

Done in 516ms using pnpm v10.34.0
```

Verdict: **PASS** — clean install, lockfile honored, no build errors.

## Step 4 — `pnpm test` (raw output tail, incl. counts)

```
✔ I7: different-IRI takeover retargets triples with audit flags, never merges (§7) (1.970833ms)
✔ I7: conflict flags persist until an explicit ResolveConflict (§6) (2.991875ms)
✔ I7: ResolveConflict with text creates a merged revision based on keep (§6) (0.788291ms)
✔ I7: audit flags are drainable via ClearFlag (§6) (1.079667ms)
✔ I7: cross-writer head supersession without shared base clobber-flags (§5.4/§6) (0.741666ms)
✔ I8: triple indexes are maintained inside the same apply pass (§4) (5.316333ms)
✔ I8: a deferred DefineTerm makes previously-unmapped values index-visible (§10.3) (2.235375ms)
✔ I8: kind-changing redefinition migrates state and keeps indexes well-formed (§5.5) (3.687041ms)
✔ I8: host-key promotion migrates host/ state into f/ and backfills (§5.6) (0.641583ms)
✔ I8: deletion suppresses a subject from idx/* and bl/*; undelete restores (§9.2) (1.784792ms)
✔ §10.2: xsd:integer — no decimal point, no leading zeros, no plus sign (0.472084ms)
✔ §10.2: xsd:decimal canonical mapping (0.163584ms)
✔ §10.2: xsd:double canonical mapping, never platform toString (0.130417ms)
✔ §10.2: xsd:dateTime/date canonical ISO-8601 with explicit Z (0.957416ms)
✔ §10.2: language tags lowercased; typed literals canonicalized (0.166625ms)
✔ §3.1: NFC and NFD spellings are the same subject (3.301125ms)
✔ §10.2: byte forms give a total, type-discriminated order (0.090083ms)
✔ I10/§8.0: a non-indexer AddWriter{indexer:true} never reaches host.addWriter and never mutates ctx/gov (2.155625ms)
✔ I10/§8.6: an agent op outside its namespace never mutates n/ (2.637583ms)
✔ I10/§8.3: revocation is causal (clock-based), not positional (1.367333ms)
✔ I10/§8.3: triple replay — incremental, from-scratch, forced-reorg partitions identical (4.045459ms)
✔ I10/§8.2: unacked optimistic ops are held, folded at ack position, never early-applied (1.478167ms)
✔ I10/§8.2: H_max caps the hold buffer of an unacked writer (0.318584ms)
✔ I10/§8.2: RemoveWriter for an unacked writer drops holds without folding (0.337125ms)
✔ I10/§8.5: token bucket — default ceiling applies from the first op; indexer ops replenish (0.977708ms)
✔ I10/§8.5: SetWriterPolicy may only tighten below the default; override audited (0.418208ms)
✔ I10/§8.6: namespace partition is stable across replay shapes (1.537166ms)
✔ I10: governance ops from a writer with no record at all are rejected (0.133625ms)
✔ §4: components round-trip through escaping; separators cannot be injected (0.604083ms)
✔ §4: a subject named 'hold' can never collide with the n/hold/ family (0.123958ms)
✔ §9.4: an op naming '../escape' is contained in the keyspace on any peer (4.426625ms)
✔ §9.4: apply rejects SetPath values that escape root (1.464709ms)
✔ §9.4: isSafePath is strict on traversal, absolute paths, and drive letters (0.097708ms)
✔ §8.6: prefix matching is per path segment, never byte-prefix (0.069083ms)
✔ §8.2/§8.4: hold, rejection, and optimistic families share one ordinal source (1.540833ms)
✔ §6: root revision (null base) matches the reference construction (0.77625ms)
✔ §6: chained revision includes the 64-hex base bytes (0.178166ms)
✔ §6: text is NFC-normalized before hashing (§3.1) (0.098ms)
✔ §6: malformed base is refused (0.242375ms)
✔ two writers converge to bit-identical views (hash equality) (1375.887417ms)
✔ optimistic onboarding: held locally, folded at the ack position (§8.2) (770.472708ms)
✔ encrypted vault: init, write, reopen from disk, read (634.600875ms)
✔ encrypted vault: a second peer with the invite key converges (662.134542ms)
✔ metadata canonical bytes are independent of input key order (0.983208ms)
✔ metadata defaults mirror the core vault-metadata table (0.405584ms)
✔ metadata is written at init, loaded at open, and pinned to the vault key (513.856167ms)
✔ metadata is identical across peers of the same vault (249.737042ms)
✔ a divergent invite or mismatched key is refused (337.384792ms)
✔ restart from disk: reopened view equals the pre-close view (I3) (1178.096625ms)
✔ fresh peer rebuild from the log equals the restarted view (471.315458ms)
✔ two vaults replicate over hyperswarm (discoveryKey join) (830.115416ms)
✔ writer add/remove round trip (1465.484833ms)
ℹ tests 111
ℹ suites 0
ℹ pass 111
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14088.264041
```

Verdict: **PASS** — 111 tests, 111 pass, 0 fail, 0 skipped.

## Step 5 — `node examples/recipe-book/index.js` + byte-determinism

Output tail (exit code 0):

```
--- editorial pass: Dill resolves what the flags surfaced ---
[dill ] ResolveConflict on Tomato Soup: keep Basil's revision, supersede mine, append the merged text (§6)
[dill ] saffron in a rustic soup? removing it (RemMember cites every observed tag, §5.3)
[dill ] tightening Clove's prepTime on Garlic Bread 10 → 12 (audited via flag/clobber)
[all  ] flag/conflict drained by the ResolveConflict op: 0 left
[all  ] still dangling (left as a TODO for the next session): Herbes de Provence

--- session dump: the knowledge graph as readable faces ---
[nova ] materialized 14 files to examples/recipe-book/out/vault
[nova ] exported 7 schema + 40 data triples to examples/recipe-book/out/rdf

=== what just happened ===
We told four agents to write a recipe book from scratch. They negotiated an
ontology, wrote concurrently while disconnected, disagreed, merged, and
audited every disagreement — all as ops in one shared log. That knowledge
graph is now represented as the Markdown files under out/vault/ (open the
folder in Obsidian) and as RDF under out/rdf/ (schema.ttl + data.ttl).
The op log stays the source of truth; out/ is a session dump a human can read.
```

`git status --short` after the run:

```
(empty — zero lines, exit 0)
```

Verdict: **PASS** — the example regenerated the committed `examples/recipe-book/out/` tree byte-identically (no working-tree diff). Byte-determinism holds. (The suite also asserts this independently: `test/example-recipe-book.test.js` re-runs the example into a scratch dir and tree-hash-compares against the committed out/.)

## Step 6 — DEVIATIONS.md + SPEC-FINAL §15 acceptance mapping

`DEVIATIONS.md` exists at repo root (8 KB, 10 entries: node:test mandate; autobee-only substrate; §8.2/§8.4 ordinal source; §10.1 layer inference; §13 store port mappings; §8.2 ackWriter port; uniform topo weight; UNVERIFIED ledger; §4.5 encodeName over-encoding; §9.4 unsafepath-as-report). Verdict: **PRESENT and substantive**.

SPEC-FINAL is `prompts/01-implementation-spec-prompt.v5.md`; §15 lists six acceptance items. Per-item verdicts:

| # | §15 item | Verdict | Evidence path(s) |
|---|----------|---------|------------------|
| 1 | Every invariant I1..I10 has a passing test, incl. the seven named sub-tests | **unit-level evidence** (all green in the 111/111 run) | `test/i01-determinism.test.js` … `test/i10-governance.test.js`. Named sub-tests: triple-replay revocation §8.3 → `test/i10-governance.test.js` ("triple replay — incremental, from-scratch, forced-reorg partitions identical"); non-indexer governance rejection §8.0 → `test/i10-governance.test.js`; namespace reorg stability §8.6 → `test/i10-governance.test.js` ("namespace partition is stable across replay shapes"); dual takeover §7 → `test/i07-flag-lifecycle.test.js:24` (same-IRI) and `:39` (different-IRI); backfill §10.3 → `test/i08-index-coherence.test.js` ("deferred DefineTerm … index-visible"); kind-changing redefinition §5.5 → `test/i08-index-coherence.test.js`; adversarial `../escape` §9.4 → `test/keyspace.test.js` (keyspace containment) and `test/faces-materialize.test.js:122` (on-disk containment) |
| 2 | `materialize` output opens cleanly in Obsidian | **unit-level evidence + deferred-to-P6 for the literal open** | Structural proxy: `test/faces-materialize.test.js:71` ("materialized vault has the Obsidian/vault-ld shape (§9.1)"); committed human-inspectable vault at `examples/recipe-book/out/vault/`. The literal opened-in-Obsidian structural check is explicitly assigned to Phase P6 by `prompts/04-supervisor-prompt.md` ("`materialize` opened-in-Obsidian structural check (frontmatter parses, links resolve)") |
| 3 | `exportTurtle` parses with a standard Turtle parser; partitions schema.ttl/data.ttl per §10.1 | **unit-level evidence** | `test/faces-turtle.test.js:20` (parses with N3.js) and `:73` (layer partition schema.ttl/data.ttl §10.1); committed `examples/recipe-book/out/rdf/{schema,data}.ttl` |
| 4 | Roundtrip export/ingest preserves placement via `vld:path` (§10.4) | **unit-level evidence** | `test/faces-roundtrip.test.js:58` ("authored path → vld:path → identical rebuild (§9.3/§10.4)"); `test/faces-turtle.test.js:144` (roundtrip flag gates vld:path); `test/faces-ingest.test.js:148` (vld:path consumed, never stored) |
| 5 | Human deletion of a frontmatter field and of a whole note survives ingest → converge → materialize (no resurrection, §9.2) | **unit-level evidence** (composed) | Field: `test/faces-ingest.test.js:41` ("deleting a frontmatter line emits exactly one UnsetField"); whole note: `test/faces-ingest.test.js:177` ("guarded DeleteSubject; deletion survives a materialize cycle … deletion not resurrected by materialize"); the converge leg cross-writer: `test/faces-roundtrip.test.js:83` ("human edits ingest on one writer and converge to identical faces on another (I2 → I9)") and `test/i08-index-coherence.test.js` (deletion suppression/undelete). Note: the deletion tests and the cross-writer-converge test are separate tests, not one end-to-end scenario; the integrated cycle under faults is P4-harness territory |
| 6 | Three-writer demo (two simulated agents, one human ingest path) converges after partition and heal | **unit-level composite evidence + deferred-to-P4 for the integrated demo** | Partition/heal multi-writer convergence demo exists and is executed by the suite: `examples/recipe-book/index.js` (four real on-disk peers, disconnect → concurrent writes → heal → converge; run end-to-end by `test/example-recipe-book.test.js`). Human ingest converging across writers: `test/faces-roundtrip.test.js:83`. The exact two-agents-plus-one-human-ingest composition in a single scenario is not present as one artifact; it maps to the P4 multi-process fault-injection harness / scenario matrix S1..S10 (`prompts/04-supervisor-prompt.md` Phase P4; STATE.md open checklist rows "Harness real …" and "S1..S10 green"). No document names §15-item-6 verbatim as deferred — flagging that as a bookkeeping nit for the supervisor, not a gate failure, since the item's substance (partition/heal convergence + human-ingest convergence) has committed, passing evidence |

No item is MISSING: all six have unit-level evidence in the clone; items 2 and 6 additionally point to P6/P4 for their full end-to-end forms, consistent with the supervisor prompt's phase plan.

## Notes / nits (non-gating)

- STATE.md's goal checklist row "Clean-clone install; unit green; I1..I10 mapped" is still unchecked in the clone (this report is that evidence; supervisor should tick it).
- §15 items 2 and 6 rely on phase-plan pointers (`prompts/04-supervisor-prompt.md` P4/P6) rather than an explicit per-item deferral note in DEVIATIONS.md or STATE.md; a one-line acceptance-mapping table in STATE.md would make the mapping self-evident at G6.

---

**VERDICT: G3-PASS**
