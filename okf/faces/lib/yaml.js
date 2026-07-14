// YAML for the OKF faces (okf SPEC §6, §9). Pattern ancestor:
// vault-ld/faces/lib/note.js (copy-don't-depend, SPEC §0).
//
// EMISSION is hand-rolled and canonical (§9 "YAML emission is pinned"):
// byte-deterministic output is required for cross-implementation
// byte-identity and OKF §9(1) parseability. A general-purpose YAML dumper
// owns its style decisions (quote choice, line wrapping, number/date
// rendering) and can change them across versions, which would silently
// break I9. So the emitter below defines every byte:
//   - scalars double-quoted iff YAML would otherwise reinterpret them
//   - flow-style lists
//   - LF line endings, trailing newline (renderNote)
//
// PARSING human-edited YAML, by contrast, needs full YAML 1.2 coverage, so
// ingest and the frontmatter reader use the maintained `yaml` package
// (https://eemeli.org/yaml/ — YAML 1.2 core schema; parse() returns plain
// JS values). Parse-only: the emitter is never the `yaml` dumper.
import { parse as parseYaml } from 'yaml'
import { canonical } from '@auto-okf/core'

const { nfc, canonicalInteger, canonicalDouble, stableStringify } = canonical

// ---------- canonical YAML emission (§9) ----------

// Core-schema spellings that would change a plain scalar's TYPE on re-parse.
const YAML_RESERVED_WORD = /^(?:null|Null|NULL|~|true|True|TRUE|false|False|FALSE)$/
// Number-shaped strings must be quoted so they stay strings on re-parse.
const YAML_NUMBERISH = /^[-+]?(?:\.[0-9]|[0-9]|\.inf|\.Inf|\.INF|\.nan|\.NaN|\.NAN)/
// Conservative plain-style charset (ASCII, no flow indicators or comment/
// anchor/tag introducers). Anything outside is double-quoted; being
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
    // Wiki-style reference and typed-literal shapes core's canonicalValue may
    // produce. OKF fields are ordinarily plain scalars; these keep any richer
    // value round-trippable rather than dropped.
    if (typeof v.ref === 'string') return emitString(v.ref)
    if ('value' in v) {
      const parts = []
      if (v.datatype !== undefined) parts.push('datatype: ' + emitString(String(v.datatype)))
      if (v.lang !== undefined) parts.push('lang: ' + emitString(String(v.lang)))
      parts.push('value: ' + emitString(String(v.value)))
      return '{' + parts.join(', ') + '}'
    }
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
 * caller's (§6: _id, _rev, type, then sorted); values are scalars or arrays;
 * arrays are always flow style; a length-1 array collapse is the caller's
 * decision.
 */
export function emitFrontmatter(pairs) {
  let out = ''
  for (const [k, v] of pairs) {
    out += emitYamlKey(k) + ': ' + emitYamlValue(v) + '\n'
  }
  return out
}

/**
 * Render one concept note (§9 byte layout, fixed for I9):
 *   ---\n<frontmatter>---\n            (frontmatter always present: type is
 *                                        required, so pairs is non-empty)
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
 * Parse one concept note into { fm, body, warnings }. `fm` is null when the
 * file has no frontmatter block, else the plain-object YAML parse. The body
 * is the text after the closing '---' with the single leading blank
 * separator line and the single trailing file newline removed — the exact
 * inverse of renderNote for any body not itself ending in '\n' (ingest
 * canonicalizes bodies to no trailing newline; see the README).
 */
export function parseNote(text) {
  const warnings = []
  let fm = null
  let rest = text
  if (text.startsWith('---\n')) {
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

/**
 * Map one parsed YAML value to the op-value shape core canonicalizes
 * (§3/§5): strings NFC-normalized; Date -> canonical xsd:dateTime string;
 * numbers/booleans/null pass through. OKF frontmatter is plain data, so this
 * stays intentionally simple.
 */
export function yamlToValue(v) {
  if (typeof v === 'string') return nfc(v)
  if (v instanceof Date) return v.toISOString().replace(/\.000Z$/, 'Z')
  return v
}

/** Frontmatter entry -> { values: [...canonical...], scalar }. */
export function yamlToValues(v) {
  const arr = Array.isArray(v) ? v : [v]
  return { values: arr.map(yamlToValue), scalar: !Array.isArray(v) }
}
