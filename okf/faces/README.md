# @auto-okf/faces

The **generated faces** of [auto-okf](../SPEC.md): the bridge between the
multi-writer op log and a plain
[OKF v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
bundle on disk. `materialize` projects a converged view into a
byte-deterministic directory of markdown files; the ingest watcher folds
human edits back into the log as *minimal* ops; `wanted` reports what the
graph is asking to have written; `status` reports each file's state against
the log, read-only (ADR-002); `importFace` fills a new vault from a face (a
generation, SPEC §10). The log stays the source of truth — a face
can always be regenerated, byte-for-byte, and human edits always re-enter as
ops (SPEC §2, §9).

## Usage

Create a vault, write a couple of concepts, materialize the bundle, edit a
file by hand, ingest the edit, and inspect the demand index:

```js
import { Bundle } from '@auto-okf/store'
import { materialize, createIngestWatcher, wanted } from '@auto-okf/faces'
import { readFile, writeFile } from 'node:fs/promises'

const bundle = await Bundle.init('./storage')

// mint two concepts (the returned tag is each one's _id, SPEC §6)
const { tag: sales } = await bundle.createConcept('datasets/sales', 'BigQuery Dataset')
await bundle.setField(sales, 'title', 'Sales')
await bundle.setField(sales, 'description', 'All sales tables.')
await bundle.setBody(sales, null, 'Contains [orders](/tables/orders.md).')

const { tag: orders } = await bundle.createConcept('tables/orders', 'BigQuery Table')
await bundle.setField(orders, 'title', 'Orders')
await bundle.addTag(orders, 'sales')
await bundle.setBody(orders, null, 'One row per order.')
await bundle.update()

// 1. materialize — one .md per live concept, plus derived index.md/log.md
const report = await materialize(bundle, './bundle')
// ./bundle/index.md          (root: okf_version + # Contents listing)
// ./bundle/log.md            (# Update Log, newest-first date headings)
// ./bundle/datasets/sales.md  ./bundle/datasets/index.md
// ./bundle/tables/orders.md   ./bundle/tables/index.md
console.log(report.ok, report.written)

// 2. a human edits a file on disk
const f = './bundle/datasets/sales.md'
await writeFile(f, (await readFile(f, 'utf8')).replace('All sales tables.', 'Every sales table.'))

// 3. ingest — the edit re-enters as exactly ONE op (a per-field diff)
const watcher = await createIngestWatcher(bundle, './bundle', { watch: false })
const ops = await watcher.ingestFile('datasets/sales.md')
console.log(ops) // [{ type: 'set-field', payload: { id: sales, key: 'description', ... } }]

// 4. wanted/ — the ranked demand index. sales links tables/orders, which
//    exists, so nothing is wanted; an unresolved link ranks here as
//    { path, count, referrers }
console.log(await wanted(bundle)) // []

await watcher.close()
await bundle.close()
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

### Verifying content is in the log

`status(vault, dir)` is the quick check: one `{ path, state }` row per file,
with `state` one of `in-log`, `pending-ingest`, `dirty`, `absent`, `foreign`
(ADR-002) — strictly read-only (no ops, no writes, no manifest touch). For
proof *from* the log, use a scratch materialize: a vault has no privileged
bundle directory; the emission manifest
(`.okf-manifest.json`) lives in each target directory, so materializing to
a scratch directory never disturbs another bundle. That makes verification
trivial: materialize to an empty scratch directory — an empty dir that
fills on materialize is proof the content is in the log, because
everything that appears came from it.

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
  **unknown** `_id` → **adopt** it (the generation contract, SPEC §10);
- a file deleted on disk → `DeleteConcept`, behind a confirmation guard that
  is **on by default** (no confirmer ⇒ nothing is deleted). Core's verdict
  comes first: a `DeleteConcept` that core rejects emits `rejected`, and
  ingest keeps the manifest entry and the pending record of the file.
  `scan()` tries the delete of each path that the manifest or the pending
  record lists and the disk no longer holds, so it also finds a pending
  file that never reached the manifest;
- links go to apply's normative extractor; unresolved targets feed
  `wanted/`, never a flag (SPEC §9, I4); `index.md`/`log.md` edits are
  ignored (regenerated faces).

After it appends the ops of a file, the watcher reads core's verdict on
each one at its own fold (`okf/faces/lib/ingest.js:677-686`). A later
reorder can still change a verdict (SPEC §8). The watcher emits these
events:

- `ops` `{ path, ops }`: the ops that the watcher appended for the file,
  with no rejection. A file that holds a concept is then recorded as
  ingested in the emission manifest (`okf/faces/lib/ingest.js:287-316`).
- `rejected` `{ path, op, reason }`: core rejected that op. The file is
  not recorded as ingested, so it stays pending, and the next
  `materialize` keeps it (`okf/faces/lib/ingest.js:298-307`).
- `oversize` `{ path, bytes, limit, opBytes }`: the encoded `set-body` op
  is over `maxOpBytes`. `bytes` is the body size and `opBytes` the op
  size. Nothing of the file is appended
  (`okf/faces/lib/ingest.js:268-277`, `:355-359`).
- `copy` `{ path, of }`, `delete-skipped`, `skip`, `warning` and `error`.

A new file gets its `_id` only when `materialize` stamps it. If an ingest
gives a concept to a file with no `_id` of its own (a note without `_id`,
or a copy) and does not complete, the watcher records that concept in
`<dir>/.okf-pending.json`: the file's path, the bytes of that ingest
(`sha256`), and the concept's path in the view (`at`). A later ingest, in
any watcher, takes that concept only on evidence that the file is the
same:

- the file at the recorded path: an edit, or a retry of the same bytes;
- a file at another path with the same bytes, while the recorded path is
  gone from the disk: a rename. The ingest moves the concept to the new
  path, so a renamed pending file never gets a second concept.

The record attaches nothing once its concept is not live at `at`: a note
with the concept's `_id`, or another writer, moved it away. When a delete
pass finds the file gone and deletes nothing (no confirmation, or core
rejected the delete), the record takes back only the same bytes at its
path, and a new note there gets a concept of its own. The record of a
concept goes when an ingest of its file or of the concept completes, or
when the delete of the file takes effect. A rename and an edit in one
step, while no watcher runs, is a new file, and the old concept waits for
the delete of the old path (`okf/faces/lib/ingest.js:809-838`). Tests:
the two "D-055 Q2" tests and the three "D-060 F04" tests in
`okf/test/faces-ingest.test.js`.

> The note codec keeps body bytes exactly: `parseNote(renderNote(pairs,
> body)).body === body` for every body and every non-empty `pairs` (a note
> always has `type`), also for a body that ends in one or more newlines.
> `renderNote` always writes one file newline after a non-empty body, and
> `parseNote` removes exactly that one. So the round-trip
> `materialize → ingest → materialize` is a fixpoint for every body. A
> hand-written note that ends in one newline holds a body with no trailing
> newline, and a note that ends in two holds a body that ends in one.

### Generations: materialize, then import (SPEC §10, the CouchDB homage)

Byte reclamation in auto-okf is an **operator act via the face**, never an
op — the SPEC §8 wire contract has no prune or byte-destroying message at
all. A **generation** is two steps: `materialize` the live vault into a
face, then `importFace` that face into a **fresh vault** with `_id`
**adoption**. Live **state and identity survive byte-for-byte** — every
live concept's `_id`, `type`, fields, tags, path and head body — while
**history is shed by design**: old revisions, per-op attribution and
clocks do not cross (I11 asserts it positively). Tombstoned concepts are
not in the face; `_rev` and `log.md` re-derive in the new generation (a
head that was an *edit* re-roots at `base:null`, so its revHash changes
even though the body text is identical — SPEC §14).

```js
import { Bundle } from '@auto-okf/store'
import { materialize, importFace } from '@auto-okf/faces'

// 1. the face of the live vault; report.lossy lists each value that the
//    face cannot hold: fix each one in the vault and materialize again
const report = await materialize(old, './generation-face')
if (report.lossy.length > 0) throw new Error('fix report.lossy before import')
// 2. resolve in the face what must not cross: a .conflict- copy is refused
// 3. a fresh vault, filled from the notes of the face
const res = await importFace(Bundle.init, './generation-face', './vault-e1', {
  metadata: old.metadata,     // carries limits, rate and schemaVersion, never swarm
  predecessorKey: old.keyHex  // records the generation chain
  // encryptionKey: a 32-byte key encrypts the new vault
})
// res.vault      — the fresh, OPEN vault (the caller closes it)
// res.generation — the per-generation corestore namespace id
// res.counts     — { notes, imported }: notes read, notes that made a concept
// (no warnings: a note that warns, such as one without `type`, fails the
// import, and the error carries err.warnings)
await res.vault.close()
```

The face is **inert source**: `importFace` reads it once, into memory,
writes nothing to it, and opens no predecessor vault. The old vault is
never touched: archive or destroy it out-of-band.

**Before it writes anything**, `importFace` refuses, by name: a `dir` that
is pinned, not empty, or not a directory (`IMPORT_DIR_NOT_EMPTY`); a key
that is not a 32-byte Buffer or Uint8Array (`IMPORT_ENCRYPTION_KEY_INVALID`,
and no value is read as no key); metadata that says encrypted, without a
key, or a face that holds the mark of an encrypted vault without a key
(`IMPORT_ENCRYPTION_KEY_REQUIRED`: a generation of an encrypted vault is
never unencrypted, with or without `metadata`); a `predecessorKey` that is
not a vault key
(`IMPORT_PREDECESSOR_INVALID`); and a face that holds an entry that is not
a regular file or a directory, such as a symlink (`IMPORT_FACE_ENTRY`), a
`.conflict-<hex>` note (`IMPORT_CONFLICT_COPY`: resolve the collision in
the face first), a note at a reserved `.okf-` name
(`IMPORT_RESERVED_NAME`) or a note whose frontmatter holds no `_id`
(`IMPORT_MISSING_ID`: import keeps each `_id`, and cannot keep one that
the note does not hold). A missing `initBundle` throws
`IMPORT_NO_INITBUNDLE`.

**One import at a time holds `dir`.** Before it calls `initBundle`,
`importFace` makes `dir` if it is absent, and creates the claim file
`okf-import-claim` in it with an exclusive open. Only one open can create
that file, so a second import into the same `dir` refuses by name
(`IMPORT_DIR_CLAIMED`) before its `initBundle`, and removes nothing. The
store's first open moves the claim into `dir/db/` (hypercore-storage
moves each file that it does not know at the top of a new storage
directory there). From then on the files of the new vault hold `dir`: a
second import refuses it as not empty (`IMPORT_DIR_NOT_EMPTY`). A
successful import removes the claim at both places. A signal before
`initBundle` leaves only the claim, and a signal after it leaves a
partial vault: either one refuses a rerun. When no import runs, remove
`dir`.

**Import-mode ingest** (`IngestWatcher.importNote`) ignores the emission
manifest and the pending record (`.okf-pending.json`) of the face, treats
every `_rev` as absent (each head becomes the
concept's first revision), and imports dot-segment paths such as
`.drafts/idea`. Before it appends an op it checks the encoded op against
the new vault's `maxOpBytes` (`IMPORT_OVERSIZE`), and an op that core
rejects fails the import (`IMPORT_REJECTED`, with core's reason).

**importFace checks its own output.** After the import, the notes of a
materialize of the new vault (its byte plan, in memory) must equal the
notes of the face, byte for byte, without `_rev` lines. `index.md` and
`log.md` are regenerated faces that import never reads, so the check
leaves them out. A difference throws `IMPORT_FIDELITY`, with every
difference in the message and in `err.differences`. A note that warns
does not round-trip: a note without `type` establishes no concept
(`missing`), and a copy of another note's `_id` gets a new `_id`
(`differs`). So each warning comes with a difference, the error carries
the warnings as `err.warnings`, and a successful import has none. On any failure after
the new vault exists, `importFace` closes it and removes what it created:
each entry that it wrote in `dir` while it held the claim, the claim, and
then each directory that it made for `dir`, when that directory is empty.
An existing `dir` stays. No verification copy is written to disk.

A generation is the eviction point, so `opts.metadata` never carries the
`swarm` allowlist (`okf/faces/lib/import.js:44`, `:380-390`). The invite
of the new vault lists only the swarm key of the peer that ran the
import, and an indexer admits each writer again with
`writers.add(key, { swarmKey })`.

The fresh vault uses a **fresh writer keypair**: `@auto-okf/store` derives
writer cores under a per-generation namespace derived from
`predecessorKey` (SPEC §10), which is why adopting the predecessor's
mint-shaped ids never trips `mint-collision-risk`. The face of an
encrypted vault holds its contents as plaintext: `materialize` announces
it (`opts.onPlaintext`), and `importFace` writes no plaintext. Before its
first plaintext write, `materialize` also marks that face: it writes
`.okf-encrypted` at the root. `importFace` refuses a marked face without
`encryptionKey` (`IMPORT_ENCRYPTION_KEY_REQUIRED`), so the face itself
carries decision 8, and no option turns the refusal off. `materialize`
never removes the mark.

**materialize reports every value that the face cannot hold.** The face
cannot hold some values that the view can: a scalar `null` is omitted, only
the first `type` value is written, a reference or an object is written as
a string, and a lone UTF-16 surrogate in a string becomes U+FFFD in the
UTF-8 note. `importFace` reads only the face, so it cannot see such a
change. So `materialize` parses the bytes of each note that it renders back and
compares each field with the view. Each difference is in `report.lossy` as
`{ id, path, key, before, after }` (`before` the view's values, `after`
what the note gives back). A path is such a value too: two spellings that
fold together (NFC, then lowercase), such as the directories of `Notes/a`
and `notes/b`, are one directory on a case-insensitive file system such as
APFS. There the import gives `notes/b` the spelling `Notes/b`. So
`materialize` reports each such note with the key `path` (`before` the
concept's path, `after` the path that the note gives back), on every file
system. An operator fixes those values in the vault, and materializes
again, before the import (SPEC §10).

## Install

```sh
npm install @auto-okf/faces
```

## API

| export | what |
| --- | --- |
| `materialize(vault, dir, opts)` | emit the OKF bundle; `opts.forceMirror` mirrors unconditionally; `opts.onPlaintext` is awaited with the plaintext warning before the first write of an encrypted vault, and the face of an encrypted vault gets the mark `.okf-encrypted`; returns `{ ok, written, unchanged, pendingIngest, removed, stale, unsafe, root, warnings, lossy }`, `lossy` the values that the face cannot hold (above) |
| `createIngestWatcher(vault, dir, opts)` | start the watcher; `opts`: `confirmDelete`, `debounce`, `settle`, `watch:false` (drive `ingestFile`/`scan` manually); events `ops`, `rejected`, `oversize` and the others above |
| `importFace(initBundle, faceDir, dir, opts)` | SPEC §10 generation: a new vault in a new or empty `dir`, filled from the notes of the face; `initBundle` is the store factory (`Bundle.init`); `opts`: `encryptionKey`, `metadata` (carries `limits`, `rate`, `schemaVersion`, never `swarm`), `predecessorKey`; returns `{ vault, dir, generation, counts }`; errors carry an `IMPORT_*` code (above), and the errors after the refusals carry `err.warnings` |
| `status(vault, dir)` | read-only per-file state rows `[{ path, state }]` (ADR-002) |
| `wanted(vault)` | `[{ path, count, referrers }]`, most-wanted first (from `wanted/` + `wantedrank/`) |
| `readView(reader)` / `readLog(reader)` | the pure view→model projection materialize builds on |
| `renderNote` / `parseNote` / `emitFrontmatter` | the canonical YAML note codec |

`vault` is a [`@auto-okf/store`](../store) Bundle (or any object exposing
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
human-file-preservation case; conflict-copy round-trip; the **I11 generation**
suite (`okf/test/i11-roundtrip.test.js`: a non-trivial bundle round-trips
through materialize and import byte-identically modulo `_rev`/`log.md`,
identity + state fidelity per live concept, history shed positively
asserted, a second generation that keeps even `_rev`, the values that
the face cannot hold reported by `materialize`, dot-segment paths,
exact body bytes, the carried `limits`, `rate` and `schemaVersion`, the
encoded-op preflight and core rejections, a truncated note that fails
`IMPORT_FIDELITY`, the refusals, and a second import into the same `dir`
that refuses `IMPORT_DIR_CLAIMED` while the first keeps its vault); and an
**independent** OKF v0.1 conformance check (`okf/test/okf-conformance.js`,
written from scratch against the OKF spec — it does not call this package's
emitter).

## License

Apache-2.0
