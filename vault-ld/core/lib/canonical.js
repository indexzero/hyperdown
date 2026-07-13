// Canonical string and literal forms (SPEC-FINAL §3.1, §10.2).
//
// Everything here is a pure function: no wall clock, no randomness, no
// locale-dependent formatting (I1). Literal canonicalization follows the XSD
// canonical lexical mappings, never platform toString defaults (§10.2).

/** Unicode NFC normalization (§3.1). Applied before any key/IRI/hash use. */
export function nfc(s) {
  return String(s).normalize('NFC')
}

/** UTF-8 byte length of the NFC form (used by the §8.4 oversize-subject limit). */
export function nfcByteLength(s) {
  return Buffer.byteLength(nfc(s), 'utf8')
}

/**
 * Canonical xsd:double lexical form per the XSD canonical mapping
 * (https://www.w3.org/TR/xmlschema11-2/#double): mantissa in [1,10) with at
 * least one fractional digit, 'E', exponent with no leading zeros.
 */
export function canonicalDouble(n) {
  if (Number.isNaN(n)) return 'NaN'
  if (n === Infinity) return 'INF'
  if (n === -Infinity) return '-INF'
  if (n === 0) return Object.is(n, -0) ? '-0.0E0' : '0.0E0'
  // toExponential() with no argument is exact & deterministic per ECMA-262.
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(n.toExponential())
  const sign = m[1]
  const int = m[2]
  let frac = (m[3] || '0').replace(/0+$/, '')
  if (frac === '') frac = '0'
  const exp = parseInt(m[4], 10)
  return `${sign}${int}.${frac}E${exp}`
}

/**
 * Canonical xsd:integer lexical form: no decimal point, no leading zeros,
 * no '+' sign (§10.2).
 */
export function canonicalInteger(v) {
  const s = typeof v === 'bigint' ? v.toString(10) : String(v)
  const m = /^([+-]?)0*(\d+)$/.exec(s)
  if (!m) throw new TypeError('not an integer lexical: ' + s)
  const sign = m[1] === '-' && m[2] !== '0' ? '-' : ''
  return sign + m[2]
}

/**
 * Canonical xsd:decimal lexical form: '.' required, no leading/trailing
 * zeros except a single guard zero on each side (§10.2).
 */
export function canonicalDecimal(v) {
  const s = String(v)
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s)
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) {
    throw new TypeError('not a decimal lexical: ' + s)
  }
  let int = (m[2] || '').replace(/^0+/, '')
  if (int === '') int = '0'
  let frac = (m[3] || '').replace(/0+$/, '')
  if (frac === '') frac = '0'
  const sign = m[1] === '-' && !(int === '0' && frac === '0') ? '-' : ''
  return `${sign}${int}.${frac}`
}

/**
 * Canonical xsd:dateTime: ISO-8601 with explicit 'Z', milliseconds omitted
 * when zero (§10.2). Date parsing of ISO strings is defined by ECMA-262 and
 * deterministic across platforms.
 */
export function canonicalDateTime(v) {
  const d = v instanceof Date ? v : new Date(String(v))
  if (Number.isNaN(d.getTime())) throw new TypeError('not a dateTime lexical: ' + v)
  return d.toISOString().replace(/\.000Z$/, 'Z')
}

/** Canonical xsd:date: YYYY-MM-DD (§10.2). */
export function canonicalDate(v) {
  return canonicalDateTime(v).slice(0, 10)
}

/** Language tags are lowercased (§10.2). */
export function canonicalLang(tag) {
  return String(tag).toLowerCase()
}

const XSD = 'http://www.w3.org/2001/XMLSchema#'

/** Canonical lexical form for a typed-literal value object (§10.2). */
export function canonicalLexical(value, datatype) {
  switch (datatype) {
    case XSD + 'integer':
    case 'xsd:integer':
      return canonicalInteger(value)
    case XSD + 'decimal':
    case 'xsd:decimal':
      return canonicalDecimal(value)
    case XSD + 'double':
    case 'xsd:double':
    case XSD + 'float':
    case 'xsd:float':
      return canonicalDouble(typeof value === 'number' ? value : Number(value))
    case XSD + 'dateTime':
    case 'xsd:dateTime':
      return canonicalDateTime(value)
    case XSD + 'date':
    case 'xsd:date':
      return canonicalDate(value)
    case XSD + 'boolean':
    case 'xsd:boolean':
      return String(value) === 'true' || value === true ? 'true' : 'false'
    default:
      return nfc(String(value))
  }
}

/** JSON stringify with sorted keys — deterministic (I1). */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
}

/**
 * Normalize an op value into its canonical stored form (§3.1, §10.2):
 * - strings are NFC-normalized
 * - `{ ref }` wiki-link references get an NFC-normalized target
 * - `{ value, datatype?, lang? }` typed literals get canonical lexicals and
 *   lowercased language tags
 * - plain numbers/booleans/null pass through (JSON round-trip of numbers is
 *   deterministic per ECMA-262)
 */
export function canonicalValue(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return nfc(v)
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'object' && !Array.isArray(v)) {
    if (typeof v.ref === 'string') return { ref: nfc(v.ref) }
    if ('value' in v) {
      const out = { value: canonicalLexical(v.value, v.datatype) }
      if (v.datatype) out.datatype = nfc(String(v.datatype))
      if (v.lang) out.lang = canonicalLang(v.lang)
      return out
    }
  }
  return v
}

/**
 * The §10.2 byte form of a value: a total-order sort key (type discriminator
 * + canonical lexical). Register arrays and or-set/unmapped listings are
 * ordered by this form; equality of byte forms is value identity (§3.1).
 */
export function byteForm(v) {
  const c = canonicalValue(v)
  if (c === null) return 'z:'
  if (typeof c === 'boolean') return 'b:' + (c ? 'true' : 'false')
  if (typeof c === 'number') {
    return Number.isInteger(c) ? 'n:' + canonicalInteger(c) : 'n:' + canonicalDouble(c)
  }
  if (typeof c === 'string') return 's:' + c
  if (typeof c === 'object' && typeof c.ref === 'string') return 'r:' + c.ref
  if (typeof c === 'object' && 'value' in c) {
    return 'l:' + (c.datatype || '') + ':' + c.value + (c.lang ? '@' + c.lang : '')
  }
  return 'j:' + stableStringify(c)
}

export function valuesEqual(a, b) {
  return byteForm(a) === byteForm(b)
}

/** Sort values ascending by their §10.2 byte form (UTF-8 byte order). */
export function sortValues(values) {
  return [...values].sort((a, b) => {
    const x = Buffer.from(byteForm(a), 'utf8')
    const y = Buffer.from(byteForm(b), 'utf8')
    return Buffer.compare(x, y)
  })
}

/** Canonical register array (§5.1): sorted by byte form, deduplicated. */
export function canonicalArray(o) {
  const arr = Array.isArray(o) ? o : [o]
  const seen = new Set()
  const out = []
  for (const v of sortValues(arr.map(canonicalValue))) {
    const bf = byteForm(v)
    if (seen.has(bf)) continue
    seen.add(bf)
    out.push(v)
  }
  return out
}

/** Literal nesting depth for the §8.4 depth-exceeded limit. */
export function valueDepth(v, d = 1) {
  if (v === null || typeof v !== 'object') return d
  let max = d
  const children = Array.isArray(v) ? v : Object.values(v)
  for (const c of children) {
    const cd = valueDepth(c, d + 1)
    if (cd > max) max = cd
    if (max > 512) return max // hard stop; limit is 64 anyway
  }
  return max
}
