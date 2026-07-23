// Store scope item 1: hyperswarm replication — vault.joinSwarm() joins
// db.discoveryKey and feeds every connection into db.replicate. Runs over a
// local hyperdht testnet (no public DHT). hyperdht is a transitive dep of
// hyperswarm, so it is resolved through the store package's module graph.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Vault, K, tmpDir, until } from './store-helpers.js'

const storeRequire = createRequire(new URL('../vault-ld/store/index.js', import.meta.url))
const Hyperswarm = storeRequire('hyperswarm')
const createTestnet = createRequire(storeRequire.resolve('hyperswarm'))('hyperdht/testnet')

test('two vaults replicate over hyperswarm (discoveryKey join)', async (t) => {
  const tn = await createTestnet(3)
  const swarmA = new Hyperswarm({ bootstrap: tn.bootstrap })
  const swarmB = new Hyperswarm({ bootstrap: tn.bootstrap })
  const a = await Vault.init(await tmpDir('swarm-a'), { swarm: swarmA })
  const b = await Vault.join(await tmpDir('swarm-b'), a.key, { swarm: swarmB })
  t.after(async () => {
    await a.close()
    await b.close()
    await swarmA.destroy()
    await swarmB.destroy()
    await tn.destroy()
  })

  await a.joinSwarm()
  await b.joinSwarm()

  await a.defineTerm('core', 'title', { '@id': 'ex:title' })
  await a.setField('Home', 'title', 'over the swarm')
  assert.ok(
    await until(async () => {
      await b.update()
      return (await b.val(K.nField('Home', 'title'))) !== undefined
    }, 30000),
    'b folds ops that arrived via swarm connections'
  )
  assert.deepEqual((await b.val(K.nField('Home', 'title'))).reg.values, ['over the swarm'])
})
