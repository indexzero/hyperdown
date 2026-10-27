# @auto-okf/core

The core of **auto-okf** — a multi-writer storage substrate for
[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
bundles. This package is transport-agnostic: it defines the op wire
contract, the deterministic `apply` that folds a linearized op stream into
a view, the view keyspace, and an in-memory view double. It never imports
autobee; `@auto-okf/store` supplies the substrate.

## Usage

Encode ops, apply them, inspect the view:

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

The generated codec lives in `spec/` (committed; append-only for the life
of a vault — rebuild with `pnpm build:schema` only to APPEND new ops).
`decodeOp` never throws: garbage decodes to `{ ok: false, reason }` and
apply records it under `flag/rejected/<writer>/<seq>`.

### Merge semantics (SPEC §5, frozen)

- `tags`: OR-set (SU-set semantics; concurrent add beats
  remove-of-unobserved; stale citations audit to `flag/staletag`).
- every other frontmatter key: LWW-array register; cross-writer
  supersessions audit to `flag/clobber`.
- bodies: immutable revisions keyed by `revHash`; same-base siblings both
  survive under `flag/conflict` until `resolve-conflict`; fabricated bases
  can never displace real ancestry.
- `_id` mints from the creating op's tag (squat-proof fallback per §6);
  `_rev` is derived output — `set-field` on `tags`/`_id`/`_rev` rejects.

### Paths (SPEC §7)

`set-path` is an LWW register on the concept (renames merge with
concurrent edits). Path collisions — exact or casefolded — are first-wins
by apply ordinal, flagged `flag/pathcollision`, and self-heal when the
loser is renamed or the winner vacates. `index`/`log` terminals and
`*.conflict-<hex8+>` are reserved.

### Governance (SPEC §8)

Genesis key is the first indexer. Governance ops require an indexer
issuer (else `policy-governance`). A writer's ops take effect only once an
indexer's `add-writer` has admitted it: an op from a key with no
`gov/writer` record is rejected `not-a-writer`, and admission revives no
earlier op. apply calls `host.addWriter(key, { weight: 0 })` for every
`add-writer` op it folds, accepted or rejected, so a reorder never undoes
a substrate grant; okf membership comes only from `gov/`. Revocation is
causal (clock-based, never positional) with a seq-at-removal cross-check,
and `host.removeWriter` is never called. An op's seq is its node's
position in its writer's core (`node.length - 1`); a clock whose self
entry differs from it is rejected `forged-clock`. Per-writer token
buckets refill on accepted indexer ops.

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

`keyspace.js`, `canonical.js`, `revhash.js` are copied from
`@autovault-ld/core` with provenance headers (copy-don't-depend, SPEC §0);
this package has no dependency on `@autovault-ld/*`.
