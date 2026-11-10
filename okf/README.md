# auto-okf

auto-okf is a multi-writer store for one OKF bundle, on autobee, for a swarm
of agents that trust each other. Every peer folds the same ops into the same
view and writes the same files. Trust is total, and it lasts one generation:
one vault, one key set, one log. If your writers are not all yours, or you
must revoke one without starting over, auto-okf is the wrong tool.

## The lifecycle

    auto-okf init <dir> [--encryption-key <hex64>]                 # generation 1
    auto-okf keys <dir>                                            # this peer's writer key and swarm key
    auto-okf join <dir> <vault-key> --metadata <okf-vault.json>    # on each new peer, with the invite
    auto-okf add-writer <dir> <writer-key> --swarm-key <hex64>
    auto-okf bootstrap --port <n> [--host <ipv4>]                  # the hub of your private DHT
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
  plaintext: no flags, and `log.md` names past paths. The ingest watcher
  turns edits into ops.

## What will bite you

| Fact | What to do | Home |
|---|---|---|
| Any writer, or any key a writer ever named, can halt every peer for good. | Admit only keys you would trust with the whole vault. | SECURITY_MODEL, the unbounded approval |
| Removing a writer stops cooperating clients only. A modified client backdates past it, with no rejection flag. | To evict, import into the next generation and do not add the key again. | SECURITY_MODEL, the revocation bypass |
| Writers order concurrent writes by their own clocks. | Keep clocks in sync. A slow clock loses every race. Two hours ahead stalls the peer. | SPEC §8 |
| A non-indexer writer has a budget of 1024 ops, refilled by accepted indexer ops. | Raise the ceiling, or admit the agents as indexers. | SPEC §8 |
| `append` reports durable, not accepted. Ingest reports the verdict of its own fold, and a reorder can change it. | Read `flags rejected` in your write loop. | store README |
| One process per vault directory. | Stop `watch` before another command, or give each process its own vault. | store README |
| Within a generation the log only grows, and nothing written can be removed. | To redact, import into a new generation and destroy every old replica. | SPEC §10 |
| One op, so one body, is at most 64 KiB. A path is at most 1,024 bytes and 64 segments. | Split large documents into linked concepts. | SPEC §3 |
| Tags are an OR-set. Other fields are last-writer-wins, with a flag. Two body edits both persist until `resolve`. | Run a resolve step before `materialize`. `import` refuses an open path collision, and carries only the head of a body conflict. | SPEC §5 |
| Correctness relies on undocumented behaviour of autobee 2.12.1, pinned exactly. | Install from the lockfile. | DEVIATIONS |
| If every indexer directory is lost, nobody can admit a writer. | Back up an indexer directory, or admit two indexers. | SECURITY_MODEL |
| A writer can make every peer open unbounded writer cores. | Expect cost. Only 200 cores are tested. | SECURITY_MODEL, the writer-core flood |

## Known issues

| Trigger | What to do |
|---|---|
| On a case-insensitive file system, you change a path only in case, such as the fix for a path that the fold report of `materialize` names, then materialize into the same face again. That run unlinks the note, and `import` drops its concept (`reconcile` in `okf/faces/lib/materialize.js`). | Materialize each generation into a new, empty directory (`okf/faces/test/generation.test.js`). |
| Two paths differ only in letters that APFS folds together and `toLowerCase` does not, such as ß and SS, or σ and ς. The fold report of `materialize` misses them, and `import` can rename or drop those concepts (`casefoldPath` in `okf/core/lib/apply.js`, `lossyPaths` in `okf/faces/lib/materialize.js`). | Run `materialize` and `import` on a case-sensitive file system. |
| You import a subdirectory of the face of an encrypted vault, or a copy of that face that skipped dot-files. `import` looks for the `.okf-encrypted` mark only at the root of the face, so an import without a key makes an unencrypted vault (`importFace` and `isMarkedEncrypted` in `okf/faces/lib/import.js`). | Pass the old vault's `okf-vault.json` with `--metadata`. `import` then refuses to run without `--encryption-key` (`importFace` in `okf/faces/lib/import.js`). |
| A file whose ingest did not complete stays pending in `.okf-pending.json`. If it has an NFD name, its record goes stale, it gets a case-only rename on APFS, a conflict copy of its concept ingests, or a rename and a copy of it ingest at once, ingest can attach an edit or a delete to the wrong concept (`_pendingConcept`, `_pendingOf` and `_keepPending` in `okf/faces/lib/ingest.js`). | Give note files NFC names. Fix each file that an `error:` line of `ingest` names until it ingests, before you rename, copy or delete it, or edit its conflict copy. Run `ingest` without `--confirm-deletes` while `.okf-pending.json` exists. |
| A peer joins through the store API with the vault key alone, so it pins `swarm.genesis: null`. When an indexer removes the creator, that peer never cuts the creator's swarm key (`_refreshAllowlistOnce` in `okf/store/lib/bundle.js`). | Pass the invite as `opts.metadata` to `Bundle.join`, as `auto-okf join --metadata` does. |
| Some docs and help texts are imprecise. | Where a text and the code differ, trust the code and its tests. |

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

`./bundle` is a plain OKF bundle, and any markdown reader can open it. If
you edit a file there, `ingest` turns the edit into the smallest set of ops.
The op log is the source of truth. The bundle and the view are projections
of that log, and neither is authoritative ([SPEC §2](./SPEC.md)).

auto-okf has no RDF, and it has its own store on autobee@2.12.1
([`@auto-okf/store`](./store)). [Vault-LD](../vault-ld/README.md) is the
other system in this repository. [GLOSSARY.md](./GLOSSARY.md) gives each
term of auto-okf one meaning, such as `concept`, `bundle`, `vault`,
`writer` and `ingest`.

## Install

```sh
pnpm add @auto-okf/store @auto-okf/faces   # and @auto-okf/cli for the auto-okf binary
```

auto-okf needs Node.js 20 or later. In this repository, `pnpm install` at
the root sets up the whole workspace. A consumer must make
`hypercore-crypto` and `b4a` resolvable for the dependencies of the store.
See [`@auto-okf/store`, "Install"](./store/README.md#install).

This release writes vault metadata version 2, and it opens only vaults
with metadata version 2. It does not carry over the vaults of an earlier
release. Its peers find each other on the `auto-okf/2` hyperswarm topic.
See [`@auto-okf/store`, "Vaults this release opens"](./store/README.md#vaults-this-release-opens).

The ops of a joining peer take effect only after an indexer admits it with
`add-writer`. Until autobee adds the peer, its store refuses every append
with `VAULT_NOT_WRITABLE`. See SPEC §8 and
[`@auto-okf/store`](./store/README.md).

## The flagship example: four agents write a session bundle

```sh
node okf/examples/agent-session/session.js   # from the repo root
```

Four AI agents write findings, determinations and an RFC to one shared
vault. Each agent is a peer with its own writer core. The agents write
while a partition separates them, and then the partition heals:

- The tag OR-sets take the union of the adds from each side.
- Each LWW register picks the same winner on every peer, and flags the
  overwrite.
- A human operator materializes the session as an OKF bundle.

The example writes the committed
[`examples/agent-session/out/`](./examples/agent-session/out/) tree again,
byte for byte (I9). See
[`examples/agent-session/README.md`](./examples/agent-session/README.md).

There are two smaller examples:

- [`slop-archive`](./examples/slop-archive/) is a durable archive of LLM
  output. It shows the append-only guarantee.
- [`vlurp-library`](./examples/vlurp-library/) is one script that turns a
  vlurpfile into a bundle with an `_id` in each note.

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

No component treats a bundle as authoritative. An edit of a file in the
bundle enters the log as ops (SPEC §9). From a converged view,
`materialize` writes the same bytes again (I9). A
[generation](./GLOSSARY.md#generation--import) is an operator act, never
an op (SPEC §10).

## Packages

| Package | What it is |
| --- | --- |
| [`@auto-okf/core`](./core) | the op wire codec, the deterministic `apply`, the view keyspace, the canonical forms |
| [`@auto-okf/store`](./store) | the vault lifecycle on autobee: appends, governance (SPEC §8), the pinned metadata, swarm replication |
| [`@auto-okf/faces`](./faces) | materialize, the ingest watcher, the `wanted/` demand index, the import of a bundle into a new vault |
| [`@auto-okf/cli`](./cli) | `auto-okf init/join/add-writer/keys/remove-writer/materialize/ingest/watch/bootstrap/status/wanted/flags/import/resolve/undelete` |

Each package README states the usage first, then gives a table of its API.
The CLI README gives a table of its commands. [SPEC.md](./SPEC.md) is the
home of every rule of okf.

## Security model

okf has two adversaries, because it has two doors. The first is a writer
that appends arbitrary bytes to its own core. The second is anyone who can
write files into the watched bundle directory.
[SECURITY_MODEL.md](./SECURITY_MODEL.md) is the home of the trust model,
the eviction ladder, the defenses and each residual.

## Running the tests

Run these from the repo root:

```sh
pnpm test:okf                   # node:test; unit + invariant suite (I1..I11)
pnpm test:okf-harness:clean     # multi-process fault harness (:lossy, :partitioned, :fuzz)
pnpm test:okf:soak              # sustained-flood soak
```

The tests of each package are in `okf/<package>/test/`. The harness
scenarios are in `okf/harness/scenarios/`, and the example tests are in
`okf/examples/test/`. SPEC §11 maps each invariant,
I1 to I11, to the suite. See [harness/README.md](./harness/README.md) for
the fault harness.

## License

Apache-2.0
