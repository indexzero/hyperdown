// Each test runs one merge rule across real peers: the peers partition,
// write concurrently, heal, and must hold the same view.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setupVaultCluster, flagKeys, assertAllCoherent, replayHash } from './helpers.js'

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

// I6 and I4 under a partition, with a permutation replay. See SPEC §5.
test('concurrent SetFields of one key converge to one linearization winner and one flag/clobber', async () => {
  const { ctl, writers } = await setupVaultCluster('s01-lww', 2)
  const [a, b] = writers
  try {
    const { tag: id } = await a.call('createConcept', 'notes/doc', 'note')
    await ctl.quiesce(writers) // both peers observe the concept

    await ctl.disconnect(a, b)
    await a.call('setField', id, 'title', 'from-a')
    await b.call('setField', id, 'title', 'from-b')
    await ctl.connect(a, b)
    const hash = await ctl.quiesce(writers)

    for (const w of writers) {
      const dump = await w.dump('')
      const reg = dump[`c/${id}/f/title`]
      assert.equal(reg.values.length, 1, `${w.name}: one materialized winner`)
      assert.ok(['from-a', 'from-b'].includes(reg.values[0]))
      assert.equal(flagKeys(dump, `clobber/${id}/title`).length, 1, `${w.name}: one clobber`)
    }
    await assertAllCoherent(writers)

    assert.equal(await replayHash(ctl, writers, 's01'), hash, 'winner is pure linearization')
  } finally {
    await ctl.stop()
  }
})

// I5 under a partition, and a staletag flag for a fabricated token.
// See SPEC §5 for the OR-set rule.
test('a concurrent add wins over a remove that did not observe it, and the tag is present on every peer', async () => {
  const { ctl, writers } = await setupVaultCluster('s02-orset', 2)
  const [a, b] = writers
  try {
    const { tag: id } = await a.call('createConcept', 'notes/tagged', 'note')
    await a.call('addTag', id, 'k') // token t0, observed by both
    await ctl.quiesce(writers)

    await ctl.disconnect(a, b)
    await a.call('remTag', id, 'k') // A cites the observed token t0
    await b.call('addTag', id, 'k') // B mints a new token that A did not see
    // a token that no writer minted
    const bogus = a.info.localKey + 'ff'
    await a.append('rem-tag', { id, value: 'k', tags: [bogus] })
    await ctl.connect(a, b)
    await ctl.quiesce(writers)

    for (const w of writers) {
      const dump = await w.dump('')
      const rec = dump[`c/${id}/f/tags`]
      const values = Object.values(rec.els)
      assert.ok(values.includes('k'), `${w.name}: SU-set keeps the concurrently re-added tag`)
      assert.equal(flagKeys(dump, `staletag/${id}`).length, 1, `${w.name}: one staletag audit`)
    }
    await assertAllCoherent(writers)
  } finally {
    await ctl.stop()
  }
})

// wanted/ demand under a partition (I7, I8). See SPEC §4.
test('a link and a late create clear wanted/ deterministically, in both heal orders', async () => {
  const { ctl, writers } = await setupVaultCluster('s03-wanted', 2)
  const [a, b] = writers
  try {
    const { tag: src } = await a.call('createConcept', 'notes/src', 'note')
    await ctl.quiesce(writers)

    await ctl.disconnect(a, b)
    await a.append('set-body', { id: src, base: null, text: 'need [x](/notes/target)' })
    const { tag: target } = await b.call('createConcept', 'notes/target', 'note')
    await ctl.connect(a, b)
    const hash = await ctl.quiesce(writers)

    for (const w of writers) {
      const dump = await w.dump('')
      const wantedForTarget = Object.keys(dump).filter((k) => k.startsWith('wanted/notes%2Ftarget/'))
      assert.equal(wantedForTarget.length, 0, `${w.name}: no residual demand for the created path`)
      assert.ok(dump[`bl/${target}/${src}`], `${w.name}: edge promoted to a backlink`)
    }
    await assertAllCoherent(writers)

    assert.equal(await replayHash(ctl, writers, 's03'), hash, 'demand resolution is order-independent')
  } finally {
    await ctl.stop()
  }
})

// A body conflict under a partition (I4, I7). See SPEC §5.
test('two revisions on the same base both survive under one conflict flag, and a resolve drains it', async () => {
  const { ctl, writers } = await setupVaultCluster('s04-body', 2)
  const [a, b] = writers
  try {
    const { tag: id } = await a.call('createConcept', 'notes/doc', 'note')
    await a.append('set-body', { id, base: null, text: 'root' })
    await ctl.quiesce(writers)
    const base = (await a.dump(`c/${id}/`))[`c/${id}/body`] // the shared head

    await ctl.disconnect(a, b)
    await a.append('set-body', { id, base, text: 'edit A' })
    await b.append('set-body', { id, base, text: 'edit B' })
    await ctl.connect(a, b)
    await ctl.quiesce(writers)

    let head = null
    for (const w of writers) {
      const dump = await w.dump('')
      assert.equal(Object.keys(dump).filter((k) => k.startsWith(`c/${id}/rev/`)).length, 3, `${w.name}: both siblings + root retained`)
      assert.equal(flagKeys(dump, `conflict/${id}`).length, 1, `${w.name}: exactly one conflict`)
      const h = dump[`c/${id}/body`]
      if (head === null) head = h
      else assert.equal(h, head, 'head is deterministic across peers')
    }
    await assertAllCoherent(writers)

    const dump = await a.dump('')
    const revs = Object.keys(dump).filter((k) => k.startsWith(`c/${id}/rev/`)).map((k) => k.split('/').pop())
    const root = revs.find((r) => dump[`c/${id}/rev/${r}`].base === null)
    const sibling = revs.find((r) => r !== head && r !== root)
    await a.call('resolveConflict', id, head, { supersede: [sibling] })
    await ctl.quiesce(writers)
    for (const w of writers) {
      const d = await w.dump('')
      assert.equal(flagKeys(d, `conflict/${id}`).length, 0, `${w.name}: conflict drained`)
      assert.equal(d[`c/${id}/body`], head, `${w.name}: kept head`)
    }
    await assertAllCoherent(writers)
  } finally {
    await ctl.stop()
  }
})

// A rename and a concurrent edit under a partition. The path is an LWW
// register on a stable `_id`, so the two merge. See SPEC §7.
test('a rename and a concurrent edit merge: the edit follows the concept, and no ghost stays at the old path', async () => {
  const { ctl, writers } = await setupVaultCluster('s05-rename-edit', 2)
  const [a, b] = writers
  try {
    const { tag: id } = await a.call('createConcept', 'notes/old', 'note')
    await ctl.quiesce(writers)

    await ctl.disconnect(a, b)
    await a.call('setPath', id, 'notes/new')
    await b.call('setField', id, 'title', 'edited')
    await ctl.connect(a, b)
    await ctl.quiesce(writers)

    for (const w of writers) {
      const dump = await w.dump('')
      assert.equal(dump['path/notes%2Fnew'], id, `${w.name}: concept at the new path`)
      assert.equal(dump['path/notes%2Fold'], undefined, `${w.name}: old path vacated (no ghost)`)
      assert.deepEqual(dump[`c/${id}/f/title`].values, ['edited'], `${w.name}: edit not lost`)
      assert.equal(dump[`c/${id}/path`].path, 'notes/new')
    }
    await assertAllCoherent(writers)
  } finally {
    await ctl.stop()
  }
})

// Two renames of one concept under a partition (I6, I4). See SPEC §7.
test('concurrent renames of one concept: the linearization winner holds the path, and the loser gets one flag/clobber', async () => {
  const { ctl, writers } = await setupVaultCluster('s06-rename-rename', 2)
  const [a, b] = writers
  try {
    const { tag: id } = await a.call('createConcept', 'notes/base', 'note')
    await ctl.quiesce(writers)

    await ctl.disconnect(a, b)
    await a.call('setPath', id, 'notes/a')
    await b.call('setPath', id, 'notes/b')
    await ctl.connect(a, b)
    const hash = await ctl.quiesce(writers)

    for (const w of writers) {
      const dump = await w.dump('')
      const winner = dump[`c/${id}/path`].path
      assert.ok(['notes/a', 'notes/b'].includes(winner), `${w.name}: one path wins`)
      assert.equal(dump[`path/${winner === 'notes/a' ? 'notes%2Fa' : 'notes%2Fb'}`], id)
      assert.equal(flagKeys(dump, `clobber/${id}/path`).length, 1, `${w.name}: one path clobber`)
    }
    await assertAllCoherent(writers)

    assert.equal(await replayHash(ctl, writers, 's06'), hash, 'rename winner is pure linearization')
  } finally {
    await ctl.stop()
  }
})

// A path collision under a partition, then I9 over the conflicted copy.
// See SPEC §7.
test('two concepts on one path give a deterministic conflicted copy and byte-identical bundles on every peer', async () => {
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
