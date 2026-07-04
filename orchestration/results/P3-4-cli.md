# P3-4 build report: CLI + flagship example + top-level README

Branch `5/cli`, three atomic commits, no push, no PRs, no AI footers:

- `cc26cc0` feat(cli): @hyperwiki/cli — thin veneer over core/store/faces
- `0b3bf91` feat(example): recipe-book — four agents co-write a knowledge graph
- `a19ba28` docs: top-level README — usage-first, on autobee

## 1. `/packages/cli` (SPEC-FINAL §13)

`packages/cli/{package.json, bin/hyperwiki.js, lib/run.js, README.md}`.
Commands: `init`, `join`, `add-writer [--indexer]`, `remove-writer`,
`materialize`, `export [--roundtrip]`, `flags [family] [--json]`
(list/inspect the flag queue), plus the foreground `watch <storage> <dir>
[--swarm] [--confirm-deletes] [--debounce]` (ingest watcher + optional
hyperswarm replication; no daemon — Ctrl-C stops it). Thin veneer: every
effect flows through `@hyperwiki/{store,faces}`; the CLI never touches the
view or the face directly. Exit codes 0/1/2; `-h/--help`; parseArgs-strict
usage errors. Notables:

- governance commands verify their effect in the view after `update()` and,
  on rejection, surface apply's `flag/rejected` reason and exit 1 (§8.0
  observable from the CLI);
- commands refuse unpinned storage ("not a vault") instead of silently
  minting junk vaults, and `init` refuses already-pinned storage;
- there is deliberately no content-write command: content enters via the
  watcher (humans) or the store API (agents).

## 2. `examples/recipe-book` (flagship, LLM-framed)

`examples/recipe-book/{package.json, index.js, README.md, out/}` (workspace
member; `pnpm-workspace.yaml` gained `examples/*`). `node
examples/recipe-book` runs non-interactively: four agent peers with seeded
key pairs (Nova/Basil/Clove/Dill) on one shared vault — Nova (genesis
indexer) admits the others via `AddWriter` ops and defines the culinary
ontology in-log (`DefineScope`/`DefineTerm`: Recipe, Ingredient,
hasIngredient, prepTime, servings, …); the three writers then go offline
(replication streams torn down) and write concurrently: OR-set union across
writers on `hasIngredient`, cross-agent field edits, one LWW clobber
(`servings` 4 vs 6, `flag/clobber`), one body conflict (two revisions off
the same base, `flag/conflict`), dangling `[[refs]]` minted then healed by
the pantry notes ([[Herbes de Provence]] deliberately left dangling as the
honest TODO). Dill's editorial pass drains the conflict with
`ResolveConflict` (merged text), `RemMember` with the full §5.3 citation
set, and an audited prepTime edit. Finally the session is dumped:
`materialize` → `out/vault/` (14 files, opens in Obsidian) and
`exportTurtle` → `out/rdf/{schema,data}.ttl` (7 + 40 triples), **committed
to git** so a human can read the result in the repo.

Determinism: seeded key pairs + converged barriers before each concurrent
phase make the final view — and every byte of `out/` — identical on every
run; verified by two independent runs (`diff -r` byte-identical) plus the
committed-tree test. `.gitignore` needed a negation
(`!examples/recipe-book/out/`) because the stock Node ignore file's bare
`out` pattern (Next.js block) swallowed the dump. Example storage goes to a
fresh dir under `sslop/015/tmp/recipe-book/` per run (`RECIPE_BOOK_STORAGE`
/ `RECIPE_BOOK_OUT` overrides for the test). The example README carries the
roundtrip diagram (RDF ◀─ingest── markdown ──export▶) and the
sessions/findings/determinations/RFCs sibling-ontology note.

## 3. Top-level `README.md`

Usage-first per "How to write a README": (a) name + the exact one-liner;
(b) smallest end-to-end snippet FIRST — verified runnable as-is (root
`package.json` now devDepends on `@hyperwiki/*` workspace links so the
imports resolve; executed it from a scratch dir and read back `Home.md`);
(c) pnpm install; (d) recipe-book invocation + what it demonstrates; (e)
one architecture diagram (op log on autobee = source of truth; generated
faces: markdown vault, turtle export, queryable view + flag queue) with the
owner's registry framing verbatim (`[name, version]` grown to `[subject,
predicate, value, tag]`); (f) per-package API stubs (entry-point imports)
linking the four package READMEs; (g) the §5.7 policy-epoch caveat stated
plainly + the threat-model summary; also the §11 retention costs with the
spec's worked numbers and the §14 narrowed novelty claim (both README-
mandated by SPEC-FINAL); (h) `pnpm test`; (i) Apache-2.0. "Autobase"
appears nowhere in any deliverable (grep-verified).

## 4. Tests

- `test/cli.test.js` — 5 smoke tests spawning the real binary against real
  vaults on `sslop/015/tmp/`: exit codes/usage, init + re-init refusal,
  unpinned-storage guidance, join/add-writer/remove-writer round trip (incl.
  unadmitted-peer governance failure), materialize/export/flags against a
  seeded vault (unmapped round-trip on the face, never in the ttl), and a
  live `watch` run (spawn → human edit → `set-field` ingested → SIGINT →
  clean exit → view asserts the edit landed).
- `test/example-recipe-book.test.js` — runs the example into fresh scratch
  and asserts the freshly generated tree is **byte-identical** to the
  committed `examples/recipe-book/out/` (I9 in action), plus narrative
  assertions for the I5 union, §5.4 clobber, §6 conflict + resolution, §7
  dangling TODO.

## 5. DEVIATIONS.md

No new entries: nothing here deviates from SPEC-FINAL (the `watch` command
is assignment-mandated plumbing for the §9.2 watcher, not a spec conflict;
the gitignore negation and root devDeps are repo mechanics).

## 6. Verification

- `pnpm install` clean from scratch (all `node_modules` removed first).
- Full repo suite green: **111/111** (104 pre-existing + 7 new).
- Example run once more post-commit; committed `out/` regenerates
  byte-identically (also re-proven inside the suite run below).

Example narrative tail (`node examples/recipe-book`):

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

Test run tail (`pnpm test`, after clean install):

```
✔ join + add-writer + remove-writer round trip (§8.0/§8.3 plumbing)
✔ materialize + export + flags against a seeded vault
✔ watch ingests a human edit in the foreground and exits on SIGINT
✔ recipe-book example regenerates the committed out/ byte-identically (I9)
ℹ tests 111
ℹ suites 0
ℹ pass 111
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13855.285
```

Working tree clean at `a19ba28`.
