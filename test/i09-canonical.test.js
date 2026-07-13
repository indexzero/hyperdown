// I9 (unit level): canonical string and literal forms (§3.1, §10.2) —
// converged peers emit identical bytes because stored forms are canonical.
import test from 'node:test'
import assert from 'node:assert/strict'
import { canonical, keyspace as K } from '../packages/core/index.js'
import { run, n, GEN, makeTag, defineLwwTerm } from './helpers.js'

const {
  nfc,
  canonicalInteger,
  canonicalDecimal,
  canonicalDouble,
  canonicalDateTime,
  canonicalDate,
  canonicalLang,
  canonicalValue,
  byteForm
} = canonical

test('§10.2: xsd:integer — no decimal point, no leading zeros, no plus sign', () => {
  assert.equal(canonicalInteger('0042'), '42')
  assert.equal(canonicalInteger('+7'), '7')
  assert.equal(canonicalInteger('-007'), '-7')
  assert.equal(canonicalInteger('-0'), '0')
  assert.equal(canonicalInteger(1234), '1234')
})

test('§10.2: xsd:decimal canonical mapping', () => {
  assert.equal(canonicalDecimal('01.10'), '1.1')
  assert.equal(canonicalDecimal('.5'), '0.5')
  assert.equal(canonicalDecimal('5.'), '5.0')
  assert.equal(canonicalDecimal('-0.0'), '0.0')
  assert.equal(canonicalDecimal('42'), '42.0')
})

test('§10.2: xsd:double canonical mapping, never platform toString', () => {
  assert.equal(canonicalDouble(100), '1.0E2')
  assert.equal(canonicalDouble(0.5), '5.0E-1')
  assert.equal(canonicalDouble(-1.5e10), '-1.5E10')
  assert.equal(canonicalDouble(0), '0.0E0')
  assert.equal(canonicalDouble(Infinity), 'INF')
  assert.equal(canonicalDouble(NaN), 'NaN')
})

test('§10.2: xsd:dateTime/date canonical ISO-8601 with explicit Z', () => {
  assert.equal(canonicalDateTime('2026-07-03T12:30:00+02:00'), '2026-07-03T10:30:00Z')
  assert.equal(canonicalDateTime('2026-01-01T00:00:00.500Z'), '2026-01-01T00:00:00.500Z')
  assert.equal(canonicalDate('2026-07-03T10:30:00Z'), '2026-07-03')
})

test('§10.2: language tags lowercased; typed literals canonicalized', () => {
  assert.equal(canonicalLang('EN-US'), 'en-us')
  const v = canonicalValue({ value: '0042', datatype: 'xsd:integer' })
  assert.equal(v.value, '42')
  const l = canonicalValue({ value: 'Hallo', lang: 'DE' })
  assert.equal(l.lang, 'de')
})

test('§3.1: NFC and NFD spellings are the same subject', async () => {
  const nfdName = 'Cafe\u0301' // Cafe + combining acute (NFD)
  const nfcName = 'Caf\u00e9' // Cafe with precomposed e-acute (NFC)
  assert.notEqual(nfdName, nfcName)
  assert.equal(nfc(nfdName), nfcName)

  const { view } = await run([
    defineLwwTerm('title'),
    n(GEN, 'set-field', { s: nfdName, p: 'title', o: 'x', tag: makeTag(GEN, 1) }),
    n(GEN, 'set-field', { s: nfcName, p: 'title', o: 'y', tag: makeTag(GEN, 2) })
  ])
  // one subject, not two: the NFD write and NFC write hit the same key (I1/I2)
  const rec = (await view.get(K.nField(nfcName, 'title'))).value
  assert.deepEqual(rec.reg.values, ['y'])
  const fieldKeys = Object.keys(view.dump('n/')).filter((k) => k.includes('/f/'))
  assert.equal(fieldKeys.length, 1)
})

test('§10.2: byte forms give a total, type-discriminated order', () => {
  const forms = [true, 42, 'x', { ref: 'T' }, { value: '1.0', datatype: 'xsd:decimal' }, null].map(byteForm)
  assert.equal(new Set(forms).size, forms.length)
  assert.equal(byteForm('café'), byteForm('café')) // NFC equivalence
})
