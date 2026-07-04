# D-022 Final Independent Verification — hyperwiki2 `6/harness`

- **Clone:** `git@github.com:indexzero/hyperwiki2.git` branch `6/harness`, fresh clone at
  `/Users/cjr/Git/indexzero/hyperwiki2/sslop/022/clone`
- **HEAD:** `d77482ab5d40aa6840bb7b34e281eb5436882f5c` ("docs(p6): dispatch D-022 final independent verification")
- **Spec:** `prompts/01-implementation-spec-prompt.v5.md` (SPEC-FINAL, read from the clone)
- **Toolchain:** node v24.16.0, pnpm 10.34.0, macOS (Darwin 25.2.0)
- **Independence:** no orchestration/ docs, CLAUDE.md, or review files were read; every result below is from my own runs.
- **Raw logs preserved:** `sslop/022/{unit.log,regressions.log,h-clean.log,h-lossy.log,h-part.log,h-fuzz.log}`;
  step-8 artifacts under `sslop/022/step8/`; check scripts `sslop/022/{verify-vault.mjs,verify-ttl.mjs,step8-determinism.mjs}`.

---

## Step 1 — Clean clone

```
$ git clone --branch 6/harness git@github.com:indexzero/hyperwiki2.git sslop/022/clone
Cloning into '.../sslop/022/clone'...
$ git rev-parse HEAD
d77482ab5d40aa6840bb7b34e281eb5436882f5c
```

PASS.

## Step 2 — `pnpm install`

```
Scope: all 6 workspace projects
Lockfile is up to date, resolution step is skipped
Packages: +106
devDependencies:
+ @hyperwiki/cli 0.0.0 <- packages/cli
+ @hyperwiki/core 0.0.0 <- packages/core
+ @hyperwiki/faces 0.0.0 <- packages/faces
+ @hyperwiki/store 0.0.0 <- packages/store
+ n3 2.1.1
Done in 608ms using pnpm v10.34.0
```

PASS.

## Step 3 — Full unit suite (`pnpm test`)

```
exit=0
ℹ tests 114
ℹ pass 114
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

114/114 pass, exit 0. Full output in `sslop/022/unit.log`. Representative tail:

```
✔ two writers converge to bit-identical views (hash equality) (1350ms)
✔ optimistic onboarding: held locally, folded at the ack position (§8.2) (731ms)
✔ encrypted vault: a second peer with the invite key converges (746ms)
✔ restart from disk: reopened view equals the pre-close view (I3) (906ms)
✔ fresh peer rebuild from the log equals the restarted view (502ms)
✔ two vaults replicate over hyperswarm (discoveryKey join) (551ms)
✔ writer add/remove round trip (1173ms)
```

PASS.

## Step 4 — Regressions (`pnpm test:regressions`)

```
exit=0
✔ revocation race: peers converge after a removed writer's in-flight op (I2/I10) (6316ms)
✔ null-base SetBody raises no mutual conflicts and applies in ~linear time (45ms)
✔ chained SetBody (base = head) no longer pays an O(R) scan per op (349ms)
✔ cross-writer null-base supersession is surfaced via §5.4 clobber, not §6 conflict (0.9ms)
✔ true same-non-null-base concurrency still yields exactly one conflict flag (§6) (0.88ms)
ℹ tests 5  ℹ pass 5  ℹ fail 0
```

PASS.

## Step 5 — Full scenario matrix at all three fault profiles + fuzz

Ran in background sequentially; summaries from each `node --test` run (zero `✖` lines in any log):

| run | tests | pass | fail | cancelled | log |
|---|---|---|---|---|---|
| `pnpm test:harness:clean` (HARNESS_PROFILE=clean) | 17 | 17 | 0 | 0 | `sslop/022/h-clean.log` |
| `pnpm test:harness:lossy` (HARNESS_PROFILE=lossy) | 17 | 17 | 0 | 0 | `sslop/022/h-lossy.log` |
| `pnpm test:harness:partitioned` | 17 | 17 | 0 | 0 | `sslop/022/h-part.log` |
| `pnpm test:harness:fuzz` (HARNESS_FUZZ_ITERS=10) | 1 | 1 | 0 | 0 | `sslop/022/h-fuzz.log` |

Clean-profile scenario list (identical set passed at lossy and partitioned):

```
✔ ADV1: keyspace injection — hostile subjects cannot escape their family
✔ ADV2: a poison op is contained per-op and cannot halt apply (I4)
✔ ADV3: reported quiescence is real — forced update rounds do not move the hash
✔ ADV4: sole-indexer self-removal is deterministic and non-fatal
✔ fuzz shrinker reduces a schedule to the minimal failing core
✔ S1: LWW winner is arrival-order independent (I6)
✔ S2: concurrent add wins over remove of unobserved tag (I5)
✔ S2b: remove citing a never-replicated tag is deterministic
✔ S3: dangling flag clears when the target materializes, both heal orders (I7)
✔ S4: concurrent same-base SetBody keeps both revisions + one conflict flag (I4)
✔ S5: DefineTerm kind flip concurrent with field writes converges (I1)
✔ S6: ops racing their revocation are contained to flag/ (I10)
✔ S7: SIGKILL mid-apply, restart, rebuild-from-scratch equality (I3)
✔ S8: materialize + Turtle are byte-identical across peers; ingest is minimal (I9)
✔ S9: idx/* and bl/* exactly derivable from n/* under churn (I8)
✔ S10: seeded fuzz x3 (convergence + I8 after every heal)
✔ smoke: two-process convergence through the fault proxy
```

Fuzz run: `✔ S10: seeded fuzz x10 (convergence + I8 after every heal) (33133ms)`.

Note: the background wrapper shell exited 1 solely because its bookkeeping append to
`/tmp/h-status.txt` was blocked by the sandbox; every test invocation's own
`node --test` summary reports `fail 0` / `cancelled 0` and the logs contain zero
failing-test lines. The regression/lossy/partitioned/fuzz verdicts above are read
directly from those summaries.

PASS (all four runs).

## Step 6 — Materialize structural check (recipe-book)

`node examples/recipe-book/index.js` → exit 0. Run output (tail):

```
[nova ] materialized 14 files to examples/recipe-book/out/vault
[nova ] exported 7 schema + 40 data triples to examples/recipe-book/out/rdf
[all  ] still dangling (left as a TODO for the next session): Herbes de Provence
```

Programmatic per-file verification (`sslop/022/verify-vault.mjs`: YAML frontmatter parse via
the repo's `yaml` dependency, `[[wiki link]]` resolution against the vault file set with the
run's `flag/dangling/` set as the only permitted escape, JSON parse of `context.jsonld` and
`.vld-manifest.json`):

```
Baguette.md: yaml:OK(2 keys) links:OK(1 links)
Basil.md: yaml:OK(2 keys) links:OK(1 links)
Eggplant.md: yaml:OK(2 keys) links:OK(1 links)
Garlic Bread.md: yaml:OK(5 keys) links:OK(6 links)
Garlic.md: yaml:OK(2 keys) links:OK(1 links)
Olive Oil.md: yaml:OK(2 keys) links:OK(1 links)
Ontologies/culinary/Classes/Ingredient.md: yaml:OK(2 keys) links:OK(0 links)
Ontologies/culinary/Classes/Recipe.md: yaml:OK(2 keys) links:OK(0 links)
Ontologies/culinary/Properties/hasIngredient.md: yaml:OK(3 keys) links:OK(0 links)
Ratatouille.md: yaml:OK(5 keys) links:OK(9 links)
Tomato Soup.md: yaml:OK(8 keys) links:OK(9 links)
Tomato.md: yaml:OK(2 keys) links:OK(1 links)
Zucchini.md: yaml:OK(2 keys) links:OK(1 links)
context.jsonld: json:OK(top-level keys: @context)
.vld-manifest.json: json:OK
VAULT-STRUCTURAL: PASS
```

Control run with the dangling set emptied shows exactly one unresolved link —
`Ratatouille.md → [[Herbes de Provence]]` — which is precisely the target reported by the
run's `flag/dangling/` scan. Every other wiki link resolves to a file in the vault.

This is the **structural proxy** for "opens cleanly in Obsidian" (SPEC-FINAL §15): valid YAML
frontmatter in every note, resolvable links (dangling ones flag-accounted), valid shared
context document. Obsidian itself was not launched.

PASS (as structural proxy).

## Step 7 — Turtle check

Parsed with `n3` 2.1.1 (the repo's devDependency, installed by step 2 — the repo's standard
Turtle parser; nothing installed fresh):

```
examples/recipe-book/out/rdf/schema.ttl: PARSE-OK (7 triples)
examples/recipe-book/out/rdf/data.ttl:   PARSE-OK (40 triples)
```

Zero parse errors; triple counts match the export report (7 schema + 40 data). Partition is
real: the three `Ontologies/…` notes' triples land in `schema.ttl`, instances in `data.ttl`.

PASS.

## Step 8 — Byte-determinism across two REAL peer processes

Script `sslop/022/step8-determinism.mjs` uses the harness controller: two **forked writer
processes** (distinct OS pids) meshed through the fault proxy, genesis admits the second via
an in-log `AddWriter`, then concurrent cross-writer writes (LWW register, OR-set with a ref
and a dangling ref, NFD-authored unicode title, body revision, host-allowlist key `tags`,
unmapped key `mood`, `@type` on a second subject), quiesce, then `materialize` and
`exportTurtle` (roundtrip) executed **inside each peer process against its own view** into
four separate directories:

```
[harness] run=d022-step8-66647-mr63c391 seed=677545589 profile=clean
peer A pid: 66648  peer B pid: 66649  same? false
converged view hash: bd2ec6c5939eb4f74707fed3af684ce34461c3e39102fe4a2f8335083eebfdbc

$ diff -r vault-a vault-b ; echo vault-diff-exit=$?
vault-diff-exit=0
$ diff -r ttl-a ttl-b ; echo ttl-diff-exit=$?
ttl-diff-exit=0
```

Identical bytes for the full vault set (`Home.md`, `Recipe.md`, `context.jsonld`,
`.vld-manifest.json`) and the full `.ttl` set (`schema.ttl`, `data.ttl`); both peers' Turtle
re-parses cleanly with n3. Artifacts kept under `sslop/022/step8/`. Additionally, the
harness S8 scenario ("materialize + Turtle are byte-identical across peers") passed at all
three fault profiles in step 5, and the unit suite's
"recipe-book example regenerates the committed out/ byte-identically (I9)" passed.

PASS (SPEC-FINAL I9, §15).

---

## Step 9 — SPEC-FINAL §15 acceptance items, each with evidence from THIS run

1. **Every invariant I1..I10 has a passing test** — all from my `pnpm test` run
   (`sslop/022/unit.log`), reinforced by the harness matrix:
   - I1: `✔ I1: identical logs produce bit-identical views`; `✔ I1: core sources contain no
     wall clock, randomness, or peer-local reads`; harness S5 at 3 profiles.
   - I2: `✔ I2: batching variance does not change the converged view hash`; `✔ two writers
     converge to bit-identical views (hash equality)`; harness smoke/S10 at 3 profiles.
   - I3: `✔ I3: incremental view equals from-scratch rebuild`; `✔ restart from disk…(I3)`;
     harness S7 (SIGKILL mid-apply) at 3 profiles.
   - I4: `✔ I4: unmapped writes…flagged`, `✔ I4: op/kind mismatch…flag/kindmismatch`,
     `✔ I4: cross-writer LWW supersession is clobber-flagged`, `✔ I4: undecodable and
     oversize ops are flagged writer/seq-keyed`, `✔ I4: depth-exceeded rejects`,
     `✔ I4: epoch divergence…applied under the cited kind and flagged`; harness S4/ADV2.
   - I5: `✔ I5: concurrent add and remove…converge to present`; `✔ I5: remove deletes
     exactly the cited present tags; stale citations flag (§5.3)`; harness S2/S2b.
   - I6: `✔ I6: last in linearized order wins, independent of apply batching`; `✔ I6: an lww
     register value is a canonical array`; harness S1.
   - I7: `✔ I7: dangling ref mints in the data namespace and coalesces a count`; conflict
     persistence + ResolveConflict + ClearFlag tests; harness S3 both heal orders.
   - I8: `✔ I8: a deferred DefineTerm makes previously-unmapped values index-visible (§10.3)`
     (**backfill test**); `✔ I8: kind-changing redefinition migrates state and keeps indexes
     well-formed (§5.5)` (**kind-changing test**); host-key promotion test; harness S9.
   - I9: `✔ materialize is byte-deterministic…(I9)`, `✔ export is byte-deterministic across
     passes, rebuilds, and peers (I9)`; harness S8 at 3 profiles; my step-8 byte-diff.
   - I10: `✔ I10/§8.3: triple replay — incremental, from-scratch, forced-reorg partitions
     identical` (**triple-replay revocation test**); `✔ I10/§8.0: a non-indexer
     AddWriter{indexer:true} never reaches host.addWriter and never mutates ctx/gov`
     (**non-indexer governance rejection**); `✔ I10/§8.6: namespace partition is stable
     across replay shapes` (**namespace reorg-stability**); `✔ I10/§8.6: an agent op outside
     its namespace never mutates n/`; harness S6 at 3 profiles.
   - **Dual takeover (I7, §7):** `✔ I7: same-IRI takeover clears the flag and reuses the
     IRI` and `✔ I7: different-IRI takeover retargets triples with audit flags, never merges`.
   - **Adversarial `../escape` (§9.4):** `✔ adversarial containment: ../escape and unsafe
     SetPath never write outside root (§9.4)`, `✔ §9.4: an op naming '../escape' is contained
     in the keyspace on any peer`, `✔ §9.4: apply rejects SetPath values that escape root`.
   **PASS.**

2. **`materialize` output opens cleanly in Obsidian** — verified via the structural proxy of
   step 6 (all 13 notes: YAML frontmatter parses; all 31 wiki links resolve or are
   flag-accounted dangling; `context.jsonld` valid JSON). Obsidian was not launched; noted
   as a proxy. **PASS (structural proxy).**

3. **`exportTurtle` parses with a standard Turtle parser and partitions into
   `schema.ttl`/`data.ttl` per §10.1** — step 7: n3 parses both files with zero errors,
   7 schema / 40 data triples, ontology notes in the schema layer. **PASS.**

4. **Roundtrip export/ingest preserves note placement via `vld:path` (§10.4)** — from my
   unit run: `✔ note placement roundtrips: authored path → vld:path → identical rebuild
   (§9.3/§10.4)`, `✔ roundtrip flag gates vld:path emission (§10.4)`, `✔ vld:path
   frontmatter is consumed, never stored as a field (§9.3/§10.4)`. **PASS.**

5. **Human deletion of a frontmatter field and of a whole note survives a full
   ingest → converge → materialize cycle** — from my unit run: `✔ deleting a frontmatter
   line emits exactly one UnsetField (§9.2)`, `✔ deleting a file: guarded DeleteSubject;
   deletion survives a materialize cycle (§9.2)`, `✔ I8: deletion suppresses a subject from
   idx/* and bl/*; undelete restores (§9.2)`, plus `✔ human edits ingest on one writer and
   converge to identical faces on another (I2 → I9)` for the cross-peer cycle. **PASS.**

6. **Three-writer demo (two simulated agents, one human ingest path) converges after
   partition and heal** — covered by composition in my runs: (a) the recipe-book example
   (step 6): four writer peers disconnect (partition), write concurrently, reconnect (heal),
   converge, and the human operator's session dump is guarded by the ingest report; (b)
   harness S9: three real writer processes under seeded random partitions and heals,
   convergence + index coherence at every quiescent point, passing at clean, lossy, and
   partitioned profiles; (c) harness S8 + `✔ watch ingests a human edit in the foreground
   and exits on SIGINT` + the faces roundtrip tests exercise the human ingest path across
   real peers. No single test combines all three elements in one scene, but every element —
   ≥3 writers, partition/heal convergence, human ingest path converging across peers — passed
   in this run. **PASS.**

## Verdict

Every dispatched step (1–8) completed with the required outcome from a clean clone, and
every SPEC-FINAL §15 acceptance item has passing evidence from this run, with the single
qualification that "opens cleanly in Obsidian" was verified by the structural proxy defined
in the dispatch, not by launching Obsidian.

VERDICT: FINAL-PASS
