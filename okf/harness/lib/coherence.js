// Independent index-coherence checker (okf harness S10; SPEC §11 I8):
// path/, link/, bl/, wanted/, wantedrank/ and revbybase/ are exactly
// derivable from c/ at every quiescent point. This is an INDEPENDENT
// reimplementation of the derivation and of the §9 link extraction — it
// imports nothing from @auto-okf/* (the code under test). Escaping, the
// wantedrank inv-count, and the markdown link extraction are all rewritten
// here from SPEC §4/§7/§9 and cross-checked against the packages' READMEs.
//
// Given a full flat view dump ({ key: value }), rederives the six index
// families from c/ alone and reports every discrepancy.

// ---- §4 keyspace escaping (reimplemented) ----
function esc(component) {
  return String(component).replace(/%/g, '%25').replace(/\//g, '%2F')
}
function unesc(component) {
  return String(component).replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}
function parseKey(key) {
  return key.split('/').map(unesc)
}

// wantedrank/<inv-count>/<path>: inv-count = (MAX - count), 16-digit padded,
// MAX = 10^16 - 1 (reimplemented from §4).
const WANTED_MAX = 10n ** 16n - 1n
function invCount(count) {
  return String(WANTED_MAX - BigInt(count)).padStart(16, '0')
}

// ---- §9 markdown link extraction (reimplemented, restricted CommonMark) ----
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/

function nfc(s) {
  return String(s).normalize('NFC')
}

function dirOf(path) {
  const i = String(path).lastIndexOf('/')
  return i === -1 ? '' : String(path).slice(0, i)
}

/** Resolve `.`/`..` of target against baseDir; null if it escapes the root. */
function resolveTarget(target, baseDir) {
  const segs = (baseDir ? baseDir.split('/') : []).concat(String(target).split('/'))
  const stack = []
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  return stack.join('/')
}

/** Normalize one raw destination per §9; null for citations/escapes/empty. */
function normalizeLinkTarget(raw, sourceDir) {
  let t = String(raw)
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1)
  if (SCHEME_RE.test(t)) return null
  if (t.startsWith('//')) return null
  t = t.split('#')[0]
  if (t === '') return null
  const resolved = t.startsWith('/') ? resolveTarget(t.slice(1), '') : resolveTarget(t, sourceDir)
  if (resolved === null || resolved === '') return null
  const stripped = resolved.replace(/\.md$/i, '')
  if (stripped === '') return null
  return nfc(stripped)
}

/**
 * Extract resolved bundle-relative link targets from markdown body text.
 * Restricted (independent) CommonMark subset matching §9: skip fenced/
 * indented code and inline code spans; inline links + reference links; no
 * images, no autolinks. Faithful to core/lib/links.js on the harness's
 * (deliberately simple) body texts.
 */
function extractLinks(text, sourceDir = '') {
  const targets = new Set()
  if (!text) return targets

  // 1. drop fenced code blocks and indented code lines
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

  // 2. blank inline code spans
  body = body.replace(/(`+)[^`]*?\1/g, ' ')

  // 3. reference definitions, then blank the definition lines
  const defs = new Map()
  const normLabel = (l) => String(l).trim().replace(/\s+/g, ' ').toLowerCase()
  for (const m of body.matchAll(/^ {0,3}\[([^\]]+)\]:[ \t]*(\S+)/gm)) {
    const label = normLabel(m[1])
    if (!defs.has(label)) defs.set(label, m[2])
  }
  body = body.replace(/^ {0,3}\[[^\]]+\]:[ \t]*\S+.*$/gm, ' ')

  const add = (raw) => {
    const t = normalizeLinkTarget(raw, sourceDir)
    if (t !== null) targets.add(t)
  }

  // 4. inline links [text](dest "title"), images skipped
  for (const m of body.matchAll(/(!?)\[([^\]]*)\]\(([^()\s]+)(?:[ \t]+"[^"]*")?\)/g)) {
    if (m[1] !== '!') add(m[3])
  }
  body = body.replace(/!?\[[^\]]*\]\([^()]*\)/g, ' ')

  // 5. full and collapsed reference links
  for (const m of body.matchAll(/(!?)\[([^\]]*)\]\[([^\]]*)\]/g)) {
    if (m[1] === '!') continue
    const t = defs.get(normLabel(m[3] === '' ? m[2] : m[3]))
    if (t !== undefined) add(t)
  }
  body = body.replace(/!?\[[^\]]*\]\[[^\]]*\]/g, ' ')

  // 6. shortcut references
  for (const m of body.matchAll(/(!?)\[([^\]]+)\]/g)) {
    if (m[1] === '!') continue
    const t = defs.get(normLabel(m[2]))
    if (t !== undefined) add(t)
  }

  return targets
}

/**
 * @param {object} dump  full flat view dump { key: value }
 * @returns {string[]}   violations (empty = coherent)
 */
export function checkCoherence(dump) {
  // -- pass 1: collect per-concept state from c/ --
  const concepts = new Map() // id -> { meta, path, body, revs: Map }
  for (const [key, value] of Object.entries(dump)) {
    if (!key.startsWith('c/')) continue
    const segs = parseKey(key)
    const id = segs[1]
    let c = concepts.get(id)
    if (!c) {
      c = { meta: null, path: null, body: undefined, revs: new Map() }
      concepts.set(id, c)
    }
    if (segs[2] === 'meta') c.meta = value
    else if (segs[2] === 'path') c.path = value
    else if (segs[2] === 'body') c.body = value
    else if (segs[2] === 'rev') c.revs.set(segs[3], value)
  }

  // -- pass 2: derived families --
  const expected = {
    revbybase: new Set(),
    path: new Map(), // key -> id
    link: new Set(),
    bl: new Set(),
    wanted: new Set(),
    wantedrank: new Map() // key -> count
  }

  // revbybase/: every revision citing a non-null base
  for (const [id, c] of concepts) {
    for (const [rh, rev] of c.revs) {
      if (rev && rev.base !== null && rev.base !== undefined) {
        expected.revbybase.add(`revbybase/${esc(id)}/${esc(rev.base)}/${esc(rh)}`)
      }
    }
  }

  // path/: per exact path, the live claim with the lowest ord
  const claims = new Map() // exactPath -> { id, ord }
  const isLive = (c) => c.meta && c.meta.deleted == null && c.path
  for (const [id, c] of concepts) {
    if (!isLive(c)) continue
    const cur = claims.get(c.path.path)
    if (!cur || c.path.ord < cur.ord) claims.set(c.path.path, { id, ord: c.path.ord })
  }
  for (const [p, { id }] of claims) expected.path.set(`path/${esc(p)}`, id)

  // link/ + bl/ + wanted/(+rank): live concepts' head-text extraction
  const wantedCounts = new Map()
  for (const [id, c] of concepts) {
    if (!isLive(c) || c.body === undefined) continue
    const rev = c.revs.get(c.body)
    if (!rev) continue
    for (const t of extractLinks(rev.text, dirOf(c.path.path))) {
      expected.link.add(`link/${esc(id)}/${esc(t)}`)
      const holder = claims.get(t)
      if (holder) {
        expected.bl.add(`bl/${esc(holder.id)}/${esc(id)}`)
      } else {
        expected.wanted.add(`wanted/${esc(t)}/${esc(id)}`)
        wantedCounts.set(t, (wantedCounts.get(t) || 0) + 1)
      }
    }
  }
  for (const [t, n] of wantedCounts) expected.wantedrank.set(`wantedrank/${invCount(n)}/${esc(t)}`, n)

  // -- pass 3: compare with the actual dump --
  const violations = []
  const setFamily = (prefix, expSet) => {
    const actual = new Set(Object.keys(dump).filter((k) => k.startsWith(prefix)))
    for (const k of expSet) if (!actual.has(k)) violations.push(`missing ${k}`)
    for (const k of actual) if (!expSet.has(k)) violations.push(`stray ${k}`)
  }
  setFamily('link/', expected.link)
  setFamily('bl/', expected.bl)
  setFamily('wanted/', expected.wanted)
  setFamily('revbybase/', expected.revbybase)

  // path/ (value-bearing)
  const actualPath = new Set(Object.keys(dump).filter((k) => k.startsWith('path/')))
  for (const [k, id] of expected.path) {
    if (!(k in dump)) violations.push(`missing ${k}`)
    else if (dump[k] !== id) violations.push(`path holder mismatch ${k}: expected ${id}, got ${dump[k]}`)
  }
  for (const k of actualPath) if (!expected.path.has(k)) violations.push(`stray ${k}`)

  // wantedrank/ (value-bearing count)
  const actualRank = new Set(Object.keys(dump).filter((k) => k.startsWith('wantedrank/')))
  for (const [k, n] of expected.wantedrank) {
    if (!(k in dump)) violations.push(`missing ${k}`)
    else if (dump[k] !== n) violations.push(`wantedrank count mismatch ${k}: expected ${n}, got ${dump[k]}`)
  }
  for (const k of actualRank) if (!expected.wantedrank.has(k)) violations.push(`stray ${k}`)

  return violations
}
