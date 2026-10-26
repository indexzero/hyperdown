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
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

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

function byteCmp(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}
