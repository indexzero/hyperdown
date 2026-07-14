# @auto-okf/faces

The **generated faces** of [auto-okf](../SPEC.md): the bridge between the
multi-writer op log and a plain
[OKF v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
bundle on disk. `materialize` projects a converged view into a
byte-deterministic directory of markdown files; the ingest watcher folds
human edits back into the log as *minimal* ops; `wanted` reports what the
graph is asking to have written. The log stays the source of truth — a face
can always be regenerated, byte-for-byte, and human edits always re-enter as
ops (SPEC §2, §9).

## Usage

Open a vault, write a couple of concepts, materialize the bundle, edit a
file by hand, ingest the edit, and inspect the demand index:

```js
import { initVault } from '@auto-okf/store'
import { materialize, createIngestWatcher, wanted } from '@auto-okf/faces'
import { readFile, writeFile } from 'node:fs/promises'

const vault = await initVault('./vault')

// mint two concepts (the returned tag is each one's _id, SPEC §6)
const { tag: sales } = await vault.createConcept('datasets/sales', 'BigQuery Dataset')
await vault.setField(sales, 'title', 'Sales')
await vault.setField(sales, 'description', 'All sales tables.')
await vault.setBody(sales, null, 'Contains [orders](/tables/orders.md).')

const { tag: orders } = await vault.createConcept('tables/orders', 'BigQuery Table')
await vault.setField(orders, 'title', 'Orders')
await vault.addTag(orders, 'sales')
await vault.setBody(orders, null, 'One row per order.')
await vault.update()

// 1. materialize — one .md per live concept, plus derived index.md/log.md
const report = await materialize(vault, './bundle')
// ./bundle/index.md          (root: okf_version + # Contents listing)
// ./bundle/log.md            (# Update Log, newest-first date headings)
// ./bundle/datasets/sales.md  ./bundle/datasets/index.md
// ./bundle/tables/orders.md   ./bundle/tables/index.md
console.log(report.ok, report.written)

// 2. a human edits a file on disk
const f = './bundle/datasets/sales.md'
await writeFile(f, (await readFile(f, 'utf8')).replace('All sales tables.', 'Every sales table.'))

// 3. ingest — the edit re-enters as exactly ONE op (a per-field diff)
const watcher = await createIngestWatcher(vault, './bundle', { watch: false })
const ops = await watcher.ingestFile('datasets/sales.md')
console.log(ops) // [{ type: 'set-field', payload: { id: sales, key: 'description', ... } }]

// 4. wanted/ — the ranked demand index (sales links an unwritten concept)
console.log(await wanted(vault)) // [{ path: 'tables/orders', ... }] resolves; unresolved links rank here

await watcher.close()
await vault.close()
```

Left running (`createIngestWatcher(vault, dir)` without `{ watch: false }`)
the watcher debounces filesystem events, waits for writes to settle, and
emits ops as files change — coordinating with `materialize` through a shared
per-path lock and an emission manifest so it never echoes the system's own
writes back as ops.

### What materialize emits (OKF v0.1)

- **One file per live concept** at `<path>.md`, frontmatter in SPEC §6 order
  (`_id`, `_rev`, `type`, then remaining keys canonically sorted), body =
  the head revision. Tombstoned concepts are suppressed.
- **Conflicted copies** (SPEC §7): a path-collision loser materializes at a
  deterministic `<path>.conflict-<first-8-hex-of-SHA-256(_id)>.md`. The
  suffix is reserved and round-trippable — ingest strips it back to the
  losing `_id`.
- **`index.md` per directory** (OKF §6): a `# Contents` listing, concepts
  then subdirectories, each in canonical link-target order; root-only
  frontmatter `okf_version: "0.1"`.
- **`log.md` at the root** (OKF §7): `# Update Log`, `## YYYY-MM-DD` UTC date
  headings newest-first, projected from the op log's `at` timestamps.

Every byte is a pure function of the converged view: two peers that
exchanged all ops emit **identical** bundles (I9). The canonical YAML
emitter is hand-rolled (double-quoted only when YAML would otherwise
reinterpret a scalar, flow lists, LF endings) because no YAML library
guarantees byte order; the ingest path and the conformance checker use the
maintained [`yaml`](https://eemeli.org/yaml/) parser (parse-only).

### Deletion is dangerous (N3)

`materialize` reconciles the directory to the view **through an emission
manifest, never by blind mirroring**. It records the `(path, hash)` set it
last wrote; the only files it will remove are its own prior outputs whose
bytes still match. A `.md` file whose bytes differ from the manifest — or
that the manifest never tracked (human-authored, not yet ingested) — is
**never deleted or overwritten**. It is left in place and surfaced in
`report.pendingIngest`, and `report.ok` is `false` until it is ingested.
`materialize(vault, dir, { forceMirror: true })` restores unconditional
mirroring for operator use.

### Ingest: minimal ops, not whole files

The watcher diffs frontmatter **per key** against view state and the body
against the head revision:

- a changed field → `SetField` / `AddTag` / `RemTag`; a removed key →
  `SetField` with an empty array (a removed `tags` key → `RemTag` citing
  every observed token);
- a changed body → one `SetBody` citing the file's `_rev`;
- `_id`/`_rev` are stripped from the diff (identity and derived output are
  never fields, SPEC §5);
- a known `_id` at a new path → `SetPath`; a missing `_id` → mint; an
  **unknown** `_id` → **adopt** it (the epoch-cycle contract, SPEC §10);
- a file deleted on disk → `DeleteConcept`, behind a confirmation guard that
  is **on by default** (no confirmer ⇒ nothing is deleted);
- links go to apply's normative extractor; unresolved targets feed
  `wanted/`, never a flag (SPEC §9, I4); `index.md`/`log.md` edits are
  ignored (regenerated faces).

> Bodies are canonicalized to no trailing newline, so the round-trip
> `materialize → ingest → materialize` is a stable fixpoint for any body
> that does not itself end in a blank line.

### Epoch-cycle compaction (SPEC §10, the CouchDB homage)

Byte reclamation in auto-okf is an **operator act via the hydrated face**,
never an op — the SPEC §8 wire contract has no prune/compact/byte-destroying
message at all. `compact` performs one **epoch cycle**: it materializes the
live bundle, spins up a **fresh vault**, and ingests the bundle back with
`_id` **adoption**. Live **state and identity survive byte-for-byte** — every
live concept's `_id`, `type`, fields, tags, path and head body — while
**history is shed by design**: old revisions, per-op attribution and clocks
do not cross the boundary (this is what compaction *means*, and I11 asserts it
positively). Tombstoned concepts are dropped; `_rev` and `log.md` necessarily
re-derive in the new epoch (a head that was an *edit* re-roots at `base:null`,
so its revHash changes even though the body text is identical — SPEC §14).

```js
import { initVault } from '@auto-okf/store'
import { compact } from '@auto-okf/faces'

const res = await compact(old, {
  toDir: './epoch-face',   // where the hydrated OKF bundle is written
  vaultDir: './vault-e1',  // storage dir for the fresh vault
  initVault                // the @auto-okf/store factory (substrate is injected)
})
// res.vault           — the fresh, OPEN vault (the caller closes it)
// res.epoch           — the fresh per-epoch corestore namespace id
// res.predecessorPath — the OLD vault's dir; compact NEVER deletes it —
//                       the operator archives or destroys it out-of-band
// res.predecessorCheckpoint — { viewHash, writerLengths } anchoring the chain
// res.conflictCopies  — [{ from, to, id }] carried across (only under force)
// res.logPath         — the log/epoch.json entry written into the new vault
await res.vault.close()
```

The fresh vault uses a **fresh writer keypair** (`@auto-okf/store` derives
writer cores under a per-epoch namespace keyed by the predecessor fields —
SPEC §10/N2), which is exactly why adopting the predecessor's mint-shaped ids
never trips `mint-collision-risk`. compact **refuses without `force: true`**
while any `flag/conflict` or `flag/pathcollision` is open (a live conflict must
never be silently frozen into a new epoch); with `force`, carried-across
conflicted copies are enumerated in the new vault's `log/epoch.json`. `_id`,
`type`, fields, tags, path and head body cross the boundary intact; drained
conflicts and resolved renames land as their settled state with no history.

## Install

```sh
npm install @auto-okf/faces
```

## API

| export | what |
| --- | --- |
| `materialize(vault, dir, opts)` | emit the OKF bundle; `opts.forceMirror` mirrors unconditionally; returns `{ ok, written, unchanged, pendingIngest, removed, stale, unsafe, root }` |
| `createIngestWatcher(vault, dir, opts)` | start the watcher; `opts`: `confirmDelete`, `debounce`, `settle`, `watch:false` (drive `ingestFile`/`scan` manually) |
| `compact(vault, opts)` | SPEC §10 epoch cycle; `opts`: `initVault` (required store factory), `toDir`, `vaultDir`, `force`, `keyPair`, `encryptionKey`, `sign`, `stageDir`; returns `{ vault, epoch, predecessorKey, predecessorPath, predecessorCheckpoint, conflictCopies, logPath, ingestOps }` |
| `wanted(vault)` | `[{ path, count, referrers }]`, most-wanted first (from `wanted/` + `wantedrank/`) |
| `readView(reader)` / `readLog(reader)` | the pure view→model projection materialize builds on |
| `renderNote` / `parseNote` / `emitFrontmatter` | the canonical YAML note codec |

`vault` is a [`@auto-okf/store`](../store) Vault (or any object exposing
`val`, `scan`, `update` and the content-op helpers). Nothing here imports
autobee; the substrate is injected.

## Tests

```sh
pnpm test:okf     # core + store + these faces tests
```

The faces suite runs on **real** `@auto-okf/store` vaults (autobee +
corestore on disk, no stubs): materialize byte-determinism across two runs,
a replicated peer, and a from-scratch rebuild (I9); ingest minimality (one
field edit → one op); the full `materialize → edit → ingest → materialize`
round-trip; a rename + concurrent-edit merge across the round-trip; the N3
human-file-preservation case; conflict-copy round-trip; the **I11 epoch-cycle**
suite (`okf/test/i11-roundtrip.test.js`: a non-trivial bundle round-trips
byte-identically modulo `_rev`/`log.md`, identity + state fidelity per live
concept, history shed positively asserted, the conflict-drain guardrail, a
length-2 epoch chain, and `--force` conflict-copy carry-across); and an
**independent** OKF v0.1 conformance check (`okf/test/okf-conformance.js`,
written from scratch against the OKF spec — it does not call this package's
emitter).

## License

Apache-2.0
