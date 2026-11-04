// The byte compare behind the fidelity check of importFace. See SPEC §10
// and §14.

/**
 * Compare the notes of a bundle with the notes of the new vault. Both are
 * Map<rel, Buffer> without index.md and log.md. Returns every difference in
 * byte order of path, [] when they match:
 *
 *   { path, kind: 'missing' }   only the bundle holds the note
 *   { path, kind: 'extra' }     only the vault holds it
 *   { path, kind: 'differs' }   the bytes differ
 *
 * `_rev` lines are not compared (withoutRev).
 */
export function compareNotes(face, vault) {
  const paths = [...new Set([...face.keys(), ...vault.keys()])].sort(byteCmp)
  const differences = []
  for (const rel of paths) {
    if (!vault.has(rel)) differences.push({ path: rel, kind: 'missing' })
    else if (!face.has(rel)) differences.push({ path: rel, kind: 'extra' })
    else if (withoutRev(face.get(rel)) !== withoutRev(vault.get(rel))) differences.push({ path: rel, kind: 'differs' })
  }
  return differences
}

/**
 * The bytes of a note as latin1, without the `_rev:` lines of its
 * frontmatter block. `_rev` re-derives in the new vault (SPEC §14). A
 * `_rev:` line in a body stays. The block is found the way parseNote finds
 * it.
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
