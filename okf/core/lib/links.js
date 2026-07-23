// Pure markdown link extraction + target resolution (okf SPEC §9,
// "Extraction, normative"). Runs inside apply on every body-head change so
// link/, bl/ and wanted/ are identical on every peer (I2, I8): CommonMark
// inline and reference links only — no autolinks, no images — skipping
// fenced/indented code blocks and inline code spans. Everything here is a
// pure function of (text, sourceDir): no clock, no randomness (I1).
import { nfc } from './canonical.js'

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/

/** CommonMark labels match case-insensitively with collapsed whitespace. */
function normLabel(label) {
  return String(label).trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Resolve `..`/`.` segments of `target` against `baseDir` ('' = bundle
 * root). Returns the normalized bundle-relative path, or null when the
 * resolution escapes the bundle root (§9: ignored).
 */
export function resolveTarget(target, baseDir) {
  const segs = (baseDir ? baseDir.split('/') : []).concat(String(target).split('/'))
  const stack = []
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (stack.length === 0) return null // escapes the bundle root
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  return stack.join('/')
}

/**
 * Normalize one raw link destination per §9. Returns the bundle-relative
 * path that keys `link/`, or null when the target is a citation (URI
 * scheme / protocol-relative), escapes the root, or normalizes to nothing.
 */
export function normalizeLinkTarget(raw, sourceDir) {
  let t = String(raw)
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1) // CommonMark <dest>
  if (SCHEME_RE.test(t)) return null // URI scheme → citation, ignored
  if (t.startsWith('//')) return null // protocol-relative → citation
  t = t.split('#')[0] // strip any fragment
  if (t === '') return null
  const resolved = t.startsWith('/')
    ? resolveTarget(t.slice(1), '') // '/'-prefixed = bundle-relative
    : resolveTarget(t, sourceDir) // else relative to the source's directory
  if (resolved === null || resolved === '') return null
  // strip one trailing '.md' (materialize emits `<path>.md`)
  const stripped = resolved.replace(/\.md$/i, '')
  if (stripped === '') return null
  return nfc(stripped)
}

/**
 * Extract the set of resolved bundle-relative link-target paths from a
 * markdown body. `sourceDir` is the directory of the source concept's
 * current path ('' at the bundle root).
 */
export function extractLinks(text, sourceDir = '') {
  const targets = new Set()
  if (!text) return targets

  // 1. drop fenced code blocks (``` / ~~~) and indented code lines
  const kept = []
  let fence = null
  for (const line of String(text).split('\n')) {
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fm) {
      if (fence === null) fence = fm[1][0]
      else if (fm[1][0] === fence) fence = null
      kept.push('')
      continue
    }
    if (fence !== null || /^(?: {4}|\t)/.test(line)) {
      kept.push('')
      continue
    }
    kept.push(line)
  }
  let body = kept.join('\n')

  // 2. blank inline code spans (matched backtick runs)
  body = body.replace(/(`+)[^`]*?\1/g, ' ')

  // 3. collect reference definitions, then blank the definition lines so
  //    they are not re-read as shortcut references
  const defs = new Map()
  for (const m of body.matchAll(/^ {0,3}\[([^\]]+)\]:[ \t]*(\S+)/gm)) {
    const label = normLabel(m[1])
    if (!defs.has(label)) defs.set(label, m[2]) // first definition wins (CommonMark)
  }
  body = body.replace(/^ {0,3}\[[^\]]+\]:[ \t]*\S+.*$/gm, ' ')

  const add = (raw) => {
    const t = normalizeLinkTarget(raw, sourceDir)
    if (t !== null) targets.add(t)
  }

  // 4. inline links [text](dest "title") — images (![) are skipped
  for (const m of body.matchAll(/(!?)\[([^\]]*)\]\(([^()\s]+)(?:[ \t]+"[^"]*")?\)/g)) {
    if (m[1] !== '!') add(m[3])
  }
  body = body.replace(/!?\[[^\]]*\]\([^()]*\)/g, ' ')

  // 5. full [text][label] and collapsed [label][] reference links
  for (const m of body.matchAll(/(!?)\[([^\]]*)\]\[([^\]]*)\]/g)) {
    if (m[1] === '!') continue
    const t = defs.get(normLabel(m[3] === '' ? m[2] : m[3]))
    if (t !== undefined) add(t)
  }
  body = body.replace(/!?\[[^\]]*\]\[[^\]]*\]/g, ' ')

  // 6. shortcut [label] references (only when a definition exists)
  for (const m of body.matchAll(/(!?)\[([^\]]+)\]/g)) {
    if (m[1] === '!') continue
    const t = defs.get(normLabel(m[2]))
    if (t !== undefined) add(t)
  }

  return targets
}

/** Directory of a bundle-relative path ('' at the root). */
export function dirOf(path) {
  const i = String(path).lastIndexOf('/')
  return i === -1 ? '' : String(path).slice(0, i)
}
