// Regression (T10 adversarial review, finding F1 — BLOCKER): a poison op
// must be contained per-op (flag/rejected), never halt every peer's fold
// (okf SPEC §3 "apply MUST NOT throw"; I1 determinism; I10 governance
// partition stability).
//
// Root cause: SetField.value is wire type `json` (arbitrary JSON), and
// canonicalArray -> canonicalValue -> canonicalLexical routes a typed
// literal { value, datatype } through strict canonicalInteger /
// canonicalDecimal / canonicalDateTime, which THROW on a bad lexical.
// opSetField called canonicalArray with no guard and the top-level apply
// loop had no per-node net, so one crafted op threw straight out of apply
// and halted the peer (and every I3 rebuild re-threw forever).
//
// Fix: opSetField rejects a non-canonicalizable value as `bad-value`, and
// the apply loop wraps each node in a last-resort containment net
// (flag/rejected reason `apply-error`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, hostStub, rejectedReasons } from '../helpers.js'

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

    // the poison op is rejected, not silently dropped (I4)
    const reasons = Object.values(rejectedReasons(view))
    assert.ok(reasons.includes('bad-value'), 'poison op flagged bad-value')
    // the vault keeps working: the following legitimate op still applied
    const titleRec = view.dump(`c/${id}/f/title`)
    assert.ok(Object.keys(titleRec).length === 1, 'later legit op still applied')
  })
}

test('poison op containment is convergent across apply order (I1/I2)', async () => {
  // Build the same three ops, apply in a single batch vs. one-node chunks:
  // the view hash must be identical (containment is a pure function of the
  // linearized prefix, not of batching).
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
