// A poison op must be contained per op under flag/rejected, and never halt
// the fold of every peer (SPEC §3: apply must not throw). A typed literal
// { value, datatype } in a SetField routes through canonicalInteger,
// canonicalDecimal and canonicalDateTime, which throw on a bad lexical.
// opSetField rejects it as `bad-value`, and the apply loop records any
// other throw as `apply-error`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, hostStub, rejectedReasons } from './helpers.js'

const BAD_LEXICALS = [
  { value: 'abc', datatype: 'xsd:integer' },
  { value: 'xyz', datatype: 'xsd:decimal' },
  { value: 'not-a-date', datatype: 'xsd:dateTime' },
  { value: 'nope', datatype: 'xsd:date' }
]

for (const lit of BAD_LEXICALS) {
  test(`poison SetField (${lit.datatype}) is contained, apply does not throw`, async () => {
    const env = new Env({ genesis: 'A' })
    env.op('A', 'create-concept', { path: 'notes/x', type: 'note' })
    const id = env.tag('A', 0)
    env.op('A', 'set-field', { id, key: 'count', value: lit })
    env.op('A', 'set-field', { id, key: 'title', value: 'still alive' })

    let view
    await assert.doesNotReject(async () => {
      view = await env.run(env.nodes, { host: hostStub() })
    }, 'apply must not throw on a poison SetField (§3)')

    const reasons = Object.values(rejectedReasons(view))
    assert.ok(reasons.includes('bad-value'), 'poison op flagged bad-value')
    const titleRec = view.dump(`c/${id}/f/title`)
    assert.ok(Object.keys(titleRec).length === 1, 'later legit op still applied')
  })
}

test('poison op containment is convergent across apply order (I1/I2)', async () => {
  // Containment must not depend on batching.
  function build() {
    const env = new Env({ genesis: 'A' })
    env.op('A', 'create-concept', { path: 'notes/x', type: 'note' })
    const id = env.tag('A', 0)
    env.op('A', 'set-field', { id, key: 'count', value: { value: 'abc', datatype: 'xsd:integer' } })
    env.op('A', 'add-tag', { id, value: 'live' })
    return env
  }
  const whole = await build().run(build().nodes, { host: hostStub() })
  const env2 = build()
  const chunked = await env2.run(env2.nodes, { host: hostStub(), chunk: 1 })
  assert.equal(whole.hash(), chunked.hash(), 'batched and per-node apply converge')
})
