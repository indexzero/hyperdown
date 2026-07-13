// §6: revHash construction is fixed for interoperability (I2 across
// implementations): SHA-256( len(base) || base || len(text) || utf8(NFC(text)) ).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { revHash } from '../packages/core/index.js'

function reference(baseHex, text) {
  const base = Buffer.from(baseHex || '', 'ascii')
  const t = Buffer.from(text.normalize('NFC'), 'utf8')
  const len = (n) => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64BE(BigInt(n))
    return b
  }
  return createHash('sha256')
    .update(Buffer.concat([len(base.length), base, len(t.length), t]))
    .digest('hex')
}

test('§6: root revision (null base) matches the reference construction', () => {
  assert.equal(revHash(null, 'hello'), reference('', 'hello'))
  assert.match(revHash(null, 'hello'), /^[0-9a-f]{64}$/)
})

test('§6: chained revision includes the 64-hex base bytes', () => {
  const r1 = revHash(null, 'v1')
  assert.equal(revHash(r1, 'v2'), reference(r1, 'v2'))
  assert.notEqual(revHash(r1, 'v2'), revHash(null, 'v2'))
})

test('§6: text is NFC-normalized before hashing (§3.1)', () => {
  assert.equal(revHash(null, 'Cafe\u0301'), revHash(null, 'Caf\u00e9'))
})

test('§6: malformed base is refused', () => {
  assert.throws(() => revHash('nothex', 'x'), TypeError)
  assert.throws(() => revHash('ab'.repeat(3), 'x'), TypeError) // wrong length
  assert.equal(revHash('AB'.repeat(32), 'x'), revHash('ab'.repeat(32), 'x')) // hex normalized to lowercase
})
