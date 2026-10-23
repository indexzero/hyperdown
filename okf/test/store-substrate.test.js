// Store scope, the autobee@1 to autobee@2 flag day: okf refuses a store that
// autobee@1 wrote, before anything opens it for writing, and marks every
// autobee@2 store (store/lib/substrate.js has the rule). The autobee@1
// stores are written by autobee@1.0.10 on corestore 7.11.0
// (autobee1-helpers.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bundle, K, tmpDir, pair, until } from './store-helpers.js'
import { BundleOnAutobee1 } from './autobee1-helpers.js'
import { SUBSTRATE, SUBSTRATE_MARKER, detectSubstrate } from '../store/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const Corestore = createRequire(join(ROOT, 'okf', 'store', 'package.json'))('corestore')

/** sha256 of every file under dir, by relative path. */
async function snapshot(dir, rel = '', out = {}) {
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) await snapshot(dir, r, out)
    else out[r] = createHash('sha256').update(await readFile(join(dir, r))).digest('hex')
  }
  return out
}

/** detectSubstrate on a directory, through a read-only corestore. */
async function detect(dir, vaultKeyHex, generation = 'root') {
  const store = new Corestore(dir, { readOnly: true })
  try {
    return await detectSubstrate(store.namespace('okf/generation/' + generation), Buffer.from(vaultKeyHex, 'hex'))
  } finally {
    await store.close()
  }
}

async function writeV1Pair() {
  const a = await BundleOnAutobee1.init(await tmpDir('v1-genesis'))
  const b = await BundleOnAutobee1.join(await tmpDir('v1-joiner'), a.key)
  const unpair = pair(a, b)
  await a.writers.add(b.localKey, { indexer: false })
  assert.ok(await until(async () => (await b.update(), b.writable)), 'v1 joiner writable')
  const { tag } = await a.createConcept('notes/one', 'note')
  await a.setBody(tag, null, 'written by autobee@1')
  await b.createConcept('notes/two', 'note')
  const bHex = b.localKey.toString('hex')
  assert.ok(await until(async () => (await a.update(), (await a.val(K.seen(bHex))) === 1)))
  assert.ok(await until(async () => (await b.update(), (await b.snapshotHash()) === (await a.snapshotHash()))))
  const hash = await a.snapshotHash()
  unpair()
  const out = { key: a.keyHex, hash, genesis: a.dir, joiner: b.dir }
  await a.close()
  await b.close()
  return out
}

test('the rule tells autobee@1 stores from autobee@2 stores', async () => {
  const v1 = await writeV1Pair()
  // both v1 stores have a head and no marker; their system cores are below v3
  assert.deepEqual(await detect(v1.genesis, v1.key), { substrate: 'autobee@1', marked: false })
  assert.deepEqual(await detect(v1.joiner, v1.key), { substrate: 'autobee@1', marked: false })

  // a v1 joiner that never applied a node has no head: nothing to migrate
  const unsynced = await BundleOnAutobee1.join(await tmpDir('v1-unsynced'), Buffer.from(v1.key, 'hex'))
  const unsyncedDir = unsynced.dir
  await unsynced.close()
  assert.deepEqual(await detect(unsyncedDir, v1.key), { substrate: 'none', marked: false })

  // an autobee@2 store is marked on its first open
  const v2 = await Bundle.init(await tmpDir('v2-genesis'))
  await v2.createConcept('notes/one', 'note')
  const v2Key = v2.keyHex
  await v2.close()
  assert.deepEqual(await detect(v2.dir, v2Key), { substrate: SUBSTRATE, marked: true })
})

test('a store autobee@1 wrote is refused without touching it, and stays usable by autobee@1', async () => {
  const v1 = await writeV1Pair()
  for (const dir of [v1.genesis, v1.joiner]) {
    const before = await snapshot(dir)
    await assert.rejects(
      () => Bundle.open(dir),
      (err) => err.code === 'VAULT_AUTOBEE_V1' && err.dir === dir && /was written by autobee@1/.test(err.message)
    )
    await assert.rejects(() => Bundle.join(dir, v1.key), (err) => err.code === 'VAULT_AUTOBEE_V1')
    assert.deepEqual(await snapshot(dir), before, 'every file byte-identical after the refusal')
  }
  // the old release can still open it and materialize it
  const back = await BundleOnAutobee1.open(v1.genesis)
  assert.equal(await back.snapshotHash(), v1.hash)
  await back.close()
})

test('an autobee@2 store that lost its marker is recognised and marked again', async () => {
  const v = await Bundle.init(await tmpDir('v2-unmarked'))
  const { tag } = await v.createConcept('notes/kept', 'note')
  const hash = await v.snapshotHash()
  const dir = v.dir
  const key = v.keyHex
  const localKey = v.localKey
  await v.close()

  const store = new Corestore(dir)
  const local = store.namespace('okf/generation/root').get({ key: localKey, active: false })
  await local.ready()
  await local.setUserData(SUBSTRATE_MARKER, null)
  await local.close()
  await store.close()
  assert.deepEqual(await detect(dir, key), { substrate: SUBSTRATE, marked: false }, 'decided by the system core')

  const again = await Bundle.open(dir)
  assert.equal(await again.snapshotHash(), hash)
  assert.ok(await again.val(K.cMeta(tag)))
  await again.close()
  assert.deepEqual(await detect(dir, key), { substrate: SUBSTRATE, marked: true })
})
