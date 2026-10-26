// Store scope (okf SPEC §13): the two formats that state that this release
// is v2.
// - Hyperswarm replication on the auto-okf/2 topic. vault.swarm()
//   announces the vault on sha256('auto-okf/2' ‖ db.discoveryKey), never
//   on the bare discovery key, and feeds every connection into
//   db.replicate. A peer that announces on another topic never finds a
//   vault of this release. Runs over a local hyperdht testnet (no public
//   DHT). hyperdht is a transitive dep of hyperswarm, resolved through the
//   store package's module graph. Every wait has a deadline.
// - Vault metadata version 2. A vault of this release records it, and
//   loadMetadata refuses every other version.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Bundle, K, METADATA_FILE, loadMetadata, tmpDir, until } from './store-helpers.js'

const storeRequire = createRequire(new URL('../store/index.js', import.meta.url))
const Hyperswarm = storeRequire('hyperswarm')
const createTestnet = createRequire(storeRequire.resolve('hyperswarm'))('hyperdht/testnet')

// The bound on each wait for a result that must come (ms).
const DEADLINE = 30000
// How long a stand-in peer must stay without a connection (ms).
const QUIET = 3000
// The bound on each whole test (ms).
const TEST_TIMEOUT = 120000

// Computed here, apart from bundle.js, so that the test pins the topic bytes.
function namespacedTopic(discoveryKey) {
  return createHash('sha256').update('auto-okf/2').update(discoveryKey).digest()
}

async function withDeadline(promise, ms, what) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no result in ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Polls until `vault` folds the title field of concept `id`. */
function folds(vault, id, ms = DEADLINE) {
  return until(async () => {
    await vault.update()
    return (await vault.val(K.cField(id, 'title'))) !== undefined
  }, ms)
}

test('two vaults replicate over hyperswarm on the auto-okf/2 topic', { timeout: TEST_TIMEOUT }, async (t) => {
  const tn = await withDeadline(createTestnet(3), DEADLINE, 'testnet')
  const swarmA = new Hyperswarm({ bootstrap: tn.bootstrap })
  const swarmB = new Hyperswarm({ bootstrap: tn.bootstrap })
  const a = await Bundle.init(await tmpDir('swarm-a'), { swarm: swarmA })
  const b = await Bundle.join(await tmpDir('swarm-b'), a.key, { swarm: swarmB })
  t.after(async () => {
    await a.close()
    await b.close()
    await swarmA.destroy()
    await swarmB.destroy()
    await tn.destroy()
  })

  await withDeadline(a.swarm(), DEADLINE, 'a.swarm()')
  await withDeadline(b.swarm(), DEADLINE, 'b.swarm()')

  // Each swarm joins one topic only, the namespaced one, so the two peers
  // can find each other on that topic only.
  const topic = namespacedTopic(a.discoveryKey)
  for (const [name, swarm] of [
    ['a', swarmA],
    ['b', swarmB]
  ]) {
    const topics = [...swarm.topics()].map((d) => d.topic.toString('hex'))
    assert.deepEqual(topics, [topic.toString('hex')], `${name} joins only the auto-okf/2 topic`)
    assert.equal(swarm.status(a.discoveryKey), null, `${name} does not join the bare discovery key`)
  }

  const { tag: id } = await a.createConcept('swarm/hello', 'note')
  await a.setField(id, 'title', ['over the swarm'])
  assert.ok(await folds(b, id), 'b folds ops that arrived via swarm connections')
  assert.deepEqual((await b.val(K.cField(id, 'title'))).values, ['over the swarm'])
})

test('leaveSwarm() leaves the auto-okf/2 topic', { timeout: TEST_TIMEOUT }, async (t) => {
  const tn = await withDeadline(createTestnet(3), DEADLINE, 'testnet')
  const swarmA = new Hyperswarm({ bootstrap: tn.bootstrap })
  const a = await Bundle.init(await tmpDir('swarm-leave'), { swarm: swarmA })
  t.after(async () => {
    await a.close()
    await swarmA.destroy()
    await tn.destroy()
  })

  const topic = namespacedTopic(a.discoveryKey)
  await withDeadline(a.swarm(), DEADLINE, 'a.swarm()')
  assert.ok(swarmA.status(topic), 'swarm() joins the auto-okf/2 topic')

  await withDeadline(a.leaveSwarm(), DEADLINE, 'a.leaveSwarm()')
  assert.equal(swarmA.status(topic), null, 'leaveSwarm() leaves the auto-okf/2 topic')
  assert.deepEqual([...swarmA.topics()], [], 'no topic stays joined')
})

test('a stand-in peer on the bare discovery key never replicates with a namespaced peer', { timeout: TEST_TIMEOUT }, async (t) => {
  const tn = await withDeadline(createTestnet(3), DEADLINE, 'testnet')
  const swarmA = new Hyperswarm({ bootstrap: tn.bootstrap })
  const swarmB = new Hyperswarm({ bootstrap: tn.bootstrap })
  const swarmC = new Hyperswarm({ bootstrap: tn.bootstrap })
  const a = await Bundle.init(await tmpDir('swarm-ns-a'), { swarm: swarmA })
  const b = await Bundle.join(await tmpDir('swarm-ns-b'), a.key, { swarm: swarmB })
  const c = await Bundle.join(await tmpDir('swarm-bare-c'), a.key)
  t.after(async () => {
    await a.close()
    await b.close()
    await c.close()
    await swarmA.destroy()
    await swarmB.destroy()
    await swarmC.destroy()
    await tn.destroy()
  })

  // c stands in for a peer of another release. It is a vault of this
  // release, but it never calls swarm(): a raw Hyperswarm announces it on
  // the bare db.discoveryKey and feeds each connection to c, with the same
  // wiring as swarm().
  swarmC.on('connection', (conn) => {
    conn.on('error', () => {})
    c.replicate(conn)
  })
  const bare = swarmC.join(c.discoveryKey, { server: true, client: true })
  await withDeadline(bare.flushed(), DEADLINE, 'stand-in join')

  await withDeadline(a.swarm(), DEADLINE, 'a.swarm()')
  await withDeadline(b.swarm(), DEADLINE, 'b.swarm()')

  const { tag: id } = await a.createConcept('swarm/stand-in', 'note')
  await a.setField(id, 'title', ['namespaced peers only'])

  // Control: the two namespaced peers find each other, so the DHT works and
  // both of them announce.
  assert.ok(await folds(b, id), 'b, a namespaced peer, folds the op')

  // The stand-in queries the DHT again, after both namespaced peers
  // announced. It must get no connection and no op.
  await withDeadline(swarmC.flush(), DEADLINE, 'stand-in flush')
  const leaked = await until(async () => {
    if (swarmC.connections.size > 0) return true
    await c.update()
    return (await c.val(K.cField(id, 'title'))) !== undefined
  }, QUIET)
  assert.equal(leaked, false, 'the stand-in on the bare key connects to no namespaced peer')
  assert.equal(swarmC.connections.size, 0, 'the stand-in has no connection')
  assert.equal(await c.val(K.cField(id, 'title')), undefined, 'the stand-in folds no op')

  // Control: the same stand-in, with the same wiring, replicates as soon
  // as it joins the namespaced topic. Only the topic kept it out.
  const namespaced = swarmC.join(namespacedTopic(c.discoveryKey), { server: true, client: true })
  await withDeadline(namespaced.flushed(), DEADLINE, 'stand-in namespaced join')
  assert.ok(await folds(c, id), 'the stand-in folds the op once it joins the auto-okf/2 topic')
})

test('a vault of this release records metadata version 2, and loadMetadata refuses every other version', { timeout: TEST_TIMEOUT }, async () => {
  const dir = await tmpDir('meta-v2')
  const a = await Bundle.init(dir)
  assert.equal(a.metadata.version, 2, 'the open vault records version 2')
  await a.close()

  const path = join(dir, METADATA_FILE)
  const meta = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(meta.version, 2, `${METADATA_FILE} records version 2`)
  assert.deepEqual(await loadMetadata(path), meta, 'loadMetadata accepts version 2')

  // undefined: JSON.stringify drops the key, so the file has no version.
  for (const version of [0, 3, '2', null, undefined]) {
    await writeFile(path, JSON.stringify({ ...meta, version }))
    await assert.rejects(
      loadMetadata(path),
      /unsupported vault metadata version/,
      `loadMetadata refuses version ${JSON.stringify(version)}`
    )
  }
  await assert.rejects(
    Bundle.open(dir),
    /unsupported vault metadata version/,
    'a vault without version 2 does not open'
  )
})
