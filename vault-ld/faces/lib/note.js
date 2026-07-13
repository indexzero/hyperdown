// Note serialization: canonical YAML-LD frontmatter + body (SPEC-FINAL
// §9.1/§9.2, vault-ld frontmatter conventions).
//
// EMISSION is hand-rolled and canonical: §10.2 requires byte-deterministic
// output with canonical literal lexical forms, "never the YAML library's
// default float/date rendering" (§9.1). A general-purpose YAML dumper owns
// its style decisions (line wrapping, quote choice, float formatting) and
// can change them across versions, which would silently break I9;
// determinism beats convenience, so the emitter below defines every byte.
// PARSING human-edited YAML, by contrast, needs full YAML 1.2 coverage, so
// ingest uses the maintained `yaml` package (https://eemeli.org/yaml/ —
// YAML 1.2 core schema by default; parse() returns plain JS values).
//
// Wiki-link grammar per vault-ld §4.4.1 (verified against SPEC.md,
// https://github.com/The-Knowledge-Graph-Guys/vault-ld): a wiki link is
// [[name]], optionally [[path/to/name]], [[name|display text]],
// [[name#Heading]]; the alias is display-only and MUST be ignored for
// resolution; a fragment addresses a location inside a note — the edge
// resolves to the note itself (the fragment is discarded, optionally with
// a warning); a path disambiguates same-named notes. Ambiguity is decided
// by APPLY (flag/linkambiguous), never by ingest (§9.2).
import { parse as parseYaml } from 'yaml'
import { canonical } from '@autovault-ld/core'

const { nfc, canonicalInteger, canonicalDouble, stableStringify } = canonical

// ---------- wiki-link grammar (vault-ld §4.4.1) ----------

const LINK_RE = /^\[\[([^\[\]]+)\]\]$/

/**
 * Parse a whole-value wiki link. Returns
 *   { ref, fragment|null, alias|null }  or  null when not a link.
 * The alias part is ignored for resolution; the fragment is discarded by
 * the caller (with an optional warning). A path-qualified target is
 * preserved verbatim — ingest MAY pre-resolve with a path but MUST NOT
 * decide ambiguity (§9.2).
 */
export function parseWikiLink(str) {
  if (typeof str !== 'string') return null
  const m = LINK_RE.exec(str)
  if (!m) return null
  let inner = m[1]
  let alias = null
  const pipe = inner.indexOf('|')
  if (pipe !== -1) {
    alias = inner.slice(pipe + 1)
    inner = inner.slice(0, pipe)
  }
  let fragment = null
  const hash = inner.indexOf('#')
  if (hash !== -1) {
    fragment = inner.slice(hash + 1)
    inner = inner.slice(0, hash)
  }
  const ref = nfc(inner.trim())
  if (ref === '') return null
  return { ref, fragment, alias }
}

export function wikiLink(ref) {
  return `[[${ref}]]`
}

// ---------- canonical YAML emission (§9.1/§10.2) ----------

// YAML 1.2 core-schema resolutions that would change a plain scalar's type
// (booleans/null per the core schema; yaml@2 resolves these spellings).
const YAML_RESERVED_WORD = /^(?:null|Null|NULL|~|true|True|TRUE|false|False|FALSE)$/
// Number-shaped strings must be quoted so they stay strings on re-parse.
const YAML_NUMBERISH = /^[-+]?(?:\.[0-9]|[0-9]|\.inf|\.Inf|\.INF|\.nan|\.NaN|\.NAN)/
// Conservative plain-style charset (ASCII, no flow indicators or comment/
// anchor/tag introducers): anything outside is double-quoted. Being
// conservative never hurts determinism -- only which of two deterministic
// spellings is chosen.
const PLAIN_OK = /^[A-Za-z0-9_][A-Za-z0-9_ ./@%+'()-]*$/

function quoteDouble(s) {
  let out = '"'
  for (const ch of s) {
    const code = ch.codePointAt(0)
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
      out += '\\u' + code.toString(16).toUpperCase().padStart(4, '0')
    } else {
      out += ch
    }
  }
  return out + '"'
}

function emitString(s) {
  if (
    PLAIN_OK.test(s) &&
    !YAML_RESERVED_WORD.test(s) &&
    !YAML_NUMBERISH.test(s) &&
    !s.includes(': ') &&
    !s.includes(' #') &&
    !s.endsWith(' ') &&
    !s.endsWith(':')
  ) {
    return s
  }
  return quoteDouble(s)
}

function emitNumber(n) {
  // Canonical lexical forms per §10.2 — never platform default toString for
  // non-integers (xsd:double canonical mapping via core's canonicalDouble).
  if (Number.isSafeInteger(n)) return canonicalInteger(n)
  return canonicalDouble(n)
}

/** One canonical value -> one YAML flow scalar/collection. */
export function emitYamlValue(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return emitNumber(v)
  if (typeof v === 'string') return emitString(v)
  if (Array.isArray(v)) return '[' + v.map(emitYamlValue).join(', ') + ']'
  if (typeof v === 'object') {
    if (typeof v.ref === 'string') return emitString(wikiLink(v.ref))
    if ('value' in v) {
      // Typed literal {value, datatype?, lang?}: canonical flow map with
      // fixed key order so it round-trips through core's canonicalValue.
      const parts = []
      if (v.datatype !== undefined) parts.push('datatype: ' + emitString(String(v.datatype)))
      if (v.lang !== undefined) parts.push('lang: ' + emitString(String(v.lang)))
      parts.push('value: ' + emitString(String(v.value)))
      return '{' + parts.join(', ') + '}'
    }
    // Unknown object shape: preserved as a canonical JSON string (§5.6:
    // authored values are never dropped).
    return quoteDouble(stableStringify(v))
  }
  return quoteDouble(String(v))
}

const KEY_PLAIN = /^[A-Za-z0-9_@][A-Za-z0-9_@.-]*$/

export function emitYamlKey(k) {
  return KEY_PLAIN.test(k) ? k : quoteDouble(k)
}

/**
 * Canonical frontmatter block from [key, value] pairs. Ordering is the
 * caller's (canonical sorted, §9.1); values are scalars or arrays; arrays
 * are always flow style (§5.1 "a scalar when length is 1 and a flow array
 * otherwise" — the length-1 collapse is also the caller's decision).
 */
export function emitFrontmatter(pairs) {
  let out = ''
  for (const [k, v] of pairs) {
    out += emitYamlKey(k) + ': ' + emitYamlValue(v) + '\n'
  }
  return out
}

// ---------- whole-note render / parse ----------

/**
 * Render one note file. `pairs` as for emitFrontmatter; `body` is the head
 * revision text (already NFC from apply). Byte layout is fixed (I9):
 *   ---\n<frontmatter>---\n            (only when there are pairs)
 *   \n<body>\n                          (only when body is non-empty)
 */
export function renderNote(pairs, body) {
  let out = ''
  if (pairs.length > 0) {
    out += '---\n' + emitFrontmatter(pairs) + '---\n'
  }
  if (body !== undefined && body !== null && body !== '') {
    out += (out === '' ? '' : '\n') + body
    if (!out.endsWith('\n')) out += '\n'
  }
  return out
}

/**
 * Parse one note file into { fm, body, warnings }. `fm` is null when the
 * file has no frontmatter block, else the plain-object YAML parse.
 * The body is the text after the closing '---' with the single leading
 * blank separator line and the single trailing file newline removed —
 * the exact inverse of renderNote for any body not itself ending in '\n'
 * (ingest canonicalizes bodies to no trailing newline; documented in the
 * README).
 */
export function parseNote(text) {
  const warnings = []
  let fm = null
  let rest = text
  if (text.startsWith('---\n')) {
    // The closing fence is exactly '---' on its own line (or at EOF).
    const m = /\n---(?:\n|$)/.exec(text.slice(3))
    if (m) {
      const end = 3 + m.index
      const yamlSrc = text.slice(4, end + 1)
      const after = text.indexOf('\n', end + 1)
      rest = after === -1 ? '' : text.slice(after + 1)
      try {
        const parsed = parseYaml(yamlSrc)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          fm = parsed
        } else if (parsed !== null) {
          warnings.push('frontmatter is not a mapping; ignored')
        }
      } catch (err) {
        warnings.push('frontmatter YAML parse error: ' + err.message)
      }
    }
  }
  let body = rest
  if (body.startsWith('\n')) body = body.slice(1)
  if (body.endsWith('\n')) body = body.slice(0, -1)
  return { fm, body, warnings }
}

// ---------- YAML value -> canonical op value ----------

/**
 * Map one parsed YAML value to the op-value shape core canonicalizes
 * (§3.1/§10.2): strings become NFC strings or { ref } wiki links; mappings
 * with a `value` key are typed literals; numbers/booleans/null pass
 * through. Returns { value, warnings }.
 */
export function yamlToValue(v) {
  const warnings = []
  if (typeof v === 'string') {
    const link = parseWikiLink(v)
    if (link) {
      if (link.fragment !== null) {
        // vault-ld §4.4.1: the edge resolves to the note; the fragment is
        // discarded and a tool MAY warn.
        warnings.push(`fragment '#${link.fragment}' discarded from [[${link.ref}]]`)
      }
      return { value: { ref: link.ref }, warnings }
    }
    return { value: nfc(v), warnings }
  }
  if (v instanceof Date) {
    // yaml@2 core schema does not resolve timestamps, but guard anyway:
    // canonical xsd:dateTime lexical (§10.2), never Date.toString().
    return { value: { value: v.toISOString().replace(/\.000Z$/, 'Z'), datatype: 'xsd:dateTime' }, warnings }
  }
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && 'value' in v) {
    const out = { value: v.value }
    if (v.datatype !== undefined && v.datatype !== null) out.datatype = String(v.datatype)
    if (v.lang !== undefined && v.lang !== null) out.lang = String(v.lang)
    return { value: out, warnings }
  }
  return { value: v, warnings }
}

/** Frontmatter entry -> array of canonical op values + scalar-ness. */
export function yamlToValues(v) {
  const arr = Array.isArray(v) ? v : [v]
  const values = []
  const warnings = []
  for (const item of arr) {
    const r = yamlToValue(item)
    values.push(r.value)
    warnings.push(...r.warnings)
  }
  return { values, scalar: !Array.isArray(v), warnings }
}
