// Op wire contract (okf SPEC §3): 12 ops, hyperschema + hyperdispatch,
// append-only command ids, decode-never-throws, clock+at on every op.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeOp, decodeOp, OP_TYPES, makeTag, parseTag, normalizeClock } from '../core/index.js'
import { writerKey } from './helpers.js'

const SPEC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'spec')

const W = writerKey('codec').toString('hex')
const CLOCK = [[W, 3]]
const AT = 1700000000123

const SAMPLES = {
  'create-concept': [
    { id: null, path: 'a/b', type: 'note', clock: CLOCK, at: AT },
    { id: 'abcd1234', path: 'a/adopted', type: 'note', clock: CLOCK, at: AT }
  ],
  'set-field': [{ id: 'abcd', key: 'status', value: ['open', 1, true], clock: CLOCK, at: AT }],
  'add-tag': [{ id: 'abcd', value: 'draft', clock: CLOCK, at: AT }],
  'rem-tag': [{ id: 'abcd', value: 'draft', tags: [makeTag(W, 0), makeTag(W, 7)], clock: CLOCK, at: AT }],
  'set-body': [
    { id: 'abcd', base: null, text: 'body text', clock: CLOCK, at: AT },
    { id: 'abcd', base: 'ef'.repeat(32), text: 'child', clock: CLOCK, at: AT }
  ],
  'set-path': [{ id: 'abcd', path: 'new/place', clock: CLOCK, at: AT }],
  'delete-concept': [{ id: 'abcd', clock: CLOCK, at: AT }],
  'undelete-concept': [{ id: 'abcd', clock: CLOCK, at: AT }],
  'resolve-conflict': [
    { id: 'abcd', keep: 'ab'.repeat(32), supersede: ['cd'.repeat(32)], text: null, clock: CLOCK, at: AT },
    { id: 'abcd', keep: 'ab'.repeat(32), supersede: [], text: 'merged', clock: CLOCK, at: AT }
  ],
  'add-writer': [{ key: writerKey('w'), indexer: true, clock: CLOCK, at: AT }],
  'remove-writer': [{ key: writerKey('w'), clock: CLOCK, at: AT }],
  'set-writer-policy': [
    { key: writerKey('w'), namespacePrefixes: ['team', 'docs'], rateCeiling: 64, clock: CLOCK, at: AT }
  ]
}

test('§3: every one of the 12 ops round-trips through the committed codec', () => {
  assert.equal(OP_TYPES.length, 12)
  for (const type of OP_TYPES) {
    assert.ok(SAMPLES[type], `sample for ${type}`)
    for (const payload of SAMPLES[type]) {
      const buf = encodeOp(type, payload)
      const dec = decodeOp(buf)
      assert.equal(dec.ok, true)
      assert.equal(dec.type, type)
      for (const [k, v] of Object.entries(payload)) {
        if (Buffer.isBuffer(v)) assert.deepEqual(Buffer.from(dec.op[k]), v)
        else assert.deepEqual(dec.op[k], v, `${type}.${k}`)
      }
    }
  }
})

test('§3: command ids are pinned append-only, 0..11 in SPEC order', async () => {
  const dispatch = JSON.parse(await readFile(join(SPEC_DIR, 'hyperdispatch', 'dispatch.json'), 'utf8'))
  const byId = dispatch.schema.map((c) => [c.id, c.name])
  assert.deepEqual(
    byId,
    OP_TYPES.map((t, i) => [i, '@okf/' + t])
  )
})

test('§3: decode never throws — garbage, truncation, unknown ids all map to reasons', () => {
  const cases = [
    Buffer.alloc(0),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from('plain text, definitely not an op'),
    encodeOp('set-body', SAMPLES['set-body'][0]).subarray(0, 3) // truncated
  ]
  for (const buf of cases) {
    const dec = decodeOp(buf)
    assert.equal(dec.ok, false)
    assert.ok(dec.reason === 'undecodable' || dec.reason === 'unknown-msgid', dec.reason)
  }
})

test('§3/§6: tags are writerKey‖minimal-hex-seq and round-trip', () => {
  assert.equal(makeTag(W, 0), W + '0')
  assert.equal(makeTag(W, 255), W + 'ff')
  assert.deepEqual(parseTag(makeTag(W, 255)), { writer: W, seq: 255 })
  assert.throws(() => parseTag('zz'))
})

test('§3: clock normalization accepts pair-arrays, rejects malformed clocks', () => {
  assert.deepEqual(normalizeClock([[W, 3], ['ab', 1]]), { [W]: 3, ab: 1 })
  assert.equal(normalizeClock(null), null)
  assert.equal(normalizeClock('nope'), null)
  assert.equal(normalizeClock([['not hex!', 1]]), null)
  assert.equal(normalizeClock([[W, -1]]), null)
})
