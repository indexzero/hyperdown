import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  Bundle,
  K,
  materialize,
  readView,
  wanted,
  parseNote,
  renderNote,
  checkOkfConformance,
  tmpDir,
  readBundle,
  bundleDiff,
  listFiles,
  treeHash,
  entries,
  pair,
  converged
} from './helpers.js'
import { planBundle } from '../lib/materialize.js'
import { atomicWrite, hashFile, sha256, statOrNull } from '../lib/fsatomic.js'

/** Seed three concepts that link to each other. Returns their ids. */
async function seed(v) {
  const { tag: sales } = await v.createConcept('datasets/sales', 'BigQuery Dataset')
  await v.setField(sales, 'title', 'Sales')
  await v.setField(sales, 'description', 'All sales tables for the retail business.')
  await v.setBody(sales, null, 'Contains [orders](/tables/orders.md) and [customers](/tables/customers.md).')

  const { tag: orders } = await v.createConcept('tables/orders', 'BigQuery Table')
  await v.setField(orders, 'title', 'Orders')
  await v.addTag(orders, 'sales')
  await v.addTag(orders, 'revenue')
  await v.setBody(orders, null, 'One row per completed order. Part of [sales](/datasets/sales.md).')

  const { tag: top } = await v.createConcept('overview', 'Reference')
  await v.setField(top, 'title', 'Overview')
  await v.setBody(top, null, 'Start here.')
  await v.update()
  return { sales, orders, top }
}

test('I9: materialize is byte-deterministic across two runs of the same view', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  await seed(v)
  const dir1 = await tmpDir('bundle')
  const dir2 = await tmpDir('bundle')
  const r1 = await materialize(v, dir1)
  const r2 = await materialize(v, dir2)
  assert.ok(r1.ok && r2.ok)
  const diff = bundleDiff(await readBundle(dir1), await readBundle(dir2))
  assert.equal(diff, null, `bundles differ: ${diff}`)
  await v.close()
})

test('I9: materialize is byte-identical on a replicated peer', async () => {
  const a = await Bundle.init(await tmpDir('vault-a'))
  await seed(a)
  const b = await Bundle.join(await tmpDir('vault-b'), a.key)
  const unpair = pair(a, b)
  const h = await converged([a, b])
  assert.ok(h, 'peers did not converge')

  const dirA = await tmpDir('bundle-a')
  const dirB = await tmpDir('bundle-b')
  await materialize(a, dirA)
  await materialize(b, dirB)
  const diff = bundleDiff(await readBundle(dirA), await readBundle(dirB))
  assert.equal(diff, null, `peer bundles differ: ${diff}`)

  unpair()
  await a.close()
  await b.close()
})

test('I3, I9: materialize is byte-identical on a view rebuilt from the log', async () => {
  const dir = await tmpDir('vault')
  const a = await Bundle.init(dir)
  const ids = await seed(a)
  const dir1 = await tmpDir('bundle')
  await materialize(a, dir1)
  const before = await readBundle(dir1)
  await a.close()

  // Reopen from disk, so the view is refolded from the persisted log.
  const b = await Bundle.open(dir)
  await b.update()
  const dir2 = await tmpDir('bundle')
  await materialize(b, dir2)
  const diff = bundleDiff(before, await readBundle(dir2))
  assert.equal(diff, null, `rebuilt bundle differs: ${diff}`)
  assert.ok(ids.sales)
  await b.close()
})

test('the bundle that materialize writes passes the independent OKF v0.1 conformance check', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  await seed(v)
  const dir = await tmpDir('bundle')
  await materialize(v, dir)
  const res = await checkOkfConformance(dir)
  assert.ok(res.ok, 'conformance violations: ' + JSON.stringify(res.violations, null, 2))
  // Make sure that the checker saw concept files, index.md and log.md, so the pass is not vacuous.
  assert.ok(res.files.includes('index.md'))
  assert.ok(res.files.includes('log.md'))
  assert.ok(res.files.includes('datasets/sales.md'))
  await v.close()
})

test('frontmatter emission order is _id, _rev, type, then sorted keys (§6)', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  const { orders } = await seed(v)
  const dir = await tmpDir('bundle')
  await materialize(v, dir)
  const bundle = await readBundle(dir)
  const text = bundle.get('tables/orders.md')
  const fmLines = text.split('\n---\n')[0].replace(/^---\n/, '').split('\n').filter(Boolean)
  const keys = fmLines.map((l) => l.split(':')[0])
  assert.equal(keys[0], '_id')
  assert.equal(keys[1], '_rev')
  assert.equal(keys[2], 'type')
  const rest = keys.slice(3)
  assert.deepEqual(rest, [...rest].sort())
  assert.match(text, /tags: \[revenue, sales\]/)
  assert.ok(orders)
  await v.close()
})

test('root index.md carries okf_version and lists concepts then subdirs (OKF §6)', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  await seed(v)
  const dir = await tmpDir('bundle')
  await materialize(v, dir)
  const bundle = await readBundle(dir)
  const idx = bundle.get('index.md')
  assert.match(idx, /^---\nokf_version: "0.1"\n---\n\n# Contents\n/)
  const overviewPos = idx.indexOf('(overview.md)')
  const datasetsPos = idx.indexOf('(datasets/)')
  assert.ok(overviewPos > -1 && datasetsPos > -1 && overviewPos < datasetsPos)
  assert.ok(!bundle.get('datasets/index.md').startsWith('---'))
  await v.close()
})

test('log.md is # Update Log with ISO date headings newest-first (OKF §7)', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  await seed(v)
  const dir = await tmpDir('bundle')
  await materialize(v, dir)
  const log = (await readBundle(dir)).get('log.md')
  assert.match(log, /^# Update Log\n/)
  const dates = [...log.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  for (const d of dates) assert.match(d, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(dates, [...dates].sort().reverse())
  await v.close()
})

test('parseNote inverts renderNote for every body, trailing newlines included', () => {
  const pairs = [['type', 'note']]
  const bodies = ['', 'text', 'text\n', 'text\n\n', 'text\n\n\n', '\n', '\n\n', '\ntext', '\n\ntext\n\n', 'a\n\nb\n', 'a\r\n']
  for (const body of bodies) {
    assert.deepEqual(parseNote(renderNote(pairs, body)), { fm: { type: 'note' }, body, warnings: [] }, JSON.stringify(body))
  }
  // The layout: the frontmatter block, one blank line, the body, one file
  // newline. An empty body writes the frontmatter block only.
  assert.equal(renderNote(pairs, 'text'), '---\ntype: note\n---\n\ntext\n')
  assert.equal(renderNote(pairs, 'text\n'), '---\ntype: note\n---\n\ntext\n\n')
  assert.equal(renderNote(pairs, 'text\n\n'), '---\ntype: note\n---\n\ntext\n\n\n')
  assert.equal(renderNote(pairs, ''), '---\ntype: note\n---\n')
})

test('wanted() ranks unwritten concepts by referrer count (§4/§9)', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  const { tag: a } = await v.createConcept('a', 'Note')
  await v.setBody(a, null, 'See [hot](/hot.md) and [cold](/cold.md).')
  const { tag: b } = await v.createConcept('b', 'Note')
  await v.setBody(b, null, 'See [hot](/hot.md).')
  await v.update()
  const list = await wanted(v)
  assert.equal(list[0].path, 'hot')
  assert.equal(list[0].count, 2)
  assert.ok(list.some((w) => w.path === 'cold' && w.count === 1))
  assert.ok(list[0].count >= list[list.length - 1].count)
  await v.close()
})

// ---------- materialize writes inside the bundle directory only ----------

/** A vault's state: its full-view hash. */
async function vaultState(v) {
  await v.update()
  return v.snapshotHash()
}

test('a symlink in the face that leads out of it fails materialize by name before any change, and the files outside stay', async () => {
  // notes/ in the face is a symlink to a directory outside it, and the
  // concept moved. If materialize checks lexical containment only, it deletes
  // the files outside through the symlink.
  const base = await tmpDir('face-escape')
  const old = await Bundle.init(join(base, 'vault'))
  const { tag } = await old.createConcept('notes/a', 'note')
  await old.setBody(tag, null, 'outside victim content')
  await old.update()
  const face = join(base, 'face')
  assert.equal((await materialize(old, face)).ok, true)
  const outside = join(base, 'outside')
  await rename(join(face, 'notes'), outside)
  await symlink(outside, join(face, 'notes'))
  await old.setPath(tag, 'new/a')
  await old.update()
  const state = async () => ({
    outsideFiles: await listFiles(outside),
    outsideBytes: await treeHash(outside),
    faceEntries: await entries(face),
    faceBytes: await treeHash(face),
    vault: await vaultState(old)
  })
  const before = await state()
  assert.deepEqual(before.outsideFiles, ['a.md', 'index.md'])
  await assert.rejects(
    () => materialize(old, face),
    (err) => {
      assert.equal(err.code, 'UNSAFE_PATH', err.stack)
      assert.match(err.message, /'notes\/(a|index)\.md' resolves outside the bundle root/)
      return true
    }
  )
  assert.deepEqual(await state(), before, 'materialize changed the face, the files outside it or the vault')
  assert.deepEqual(await entries(base), ['face', 'outside', 'vault'])
  await old.close()

  // A write through a symlink: <face>/new leads outside the face. The mkdir
  // of a parent must not run before the real-path check.
  const base2 = await tmpDir('face-escape-write')
  const v = await Bundle.init(join(base2, 'vault'))
  await v.createConcept('new/sub/a', 'note')
  await v.update()
  const face2 = join(base2, 'face')
  const elsewhere = join(base2, 'elsewhere')
  await mkdir(elsewhere)
  await mkdir(face2)
  await symlink(elsewhere, join(face2, 'new'))
  await assert.rejects(
    () => materialize(v, face2),
    (err) => {
      assert.equal(err.code, 'UNSAFE_PATH', err.stack)
      assert.match(err.message, /'new\/(index|sub\/a|sub\/index)\.md' resolves outside the bundle root/)
      return true
    }
  )
  assert.deepEqual(await entries(elsewhere), [], 'materialize created something outside the face')
  assert.deepEqual(await entries(face2), ['new'], 'materialize wrote to the face')
  assert.deepEqual(await entries(base2), ['elsewhere', 'face', 'vault'])
  await v.close()
})

// ---------- the bundle of an encrypted vault ----------

const SECRET = 'TOP-SECRET-PAYLOAD'

/**
 * An open encrypted vault that holds concept `a` (body SECRET) and concept
 * `z`. materialize writes a.md, index.md and log.md before z.md, in byte order.
 */
async function encryptedAZ(storage) {
  const v = await Bundle.init(storage, { encryptionKey: Buffer.alloc(32, 0xcd) })
  const { tag } = await v.createConcept('a', 'note')
  await v.setBody(tag, null, SECRET)
  await v.createConcept('z', 'note')
  await v.update()
  return v
}

/** A face directory whose z.md is a directory: materialize writes a.md, then fails with EISDIR on z.md. */
async function faceWithDirAtZ(face) {
  await mkdir(join(face, 'z.md'), { recursive: true })
  return face
}

/** Does `face`/a.md hold SECRET? */
async function secretIn(face) {
  return (await readFile(join(face, 'a.md'), 'utf8').catch(() => '')).includes(SECRET)
}

test('materialize announces the plaintext directory before the first write, and a failure partway carries the warning', async () => {
  // materialize must call onPlaintext, and await it, before the first write,
  // and carry the warning in the report and in a later error.
  const base = await tmpDir('enc-announce')
  const v = await encryptedAZ(join(base, 'vault'))
  const warning = (dir) => ({ kind: 'plaintext', path: dir, message: 'now holds the contents of an encrypted vault as plaintext' })
  try {
    /** An onPlaintext that records each warning, and what the face held at that moment. */
    const recorder = (face) => {
      const calls = []
      return { calls, onPlaintext: async (w) => calls.push({ w, secretWritten: await secretIn(face) }) }
    }

    const ok = join(base, 'mat-ok')
    const okRec = recorder(ok)
    const report = await materialize(v, ok, { onPlaintext: okRec.onPlaintext })
    assert.deepEqual(report.warnings, [warning(ok)])
    assert.deepEqual(okRec.calls, [{ w: warning(ok), secretWritten: false }])
    assert.equal(await secretIn(ok), true)

    const face = await faceWithDirAtZ(join(base, 'partial-materialize'))
    const rec = recorder(face)
    await assert.rejects(
      () => materialize(v, face, { onPlaintext: rec.onPlaintext }),
      (err) => {
        assert.equal(err.code, 'EISDIR', err.stack)
        assert.deepEqual(err.warnings, [warning(face)])
        return true
      }
    )
    assert.deepEqual(rec.calls, [{ w: warning(face), secretWritten: false }])
    assert.equal(await secretIn(face), true, 'setup: a.md must hold the plaintext')
  } finally {
    await v.close()
  }

  const plain = await Bundle.init(join(base, 'plain'))
  const calls = []
  const plainReport = await materialize(plain, join(base, 'plain-bundle'), { onPlaintext: (w) => calls.push(w) })
  assert.deepEqual(plainReport.warnings, [])
  assert.deepEqual(calls, [])
  await plain.close()
})

test('materialize marks the bundle of an encrypted vault with .okf-encrypted before it writes a note, and does not write the mark again; the bundle of an unencrypted vault gets no mark', async () => {
  // import refuses a marked bundle without a key. Without the mark, a
  // generation of an encrypted vault can come out unencrypted.
  const base = await tmpDir('enc-mark')
  const v = await encryptedAZ(join(base, 'vault'))
  try {
    // a.md is a directory, so materialize fails at the first note of the
    // plan. The mark must be there already.
    const early = join(base, 'early')
    await mkdir(join(early, 'a.md'), { recursive: true })
    await assert.rejects(() => materialize(v, early), { code: 'EISDIR' })
    assert.deepEqual(await entries(early), ['.okf-encrypted', 'a.md'])

    const face = join(base, 'face')
    assert.equal((await materialize(v, face)).ok, true)
    const first = await stat(join(face, '.okf-encrypted'))
    // atomicWrite renames a new file into place, so a second write gives a
    // new inode.
    const again = await materialize(v, face)
    assert.deepEqual([again.written, again.removed, again.stale], [[], [], []])
    assert.equal((await stat(join(face, '.okf-encrypted'))).ino, first.ino, 'materialize wrote the mark again')
  } finally {
    await v.close()
  }

  const plain = await Bundle.init(join(base, 'plain'))
  await plain.createConcept('a', 'note')
  assert.equal((await materialize(plain, join(base, 'plain-face'))).ok, true)
  assert.ok(!(await entries(join(base, 'plain-face'))).includes('.okf-encrypted'))
  await plain.close()
})

// ---------- the guards of the write and of the plan ----------

test('atomicWrite stops with MODIFIED when the file does not hold the hash that the caller observed, and leaves the file as it is and no temp file', async () => {
  // materialize passes the hash that it read under the path lock. Without
  // this check, a file that a human saves between that read and the rename
  // is overwritten.
  const root = await realpath(await tmpDir('atomic-modified'))
  const file = join(root, 'note.md')
  await writeFile(file, 'a human edit\n')
  const planned = Buffer.from('planned\n')
  for (const [name, hash] of [['another hash', sha256(Buffer.from('the bytes before the edit\n'))], ['no file', null]]) {
    await assert.rejects(
      () => atomicWrite(root, 'note.md', planned, { precondition: { hash } }),
      (err) => {
        assert.equal(err.code, 'MODIFIED', `${name}: ${err.stack}`)
        assert.match(err.message, /'note\.md' changed on disk before rename/)
        return true
      }
    )
    assert.equal(await readFile(file, 'utf8'), 'a human edit\n', name)
    assert.deepEqual(await entries(root), ['note.md'], `${name}: the refusal left a temp file`)
  }

  await atomicWrite(root, 'note.md', planned, { precondition: { hash: await hashFile(file) } })
  assert.equal(await readFile(file, 'utf8'), 'planned\n')
  assert.deepEqual(await entries(root), ['note.md'])
})

test('statOrNull gives null for a path that does not exist, and rejects with every other error of the file system', async () => {
  // ingest reads null as "the file is gone" and can then delete the concept.
  // An error that is not ENOENT must not look like a deleted file.
  const root = await tmpDir('stat-or-null')
  await writeFile(join(root, 'note.md'), 'a file\n')
  assert.equal(await statOrNull(join(root, 'absent.md')), null)
  assert.equal((await statOrNull(join(root, 'note.md'))).isFile(), true)
  await assert.rejects(() => statOrNull(join(root, 'note.md', 'child.md')), { code: 'ENOTDIR' })
})

/**
 * The reader of `v`, with `extra` ([key, value] pairs) added to each scan
 * whose prefix they match. It gives a view that apply cannot produce.
 */
function withKeys(v, extra) {
  return {
    update: () => v.update(),
    val: (key) => v.val(key),
    async *scan(prefix) {
      yield* v.scan(prefix)
      for (const [key, value] of extra) if (key.startsWith(prefix)) yield { key, value }
    }
  }
}

test('readView ignores a key of a kind that it does not know under a concept', async () => {
  const v = await Bundle.init(await tmpDir('view-unknown-kind'))
  const { sales } = await seed(v)
  const known = await readView(v)
  const read = await readView(withKeys(v, [[`${K.cPrefix(sales)}later`, { any: 'value' }]]))
  assert.deepEqual(read, known)
  await v.close()
})

test('the plan never puts two concepts in one file: a concept at the path of a conflicted copy does not replace the copy', async () => {
  // apply rejects a path that ends in .conflict-<hex> (reserved-path), so
  // only a corrupt view holds one. The plan is a Map by file, and without
  // the guard the second concept takes the place of the first in silence.
  const v = await Bundle.init(await tmpDir('plan-one-file'))
  await v.createConcept('shared/note', 'note')
  const { tag: loser } = await v.createConcept('shared/note', 'note')
  await v.update()
  const copy = `shared/note.conflict-${sha256(loser).slice(0, 8)}`
  const plan = await planBundle(v)
  assert.ok(plan.has(`${copy}.md`), 'setup: the collision loser must be a conflicted copy')

  // The id sorts after every real id, so the scan gives the squatter last.
  const squatter = 'f'.repeat(64) + 'ff'
  const corrupt = await planBundle(
    withKeys(v, [
      [K.cMeta(squatter), { created: 1, type: 'note' }],
      [K.cPath(squatter), { path: copy, ord: 99 }]
    ])
  )
  assert.deepEqual([...corrupt.keys()].sort(), [...plan.keys()].sort())
  assert.deepEqual(corrupt.get(`${copy}.md`), plan.get(`${copy}.md`), 'the squatter replaced the conflicted copy')
  await v.close()
})
