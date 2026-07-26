# @autovault-ld/faces

The **generated faces** of a Vault-LD vault (SPEC-FINAL §2/§13): the
Markdown/Obsidian vault on disk, the human-edit ingest watcher, and the
Turtle export. The op log is the source of truth; every face is a pure
projection of the view, and human edits re-enter the system as semantic
ops — never whole-file writes.

```js
import { Vault } from '@autovault-ld/store'
import { materialize, createIngestWatcher, exportTurtle } from '@autovault-ld/faces'
import { readFile, writeFile } from 'node:fs/promises'

// open a vault and write some ops
const v = await Vault.init('./storage')
await v.defineScope('culinary', 'https://example.org/culinary#', 'cul')
await v.defineTerm('culinary', 'type', '@type')
await v.defineTerm('culinary', 'title', { '@id': 'cul:title' })
await v.defineTerm('culinary', 'topic', { '@id': 'cul:topic', '@container': '@set' })
await v.setField('Home', 'title', 'Welcome home')
await v.addMember('Home', 'topic', { ref: 'Recipe' })
await v.setBody('Home', null, 'Hello **world**')

// project the Obsidian-compatible vault (byte-deterministic, I9)
await materialize(v, './face')
// ./face/Home.md:
//   ---
//   title: Welcome home
//   topic: ["[[Recipe]]"]
//   ---
//
//   Hello **world**

// a human edits a file…
const home = await readFile('./face/Home.md', 'utf8')
await writeFile('./face/Home.md', home.replace('Welcome home', 'Hello there'))

// …and the watcher turns the edit into the MINIMAL op set
const w = await createIngestWatcher(v, './face')
w.on('ops', ({ path, ops }) => console.log(path, ops.map((o) => o.type)))
// -> 'Home.md' [ 'set-field' ]        (exactly one op for one edited field)

// export the knowledge graph as Turtle (schema.ttl + data.ttl)
await exportTurtle(v, './ttl', { roundtrip: true })

await w.close()
await v.close()
```

## Install

```sh
pnpm add @autovault-ld/faces
```

The faces consume any vault object exposing the `@autovault-ld/store` read
surface (`scan(prefix)`, `val(key)`, `update()`, `metadata`) plus
`append(type, payload)` for ingest; they never write the view directly
(§9.3 — the view is written only by `apply` folding ops).

## API

### `await materialize(vault, dir, [opts])`

Walks `n/` and `ctx/` and emits an Obsidian-compatible vault (§9.1):

- YAML-LD frontmatter from field state — canonical **sorted** key order,
  §10.2 canonical scalar forms (the YAML emitter is hand-rolled and
  canonical: determinism beats convenience). LWW registers emit a scalar
  when length 1 and a flow array otherwise (§5.1); OR-sets always emit the
  (deduplicated) value array; `{ ref }` values emit as `"[[Wiki Links]]"`.
- body from the head revision; `context.jsonld` composed from `ctx/`
  (`@base` from vault metadata, scope prefixes, term definitions).
- host-tool keys (`tags`, `aliases`, `cssclasses`, §5.6) and unmapped
  terms round-trip verbatim; explicit `@id` is emitted under its declared
  alias (vault-ld §4.3/§5.8); tombstoned subjects are suppressed (§9.2).
- placement: `n/<s>/path` when authored, else the vault-ld §5.1
  reconstructable default (instances at the context root, schema notes at
  `Ontologies/<Scope>/Classes|Properties/...`).

Output is **byte-deterministic for a given view** (I9): converged peers
materialize bit-identical vaults.

Returns `{ root, written, unchanged, pendingIngest, unsafe, stale }`:

- `pendingIngest`: files with unsaved external modifications — skipped,
  never clobbered (§9.4); run the ingest watcher first, then materialize
  again.
- `unsafe`: `{ subject, reason }` path-safety skips (§9.4): `..` escapes,
  absolute paths, separators in the subject position, case-insensitive
  collisions. (Deviation recorded in DEVIATIONS.md: these are report
  entries, not `flag/unsafepath` view rows, because only `apply` writes
  the view.) A **namespaced** subject (`agents/alice/Note`) materializes
  once it carries an authored path (`SetPath`).
- `stale`: previously materialized files this view no longer produces.
  **materialize never deletes files** — stale files are left in place and
  reported.

On-disk safety (§9.4): every write is atomic (temp file in the target's
real directory, `fsync`, `rename`), lexically **and** realpath-contained
under the vault root, and serialized per path against the ingest watcher
through a shared in-flight lock registry, with a re-check immediately
before rename (no TOCTOU window). Clobber-immunity is a **view** property
— bodies live in the view, regeneration is a pure projection; the
mechanisms above handle the filesystem races.

### `await createIngestWatcher(vault, dir, [opts])`

Watches `dir` (recursive `fs.watch`; macOS/Windows/Linux on Node ≥ 20) and
turns human edits into the **minimal op set** (§9.2):

- frontmatter is diffed **per field** against view state: LWW terms diff
  at whole-array granularity → one `SetField` (kind-pinned `ctxKind:
  'scalar'`, §5.7); OR-set terms → one `AddMember` per added value and one
  `RemMember` per removed value citing **every** element tag mapped to it
  (§5.3); a removed line → `UnsetField`; host keys → whole-value
  `SetField`, never flagged; unmapped keys accumulate (removals rebuild
  the accumulation: `UnsetField` + `SetField`).
- the body is diffed against the head revision → one `SetBody` citing the
  observed head. (The face adds a single trailing newline to bodies on
  disk; ingest strips it, so bodies are canonicalized to no trailing
  newline.)
- wiki links per vault-ld §4.4.1: the alias is ignored for resolution, a
  fragment is discarded (with a `'warning'` event), a path qualifier is
  preserved. Link **ambiguity is apply's job** (`flag/linkambiguous`),
  never the watcher's.
- the authored context-relative path is captured as `SetPath` (§9.3);
  a `vld:path` frontmatter key is consumed, never stored as a field.
- a removed file becomes `DeleteSubject` **only** behind the §9.2
  confirmation guard: pass `confirmDelete: async (subject, relPath) =>
  boolean`; without it deletions are skipped (observable via the
  `'delete-skipped'` event).
- file names are NFC-normalized before diffing (§3.1 — macOS delivers
  NFD).

Options: `confirmDelete`, `append` (op sink, default `vault.append`),
`debounce` (ms, default 100), `settle` (write-settle interval, default
50), `watch: false` (drive `scan()` / `ingestFile(rel)` manually).
Events: `'ops'`, `'skip'`, `'warning'`, `'delete-skipped'`, `'error'`.
Methods: `await w.scan()`, `await w.ingestFile(rel)`, `await w.close()`.

The watcher debounces, waits for write-settle (size stable for one
interval), shares materialize's per-path locks, and suppresses the
system's own writes via the materialize manifest
(`<dir>/.vld-manifest.json`) — so materialize→watch loops don't echo.

### `await exportTurtle(vault, dir, [opts])`

Produces `schema.ttl` and `data.ttl` by range-scanning `idx/spo`,
partitioned by the per-subject `n/<s>/layer` record (§10.1). Output is
byte-deterministic (§10.2): prefixes, subjects, predicates (by expanded
IRI bytes) and objects (by canonical byte form) all sort ascending;
literals use canonical XSD lexical forms; strings escape in fixed
codepoint order. Terms declared `'@type': '@id'` export string values as
IRIs; `@type` uses the `a` shorthand. Unmapped terms are **never** emitted
as triples (§10.3) — they live on the Markdown face and in the view.

With `{ roundtrip: true }`, notes whose authored path differs from their
reconstructable default carry `vld:path "<path>.md"` (§10.4; omitted for
defaults and for query-only exports), so ingest can restore placement 1:1.

Returns `{ schema: { path, triples }, data: { path, triples } }`.

## Semantics worth knowing

- **Context regimes (§5.7):** merge policy is read from the in-log context
  at apply time. The watcher pins `ctxKind` on every kind-resolved field
  op it emits, so a reorged `DefineTerm` cannot silently reinterpret a
  human edit.
- **Whole-note ingest:** a human edit carries the whole frontmatter the
  human observed; a stale field in the edited file legitimately wins the
  LWW register over a concurrent write (audited via `flag/clobber`,
  §5.4). That is per-field LWW working as specified, not a race bug.
- **IRI minting:** faces never mint IRIs of their own — subject IRIs come
  from the view (`n/<s>/base`), so all faces agree with `apply` by
  construction (see DEVIATIONS.md on the §4.5 percent-encoding set).

## Tests

From the repo root: `pnpm test` (Node's built-in runner). The faces suite
(`test/faces-*.test.js`) drives real `@autovault-ld/store` vaults (autobee +
corestore on disk): materialize byte-determinism across passes, rebuilt
stores and replicated peers (I9); ingest minimality (one edited field →
exactly one `SetField`; a deleted line → `UnsetField`; a body edit → one
`SetBody` citing the observed head); the §5.3 citation contract; the
roundtrip fixed point; Turtle byte-determinism and parsing with
[N3.js](https://github.com/rdfjs/N3.js); the §9.4 adversarial containment
and materialize/ingest race-safety tests.

## License

Apache-2.0
