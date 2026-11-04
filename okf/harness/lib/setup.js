// Shared scenario setup: N writer processes on one vault, every writer
// admitted by the genesis indexer, all meshed through the fault proxy.
import { Controller, until } from './controller.js'

/**
 * @param {string} runName
 * @param {number} n the number of writers. The first is the genesis indexer.
 * @param {object} [opts] { indexers: number (default 1), metadata, seed, profile }
 * @returns {Promise<{ ctl, writers }>}
 */
export async function setupVaultCluster(runName, n, opts = {}) {
  const ctl = await new Controller({ runName, seed: opts.seed, profile: opts.profile }).start()
  const writers = []
  const genesis = await ctl.spawn('w0')
  await genesis.init(opts.metadata)
  writers.push(genesis)
  for (let i = 1; i < n; i++) {
    const w = await ctl.spawn(`w${i}`)
    await w.join(genesis.info.keyHex)
    writers.push(w)
  }
  await ctl.connectAll(writers)
  const indexers = opts.indexers ?? 1
  for (let i = 1; i < n; i++) {
    // localKey is a { __hex } marker here. The writer revives it to a Buffer.
    await genesis.call('addWriter', writers[i].info.localKey, { indexer: i < indexers })
  }
  for (let i = 1; i < n; i++) {
    const w = writers[i]
    // A busy machine linearizes the AddWriter slowly. A short budget here
    // fails with "never writable" for reasons outside the system.
    const ok = await until(async () => {
      await w.update()
      const inf = await w.cmd('info')
      return inf.writable
    }, 120000)
    if (!ok) {
      await ctl.stop()
      throw new Error(`writer ${w.name} never became writable (seed=${ctl.seed})`)
    }
  }
  return { ctl, writers }
}
