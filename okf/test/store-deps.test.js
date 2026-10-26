// Store scope (T21): autobee resolves hypercore-crypto in this workspace.
//
// autobee@2.12.1 requires `hypercore-crypto` (index.js:11,
// lib/encoding.js:3, lib/encryption.js:3, lib/migrations.js:3) but
// declares it only in devDependencies (package.json:44). pnpm does not
// link a dev dependency of a dependency, so the require resolves only if
// the workspace hoists `hypercore-crypto` to a node_modules directory
// above autobee's. This workspace does not change autobee's manifest. It
// hoists the package publicly instead (`publicHoistPattern` in
// pnpm-workspace.yaml), so the require does not depend on pnpm's hidden
// hoist (`hoist=true`, the default).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIX = 'Keep "publicHoistPattern: [hypercore-crypto]" in pnpm-workspace.yaml, then run pnpm install.'

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

test('the workspace hoists hypercore-crypto publicly', () => {
  const hoisted = fileURLToPath(new URL('../../node_modules/hypercore-crypto/package.json', import.meta.url))
  assert.ok(
    existsSync(hoisted),
    `HYPERCORE_CRYPTO_NOT_PUBLIC: ${hoisted} does not exist. autobee then ` +
      `resolves hypercore-crypto only through pnpm's hidden hoist. ${FIX}`
  )
})
