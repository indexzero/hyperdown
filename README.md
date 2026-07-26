# Multi-writer knowledge vaults on autobee

Agents write shared knowledge, concurrently or even adversarially, into an oplog a multi-writer
key/value store (provided by [autobee], a multi-writer hyperbee). When needed, the contents of
the underlying [autobee] can be *regenerated on disk* as markdown you open that is byte-deterministic
representation ("face") of it.

## What's here, briefly

- **[OKF]** (Open Knowledge Format) is a plain convention: a folder of markdown files with
  YAML frontmatter — the kind of notes you keep in Obsidian or a docs repo.
  **[auto-okf](./okf/README.md)** makes that folder *multi-writer*. **Start here.**
- **Vault-LD** is those same notes read as **linked data**: every field and link
  is an RDF triple you can query or export as Turtle.
  **[Vault-LD](./vault-ld/README.md)** is auto-okf *plus RDF*.

> [!NOTE]
> **I decided to call this collection of tools `hyperdown`:**
> `Hypertext + Markdown + bundling === hyperdown`
>
> All the machines told me **that was a bad idea.** But since when do we listen to them, right?

## Caveat Emptor

> [!WARNING]
> **Status:** `PREVIEW`
>
> - Exensive tests, fuzz testing, and multi-writer harnesses to find
>   non-deterministic edge cases
> - A human (me, @indexzero) performed numerous passes to tidy up terminology
>   (see: [okf/GLOSSARY.md](./okf/GLOSSARY.md) and [vault-ld/GLOSSARY.md](./vault-ld/GLOSSARY.md))
> - Not (yet) published to `npm`
> - A number of LLM orchestration files still in the source tree
>
> Nonetheless, [The smallest working example](#the-smallest-working-example) below
> has real legs and has shown real promise as lightweight multi-writer native tooling
> for OKF bundles

## The smallest working example

Six calls take auto-okf from empty storage to a folder you can open:

```js
import { initVault } from '@auto-okf/store'
import { materialize } from '@auto-okf/faces'

const vault = await initVault('./vault')                    // the op log is the source of truth
const { tag: id } = await vault.createConcept('guides/getting-started', 'guide')
await vault.setField(id, 'title', 'Getting started')
await vault.setBody(id, null, 'Read the [architecture](/guides/architecture) first.')
await vault.update()
await materialize(vault, './bundle')                        // writes the tree below
await vault.close()
```

That single write now has **two faces**, both derived from the log.

**On disk** — the OKF bundle a human (or Obsidian) opens:

```
./bundle
├── guides/
│   └── getting-started.md     ← ---                              (frontmatter)
│                                 _id: 0101…01·0
│                                 _rev: 9f2c…                     (the body's revHash)
│                                 type: guide
│                                 title: Getting started
│                                 ---
│                                 Read the [architecture](/guides/architecture) first.
├── index.md                   ← derived: every concept, listed
└── log.md                     ← derived: the write history, narrated
```

**In the [view](./okf/GLOSSARY.md#view)** — the hyperbee keys every peer
converges on (values simplified):

```
c/<id>/meta                        → {"type":"guide","created":"…"}
c/<id>/f/title                     → "Getting started"
c/<id>/path                        → {"path":"guides/getting-started","ord":0}
c/<id>/body                        → 9f2c…                  head revision pointer
c/<id>/rev/9f2c…                   → "Read the [architecture](/guides/architecture)…"
path/guides%2Fgetting-started      → <id>                   who holds this path
link/<id>/guides%2Farchitecture    → true                   an outgoing link…
wanted/guides%2Farchitecture/<id>  → true                   …whose target isn't written yet
gov/writer/<writer>                → {"indexer":true}       the genesis writer
```

`<id>` is the concept's stable `_id`, minted from the op that created it: the
writer's key followed by the op's sequence number. The `/` in a path is escaped
(`%2F`) so a concept named `../escape` can never collide with another key. Nothing
on disk is authoritative — hand-edit `getting-started.md` and `ingest` folds the
change back into the log as the minimal set of ops; delete `./bundle` and it
regenerates from the log, byte for byte.

## The one idea, now that you have the example

A [writer](./okf/GLOSSARY.md#writer) never writes a file. It appends a semantic
[op](./okf/GLOSSARY.md#op--operation) — *set this field, add this tag, set this
body* — to its own core. One deterministic `apply` folds every writer's ops, in a
single linearized order, into the one view above; the markdown
[bundle](./okf/GLOSSARY.md#bundle) — and, in Vault-LD, the Turtle export — are
projections of that view.

So concurrent writers merge at the level of *statements*, not files. Two agents
editing the same concept do not collide on a file; they contribute ops that a
fixed rule combines. When one value loses, it is never lost silently — it leaves a
flag.

## When you'd swarm many agents

One writer is a wiki. The point is the swarm — many peers, each with its own core,
often disconnected, writing into one graph that always converges. What that buys
grows with the count:

| agents | a real job you'd point them at | what the design earns |
| ---: | --- | --- |
| **3** | a drafting cell — researcher, writer, fact-checker co-author one report | an overwrite never vanishes: the fact-checker's correction and the writer's edit both survive; the loser is flagged (`flag/clobber`) for a human |
| **5** | auto-documenting a five-module codebase, one agent per module | per-writer path namespaces keep them off each other's files; shared glossary terms union as OR-set [tags](./okf/GLOSSARY.md#tag-opid) |
| **10** | an overnight research swarm, each agent summarizing a different rate-limited source into one graph | partition tolerance: each agent keeps writing while its source (or a peer) is down and heals on reconnect — no central lock; `wanted/` ranks which cross-links still dangle |
| **20** | migrating a legacy wiki, each agent converting a section over hours | concurrent renames merge with concurrent edits (path is an LWW register); case-folded path collisions are flagged and self-heal when the loser moves |
| **100** | a fleet cataloguing a hundred repos or feeds into one merged catalog, nightly | nobody coordinates: each writes its own core, every peer folds to the identical view, and per-writer token buckets keep the audit bounded under flood; [generation](./okf/GLOSSARY.md#generation--compact) compaction reclaims bytes later |

The scenarios apply to both formats; pick the format by the table below.

## Choosing between them

Pick by what a *statement* is in your domain and how much merge control you need:

| | auto-okf | Vault-LD |
| --- | --- | --- |
| a statement is | a concept's field: `[concept, field, value, tag]` | a triple: `[subject, predicate, value, tag]` |
| merge policy | fixed defaults; no per-key policy (v1) | per-predicate, from the in-log JSON-LD `@context` (LWW vs OR-set) |
| on-disk face | OKF v0.1 bundle (derived `index.md`, `log.md`) | Obsidian-compatible vault + Turtle export (`schema.ttl`, `data.ttl`) |
| byte reclamation | a generation cycle: operator act, never an op | `PruneRevisions`, a logged governance op |
| invariants | I1–I11 (adds the generation roundtrip) | I1–I10 |
| flagship example | [agent-session](./okf/examples/agent-session): four agents, partitioned, write a session bundle | [recipe-book](./vault-ld/examples/recipe-book): four agents write a recipe book |
| deep dive | [README](./okf/README.md) · [SPEC](./okf/SPEC.md) · [SECURITY_MODEL](./okf/SECURITY_MODEL.md) | [README](./vault-ld/README.md) · [SPEC](./orchestration/prompts/01-implementation-spec-prompt.v5.md) · [SECURITY_MODEL](./vault-ld/SECURITY_MODEL.md) |

Each system pins its own vocabulary in a glossary —
[vault-ld/GLOSSARY.md](./vault-ld/GLOSSARY.md),
[okf/GLOSSARY.md](./okf/GLOSSARY.md). When a term is overloaded (`writer`, `op`,
`view`, `vault`), the glossary is the one place it is fixed.

## A registry with more members in the tuple

One way to see both, once the mechanism is familiar: a package registry maps a
name to versions of a blob — `[name, version]`. These systems grow that tuple.
auto-okf reaches `[concept, field, value, tag]`; Vault-LD reaches
`[subject, predicate, value, tag]`. And the rule that governs merging is itself
content in the same log — so schema evolution and data evolution share one
linearization, one determinism argument, one governance regime.

## Install

```sh
pnpm install     # workspace: vault-ld/* + okf/* + the examples
```

Node.js ≥ 20, [pnpm](https://pnpm.io). Published packages:
`@auto-okf/{core,store,faces,cli}` and `@autovault-ld/{core,store,faces,cli}`.

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

[autobee]: https://github.com/holepunchto/autobee
[OKF]: https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf
