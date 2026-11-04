// YAML for the faces. See SPEC §6 and §9.
//
// Emission is hand-written. A general YAML dumper owns its quote, wrap and
// number style and can change it across versions. That breaks I9 with no
// sign. Parsing uses the `yaml` package (YAML 1.2 core schema), parse only.
// The emitter is never the `yaml` dumper.
import { parse as parseYaml } from 'yaml'
import { canonical } from '@auto-okf/core'

const { nfc, canonicalInteger, canonicalDouble, stableStringify } = canonical

// ---------- canonical YAML emission (§9) ----------

// Spellings that change the type of a plain scalar on re-parse.
const YAML_RESERVED_WORD = /^(?:null|Null|NULL|~|true|True|TRUE|false|False|FALSE)$/
// Number-shaped strings get quotes, so that they stay strings on re-parse.
const YAML_NUMBERISH = /^[-+]?(?:\.[0-9]|[0-9]|\.inf|\.Inf|\.INF|\.nan|\.NaN|\.NAN)/
// Plain-style charset: ASCII without flow indicators and without comment,
// anchor or tag introducers. Anything else gets double quotes.
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
    // The reference and typed-literal shapes of core's canonicalValue, so
    // that a rich value round-trips.
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
 * The frontmatter block from [key, value] pairs. The caller orders the
 * pairs (SPEC §6) and decides on a length-1 array collapse. Arrays are flow
 * style.
 */
export function emitFrontmatter(pairs) {
  let out = ''
  for (const [k, v] of pairs) {
    out += emitYamlKey(k) + ': ' + emitYamlValue(v) + '\n'
  }
  return out
}

/**
 * One concept note (SPEC §9): `---\n<frontmatter>---\n`, then `\n<body>\n`
 * when the body is not empty. The file newline after the body is always
 * written, also when the body ends in '\n', so parseNote gets the body back
 * exactly.
 */
export function renderNote(pairs, body) {
  let out = ''
  if (pairs.length > 0) {
    out += '---\n' + emitFrontmatter(pairs) + '---\n'
  }
  if (body !== undefined && body !== null && body !== '') {
    out += (out === '' ? '' : '\n') + body + '\n'
  }
  return out
}

/**
 * Parse one concept note into { fm, body, warnings }. `fm` is null when the
 * file has no frontmatter block. The body is the text after the closing
 * '---', without one leading blank line and one trailing newline.
 * parseNote(renderNote(pairs, body)).body === body for every body, also one
 * that ends in '\n'. In a hand-written note, the last newline is the file
 * newline, not body.
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
 * One parsed YAML value as the op value that core canonicalizes (SPEC §3,
 * §5): a string as NFC, a Date as an xsd:dateTime string, the rest as is.
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
