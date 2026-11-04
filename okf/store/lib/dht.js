// The DHT bootstrap node of a private swarm (`auto-okf bootstrap`).
//
// The store declares hyperswarm, not hyperdht, so it loads the hyperdht
// that hyperswarm itself requires. The node and the swarms then run one
// hyperdht.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const DHT = createRequire(require.resolve('hyperswarm'))('hyperdht')

/**
 * Start a DHT bootstrap node with `DHT.bootstrapper(port, host)`. `host`
 * must be an IPv4 address, or dht-rpc's `bootstrapper` throws. The node
 * also binds `host` alone (dht-rpc reads `host` from its configuration),
 * so a node on 127.0.0.1 takes no packet from another machine. Peers pass
 * `bootstrap: ['<host>:<port>']` to Bundle.swarm(). Resolves with the node
 * once it is ready. Stop it with `await node.destroy()`.
 */
export async function startBootstrapNode({ port, host = '127.0.0.1' } = {}) {
  const node = DHT.bootstrapper(port, host, { host })
  await node.ready()
  return node
}
