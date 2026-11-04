// S7: a path collision under a partition, then I9 over the conflicted copy.
// See SPEC §7.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setupVaultCluster, flagKeys, assertAllCoherent } from './helpers.js'

/** Content hash of a materialized bundle tree (sorted relpath ‖ bytes). */
async function bundleHash(root) {
  const h = createHash('sha256')
  const walk = async (dir, rel) => {
    const entries = (await readdir(dir)).sort()
    for (const name of entries) {
      const abs = join(dir, name)
      const r = rel ? `${rel}/${name}` : name
      if ((await stat(abs)).isDirectory()) await walk(abs, r)
      else {
        h.update(r + '\0')
        h.update(await readFile(abs))
        h.update('\0')
      }
    }
  }
  await walk(root, '')
  return h.digest('hex')
}

test('S7: two concepts, one path → deterministic conflict copy + byte-identical faces', async () => {
  const { ctl, writers } = await setupVaultCluster('s07-collision', 2)
  const [a, b] = writers
  try {
    const { tag: id1 } = await a.call('createConcept', 'notes/one', 'note')
    const { tag: id2 } = await b.call('createConcept', 'notes/two', 'note')
    await a.append('set-body', { id: id1, base: null, text: 'first' })
    await b.append('set-body', { id: id2, base: null, text: 'second' })
    await ctl.quiesce(writers)

    await ctl.disconnect(a, b)
    await a.call('setPath', id1, 'notes/shared')
    await b.call('setPath', id2, 'notes/shared')
    await ctl.connect(a, b)
    await ctl.quiesce(writers)

    for (const w of writers) {
      const dump = await w.dump('')
      const holder = dump['path/notes%2Fshared']
      assert.ok([id1, id2].includes(holder), `${w.name}: one concept holds the path`)
      const loser = holder === id1 ? id2 : id1
      const pcl = flagKeys(dump, 'pathcollision/notes%2Fshared')
      assert.equal(pcl.length, 1, `${w.name}: one pathcollision flag`)
      assert.ok(pcl[0].endsWith(loser), `${w.name}: the loser is flagged`)
    }
    await assertAllCoherent(writers)

    // The hash covers the name of the conflicted copy too (I9).
    const dirA = join(ctl.baseDir, 'face-w0')
    const dirB = join(ctl.baseDir, 'face-w1')
    await a.cmd('materialize', { dir: dirA })
    await b.cmd('materialize', { dir: dirB })
    assert.equal(await bundleHash(dirA), await bundleHash(dirB), 'faces byte-identical across peers')
  } finally {
    await ctl.stop()
  }
})
