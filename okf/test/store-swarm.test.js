// Store scope (okf SPEC §13): the formats that state that this release is
// v2, and the private swarm (T25).
// - Hyperswarm replication on the auto-okf/2 topic. vault.swarm()
//   announces the vault on sha256('auto-okf/2' ‖ db.discoveryKey), never
//   on the bare discovery key, and feeds every admitted connection into
//   db.replicate. A peer that announces on another topic never finds a
//   vault of this release.
// - The private swarm (T25). Every vault has a persistent swarm key, and
//   its swarm firewall admits only the keys of metadata.swarm.allow and the
//   swarm keys of live gov/writer records. The vault key is no capability
//   to connect. swarm() joinPeers each listed key. A removed writer and a
//   revoked peer lose their connections.
// - Every swarm test runs on a local hyperdht testnet, which the vaults
//   reach with `bootstrap` (no public DHT). hyperdht is a transitive dep of
//   hyperswarm, resolved through the store package's module graph. Every
//   wait has a deadline.
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
const Corestore = storeRequire('corestore')
const createTestnet = createRequire(storeRequire.resolve('hyperswarm'))('hyperdht/testnet')

// The bound on each wait for a result that must come (ms).
const DEADLINE = 30000
// How long a peer that must stay out stays without a connection (ms).
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

/** A hyperdht testnet. Destroy it after every vault and swarm on it. */
function testnet() {
  return withDeadline(createTestnet(3), DEADLINE, 'testnet')
}

const hex = (buf) => buf.toString('hex')

/** True while `vault`'s swarm holds an open connection to `peer`'s swarm key. */
function connected(vault, peer) {
  if (!vault.swarmInstance) return false
  for (const conn of vault.swarmInstance.connections) {
    if (conn.remotePublicKey.equals(peer.swarmKey)) return true
  }
  return false
}

/**
 * The swarm key that a directory will have, before it holds a vault. A
 * pre-provisioned fleet needs each key before the creator writes the
 * invite. The derivation test below pins Bundle.readSwarmKey.
 */
async function provisionedKey(dir) {
  return hex(await Bundle.readSwarmKey(dir))
}

/** Records the remote key of every connection and every ban on a swarm. */
function watchSwarm(swarm) {
  const seen = { connections: [], bans: [] }
  swarm.on('connection', (conn) => seen.connections.push(hex(conn.remotePublicKey)))
  swarm.on('ban', (info) => seen.bans.push(hex(info.publicKey)))
  return seen
}

test('two vaults replicate over hyperswarm on the auto-okf/2 topic', { timeout: TEST_TIMEOUT }, async (t) => {
  const tn = await testnet()
  const a = await Bundle.init(await tmpDir('swarm-a'))
  const b = await Bundle.join(await tmpDir('swarm-b'), a.key, { metadata: a.metadata })
  t.after(async () => {
    await a.close()
    await b.close()
    await tn.destroy()
  })
  await a.addWriter(b.localKey, { swarmKey: b.swarmKey })

  const swarmA = await withDeadline(a.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'a.swarm()')
  const swarmB = await withDeadline(b.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'b.swarm()')

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
    assert.deepEqual(swarm.keyPair.publicKey, (name === 'a' ? a : b).swarmKey, `${name} listens on its swarm key`)
  }

  const { tag: id } = await a.createConcept('swarm/hello', 'note')
  await a.setField(id, 'title', ['over the swarm'])
  assert.ok(await folds(b, id), 'b folds ops that arrived via swarm connections')
  assert.deepEqual((await b.val(K.cField(id, 'title'))).values, ['over the swarm'])
})

test('leaveSwarm() leaves the auto-okf/2 topic and the listed peers, and destroys the swarm', { timeout: TEST_TIMEOUT }, async (t) => {
  const tn = await testnet()
  const a = await Bundle.init(await tmpDir('swarm-leave'))
  t.after(async () => {
    await a.close()
    await tn.destroy()
  })

  const topic = namespacedTopic(a.discoveryKey)
  const swarmA = await withDeadline(a.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'a.swarm()')
  assert.ok(swarmA.status(topic), 'swarm() joins the auto-okf/2 topic')

  await withDeadline(a.leaveSwarm(), DEADLINE, 'a.leaveSwarm()')
  assert.equal(swarmA.status(topic), null, 'leaveSwarm() leaves the auto-okf/2 topic')
  assert.deepEqual([...swarmA.topics()], [], 'no topic stays joined')
  assert.equal(swarmA.destroyed, true, 'the swarm that the vault owned is destroyed')
  assert.equal(a.swarmInstance, null)
})

test('swarm() refuses to run without a DHT choice: bootstrap for a private DHT, or publicDht for the commons (T25)', { timeout: TEST_TIMEOUT }, async (t) => {
  const a = await Bundle.init(await tmpDir('swarm-no-dht'))
  t.after(() => a.close())
  for (const opts of [undefined, {}, { bootstrap: [] }, { publicDht: false }, { bootstrap: ['127.0.0.1:1'], publicDht: true }, { bootstrap: 'x' }]) {
    await assert.rejects(a.swarm(opts), (err) => err.code === 'VAULT_SWARM_DHT', `refused: ${JSON.stringify(opts)}`)
  }
  assert.equal(a.swarmInstance, null, 'a refusal makes no swarm')
})

test('a stand-in peer on the bare discovery key never replicates with a namespaced peer', { timeout: TEST_TIMEOUT }, async (t) => {
  const tn = await testnet()
  const swarmC = new Hyperswarm({ bootstrap: tn.bootstrap })
  const a = await Bundle.init(await tmpDir('swarm-ns-a'))
  const b = await Bundle.join(await tmpDir('swarm-ns-b'), a.key, { metadata: a.metadata })
  const c = await Bundle.join(await tmpDir('swarm-bare-c'), a.key)
  t.after(async () => {
    await a.close()
    await b.close()
    await c.close()
    await swarmC.destroy()
    await tn.destroy()
  })
  // a admits b and the stand-in's swarm key, so only the topic can keep the
  // stand-in out.
  await a.addWriter(b.localKey, { swarmKey: b.swarmKey })
  await a.addWriter(c.localKey, { swarmKey: swarmC.keyPair.publicKey })

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

  await withDeadline(a.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'a.swarm()')
  await withDeadline(b.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'b.swarm()')

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

test('a peer with the vault key and the invite, and a swarm key outside the allowlist, never connects (T25, G44)', { timeout: TEST_TIMEOUT }, async (t) => {
  const tn = await testnet()
  const a = await Bundle.init(await tmpDir('fw-a'))
  const b = await Bundle.join(await tmpDir('fw-b'), a.key, { metadata: a.metadata })
  // The outsider holds everything a member holds except an admitted swarm
  // key: the vault key and the full invite, which names a's swarm key, so
  // it dials a directly and on the topic.
  const d = await Bundle.join(await tmpDir('fw-outsider'), a.key, { metadata: a.metadata })
  t.after(async () => {
    await a.close()
    await b.close()
    await d.close()
    await tn.destroy()
  })
  await a.addWriter(b.localKey, { swarmKey: b.swarmKey })

  const swarmA = await withDeadline(a.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'a.swarm()')
  const seenA = watchSwarm(swarmA)
  const swarmB = await withDeadline(b.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'b.swarm()')
  const seenB = watchSwarm(swarmB)
  await withDeadline(d.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'd.swarm()')

  const { tag: id } = await a.createConcept('fw/doc', 'note')
  await a.setField(id, 'title', ['members only'])
  // Control: the member folds the op, so the DHT and the dial work.
  assert.ok(await folds(b, id), 'b, an admitted member, folds the op')

  // The outsider's dial reaches a. With the firewall, a rejects the key, and
  // hyperswarm bans it (index.js:315-319). Without it, a connection opens.
  const dHex = hex(d.swarmKey)
  assert.ok(
    await until(() => seenA.bans.includes(dHex) || seenA.connections.includes(dHex), DEADLINE),
    'the outsider reached a'
  )
  const leaked = await until(async () => {
    if (seenA.connections.includes(dHex) || seenB.connections.includes(dHex)) return true
    if (d.swarmInstance.connections.size > 0) return true
    await d.update()
    return (await d.val(K.cField(id, 'title'))) !== undefined
  }, QUIET)
  assert.equal(leaked, false, 'the outsider opens no connection and folds no op')
  assert.deepEqual(seenA.connections.filter((k) => k === dHex), [], 'a never emits a connection from the outsider')
  assert.deepEqual(seenB.connections.filter((k) => k === dHex), [], 'b never emits a connection from the outsider')
  assert.equal(d.swarmInstance.connections.size, 0, 'the outsider has no connection')
  assert.equal(await d.val(K.cField(id, 'title')), undefined, 'the outsider folds no op')
  assert.ok(seenA.bans.includes(dHex), "a's firewall rejected the outsider's key")
})

test("a removed writer's connection is destroyed when the removal folds, though the invite lists its key (T25)", { timeout: TEST_TIMEOUT }, async (t) => {
  const tn = await testnet()
  // b is pre-provisioned in the invite and admitted with its swarm key, so
  // the removal must take b out of the static list too.
  const dirB = await tmpDir('rm-b')
  const bKey = await provisionedKey(dirB)
  const a = await Bundle.init(await tmpDir('rm-a'), { metadata: { swarm: { allow: [bKey] } } })
  const b = await Bundle.join(dirB, a.key, { metadata: a.metadata })
  t.after(async () => {
    await a.close()
    await b.close()
    await tn.destroy()
  })
  assert.equal(hex(b.swarmKey), bKey)
  await a.addWriter(b.localKey, { swarmKey: b.swarmKey })

  await withDeadline(a.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'a.swarm()')
  await withDeadline(b.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'b.swarm()')
  const { tag: id } = await a.createConcept('rm/before', 'note')
  await a.setField(id, 'title', ['before the removal'])
  assert.ok(await folds(b, id), 'b folds while it is a member')
  assert.ok(connected(a, b), 'a holds a connection to b')

  await a.removeWriter(b.localKey)
  await a.update()
  assert.ok(await until(() => !connected(a, b) && !connected(b, a), DEADLINE), "the fold destroys b's connection")

  // b keeps a in its list and redials, and a's firewall keeps it out.
  const { tag: after } = await a.createConcept('rm/after', 'note')
  await a.setField(after, 'title', ['after the removal'])
  const leaked = await until(async () => connected(a, b) || (await folds(b, after, 50)), QUIET)
  assert.equal(leaked, false, 'b gets no new connection and no new op')
})

test("a removed writer's swarm key leaves the allowlist though a live record carries the same key, also after a reopen (G3-P9 F01)", { timeout: TEST_TIMEOUT }, async (t) => {
  const tn = await testnet()
  const dirA = await tmpDir('shared-a')
  let a = await Bundle.init(dirA)
  const b = await Bundle.join(await tmpDir('shared-b'), a.key, { metadata: a.metadata })
  t.after(async () => {
    await a.close()
    await b.close()
    await tn.destroy()
  })
  // Core lets two gov/writer records carry one swarm key. The second
  // record names b's swarm key under a writer key that nobody holds.
  const alias = Buffer.alloc(32, 77)
  await a.addWriter(b.localKey, { swarmKey: b.swarmKey })
  await a.addWriter(alias, { swarmKey: b.swarmKey })
  await a.update()
  assert.equal((await a.val(K.govWriter(hex(alias)))).swarmKey, hex(b.swarmKey), 'the alias record carries the same key')

  await withDeadline(a.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'a.swarm()')
  await withDeadline(b.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'b.swarm()')
  const { tag: id } = await a.createConcept('shared/before', 'note')
  await a.setField(id, 'title', ['before the removal'])
  assert.ok(await folds(b, id), 'b folds while it is a member')
  assert.ok(connected(a, b), 'a holds a connection to b')

  // The removal of b takes its swarm key out, though the alias record is
  // live and carries the same key.
  await a.removeWriter(b.localKey)
  await a.update()
  assert.equal(await a.val(K.govRemoved(hex(alias))), undefined, 'the alias record stays live')
  assert.ok(await until(() => !connected(a, b) && !connected(b, a), DEADLINE), "the fold destroys b's connection")
  const { tag: after } = await a.createConcept('shared/after', 'note')
  await a.setField(after, 'title', ['after the removal'])
  const leaked = await until(async () => connected(a, b) || (await folds(b, after, 50)), QUIET)
  assert.equal(leaked, false, 'b gets no new connection and no new op')

  // A reopen reads the allowlist from gov/ again, and the key stays out.
  await a.close()
  a = await Bundle.open(dirA)
  const swarmA = await withDeadline(a.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'reopened a.swarm()')
  const bHex = hex(b.swarmKey)
  // b reaches the reopened a: a's lookup of the topic finds b, and a's
  // firewall rejects b, or the two connect.
  assert.ok(
    await until(() => connected(a, b) || swarmA.peers.get(bHex)?.banned === true, DEADLINE),
    'b reached the reopened a'
  )
  const { tag: reopened } = await a.createConcept('shared/reopened', 'note')
  await a.setField(reopened, 'title', ['after the reopen'])
  const leakedAfterReopen = await until(async () => connected(a, b) || (await folds(b, reopened, 50)), QUIET)
  assert.equal(leakedAfterReopen, false, 'after the reopen, b gets no connection and no new op')
  assert.equal(swarmA.peers.get(bHex)?.banned, true, "the reopened a's firewall rejected b")
})

test('revokePeer cuts a live connection, leaves the peer, and keeps the key out across later folds (T25)', { timeout: TEST_TIMEOUT }, async (t) => {
  const tn = await testnet()
  const a = await Bundle.init(await tmpDir('rv-a'))
  const b = await Bundle.join(await tmpDir('rv-b'), a.key, { metadata: a.metadata })
  t.after(async () => {
    await a.close()
    await b.close()
    await tn.destroy()
  })
  await a.addWriter(b.localKey, { swarmKey: b.swarmKey })
  await withDeadline(a.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'a.swarm()')
  await withDeadline(b.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'b.swarm()')
  const { tag: id } = await a.createConcept('rv/before', 'note')
  await a.setField(id, 'title', ['before'])
  assert.ok(await folds(b, id), 'b folds while it is admitted')
  assert.ok(connected(a, b))

  assert.throws(() => a.revokePeer('not-a-key'), (err) => err.code === 'VAULT_BAD_SWARM_KEY')
  a.revokePeer(b.swarmKey)
  assert.ok(await until(() => !connected(a, b) && !connected(b, a), DEADLINE), 'the connection is destroyed')

  // gov/ still admits b: the next fold re-reads the allowlist and keeps the
  // revocation.
  const { tag: after } = await a.createConcept('rv/after', 'note')
  await a.setField(after, 'title', ['after'])
  await a.update()
  const leaked = await until(async () => connected(a, b) || (await folds(b, after, 50)), QUIET)
  assert.equal(leaked, false, 'b gets no new connection and no new op')
})

test('a pre-provisioned pair connects through joinPeer, with no topic (T25)', { timeout: TEST_TIMEOUT }, async (t) => {
  const tn = await testnet()
  // Take the topic away: every join keeps its session, but neither
  // announces nor looks up. Only joinPeer and listen() can connect the pair.
  const join = Hyperswarm.prototype.join
  Hyperswarm.prototype.join = function (topic, opts) {
    return join.call(this, topic, { ...opts, server: false, client: false })
  }
  const dirB = await tmpDir('pp-b')
  const bKey = await provisionedKey(dirB)
  const a = await Bundle.init(await tmpDir('pp-a'), { metadata: { swarm: { allow: [bKey] } } })
  const b = await Bundle.join(dirB, a.key, { metadata: a.metadata })
  t.after(async () => {
    Hyperswarm.prototype.join = join
    await a.close()
    await b.close()
    await tn.destroy()
  })
  assert.deepEqual(a.metadata.swarm.allow, [hex(a.swarmKey), bKey].sort(), 'the invite lists both keys')

  // No add-writer: the static list alone admits b, and b only reads.
  const swarmA = await withDeadline(a.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'a.swarm()')
  const swarmB = await withDeadline(b.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'b.swarm()')
  assert.equal(swarmA.status(namespacedTopic(a.discoveryKey)).isServer, false, 'a does not announce the topic')
  const { tag: id } = await a.createConcept('pp/doc', 'note')
  await a.setField(id, 'title', ['pre-provisioned'])
  assert.ok(await folds(b, id), 'b folds over a direct connection')
  assert.equal(swarmA.peers.get(bKey).explicit, true, 'a joinPeered b')
  assert.equal(swarmB.peers.get(hex(a.swarmKey)).explicit, true, 'b joinPeered a')
})

test('a joiner that a firewall rejected before its admission connects once the admission folds (T25)', { timeout: TEST_TIMEOUT }, async (t) => {
  const tn = await testnet()
  const a = await Bundle.init(await tmpDir('late-a'))
  const b = await Bundle.join(await tmpDir('late-b'), a.key, { metadata: a.metadata })
  t.after(async () => {
    await a.close()
    await b.close()
    await tn.destroy()
  })
  const swarmA = await withDeadline(a.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'a.swarm()')
  const seenA = watchSwarm(swarmA)
  await withDeadline(b.swarm({ bootstrap: tn.bootstrap }), DEADLINE, 'b.swarm()')
  // b dials a before a admits it, so a's firewall rejects and bans b.
  assert.ok(await until(() => seenA.bans.includes(hex(b.swarmKey)), DEADLINE), 'a rejected b before the admission')

  await a.addWriter(b.localKey, { swarmKey: b.swarmKey })
  assert.ok(
    await until(async () => {
      await b.update()
      return b.writable
    }, DEADLINE),
    'b connects and folds its admission'
  )
})

test('a vault derives its swarm key from its own store, so the key is stable across a reopen (T25)', { timeout: TEST_TIMEOUT }, async (t) => {
  const dir = await tmpDir('swarm-key')
  const a = await Bundle.init(dir)
  const key = a.swarmKey
  assert.ok(Buffer.isBuffer(key) && key.length === 32, 'a 32-byte public key')
  assert.notDeepEqual(key, a.localKey, 'the swarm key is not the writer key')
  await a.close()

  // The derivation, computed here apart from bundle.js: corestore's
  // createKeyPair('auto-okf/swarm') on the root store of the directory.
  const store = new Corestore(dir)
  const { publicKey } = await store.createKeyPair('auto-okf/swarm')
  await store.close()
  assert.deepEqual(publicKey, key, "createKeyPair('auto-okf/swarm') of the vault's store")

  const reopened = await Bundle.open(dir)
  t.after(() => reopened.close())
  assert.deepEqual(reopened.swarmKey, key, 'the same key after a reopen')
  const otherDir = await tmpDir('swarm-key-other')
  const early = await Bundle.readSwarmKey(otherDir) // the directory holds no vault yet
  const other = await Bundle.init(otherDir)
  t.after(() => other.close())
  assert.deepEqual(other.swarmKey, early, 'readSwarmKey gives the key before the vault exists')
  assert.notDeepEqual(other.swarmKey, key, 'another store has another key')
})

test("a new vault lists its creator's swarm key in metadata.swarm.allow, and the invite carries it (T25)", { timeout: TEST_TIMEOUT }, async (t) => {
  const dirA = await tmpDir('swarm-creator')
  const listed = 'ab'.repeat(32)
  const a = await Bundle.init(dirA, { metadata: { swarm: { allow: [listed] } } })
  const own = a.swarmKey.toString('hex')
  assert.deepEqual(a.metadata.swarm.allow, [own, listed].sort(), 'the creator adds its own key to the list')
  assert.deepEqual((await loadMetadata(join(dirA, METADATA_FILE))).swarm.allow, [own, listed].sort())

  // A joiner pins the invite as it is, and adds no key of its own.
  const b = await Bundle.join(await tmpDir('swarm-creator-b'), a.key, { metadata: a.metadata })
  t.after(() => b.close())
  assert.deepEqual(b.metadata, a.metadata, 'the joiner pins the same document')

  // The creator reopens with the input that created the vault.
  await a.close()
  const again = await Bundle.open(dirA, { metadata: { swarm: { allow: [listed] } } })
  t.after(() => again.close())
  assert.deepEqual(again.metadata.swarm.allow, [own, listed].sort())
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
