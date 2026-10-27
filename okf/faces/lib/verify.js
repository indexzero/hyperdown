// compareTrees(expectedDir, actualDir) — the byte compare behind compaction's
// self-check (okf SPEC §10, §14). compact materializes the fresh vault into a
// verification directory and compares it with the face it ingested: a
// generation cycle must keep every live concept byte for byte, "modulo the
// `_rev` frontmatter lines and the regenerated `log.md`" (§14). Both of those
// re-derive in the new generation, so this compare excludes them, and only
// them.
//
// The walk is its own, not fsatomic's walkNotes: walkNotes skips every
// dot-prefixed entry, and a concept at a dot-segment path is still a concept
// (core accepts `.drafts/idea`). A compare that skipped those paths could not
// see compaction drop them.
//
// liveState(reader) and compareStates(expected, actual) — the state compare
// behind the same self-check. The face is a lossy projection of the view:
// it omits a scalar null, emits only the first `type` value, and writes a
// reference or an object as a string. Two vaults that differ in such a value
// materialize the same bytes, so the byte compare alone cannot prove I11.
// compact therefore also compares the live state of the predecessor and the
// new vault, read through okf's own view keys (readView).
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonical } from '@auto-okf/core'
import { readView } from './view.js'

const { byteForm, sortValues, stableStringify } = canonical

// §14: the root log.md re-derives in every generation. Core rejects a concept
// whose terminal path component is `log` (reserved-path), so materialize
// writes no other log.md.
const LOG_FILE = 'log.md'

/**
 * Byte-compare two materialized bundle trees. Returns every difference, in
 * byte order of path (an empty array when the trees match):
 *
 *   { path, kind: 'missing' }   the file is in expectedDir only
 *   { path, kind: 'extra' }     the file is in actualDir only
 *   { path, kind: 'differs' }   the file is in both, with different bytes
 *
 * Compared: every `.md` file at any depth, dot-prefixed paths included.
 * Excluded: the root `log.md`, and each `_rev` line of a note's frontmatter
 * block (a `_rev:` line in a body is compared). A file that is not `.md` is
 * not bundle content: the emission manifest `.okf-manifest.json` is
 * peer-local state, and a stray temp file is not a note.
 */
export async function compareTrees(expectedDir, actualDir) {
  const expected = await bundleFiles(expectedDir)
  const actual = await bundleFiles(actualDir)
  const paths = [...new Set([...expected, ...actual])].sort(byteCmp)
  const differences = []
  for (const rel of paths) {
    if (!actual.has(rel)) differences.push({ path: rel, kind: 'missing' })
    else if (!expected.has(rel)) differences.push({ path: rel, kind: 'extra' })
    else if (!(await sameBytes(join(expectedDir, rel), join(actualDir, rel)))) {
      differences.push({ path: rel, kind: 'differs' })
    }
  }
  return differences
}

/** Every compared file under `root`, as relative forward-slash paths. */
async function bundleFiles(root, rel = '', out = new Set()) {
  const entries = await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true })
  for (const e of entries) {
    const childRel = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) await bundleFiles(root, childRel, out)
    else if (e.isFile() && childRel.endsWith('.md') && childRel !== LOG_FILE) out.add(childRel)
  }
  return out
}

async function sameBytes(a, b) {
  const [x, y] = await Promise.all([readFile(a), readFile(b)])
  return withoutRev(x) === withoutRev(y)
}

/**
 * The file's bytes (as latin1, one char per byte) with every `_rev:` line of
 * its frontmatter block removed. The block is found the way parseNote finds
 * it: an opening `---\n`, then the first `\n---` line.
 */
function withoutRev(buf) {
  const text = buf.toString('latin1')
  if (!text.startsWith('---\n')) return text
  const m = /\n---(?:\n|$)/.exec(text.slice(3))
  if (!m) return text
  const close = 3 + m.index + 1 // first byte of the closing '---' line
  const lines = text.slice(4, close).split('\n')
  return text.slice(0, 4) + lines.filter((l) => !l.startsWith('_rev:')).join('\n') + text.slice(close)
}

/**
 * The canonical live state of a vault (SPEC §10, I11): Map<_id, { path,
 * body, fields }> for each live concept (not tombstoned, with a path, as
 * materialize decides). `reader` is the { scan } surface of readView.
 *
 *   path    the concept's path (c/<id>/path)
 *   body    the head body text, '' when the concept has no head
 *   fields  Map<key, string>: each field key (c/<id>/f/<key>) to the
 *           stableStringify of its values. A register gives its canonical
 *           array. `tags` (the one OR-set, §5) gives the values that hold a
 *           live token, deduplicated and in canonical order. An empty
 *           register or tag set is the key omitted (§5), so it has no entry.
 *
 * History is excluded by construction (§10): revision ancestry (the head
 * revHash and the rev/ chain), attribution (the writer and tag of each
 * record) and clocks (ords, the created tag, meta.type).
 */
export async function liveState(reader) {
  const { concepts } = await readView(reader)
  const state = new Map()
  for (const c of concepts.values()) {
    if (c.deleted || c.path === undefined) continue
    const fields = new Map()
    for (const [key, rec] of c.fields) {
      const values = key === 'tags' ? tagValues(rec) : registerValues(rec)
      if (values.length > 0) fields.set(key, stableStringify(values))
    }
    state.set(c.id, { path: c.path, body: c.headText, fields })
  }
  return state
}

/**
 * Compare two liveState maps. Returns every difference (an empty array when
 * the states match) as { path, kind: 'state', id, key }:
 *
 *   key '_id'        the concept is live in one vault only
 *   key 'path'       the path differs
 *   key 'body'       the head body text differs
 *   key 'f/<field>'  the values of the field differ (`f/tags` for the tags)
 *
 * `path` is the concept's path in `expected`, or in `actual` when only
 * `actual` holds the concept. A difference never holds a value: the vault
 * can be encrypted, and an error message can reach a log. The order is
 * byte order of path, then of _id, then of key.
 */
export function compareStates(expected, actual) {
  const differences = []
  const add = (path, id, key) => differences.push({ path, kind: 'state', id, key })
  for (const [id, want] of expected) {
    const got = actual.get(id)
    if (got === undefined) {
      add(want.path, id, '_id')
      continue
    }
    if (got.path !== want.path) add(want.path, id, 'path')
    if (got.body !== want.body) add(want.path, id, 'body')
    for (const key of new Set([...want.fields.keys(), ...got.fields.keys()])) {
      if (want.fields.get(key) !== got.fields.get(key)) add(want.path, id, `f/${key}`)
    }
  }
  for (const [id, got] of actual) {
    if (!expected.has(id)) add(got.path, id, '_id')
  }
  return differences.sort((a, b) => byteCmp(a.path, b.path) || byteCmp(a.id, b.id) || byteCmp(a.key, b.key))
}

/** The canonical values of an LWW-array register record (§5): [] when it holds none. */
function registerValues(rec) {
  return rec && Array.isArray(rec.values) ? rec.values : []
}

/** The values of the tags OR-set record (§5) that hold a live token: deduplicated, in canonical order. */
function tagValues(rec) {
  const seen = new Set()
  const out = []
  for (const v of sortValues(Object.values((rec && rec.els) || {}))) {
    const bf = byteForm(v)
    if (seen.has(bf)) continue
    seen.add(bf)
    out.push(v)
  }
  return out
}

function byteCmp(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}
