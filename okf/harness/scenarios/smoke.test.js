import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster } from '../lib/setup.js'
import { checkCoherence } from '../lib/coherence.js'

test('two writers converge through the fault proxy, and coherence holds', async () => {
  const { ctl, writers } = await setupVaultCluster('smoke', 2)
  const [a, b] = writers
  try {
    const { tag: id } = await a.call('createConcept', 'notes/home', 'note')
    await a.call('setField', id, 'title', 'Home')
    await a.call('addTag', id, 'seed')
    await a.append('set-body', { id, base: null, text: 'welcome [b](/notes/about)' })
    const { tag: about } = await b.call('createConcept', 'notes/about', 'note')
    await b.call('setField', about, 'title', 'About')

    const hash = await ctl.quiesce(writers)
    assert.equal(typeof hash, 'string')

    for (const w of writers) {
      const dump = await w.dump('')
      assert.deepEqual(checkCoherence(dump), [], `${w.name} coherent`)
      assert.ok(Object.keys(dump).some((k) => k.startsWith(`bl/${about}/`)), 'link resolved to bl/')
    }
  } finally {
    await ctl.stop()
  }
})
