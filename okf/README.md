# auto-okf

A multi-writer knowledge bundle on
[autobee](https://github.com/holepunchto/autobee): plain
[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
markdown, agents and humans co-writing one vault.

```js
import { initVault } from '@auto-okf/store'
import { materialize } from '@auto-okf/faces'

const vault = await initVault('./vault')                    // the op log is the source of truth
const { tag: id } = await vault.createConcept('guides/getting-started', 'guide')
await vault.setField(id, 'title', 'Getting started')
await vault.setBody(id, null, 'Read the [architecture](/guides/architecture) first.')
await vault.update()
await materialize(vault, './bundle')                        // guides/getting-started.md + index.md + log.md
await vault.close()
```

Open `./bundle` in any markdown reader and it is a plain OKF bundle;
hand-edit a file and `ingest` folds the change back into the log as minimal
ops. Every field write, tag, rename, and governance decision is an op in a
shared multi-writer log; the bundle on disk and the queryable view are
generated faces of that log, never authoritative
([SPEC §2](./SPEC.md)).

auto-okf is the lighter sibling of [Vault-LD](../vault-ld/README.md): same
substrate, no RDF. Its vocabulary (`concept`, `bundle`, `vault`, `writer`,
`ingest`) is pinned in [GLOSSARY.md](./GLOSSARY.md); when a term feels
overloaded, the glossary is the one place it is fixed.

## Install

```sh
pnpm add @auto-okf/store @auto-okf/faces   # and @auto-okf/cli for the auto-okf binary
```

Node.js ≥ 20. Inside this repository: `pnpm install` at the root sets up
the whole workspace.

## The flagship example: four agents write a session bundle

```sh
node okf/examples/agent-session/session.js   # from the repo root
```

Four AI agents (each a real peer with its own writer core) co-author
findings, determinations, and an RFC on one shared vault while
**partitioned**, then heal: tag OR-sets union across the partition, LWW
registers pick a deterministic winner and flag the overwrite, and a human
operator dumps the session as a readable OKF bundle. The committed
[`examples/agent-session/out/`](./examples/agent-session/out/) tree
regenerates byte-identically (I9). ThreadMode in, DocumentMode out — see
[`examples/agent-session/README.md`](./examples/agent-session/README.md).

Two smaller examples:
[`slop-archive`](./examples/slop-archive/) (a durable LLM-output archive,
showing off append-only) and [`vlurp-library`](./examples/vlurp-library/)
(one script: vlurpfile → staging → `_id`-stamped bundle).

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
             c/ concepts · path/ · link/ bl/ · flag/ audit
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
  OKF bundle                 wanted/ index                flag queue
(markdown + frontmatter,   (ranked demand: what        (conflicts, clobbers,
 index.md, log.md)          wants to be written?)       rejections…)
```

No component ever treats a generated face as authoritative: human edits to
the bundle re-enter as ops (§9), and a face can always be regenerated,
byte-identically, from a converged view (I9). Byte reclamation is an
[generation cycle](./GLOSSARY.md#generation--compact) — materialize, re-ingest into
a fresh vault with `_id` adoption — an operator act, never an op (§10).

## Packages

| package | what it is |
| --- | --- |
| [`@auto-okf/core`](./core) | the op wire codec, the pure deterministic `apply`, the view keyspace, canonical forms |
| [`@auto-okf/store`](./store) | vault lifecycle on autobee: op emission, §8 governance, metadata pinning (the append-only constant + generation chain), swarm replication |
| [`@auto-okf/faces`](./faces) | materialize (bundle + `index.md`/`log.md`), the ingest watcher, the `wanted/` demand index, generation-cycle compact |
| [`@auto-okf/cli`](./cli) | `auto-okf init/join/add-writer/remove-writer/materialize/ingest/watch/wanted/flags/resolve/undelete/compact` |

Each package README is usage-first with the full API surface.

## Security model

There are two adversaries, because okf has two doors: a writer appending
arbitrary bytes to its own core, and anyone who can write files into the
watched bundle directory. Every log-side defense lives in `apply`; the
disk side is bounded by the emission manifest and the ingest rules. The
full trust story, including what is guaranteed versus best-effort, is
[SECURITY_MODEL.md](./SECURITY_MODEL.md).

## Running the tests

```sh
pnpm test:okf                   # node:test; unit + invariant suite (I1..I11)
pnpm test:okf-harness:clean     # multi-process fault harness (:lossy, :partitioned, :fuzz)
pnpm test:okf:soak              # sustained-flood soak
```

From the repo root. The invariant suite maps each of I1–I11 (determinism,
convergence, rebuild equivalence, no-silent-loss, OR-set law, LWW law,
conflict lifecycle, index coherence, face determinism, governance, generation
roundtrip) to at least one test; the harness drives real per-writer OS
processes through a fault proxy; the example suites assert the committed
`out/` trees regenerate byte-identically.

## License

Apache-2.0
