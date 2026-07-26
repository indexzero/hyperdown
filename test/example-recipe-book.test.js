// The flagship example is executable documentation AND an I9 fixture: this
// test RUNS vault-ld/examples/recipe-book end to end (four real vault
// peers on disk) into a fresh scratch dir and asserts the freshly generated
// output is byte-identical to the committed vault-ld/examples/recipe-book/out/
// tree. If this fails after an intentional semantic change, regenerate with
// `node vault-ld/examples/recipe-book` and commit the new out/ — never
// hand-edit it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { treeHashes } from './faces-helpers.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXAMPLE = join(ROOT, 'vault-ld', 'examples', 'recipe-book')
const RUN = `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

test('recipe-book example regenerates the committed out/ byte-identically (I9)', async () => {
  const scratch = join(ROOT, 'sslop', '015', 'tmp', RUN, 'recipe-book')
  await mkdir(scratch, { recursive: true })
  const outDir = join(scratch, 'out')

  const { code, stdout, stderr } = await new Promise((resolve) => {
    execFile(
      'node',
      [join(EXAMPLE, 'index.js')],
      {
        cwd: ROOT,
        timeout: 300000,
        env: { ...process.env, RECIPE_BOOK_OUT: outDir, RECIPE_BOOK_STORAGE: join(scratch, 'storage') }
      },
      (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr })
    )
  })
  assert.equal(code, 0, `example failed:\n${stdout}\n${stderr}`)

  // the narrative hits the semantics it claims to demonstrate
  assert.match(stdout, /hasIngredient UNIONED across writers: Basil, Garlic, Olive Oil, Saffron, Tomato/, 'I5 or-set union')
  assert.match(stdout, /1 flag\/clobber record\(s\)/, '§5.4 LWW supersession surfaced')
  assert.match(stdout, /1 flag\/conflict record\(s\)/, '§6 body conflict kept')
  assert.match(stdout, /flag\/conflict drained by the ResolveConflict op: 0 left/, '§6 resolution')
  assert.match(stdout, /still dangling .*: Herbes de Provence/, '§7 honest TODO')

  // byte-identical regeneration of the committed tree (I9)
  const fresh = await treeHashes(outDir)
  const committed = await treeHashes(join(EXAMPLE, 'out'))
  assert.ok(committed.size > 0, 'committed out/ exists (run `node vault-ld/examples/recipe-book`)')
  assert.deepEqual(
    [...fresh.entries()],
    [...committed.entries()],
    'fresh run differs from committed out/ — regenerate with `node vault-ld/examples/recipe-book` and commit'
  )
})
