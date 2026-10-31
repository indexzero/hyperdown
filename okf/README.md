# auto-okf

auto-okf is a multi-writer store for one OKF bundle, on autobee, for a swarm
of agents that trust each other. Every peer folds the same ops into the same
view and writes the same files. Trust is total, and it lasts one generation:
one vault, one key set, one log. If your writers are not all yours, or you
must revoke one without starting over, auto-okf is the wrong tool.

## The lifecycle

    auto-okf init <dir> [--encryption-key <hex64>]                 # generation 1
    auto-okf keys <dir>                                            # this peer's writer key and swarm key
    auto-okf add-writer <dir> <writer-key> --swarm-key <hex64>
    auto-okf watch <dir> <bundle-dir> --swarm --bootstrap <host:port>
    auto-okf materialize <dir> <bundle-dir>                        # the live view, as plaintext files
    auto-okf import <bundle-dir> <new-dir> [--encryption-key <hex64>]   # generation 2

A generation ends when you materialize it and import the files into a new
vault. The new vault has new keys and only the writers you add again. That is
how you shrink the log, rotate keys, and shed a writer.

## What it does

- **Converges.** Peers that fold the same ops hold a bit-identical view
  (I1 to I11; the fault harness and seeded fuzz check them). Every op that
  `apply` rejects leaves a `flag/rejected` entry.
- **Connects privately.** Only [allowlisted](./store/README.md#replication)
  swarm keys pass the firewall. Peers connect directly, through a bootstrap
  node you run, or through your own DHT. The public DHT needs `--public-dht`.
- **Encrypts at rest, on request.** `--encryption-key` encrypts the stored
  cores. Every writer holds the key, and every vault directory stores it.
- **Exports and imports files.** `materialize` writes the live view as
  plaintext: no history, no flags. The ingest watcher turns edits into ops.

## What will bite you

| Fact | What to do | Home |
|---|---|---|
| Any writer, or any key a writer ever named, can halt every peer for good. | Admit only keys you would trust with the whole vault. | SECURITY_MODEL, G2 |
| Removing a writer stops cooperating clients only. A modified client backdates past it, with no rejection flag. | To evict, import into the next generation and do not add the key again. | SECURITY_MODEL, G34 |
| Writers order concurrent writes by their own clocks. | Keep clocks in sync. A slow clock loses every race. Two hours ahead stalls the peer. | SPEC §8 |
| A non-indexer writer has a budget of 1024 ops, refilled by accepted indexer ops. | Raise the ceiling, or admit the agents as indexers. | SPEC §8 |
| `append` reports durable, not accepted. Ingest reports the verdict of its own fold, and a reorder can change it. | Read `flags rejected` in your write loop. | store README |
| One process per vault directory. | Run commands from the replicating process, or give each process its own vault. | store README |
| Within a generation the log only grows, and nothing written can be removed. | To redact, import into a new generation and destroy every old replica. | SPEC §10 |
| One op, so one body, is at most 64 KiB. A path is at most 1,024 bytes and 64 segments. | Split large documents into linked concepts. | SPEC §3 |
| Tags are an OR-set. Other fields are last-writer-wins, with a flag. Two body edits both persist until `resolve`. | Run a resolve step before `materialize`. `import` refuses an open path collision, and carries only the head of a body conflict. | SPEC §5 |
| Correctness relies on undocumented behaviour of autobee 2.12.1, pinned exactly. | Install from the lockfile. | DEVIATIONS |
| If every indexer directory is lost, nobody can admit a writer. | Back up an indexer directory, or admit two indexers. | SECURITY_MODEL |
| A writer can make every peer open unbounded writer cores. | Expect cost, not a halt. | SECURITY_MODEL, G44 |

## From code

```js
import { Bundle } from '@auto-okf/store'
import { materialize } from '@auto-okf/faces'

const bundle = await Bundle.init('./storage')               // the op log is the source of truth
const { tag: id } = await bundle.createConcept('guides/getting-started', 'guide')
await bundle.setField(id, 'title', 'Getting started')
await bundle.setBody(id, null, 'Read the [architecture](/guides/architecture) first.')
await bundle.update()
await materialize(bundle, './bundle')                       // guides/getting-started.md + index.md + log.md
await bundle.close()
```

Open `./bundle` in any markdown reader and it is a plain OKF bundle;
hand-edit a file and `ingest` folds the change back into the log as minimal
ops. Every field write, tag, rename, and governance decision is an op in a
shared multi-writer log; the bundle on disk and the queryable view are
generated faces of that log, never authoritative
([SPEC §2](./SPEC.md)).

auto-okf is the lighter sibling of [Vault-LD](../vault-ld/README.md): no
RDF, and its own store on autobee@2.12.1 ([`@auto-okf/store`](./store)).
Its vocabulary (`concept`, `bundle`, `vault`, `writer`, `ingest`) is
pinned in [GLOSSARY.md](./GLOSSARY.md); when a term feels overloaded, the
glossary is the one place it is fixed.

## Install

```sh
pnpm add @auto-okf/store @auto-okf/faces   # and @auto-okf/cli for the auto-okf binary
```

Node.js ≥ 20. Inside this repository: `pnpm install` at the root sets up
the whole workspace. A consumer must make `hypercore-crypto` and `b4a`
resolvable for the store's dependencies (see
[`@auto-okf/store`](./store/README.md#install)).

This release writes vault metadata version 2 and opens only vaults with
metadata version 2: vaults of an earlier release are not carried over. Its
peers find each other on the `auto-okf/2` hyperswarm topic. A joining
peer's ops take effect only after an indexer has admitted it with
`add-writer`, and until autobee has added it, its store refuses every
append (`VAULT_NOT_WRITABLE`). See
[`@auto-okf/store`](./store/README.md#vaults-this-release-opens).

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
byte-identically, from a converged view (I9). A
[generation](./GLOSSARY.md#generation--import) is an operator act, never
an op (§10).

## Packages

| package | what it is |
| --- | --- |
| [`@auto-okf/core`](./core) | the op wire codec, the pure deterministic `apply`, the view keyspace, canonical forms |
| [`@auto-okf/store`](./store) | vault lifecycle on autobee: op emission, §8 governance, metadata pinning (the append-only constant + generation chain), swarm replication |
| [`@auto-okf/faces`](./faces) | materialize (bundle + `index.md`/`log.md`), the ingest watcher, the `wanted/` demand index, the import of a face into a new vault (a generation) |
| [`@auto-okf/cli`](./cli) | `auto-okf init/join/add-writer/keys/remove-writer/materialize/ingest/watch/bootstrap/status/wanted/flags/import/resolve/undelete` |

Each package README is usage-first, with a table of its API (for the CLI,
its commands).

## Security model

There are two adversaries, because okf has two doors: a writer appending
arbitrary bytes to its own core, and anyone who can write files into the
watched bundle directory. Every log-side defense lives in `apply`; the
disk side is bounded by the emission manifest and the ingest rules. The
trust model, the eviction ladder and each residual, with the evidence of
each, are in [SECURITY_MODEL.md](./SECURITY_MODEL.md).

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
