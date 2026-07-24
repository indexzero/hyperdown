# AutoVault-LD

A multi-writer wiki on [autobee](https://github.com/holepunchto/autobee):
Markdown vaults as linked data, agents and humans co-writing one knowledge
graph.

```js
import { Vault } from '@autovault-ld/store'
import { materialize } from '@autovault-ld/faces'

const vault = await Vault.init('./storage')                     // the op log is the source of truth
await vault.defineScope('wiki', 'https://my.wiki/terms#', 'w')  // the schema is ordinary content…
await vault.defineTerm('wiki', 'title', { '@id': 'w:title' })   // …in the same log as the data
await vault.setField('Home', 'title', 'Hello, AutoVault-LD')       // a semantic op, never a file write
await materialize(vault, './wiki')                              // ./wiki/Home.md + context.jsonld
await vault.close()
```

Open `./wiki` in Obsidian and it reads like a wiki; export it and it *is*
RDF. Every field write, link, schema definition, and governance decision is
an op in a shared multi-writer log; the Markdown vault, the Turtle export,
and the queryable view are generated faces of that log.

This repository holds two systems on one substrate. **Vault-LD** (this
README, `vault-ld/`) is the RDF/linked-data system above. **auto-okf**
(`okf/`) is a lighter sibling — plain Open Knowledge Format bundles, no RDF —
with its own [README](okf/README.md). Each has a glossary that fixes its
vocabulary: [vault-ld/GLOSSARY.md](vault-ld/GLOSSARY.md) and
[okf/GLOSSARY.md](okf/GLOSSARY.md). If a term below feels overloaded (`writer`,
`op`, `view`, `vault`), the glossary is the one place it is pinned.

## Install

```sh
pnpm install            # workspace: vault-ld/{core,store,faces,cli} + examples
```

Node.js ≥ 20, [pnpm](https://pnpm.io). Per package:
`pnpm add @autovault-ld/store @autovault-ld/faces` (and `@autovault-ld/cli` for the
`autovault-ld` binary).

## The flagship example: four agents write a recipe book

```sh
node examples/recipe-book
```

Four agent writers (each a real peer with its own writer core) build a
recipe-book knowledge graph from scratch on one shared vault: one defines
the ontology (`DefineScope`/`DefineTerm`: Recipe, Ingredient,
`hasIngredient`, `prepTime`, …), three write recipes concurrently while
disconnected — OR-set fields union across writers, LWW registers pick a
deterministic winner and flag the overwrite, wiki-links to not-yet-written
notes mint IRIs and flag dangling, two agents conflict on the same prose
body and an editor resolves it with a merge op. Then the session is dumped
for humans: the committed, regenerated-byte-identically
[`examples/recipe-book/out/`](./examples/recipe-book/out/) holds the
Markdown vault and the `schema.ttl`/`data.ttl` export. See
[`examples/recipe-book/README.md`](./examples/recipe-book/README.md).

The same substrate carries agentic communication structures — sessions,
findings, determinations, RFCs — as sibling ontologies of the recipe book.

## Architecture

```
     agents ──ops──▶  ┌─────────────────────────────┐  ◀──ops── humans (ingest watcher)
                      │   op log on autobee (§2)    │
                      │  one writer core per writer │
                      └──────────────┬──────────────┘
                        deterministic apply — folds the
                        linearized ops into ONE view
                                     │
                     queryable hyperbee view (§4 keyspace)
                 n/ field state · idx/ triples · ctx/ context+gov
                        · flag/ audit (nothing lost silently)
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          ▼                          ▼                          ▼
   markdown vault              turtle export               flag queue
 (Obsidian-compatible,     schema.ttl + data.ttl       (conflicts, clobbers,
  human-editable face)      (query-only or roundtrip)   dangling, unmapped…)
```

One way to see it: **this is a registry with more members in the tuple** —
`[name, version]` grown to `[subject, predicate, value, tag]`. A package
registry maps a name to versions of a blob; AutoVault-LD maps a subject to
per-predicate, per-element tagged values, so concurrent writers merge at
the level of *statements* instead of overwriting files. The `@context`
that decides each predicate's merge policy (LWW register vs OR-set) is
itself content in the same log — schema evolution and data evolution share
one linearization, one determinism argument, one governance regime.

**Novelty, narrowly stated:** the contribution is not per-predicate CRDT
selection and not a new CRDT — it is the reflexive composition where the
policy table (the JSON-LD `@context`) has no privileged channel: it is
ordinary data in the very same single-total-order log, folded by the very
same deterministic apply, at the cost of the epoch-sensitivity described
below. An engineering composition (SU-Set semantics + autobee
linearization + in-log mutable context), not a new merge theory.

## Packages

| package | entry point | what it is |
| --- | --- | --- |
| [`@autovault-ld/core`](./vault-ld/core) | `import { createApply, encodeOp, keyspace, canonical, revHash } from '@autovault-ld/core'` | the op wire contract, the pure deterministic `apply`, the view keyspace, canonical forms |
| [`@autovault-ld/store`](./vault-ld/store) | `import { Vault } from '@autovault-ld/store'` | vault lifecycle on autobee: op emission, writer governance plumbing, metadata pinning, hyperswarm replication |
| [`@autovault-ld/faces`](./vault-ld/faces) | `import { materialize, createIngestWatcher, exportTurtle } from '@autovault-ld/faces'` | the generated faces: Obsidian-compatible vault, human-edit ingest watcher, deterministic Turtle export |
| [`@autovault-ld/cli`](./vault-ld/cli) | `autovault-ld init/join/add-writer/remove-writer/materialize/export/flags/watch` | thin command-line veneer over the three packages |

Each package README is usage-first with the full API surface.

## Security model

The adversary is a writer that bypasses client libraries entirely and
appends arbitrary bytes to its own core; every defense lives in `apply`.
The full trust story — the defense inventory, the policy-epoch caveat, and
what is guaranteed versus best-effort — is
[vault-ld/SECURITY_MODEL.md](./vault-ld/SECURITY_MODEL.md). The okf
sibling, with its second (disk-side) adversary, is
[okf/SECURITY_MODEL.md](./okf/SECURITY_MODEL.md).

## Retention: the accepted cost (v1)

The log is never truncated in v1 — determinism and auditability are bought
with monotonic growth. Worked numbers: 50 agents × 500 ops/day ≈ **9.1M
ops/year** of never-collected input-core blocks; if 10% are `SetBody`
averaging 4 KB, ≈ **3.6 GB/year** of retained body revisions. Mitigations
that exist today: `PruneRevisions` (a logged, deterministic governance op)
removes non-head body revisions; superseded revisions become prunable after
`ResolveConflict`. Snapshot bootstrap and DXOS-style epochs are the
documented future direction (§11).

Also documented up front: clobber-immunity for prose is a **view**
property (bodies live in the view; regeneration is a pure projection);
on-disk races are handled separately by atomic writes, per-path locks, and
the pending-ingest protocol (§9.4).

## Running the tests

```sh
pnpm test        # node:test; unit + invariant suite (I1..I10) + store/faces/cli integration + the example
```

The invariant suite maps each of I1–I10 (determinism, convergence, rebuild
equivalence, no-silent-loss, OR-set law, LWW law, flag lifecycle, index
coherence, export determinism, governance) to at least one test; the store
and faces suites drive real autobee + corestore instances on disk; the CLI
suite spawns the real binary; the example test re-runs the recipe book and
asserts the committed output regenerates byte-identically.

Deviations from the build spec are recorded in
[`DEVIATIONS.md`](./DEVIATIONS.md).

## License

Apache-2.0
