# AutoVault-LD & auto-okf

Two multi-writer knowledge systems on one substrate,
[autobee](https://github.com/holepunchto/autobee): agents and humans
co-writing shared vaults where the op log is the source of truth and every
readable artifact — markdown vault, Turtle export, OKF bundle — is a
regenerable face of it.

**[Vault-LD](./vault-ld/README.md)** (`vault-ld/`) is the RDF system:
Markdown vaults as linked data. Open a vault in Obsidian and it reads like
a wiki; export it and it *is* RDF.
**[auto-okf](./okf/README.md)** (`okf/`) is the lighter sibling: plain
[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
markdown bundles, no RDF. Each system pins its vocabulary in a glossary —
[vault-ld/GLOSSARY.md](./vault-ld/GLOSSARY.md),
[okf/GLOSSARY.md](./okf/GLOSSARY.md). When a term is overloaded (`writer`,
`op`, `view`, `vault`), the glossary is the one place it is fixed.

One way to see both: **a registry with more members in the tuple.** A
package registry maps a name to versions of a blob — `[name, version]`.
Vault-LD grows that tuple to `[subject, predicate, value, tag]`; auto-okf
to `[concept, field, value, tag]`. Concurrent writers merge at the level
of *statements* instead of overwriting files, and the rules that govern
merging are themselves content in the same log: schema evolution and data
evolution share one linearization, one determinism argument, one
governance regime.

## Choosing between them

| | Vault-LD | auto-okf |
| --- | --- | --- |
| a statement is | a triple: `[subject, predicate, value, tag]` | a concept's field: `[concept, field, value, tag]` |
| merge policy | per-predicate, from the in-log JSON-LD `@context` (LWW vs OR-set) | fixed defaults; no per-key policy (v1) |
| on-disk face | Obsidian-compatible vault + Turtle export (`schema.ttl`, `data.ttl`) | OKF v0.1 bundle (derived `index.md`, `log.md`) |
| byte reclamation | `PruneRevisions`, a logged governance op | an epoch cycle: operator act, never an op |
| invariants | I1–I10 | I1–I11 (adds the epoch roundtrip) |
| flagship example | [recipe-book](./vault-ld/examples/recipe-book): four agents write a recipe book | [agent-session](./okf/examples/agent-session): four agents, partitioned, write a session bundle |
| deep dive | [README](./vault-ld/README.md) · [SPEC](./orchestration/prompts/01-implementation-spec-prompt.v5.md) · [SECURITY_MODEL](./vault-ld/SECURITY_MODEL.md) | [README](./okf/README.md) · [SPEC](./okf/SPEC.md) · [SECURITY_MODEL](./okf/SECURITY_MODEL.md) |

## The smallest working example

Vault-LD's, six calls from empty storage to an Obsidian-readable wiki:

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

auto-okf's equivalent opens [okf/README.md](./okf/README.md).

## Install

```sh
pnpm install     # workspace: vault-ld/* + okf/* + the examples
```

Node.js ≥ 20, [pnpm](https://pnpm.io). Published packages:
`@autovault-ld/{core,store,faces,cli}` and `@auto-okf/{core,store,faces,cli}`.

## Running the tests

```sh
pnpm test                      # both systems: unit + invariant suites (node:test)
pnpm test:harness:clean        # vault-ld fault harness (:lossy, :partitioned, :fuzz)
pnpm test:okf-harness:clean    # okf fault harness (:lossy, :partitioned, :fuzz)
```

Each system's README documents its full test surface. Deviations from the
build specs are recorded per system, in
[`vault-ld/DEVIATIONS.md`](./vault-ld/DEVIATIONS.md) and
[`okf/DEVIATIONS.md`](./okf/DEVIATIONS.md).

## License

Apache-2.0
