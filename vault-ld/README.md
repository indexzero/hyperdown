# Vault-LD

A multi-writer wiki on [autobee](https://github.com/holepunchto/autobee):
Markdown vaults as linked data, agents and humans co-writing one knowledge
graph.

```js
import { Vault } from '@autovault-ld/store'
import { materialize } from '@autovault-ld/faces'

const vault = await Vault.init('./storage')                     // the op log is the source of truth
await vault.defineScope('wiki', 'https://my.wiki/terms#', 'w')  // the schema is ordinary content…
await vault.defineTerm('wiki', 'title', { '@id': 'w:title' })   // …in the same log as the data
await vault.setField('Home', 'title', 'Hello, AutoVault-LD')    // a semantic op, never a file write
await materialize(vault, './wiki')                              // ./wiki/Home.md + context.jsonld
await vault.close()
```

Open `./wiki` in Obsidian and it reads like a wiki; export it and it *is*
RDF. Every field write, link, schema definition, and governance decision is
an op in a shared multi-writer log; the Markdown vault, the Turtle export,
and the queryable view are generated faces of that log.

Vault-LD is the RDF system in this repository;
[auto-okf](../okf/README.md) is its lighter sibling on the same substrate.
Vault-LD's vocabulary (`subject`, `term`, `@context`, `writer`, `view`) is
pinned in [GLOSSARY.md](./GLOSSARY.md); when a term feels overloaded, the
glossary is the one place it is fixed.

## Install

```sh
pnpm add @autovault-ld/store @autovault-ld/faces   # and @autovault-ld/cli for the autovault-ld binary
```

Node.js ≥ 20. Inside this repository: `pnpm install` at the root sets up
the whole workspace.

## The flagship example: four agents write a recipe book

```sh
node vault-ld/examples/recipe-book   # from the repo root
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

**Novelty, narrowly stated:** the contribution is not per-predicate CRDT
selection and not a new CRDT — it is the reflexive composition where the
policy table (the JSON-LD `@context`) has no privileged channel: it is
ordinary data in the very same single-total-order log, folded by the very
same deterministic apply, at the cost of the regime-sensitivity described
in [SECURITY_MODEL.md](./SECURITY_MODEL.md). An engineering composition
(SU-Set semantics + autobee linearization + in-log mutable context), not a
new merge theory.

## Packages

| package | entry point | what it is |
| --- | --- | --- |
| [`@autovault-ld/core`](./core) | `import { createApply, encodeOp, keyspace, canonical, revHash } from '@autovault-ld/core'` | the op wire contract, the pure deterministic `apply`, the view keyspace, canonical forms |
| [`@autovault-ld/store`](./store) | `import { Vault } from '@autovault-ld/store'` | vault lifecycle on autobee: op emission, writer governance plumbing, metadata pinning, hyperswarm replication |
| [`@autovault-ld/faces`](./faces) | `import { materialize, createIngestWatcher, exportTurtle } from '@autovault-ld/faces'` | the generated faces: Obsidian-compatible vault, human-edit ingest watcher, deterministic Turtle export |
| [`@autovault-ld/cli`](./cli) | `autovault-ld init/join/add-writer/remove-writer/materialize/export/flags/watch` | thin command-line veneer over the three packages |

Each package README is usage-first with the full API surface.

## Security model

The adversary is a writer that bypasses client libraries entirely and
appends arbitrary bytes to its own core; every defense lives in `apply`.
The full trust story — the defense inventory, the context-regime caveat
(read it before trusting a reorg), and what is guaranteed versus
best-effort — is [SECURITY_MODEL.md](./SECURITY_MODEL.md).

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
pnpm test                   # from the repo root: unit + invariant suites, both systems
pnpm test:harness:clean     # vault-ld multi-process fault harness (:lossy, :partitioned, :fuzz)
```

The invariant suite maps each of I1–I10 (determinism, convergence, rebuild
equivalence, no-silent-loss, OR-set law, LWW law, flag lifecycle, index
coherence, export determinism, governance) to at least one test; the store
and faces suites drive real autobee + corestore instances on disk; the CLI
suite spawns the real binary; the example test re-runs the recipe book and
asserts the committed output regenerates byte-identically.

## License

Apache-2.0
