// Shared scenario setup: spin up N writer processes on a real auto-okf
// vault, admit them all as writers via in-log §8 governance ops from the
// genesis indexer, and mesh them through the fault proxy.
import { Controller, until } from './controller.js'

/**
 * @param {string} runName
 * @param {number} n         number of writers (first is genesis indexer)
 * @param {object} [opts]    { indexers: number (default 1), metadata, seed, profile }
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
    // §8 governance op from the genesis indexer; localKey rides the IPC
    // channel as a { __hex } marker the writer revives to a Buffer.
    await genesis.call('addWriter', writers[i].info.localKey, { indexer: i < indexers })
  }
  // wait until every joined peer is writable (its AddWriter linearized)
  for (let i = 1; i < n; i++) {
    const w = writers[i]
    // generous: under a busy machine (many concurrent processes) the
    // AddWriter op can take a while to linearize; a short budget here
    // produces false "never writable" failures unrelated to the system.
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
