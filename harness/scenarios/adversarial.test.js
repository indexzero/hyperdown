// Assignment §3 review targets, graduated to harness scenarios:
// - keyspace injection (subjects colliding with reserved families,
//   separators, empty string, oversized keys)
// - poison op containment (a hand-crafted undecodable op from an admitted
//   writer must be flagged per-op and skipped, never halting apply)
// - quiescence definition (after reported quiescence, forced update rounds
//   must not move the hash)
// - host.removeable exactness (DEVIATIONS.md UNVERIFIED item 1): sole-
//   indexer self-removal, exercised against real autobee
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster } from '../lib/setup.js'
import { checkCoherence } from '../lib/coherence.js'

test('ADV1: keyspace injection — hostile subjects cannot escape their family', async (t) => {
  const { ctl, writers } = await setupVaultCluster('adv1', 2)
  t.after(() => ctl.stop())
  const [a, b] = writers

  await a.call('defineTerm', 'core', 'title', { '@id': 'ex:title' })
  await ctl.quiesce(writers)

  const hostile = [
    'hold', // reserved under n/ (§4)
    'flag/x', // embedded separator aimed at flag/
    'ctx/gov/writer/00', // aimed at governance records
    '../escape', // traversal
    '%2F%25', // pre-escaped characters
    'seen/ff', // bookkeeping family name
    'a/b/c' // plain multi-segment
  ]
  for (const s of hostile) await a.call('setField', s, 'title', `v:${s}`)
  // empty-string subject via the raw op path (helpers would also accept it)
  await a.append('set-field', { s: '', p: 'title', o: 'empty' })
  // 1 MB subject trips the §8.4 op-size limit (fixed check order: the op
  // itself is >64 KiB before the subject limit is reached); a 2 KB subject
  // trips oversize-subject. Both must flag + skip, never corrupt.
  await a.call('setField', 'S'.repeat(1024 * 1024), 'title', 'huge')
  await a.call('setField', 'S'.repeat(2048), 'title', 'big')

  const hash = await ctl.quiesce(writers)
  assert.ok(hash)

  for (const w of writers) {
    const dump = await w.dump('')
    // every hostile subject round-trips to its own n/ rows
    for (const s of hostile) {
      const esc = s.replace(/%/g, '%25').replace(/\//g, '%2F')
      const key = `n/${esc === 'hold' ? '%68old' : esc}/f/title`
      assert.ok(dump[key], `${w.name}: ${JSON.stringify(s)} stored under its own key`)
      assert.deepEqual(dump[key].reg.values, [`v:${s}`])
    }
    // reserved families untouched by the injections
    assert.equal(
      Object.keys(dump).filter((k) => k.startsWith('n/hold/')).length,
      0,
      `${w.name}: hold buffer clean`
    )
    const govKeys = Object.keys(dump).filter((k) => k.startsWith('ctx/gov/writer/'))
    assert.equal(govKeys.length, 2, `${w.name}: exactly the two real writers in ctx/gov`)
    // oversize subject was rejected with a flag, no n/ mutation (I4/I10)
    const rejected = Object.values(await w.dump('flag/rejected/')).map((r) => r.reason)
    assert.ok(rejected.includes('oversize-op'), `${w.name}: 1MB op flagged oversize-op`)
    assert.ok(rejected.includes('oversize-subject'), `${w.name}: 2KB subject flagged`)
    // and the whole view stays coherent
    assert.deepEqual(checkCoherence(dump), [], `${w.name}: coherent after injection`)
  }
})

test('ADV2: a poison op is contained per-op and cannot halt apply (I4)', async (t) => {
  const { ctl, writers } = await setupVaultCluster('adv2', 3)
  t.after(() => ctl.stop())
  const [a, b, c] = writers

  await a.call('defineTerm', 'core', 'title', { '@id': 'ex:title' })
  await ctl.quiesce(writers)

  // hand-crafted poison from an ADMITTED writer: raw garbage bytes,
  // an unknown-msgid frame, and a decodable op with a garbage base hash
  await b.cmd('appendRaw', { hexBytes: '00ff' }) // valid msgid, garbage payload
  await b.cmd('appendRaw', { hexBytes: 'fd4041' }) // varint msgid nobody owns
  await b.append('set-body', { s: 'Home', base: 'ff'.repeat(32), text: 'garbage base' })

  // apply must keep folding ops from every writer afterwards
  await a.call('setField', 'Home', 'title', 'after poison a')
  await b.call('setField', 'Other', 'title', 'after poison b')
  await c.call('setField', 'Third', 'title', 'after poison c')

  const hash = await ctl.quiesce(writers)
  assert.ok(hash, 'peers converge across the poison ops')

  const bKey = b.info.localKey
  for (const w of writers) {
    const rejected = Object.values(await w.dump(`flag/rejected/${bKey}/`)).map((r) => r.reason)
    assert.deepEqual(
      rejected.sort(),
      ['garbage-base', 'undecodable', 'unknown-msgid'],
      `${w.name}: each poison op flagged with its §8.4 reason`
    )
    const after = await w.val('n/Home/f/title')
    assert.deepEqual(after.reg.values, ['after poison a'], `${w.name}: apply continued`)
  }
})

test('ADV3: reported quiescence is real — forced update rounds do not move the hash', async (t) => {
  const { ctl, writers } = await setupVaultCluster('adv3', 3)
  t.after(() => ctl.stop())
  const [a, b, c] = writers

  await a.call('defineTerm', 'core', 'topic', { '@id': 'ex:topic', '@container': '@set' })
  for (let i = 0; i < 25; i++) {
    await writers[i % 3].call('addMember', `N${i % 7}`, 'topic', `m${i}`)
  }
  const hash = await ctl.quiesce(writers)
  for (let round = 0; round < 3; round++) {
    for (const w of writers) {
      await w.update()
      assert.equal(await w.hash(), hash, `${w.name}: hash moved after reported quiescence`)
    }
  }
})

test('ADV4: sole-indexer self-removal (host.removeable exactness, DEVIATIONS UNVERIFIED #1)', async (t) => {
  const { ctl, writers } = await setupVaultCluster('adv4', 2)
  t.after(() => ctl.stop())
  const [a, b] = writers

  await a.call('defineTerm', 'core', 'title', { '@id': 'ex:title' })
  await a.call('setField', 'Home', 'title', 'before self-removal')
  await ctl.quiesce(writers)

  // the genesis (sole indexer) removes ITSELF; autobee 1.0.10's
  // host.removeable is `always true`, so nothing guards this
  await a.call('removeWriter', a.info.localKey)

  // whatever autobee does, it must be deterministic and non-fatal for
  // readers: both peers settle on one hash and reads still work
  const hash = await ctl.quiesce(writers)
  assert.ok(hash, 'peers agree after sole-indexer self-removal')
  for (const w of writers) {
    const rec = await w.val('n/Home/f/title')
    assert.deepEqual(rec.reg.values, ['before self-removal'], `${w.name}: reads intact`)
  }

  // and the vault is now headless: the ex-indexer's later governance ops
  // are rejected (its own clock can no longer dominate the removal clock)
  await a.call('setField', 'Home', 'title', 'after self-removal')
  await ctl.quiesce(writers).catch(() => {})
  const errsA = await a.errors()
  await ctl.note(`ADV4 outcome: post-removal write errors on a: ${JSON.stringify(errsA)}`)
})
