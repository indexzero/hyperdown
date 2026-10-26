// Store scope (T21): the store loads without pnpm's hidden hoist.
//
// pnpm links only the dependencies that a package declares. Two packages
// in the store's tree require a package that they do not declare:
//
// - autobee@2.12.1 requires `hypercore-crypto` (index.js:11,
//   lib/encoding.js:3, lib/encryption.js:3, lib/migrations.js:3) but
//   declares it only in devDependencies (package.json:44).
// - bogon@1.3.0 (hyperswarm -> hyperdht -> bogon) requires `b4a`
//   (index.js:3) but does not declare it.
//
// Each require resolves only if the workspace hoists the package to a
// node_modules directory above the package that requires it. This
// workspace does not change their manifests. It hoists the two packages
// publicly instead (`publicHoistPattern` in pnpm-workspace.yaml), so the
// store does not depend on pnpm's hidden hoist (`hoist=true`, the
// default).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC = ['hypercore-crypto', 'b4a']
const FIX = `Keep "publicHoistPattern: [${PUBLIC.join(', ')}]" in pnpm-workspace.yaml, then run pnpm install.`

// autobee as the store loads it: resolved from @auto-okf/store, which
// depends on it.
const storeRequire = createRequire(new URL('../store/package.json', import.meta.url))
const autobeeManifest = storeRequire.resolve('autobee/package.json')
const autobeeRequire = createRequire(autobeeManifest)

test('autobee resolves hypercore-crypto from its own directory', () => {
  let entry
  try {
    entry = autobeeRequire.resolve('hypercore-crypto')
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err
    assert.fail(
      `HYPERCORE_CRYPTO_UNRESOLVED: autobee (${dirname(autobeeManifest)}) cannot ` +
        'resolve hypercore-crypto. autobee requires it but declares it only in ' +
        `devDependencies, so the store cannot load. ${FIX}`
    )
  }
  assert.equal(typeof autobeeRequire(entry).keyPair, 'function')
})

test('the store loads', async () => {
  let store
  try {
    store = await import('../store/index.js')
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err
    const missing = /Cannot find module '([^']+)'/.exec(err.message)?.[1]
    assert.fail(
      `STORE_DEPENDENCY_UNRESOLVED: ${err.requireStack?.[0]} cannot resolve ` +
        `${missing}, so the store cannot load. If the package that requires ` +
        `${missing} does not declare it, hoist it publicly. ${FIX}`
    )
  }
  assert.equal(typeof store.Bundle, 'function')
})

for (const name of PUBLIC) {
  test(`the workspace hoists ${name} publicly`, () => {
    const hoisted = fileURLToPath(new URL(`../../node_modules/${name}/package.json`, import.meta.url))
    assert.ok(
      existsSync(hoisted),
      `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_NOT_PUBLIC: ${hoisted} does not exist. ` +
        `The package that requires ${name} then resolves it only through pnpm's hidden hoist. ${FIX}`
    )
  })
}
