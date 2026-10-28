// compareNotes(face, vault) — the byte compare behind the fidelity check of
// importFace (okf SPEC §10, §14). After an import, the notes of a
// materialize of the new vault (in memory) must equal the notes of the face
// that import read, byte for byte, "modulo the `_rev` frontmatter lines"
// (§14): `_rev` re-derives in the new vault. importFace leaves out index.md
// and log.md, the regenerated faces, before it calls this.
//
// Both sides are Map<rel, Buffer> that the caller built: the face's notes at
// any depth, dot-segment paths included, and the byte plan of materialize.
// No directory is walked here, and no copy is written to disk.

/**
 * Compare the notes of a face with the notes of a new vault (importFace),
 * both Map<rel, Buffer>. Returns every difference, in byte order of path
 * (an empty array when they match):
 *
 *   { path, kind: 'missing' }   only the face holds the note
 *   { path, kind: 'extra' }     only the vault holds it
 *   { path, kind: 'differs' }   both hold it, with different bytes
 *
 * Each `_rev` line of a note's frontmatter block is excluded: it re-derives
 * in the new vault (§14). A `_rev:` line in a body is compared.
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
 * The note's bytes (as latin1, one char per byte) with every `_rev:` line of
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
