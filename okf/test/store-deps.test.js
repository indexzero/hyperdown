// pnpm links only the dependencies that a package declares. autobee
// requires `hypercore-crypto` but declares it only in devDependencies.
// bogon (hyperswarm -> hyperdht -> bogon) requires `b4a` and does not
// declare it. The workspace hoists both publicly (`publicHoistPattern` in
// pnpm-workspace.yaml), so neither require depends on pnpm's hidden hoist
// (`hoist=true`, the default).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC = ['hypercore-crypto', 'b4a']
const FIX = `Keep "publicHoistPattern: [${PUBLIC.join(', ')}]" in pnpm-workspace.yaml, then run pnpm install.`

// autobee as the store resolves it, from @auto-okf/store.
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

// The exact pins. okf/DEVIATIONS.md, "Substrate behaviour that okf relies
// on", records autobee and corestore behaviour that their READMEs do not
// document. The ban table of Bundle.swarm() reads hyperswarm state that
// the hyperswarm README does not document. A patch release can change
// that behaviour. So okf/store/package.json declares each version with no
// range, and the store must resolve that version.
const SUBSTRATE =
  'okf/DEVIATIONS.md, section "Substrate behaviour that okf relies on (autobee@2.12.1)", ' +
  'paragraph "The pins, and the corestore floor", says why.'
const SWARM =
  'okf/store/README.md, section "Replication", item "A bounded ban table", says why: ' +
  'the store reads hyperswarm state that the hyperswarm README does not document.'
const PINS = {
  autobee: { version: '2.12.1', why: SUBSTRATE },
  corestore: { version: '7.16.1', why: SUBSTRATE },
  hyperswarm: { version: '4.17.0', why: SWARM }
}
const storeManifest = JSON.parse(readFileSync(new URL('../store/package.json', import.meta.url), 'utf8'))

for (const [name, { version, why: WHY }] of Object.entries(PINS)) {
  const code = name.toUpperCase()

  test(`the store pins ${name} at exactly ${version}`, () => {
    const declared = storeManifest.dependencies[name]
    assert.equal(
      declared,
      version,
      `${code}_PIN_NOT_EXACT: okf/store/package.json declares ${name} "${declared}", not "${version}". ` +
        `Pin it at exactly "${version}", then run pnpm install. ${WHY}`
    )
  })

  test(`the store resolves ${name} ${version}`, () => {
    const manifest = storeRequire.resolve(`${name}/package.json`)
    const resolved = JSON.parse(readFileSync(manifest, 'utf8')).version
    assert.equal(
      resolved,
      version,
      `${code}_VERSION_DRIFT: the store resolves ${name} ${resolved} (${manifest}), not ${version}. ` +
        `Run pnpm install --frozen-lockfile. ${WHY}`
    )
  })
}
