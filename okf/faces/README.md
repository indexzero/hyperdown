# @auto-okf/faces

This package connects an [auto-okf](../SPEC.md) vault to a bundle. A
bundle is a directory of markdown files that conforms to
[OKF v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf).
The package exports five functions:

- `materialize` writes the view to a bundle. The bytes are deterministic.
- `createIngestWatcher` turns the edits of a person into the smallest
  set of ops.
- `wanted` lists the link targets that do not resolve.
- `status` reports the state of each file against the log. It is
  read-only (ADR-002).
- `importFace` fills a new vault from a bundle. That is a generation
  (SPEC §10).

The log is the source of truth. `materialize` can write a bundle again,
byte for byte, and each edit by a person enters the log as ops (SPEC §2,
§9).

## Install

```sh
npm install @auto-okf/faces
```

## Usage

This example creates a vault and writes two concepts. Then it
materializes the bundle, edits a file, ingests the edit and reads the
demand index.

```js
import { Bundle } from '@auto-okf/store'
import { materialize, createIngestWatcher, wanted } from '@auto-okf/faces'
import { readFile, writeFile } from 'node:fs/promises'

const bundle = await Bundle.init('./storage')

// Mint two concepts. The returned tag is the _id of each one (SPEC §6).
const { tag: sales } = await bundle.createConcept('datasets/sales', 'BigQuery Dataset')
await bundle.setField(sales, 'title', 'Sales')
await bundle.setField(sales, 'description', 'All sales tables.')
await bundle.setBody(sales, null, 'Contains [orders](/tables/orders.md).')

const { tag: orders } = await bundle.createConcept('tables/orders', 'BigQuery Table')
await bundle.setField(orders, 'title', 'Orders')
await bundle.addTag(orders, 'sales')
await bundle.setBody(orders, null, 'One row per order.')
await bundle.update()

// 1. materialize: one .md per live concept, and the derived index.md and log.md
const report = await materialize(bundle, './bundle')
// ./bundle/index.md          (root: okf_version and the # Contents listing)
// ./bundle/log.md            (# Update Log, date headings, newest first)
// ./bundle/datasets/sales.md  ./bundle/datasets/index.md
// ./bundle/tables/orders.md   ./bundle/tables/index.md
console.log(report.ok, report.written)

// 2. A person edits a file on disk.
const f = './bundle/datasets/sales.md'
await writeFile(f, (await readFile(f, 'utf8')).replace('All sales tables.', 'Every sales table.'))

// 3. ingest: the edit enters the log as exactly one op, a diff of one field
const watcher = await createIngestWatcher(bundle, './bundle', { watch: false })
const ops = await watcher.ingestFile('datasets/sales.md')
console.log(ops) // [{ type: 'set-field', payload: { id: sales, key: 'description', ... } }]

// 4. wanted: the ranked demand index. sales links tables/orders, which
//    exists, so nothing is wanted. A link that does not resolve ranks here
//    as { path, count, referrers }.
console.log(await wanted(bundle)) // []

await watcher.close()
await bundle.close()
```

Without `{ watch: false }`, the watcher watches `dir`. It debounces the
file system events, waits for writes to settle, and appends ops as files
change. The watcher and `materialize` share a lock per path and the
emission manifest. So the watcher never turns a write of `materialize`
into an op.

### What materialize emits (OKF v0.1)

`materialize(vault, dir)` writes these files. SPEC §9, "materialize",
holds the rules for the content of each one.

- One file per live concept, at `<path>.md`. A tombstoned concept gets no
  file.
- One conflicted copy per path-collision loser, at
  `<path>.conflict-<hex>.md` (SPEC §7).
- One `index.md` per directory.
- One `log.md` at the root.

Two peers that hold the same view write identical bundles (I9). The
package writes YAML with its own emitter, because byte identity needs a
fixed byte order. Ingest and the conformance checker read YAML with the
[`yaml`](https://eemeli.org/yaml/) package, and never write with it.

### Deletion is dangerous

The emission manifest is `.okf-manifest.json` in `dir`. It holds the path
and the hash of each file that `materialize` last wrote. See SPEC §9,
"The emission manifest".

`materialize` never deletes or overwrites a `.md` file whose bytes differ
from its manifest entry, or that has no entry. Such a file is the work of
a person, not ingested yet. `materialize` leaves the file in place and
lists it in `report.pendingIngest`. `report.ok` is `false` until an
ingest takes the file.

Do not pass `{ forceMirror: true }` to a directory that holds work that
is not ingested. With that option, `materialize` overwrites and deletes
without regard to the manifest.

### Verifying content is in the log

`status(vault, dir)` is the quick answer. It returns one
`{ path, state }` row per file. `state` is `in-log`, `pending-ingest`,
`dirty`, `absent` or `foreign` (SPEC §9, "Per-file state vocabulary
(ADR-002)"). `status` appends no op, writes no file and does not touch
the manifest.

For proof from the log, materialize to an empty scratch directory. Each
file that appears there came from the log. A vault has no privileged
bundle directory, and each target directory holds its own manifest. So a
scratch materialize never disturbs another bundle.

### Ingest: minimal ops, not whole files

The watcher compares each frontmatter key with the view, and the body
with the head revision. It never makes an op for a whole file. SPEC §9
holds the rules. This table shows the ops that an edit gives:

| Edit on disk | Ops | SPEC §9 |
| --- | --- | --- |
| a changed key | `SetField`, `AddTag` or `RemTag` | "Ingest: from edits to ops" |
| a removed key | `SetField` with an empty array | "Ingest: from edits to ops" |
| a removed `tags` key | `RemTag` that cites every observed token | "Ingest: from edits to ops" |
| a changed body | one `SetBody` that cites the `_rev` of the file | "Ingest: from edits to ops" |
| a known `_id` at a new path | `SetPath` | "Ingest: the `_id` of a file" |
| no `_id` | a mint | "Ingest: the `_id` of a file" |
| an `_id` that the vault does not know | an adoption (SPEC §10) | "Ingest: the `_id` of a file" |
| a deleted file | `DeleteConcept`, behind `confirmDelete` | "Ingest: deletions" |
| an edit of `index.md` or `log.md` | none | "Ingest: from edits to ops" |

`_id` and `_rev` are never fields, so the watcher leaves them out of the
diff (SPEC §5). The watcher extracts no links: apply does. A target that
does not resolve goes to `wanted/`, never to a flag (SPEC §9, "Links",
I4).

The confirmation guard of a delete is on by default. Without a
`confirmDelete` option, the watcher deletes nothing and emits
`delete-skipped`. Core's verdict comes first: a `DeleteConcept` that core
rejects emits `rejected`. Ingest then keeps the manifest entry and the
pending record of the file.

`scan()` ingests each file, and then runs the delete pass. See SPEC §9,
"Ingest: preflight, pending files and scope".

After it appends the ops of a file, the watcher reads core's verdict on
each one at its own fold (`_rejections` in `okf/faces/lib/ingest.js`). A
later reorder can still change a verdict (SPEC §8). The watcher emits
these events:

- `ops` `{ path, ops }`: the ops that the watcher appended for the file,
  with no rejection. `ingestFile` then records a file that holds a
  concept as ingested in the emission manifest (`_touchManifest`).
- `rejected` `{ path, op, reason }`: core rejected that op. `ingestFile`
  does not record the file as ingested (`_keepPending`). So the file
  stays pending, and the next `materialize` keeps it.
- `oversize` `{ path, bytes, limit, opBytes }`: the encoded `set-body` op
  is over `maxOpBytes` (`_preflightBody`). `bytes` is the body size and
  `opBytes` is the op size. The watcher appends nothing of the file.
- `copy` `{ path, of }`, `delete-skipped`, `skip`, `warning` and `error`.

A new file gets its `_id` only when `materialize` stamps it. An ingest
can give a concept to a file with no `_id` of its own, and then not
complete. The watcher records that concept in `<dir>/.okf-pending.json`.
A later ingest, in any watcher, takes the recorded concept only on
evidence that the file is the same. So a pending file that a person
renames never gets a second concept. SPEC §9, "Ingest: preflight, pending
files and scope", holds the rules of the record.

The record has one limit. A rename and an edit in one step, while no
watcher runs, mints again. See DEVIATIONS.md, "Pending files (SPEC §9)",
which also names the tests.

The note codec keeps body bytes exactly.
`parseNote(renderNote(pairs, body)).body === body` holds for every body
and every non-empty `pairs`. A note always has `type`, so `pairs` is
never empty. The equation also holds for a body that ends in one or more
newlines:

- `renderNote` always writes one file newline after a non-empty body, and
  `parseNote` removes exactly that one.
- So `materialize`, then ingest, then `materialize` changes no body.
- A note that a person writes with one newline at the end holds a body
  with no newline at the end.
- A note that ends in two newlines holds a body that ends in one.

### Generations: materialize, then import

A generation is two steps. `materialize` writes the bundle of the live
vault. `importFace` then fills a new vault from that bundle, and adopts
each `_id`. A generation is an act of the operator through the bundle,
never an op. SPEC §10 holds the rules: live state and identity cross,
and history does not.

```js
import { Bundle } from '@auto-okf/store'
import { materialize, importFace } from '@auto-okf/faces'

// 1. The bundle of the live vault. report.lossy lists each value that the
//    bundle cannot hold. Fix each one in the vault and materialize again.
const report = await materialize(old, './generation-face')
if (report.lossy.length > 0) throw new Error('fix report.lossy before import')
// 2. Resolve in the bundle what must not cross. import refuses a .conflict- copy.
// 3. A new vault, filled from the notes of the bundle.
const res = await importFace(Bundle.init, './generation-face', './vault-e1', {
  metadata: old.metadata,     // carries limits, rate and schemaVersion, never swarm
  predecessorKey: old.keyHex  // records the generation chain
  // encryptionKey: a 32-byte key encrypts the new vault
})
// res.vault:      the new vault, open. The caller closes it.
// res.generation: the id of the corestore namespace of this generation
// res.counts:     { notes, imported }: notes read, notes that made a concept
// A successful import has no warning. A note that warns, such as one
// without `type`, fails the import, and the error carries err.warnings.
await res.vault.close()
```

`importFace(initBundle, faceDir, dir, opts)` reads the bundle once, into
memory. It writes nothing to the bundle and opens no predecessor vault.
It never touches the old vault: archive or destroy that vault
out-of-band.

`importFace` takes these options:

- `encryptionKey`: a Buffer or a Uint8Array of 32 bytes. It encrypts the
  new vault. `undefined` or `null` is no key.
- `metadata`: the metadata of the predecessor. The new vault carries its
  `limits`, `rate` and `schemaVersion`, and no other field.
- `predecessorKey`: the vault key of the predecessor, as 64 hex
  characters or 32 bytes. The new vault records it.

An indexer must admit each writer to the new vault again with
`writers.add(key, { swarmKey })`. See SPEC §10, "Rules of import", which
also states why the new vault has new writer keypairs.

Each error of `importFace` carries a code. `importFace` refuses with one
of these codes before it writes anything:

| Code | Cause |
| --- | --- |
| `IMPORT_NO_INITBUNDLE` | `initBundle` is not a function |
| `IMPORT_ENCRYPTION_KEY_INVALID` | a key that is not a 32-byte Buffer or Uint8Array |
| `IMPORT_ENCRYPTION_KEY_REQUIRED` | no key, and `metadata` says encrypted or the bundle holds `.okf-encrypted` |
| `IMPORT_PREDECESSOR_INVALID` | a `predecessorKey` that is not a vault key |
| `IMPORT_DIR_NOT_EMPTY` | a `dir` that is pinned, not empty, or not a directory |
| `IMPORT_FACE_ENTRY` | an entry that is not a regular file or a directory, such as a symlink |
| `IMPORT_CONFLICT_COPY` | a `.conflict-<hex>` note |
| `IMPORT_RESERVED_NAME` | a note at a reserved `.okf-` name or under a directory with one, in any case |
| `IMPORT_MISSING_ID` | a note whose frontmatter holds no `_id` |
| `IMPORT_DIR_CLAIMED` | another import holds `dir` |

`importFace` reads no invalid key as no key, so it never makes an
unencrypted vault by mistake. For `IMPORT_CONFLICT_COPY`, resolve the
collision in the bundle first. For `IMPORT_MISSING_ID`, give the note its
`_id` or remove it: import keeps each `_id`, and cannot keep one that the
note does not hold. Each of the four codes for the content of the bundle
carries `err.paths`.

`importFace` fails with one of these codes after the new vault exists:

| Code | Cause | Fields |
| --- | --- | --- |
| `IMPORT_NOT_ENCRYPTED` | a key was given, and the new vault's metadata does not say encrypted | |
| `IMPORT_OVERSIZE` | an encoded op is over the new vault's `maxOpBytes` | `err.path`, `err.op`, `err.bytes`, `err.limit` |
| `IMPORT_REJECTED` | core rejected an op | `err.path`, `err.op`, `err.reason` |
| `IMPORT_FIDELITY` | the new vault does not match the bundle | `err.differences` |

Each of these errors also carries `err.warnings` and `err.counts`. On
each one, `importFace` closes the new vault and removes what it created.
It removes each entry that it wrote in `dir`, the claim with them. Then
it removes each directory that it made for `dir`, when that directory is
empty. An existing `dir` stays. `importFace` writes no verification copy
to disk.

One import at a time holds `dir`. `importFace` makes `dir` if it is
absent, and claims it with the file `okf-import-claim` before it calls
`initBundle`. A second import into the same `dir` refuses with
`IMPORT_DIR_CLAIMED` before its `initBundle`, and removes nothing. Once
the store opens, the files of the new vault hold `dir`: a second import
refuses it with `IMPORT_DIR_NOT_EMPTY`. See SPEC §10, "Rules of import",
for the claim file.

A signal stops `importFace` before its cleanup. A signal before
`initBundle` leaves only the claim, and a signal after it leaves a
partial vault. Either one refuses the next run. When no import runs,
remove `dir`.

`importFace` checks its own output against the bundle, byte for byte,
without the `_rev` lines. A difference throws `IMPORT_FIDELITY`, with
every difference in the message and in `err.differences`. Each one is
`{ path, kind }`, and `kind` is `missing`, `extra` or `differs`. See SPEC
§10, "Rules of import", for the fidelity check and for import-mode ingest
(`IngestWatcher.importNote`).

A note that warns does not cross a generation unchanged, so each warning
comes with a difference:

- A note without `type` makes no concept. Its difference has the kind
  `missing`.
- A copy of another note's `_id` gets a new `_id`. Its difference has the
  kind `differs`.

The bundle of an encrypted vault holds its contents as plaintext:

- `materialize` announces the plaintext. It awaits `opts.onPlaintext`
  with the warning before its first write.
- Before its first plaintext write, `materialize` writes the mark
  `.okf-encrypted` at the root of the bundle. It never removes the mark.
- `importFace` refuses a marked bundle without `encryptionKey`
  (`IMPORT_ENCRYPTION_KEY_REQUIRED`). No option turns the refusal off, so
  a generation of an encrypted vault is never unencrypted.
- `importFace` writes no plaintext.

`materialize` reports every value that the bundle cannot hold. Each one
is in `report.lossy` as `{ id, path, key, before, after }`. `before` is
the value in the view, and `after` is the value that the note gives back.
A path that folds together with another path is such a value too, with
the key `path`. `importFace` reads only the bundle, so it cannot see such
a change. `report.ok` does not read `report.lossy`, so the caller must.
Fix each value in the vault, and materialize again, before the import.
SPEC §10, "What the bundle cannot hold", lists the values.

## API

| Export | Options | Returns |
| --- | --- | --- |
| `materialize(vault, dir, opts)` | `forceMirror`, `onPlaintext` | `{ ok, written, unchanged, pendingIngest, removed, stale, unsafe, root, warnings, lossy }` |
| `createIngestWatcher(vault, dir, opts)` | `confirmDelete`, `debounce`, `settle`, `watch` | the watcher: `ingestFile`, `scan`, `close`, and the events above |
| `importFace(initBundle, faceDir, dir, opts)` | `encryptionKey`, `metadata`, `predecessorKey` | `{ vault, dir, generation, counts }` |
| `status(vault, dir)` | none | `[{ path, state }]` |
| `wanted(vault)` | none | `[{ path, count, referrers }]`, most wanted first |
| `readView(reader)`, `readLog(reader)` | none | the model of the view that `materialize` builds on |
| `renderNote`, `parseNote`, `emitFrontmatter` | none | the canonical YAML note codec |

With `watch: false`, the caller drives `ingestFile` and `scan`.
`initBundle` is the store factory, `Bundle.init`. `dir` of `importFace`
is new or empty. `wanted` reads `wanted/` and `wantedrank/`.

`vault` is a [`@auto-okf/store`](../store) Bundle, or any object that
has `val`, `scan`, `update` and the content-op helpers. This package
imports no autobee: the caller passes the store in.

## Tests

The tests are in `okf/faces/test/`. They run on `@auto-okf/store` vaults
on disk, with no stubs. `okf/faces/test/okf-conformance.js` is an OKF
v0.1 conformance checker that does not call this package's emitter.

```sh
pnpm test:okf     # the tests of every okf package
node --test "okf/faces/test/*.test.js"     # the faces tests only
```

## License

Apache-2.0
