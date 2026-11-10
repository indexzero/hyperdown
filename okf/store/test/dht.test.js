// startBootstrapNode starts the DHT bootstrap node of a private swarm
// (okf/store/lib/dht.js). Each test binds 127.0.0.1 only, so no test
// touches the public DHT.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { createRequire } from 'node:module'
import { startBootstrapNode } from '../index.js'

// The hyperdht that hyperswarm requires, which is the one that the store runs.
const storeRequire = createRequire(new URL('../index.js', import.meta.url))
const DHT = createRequire(storeRequire.resolve('hyperswarm'))('hyperdht')

/** A UDP port on 127.0.0.1 that was free a moment ago. dht-rpc's `bootstrapper` refuses port 0. */
async function freePort() {
  const socket = createSocket('udp4')
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, '127.0.0.1', resolve)
  })
  const { port } = socket.address()
  await new Promise((resolve) => socket.close(resolve))
  return port
}

test('startBootstrapNode resolves with a ready node on 127.0.0.1 at the given port, and the node answers a peer that bootstraps from it', { timeout: 30000 }, async (t) => {
  const port = await freePort()
  const node = await startBootstrapNode({ port })
  t.after(() => node.destroy())
  assert.deepEqual(node.address(), { host: '127.0.0.1', family: 4, port }, 'the node binds the default host and the given port')
  assert.equal(node.ephemeral, false, 'a bootstrap node is persistent from the start')
  assert.deepEqual(node.bootstrapNodes, [], 'the node bootstraps from no other node, so it starts a private DHT')

  const peer = new DHT({ bootstrap: [`127.0.0.1:${port}`] })
  t.after(() => peer.destroy())
  await peer.ready()
  const reply = await peer.ping({ host: '127.0.0.1', port })
  assert.equal(reply.from.port, port, 'the node answers on its port')
  assert.deepEqual(reply.from.id, node.id, 'the answer carries the id of the node')
})

test('startBootstrapNode rejects without a port, and with a host that is not an IPv4 address', async () => {
  await assert.rejects(startBootstrapNode(), /Port is required/)
  const port = await freePort()
  for (const host of ['localhost', '::1', '0.0.0.0']) {
    await assert.rejects(startBootstrapNode({ port, host }), /Host must be a IPv4 address|Invalid host/, `refused: ${host}`)
  }
})
