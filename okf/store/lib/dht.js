// The DHT bootstrap node of a private swarm (T25, `auto-okf bootstrap`).
//
// hyperdht is the DHT under hyperswarm. The store declares hyperswarm, not
// hyperdht, so it loads hyperdht through hyperswarm's own dependencies:
// the module that hyperswarm itself requires (hyperswarm index.js:3,
// package.json dependencies), so the node and the swarms run one hyperdht.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const DHT = createRequire(require.resolve('hyperswarm'))('hyperdht')

/**
 * Start a DHT bootstrap node (hyperdht `DHT.bootstrapper(port, host)`,
 * README.md:101-103). `host` must be an IPv4 address (index.js:104-109).
 * The node also binds `host` alone (dht-rpc README.md:143, the `host`
 * option), so a node on 127.0.0.1 takes no packet from another machine.
 * Peers pass `bootstrap: ['<host>:<port>']` to Bundle.swarm(). Resolves
 * with the node once it is ready; stop it with `await node.destroy()`.
 */
export async function startBootstrapNode({ port, host = '127.0.0.1' } = {}) {
  const node = DHT.bootstrapper(port, host, { host })
  await node.ready()
  return node
}
