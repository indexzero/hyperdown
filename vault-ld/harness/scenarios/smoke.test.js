// Harness smoke test: two real writer processes converge through the
// fault proxy at the active profile. Not part of the S1..S10 matrix; run
// it first when debugging the harness itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster } from '../lib/setup.js'

test('smoke: two-process convergence through the fault proxy', async (t) => {
  const { ctl, writers } = await setupVaultCluster('smoke', 2)
  t.after(() => ctl.stop())
  const [a, b] = writers

  await a.call('defineTerm', 'core', 'title', { '@id': 'ex:title' })
  await a.call('setField', 'Home', 'title', 'Welcome')
  await b.call('setField', 'Home', 'title', 'From b')

  const hash = await ctl.quiesce(writers)
  assert.ok(hash, 'converged')

  // quiescence self-check (assignment §3): force more update rounds, the
  // hash must not move
  await a.update()
  await b.update()
  assert.equal(await a.hash(), hash)
  assert.equal(await b.hash(), hash)
})
