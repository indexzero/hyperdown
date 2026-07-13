// I1: apply is a pure function of the linearized op sequence (§12).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { run, n, addWriters, defineSetTerm, defineLwwTerm, GEN, W1, makeTag } from './helpers.js'

function script() {
  return [
    ...addWriters([W1, false]),
    defineLwwTerm('title'),
    defineSetTerm('topics'),
    n(GEN, 'set-field', { s: 'Note', p: 'title', o: 'Hello', tag: makeTag(GEN, 3) }),
    n(W1, 'add-member', { s: 'Note', p: 'topics', o: { ref: 'Other' }, tag: makeTag(W1, 1) }),
    n(W1, 'set-body', { s: 'Note', base: null, text: 'body text' }),
    n(GEN, 'set-path', { s: 'Note', path: 'Notes/Note.md' }),
    n(W1, 'set-field', { s: 'Note', p: 'title', o: 'World', tag: makeTag(W1, 2) })
  ]
}

test('I1: identical logs produce bit-identical views', async () => {
  const a = await run(script())
  const b = await run(script())
  assert.equal(a.view.hash(), b.view.hash())
})

test('I1: core sources contain no wall clock, randomness, or peer-local reads', async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'core', 'lib')
  for (const file of await readdir(dir)) {
    const src = await readFile(path.join(dir, file), 'utf8')
    // strip comments before scanning (the ban is on executable code)
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    // note: `new Date(isoString)` (deterministic parsing) is allowed;
    // reading the wall clock is not.
    for (const banned of ['Date.now', 'new Date()', 'Math.random', 'signedLength', '.heads(']) {
      assert.ok(!code.includes(banned), `${file} must not use ${banned}`)
    }
  }
})
