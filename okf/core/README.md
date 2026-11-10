# @auto-okf/core

`@auto-okf/core` is the core of auto-okf, a multi-writer store for
[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
bundles. This package does not depend on a transport. It defines these
things:

- The op wire contract.
- The deterministic `apply`, which folds a linearized op stream into a view.
- The view keyspace.
- An in-memory view for tests.

It never imports autobee. `@auto-okf/store` supplies the substrate.

## Usage

Encode ops, apply them, then read the view:

```js
import {
  createApply,
  encodeOp,
  MemView,
  keyspace as K
} from '@auto-okf/core'

const writer = /* 32-byte writer key */ Buffer.alloc(32, 1)
const W = writer.toString('hex')

const apply = createApply({ genesisKey: writer })
const view = new MemView()

// Every op carries `clock` (the writer's observed vector clock, including
// its own [key, seq] entry) and `at` (informational wall-clock ms).
const ops = [
  encodeOp('create-concept', {
    path: 'guides/getting-started',
    type: 'guide',
    clock: [[W, 0]],
    at: Date.now()
  }),
  encodeOp('set-body', {
    id: W + '0', // minted id = the creating op's tag (writerKey || seq hex)
    base: null,
    text: 'Read the [architecture](/guides/architecture) first.',
    clock: [[W, 1]],
    at: Date.now()
  })
]

await apply(
  ops.map((value, seq) => ({ key: writer, value, length: seq + 1 })),
  view,
  null // host: autobee's { addWriter } — null is fine off-substrate
)

const meta = await view.get(K.cMeta(W + '0'))
console.log(JSON.parse(meta.value)) // { created: '…0', type: 'guide' }
console.log(view.dump('wanted/')) // { 'wanted/guides%2Farchitecture/…': true }
```

### The 12 ops (SPEC §3)

`create-concept`, `set-field`, `add-tag`, `rem-tag`, `set-body`,
`set-path`, `delete-concept`, `undelete-concept`, `resolve-conflict`,
`add-writer`, `remove-writer`, `set-writer-policy`.

The generated codec is in `spec/`, and it is committed. It is append-only
for the life of a vault. Run `pnpm build:schema` only to append a new op.
`decodeOp` never throws. Bytes that it cannot decode give
`{ ok: false, reason }`, and apply records the op under
`flag/rejected/<writer>/<seq>`.

### Merge semantics (SPEC §5, frozen)

- `tags` is an OR-set with SU-set semantics. A concurrent add wins over a
  remove that did not observe it. A stale citation leaves a record under
  `flag/staletag`.
- Every other frontmatter key is an LWW-array register. When a writer
  supersedes the value of another writer, apply records `flag/clobber`.
- A body is a set of immutable revisions, keyed by `revHash`. Two
  revisions with the same base both stay under `flag/conflict` until
  `resolve-conflict`. A fabricated base can never displace real ancestry.
- apply mints `_id` from the tag of the creating op, with the fallback of
  SPEC §6 for a squat. `_rev` is derived output. apply rejects a
  `set-field` on `tags`, `_id` or `_rev`.

### Paths (SPEC §7)

`set-path` is an LWW register on the concept, so a rename merges with a
concurrent edit. In a path collision, exact or casefolded, the first claim
by apply ordinal wins. apply records `flag/pathcollision`. The collision
clears when the loser is renamed or the winner leaves the path. The
terminals `index` and `log`, and `*.conflict-<hex8+>`, are reserved.

### Governance (SPEC §8)

SPEC §8 is the home of these rules. The symbols are in
`okf/core/lib/apply.js`.

- The genesis key is the first indexer.
- A governance op needs an indexer issuer. apply rejects it
  `policy-governance` otherwise.
- The ops of a writer take effect only after an indexer's `add-writer`
  admits it. Admission revives no earlier op.
- apply rejects a content op from a key with no `gov/writer` record as
  `not-a-writer`, if the op passes the earlier checks (`applyNode`).
- apply rejects a governance op from that key as `policy-governance`,
  because the indexer-issuer check comes first (`applyNode`).
- apply calls `host.addWriter(key, { weight: 0 })` for every `add-writer`
  op it folds, accepted or rejected (`grant`). So a reorder never undoes a
  substrate grant. okf membership comes only from `gov/`.
- Revocation is causal. It compares clocks, never positions, and it
  cross-checks the seq at removal. apply never calls `host.removeWriter`.
- The revocation check binds only the ops that sort after the removal
  (`applyNode`). So revocation stops cooperating clients only (SPEC §8).
- apply rejects an `add-writer` whose key or swarm key is not 32 bytes, as
  `bad-writer-key` or `bad-swarm-key` (`opAddWriter`).
- apply rejects an `add-writer` that demotes the last live indexer as
  `policy-governance` (`opAddWriter`, `isLastLiveIndexer`).
- The seq of an op is the position of its node in the core of its writer,
  `node.length - 1`. apply rejects a clock whose self entry differs from
  it as `forged-clock`.
- Each writer has a token bucket. An accepted indexer op refills it.

## API

| export | what |
| --- | --- |
| `createApply(config)` | build the deterministic `apply(nodes, view, host)`; `config.genesisKey` required |
| `encodeOp(type, payload)` / `decodeOp(buf)` | wire codec over `spec/` |
| `makeTag(key, seq)` / `parseTag(tag)` | opId (`writerKeyHex‖seqHex`) helpers |
| `keyspace` | view keyspace codec (`c/`, `path/`, `link/`, `wanted/`, `flag/`, …) |
| `canonical` | NFC + canonical value/array forms |
| `revHash(base, text)` | body revision hash |
| `extractLinks(text, dir)` | the §9 normative markdown link extraction |
| `MemView` | hyperbee2-surface in-memory view for tests |

`keyspace.js`, `canonical.js` and `revhash.js` are copies from
`@autovault-ld/core`. Each has a header that names its source (SPEC §0).
This package does not depend on `@autovault-ld/*`.
