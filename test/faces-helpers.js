// Shared harness for the @hyperwiki/faces tests: real @hyperwiki/store
// vaults (autobee + corestore on disk) plus on-disk face directories.
// Test dirs are unique per run under sslop/014/tmp/ (never /tmp, never
// cleaned up — handles are closed, files are left for post-mortem).
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export { Vault } from '../packages/store/index.js'
export { keyspace as K, canonical, revHash } from '../packages/core/index.js'
export * as faces from '../packages/faces/index.js'
export { pair, until, converged, sleep } from './store-helpers.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUN = `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let seq = 0

/** Unique on-disk scratch dir (vault storage or face dir). */
export async function tmpDir(name) {
  const dir = join(ROOT, 'sslop', '014', 'tmp', RUN, `${name}-${seq++}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Seed one vault with the fixture graph used across the faces tests:
 * a scope, keyword aliases, lww + or-set + @id-typed terms, a schema
 * class (authored Ontologies/ path), an instance with body/refs/host/
 * unmapped keys, and a note pinned off its default location.
 */
export async function seedVault(v) {
  await v.defineScope('culinary', 'https://example.org/culinary#', 'cul')
  await v.defineTerm('culinary', 'type', '@type')
  await v.defineTerm('culinary', 'id', '@id')
  await v.defineTerm('culinary', 'title', { '@id': 'cul:title' })
  await v.defineTerm('culinary', 'servings', { '@id': 'cul:servings' })
  await v.defineTerm('culinary', 'topic', { '@id': 'cul:topic', '@container': '@set' })
  await v.defineTerm('culinary', 'subClassOf', {
    '@id': 'rdfs:subClassOf',
    '@type': '@id',
    '@container': '@set'
  })

  // schema class with an authored path (layer 'schema' via §10.1 rule (1))
  await v.addMember('Recipe', 'type', 'owl:Class')
  await v.addMember('Recipe', 'subClassOf', 'cul:Food')
  await v.append('set-path', { s: 'Recipe', path: 'Ontologies/culinary/Classes/Recipe', scope: 'culinary' })

  // instance note: register, or-set with a ref, body, host key, unmapped key
  await v.setField('Home', 'title', 'Welcome home')
  await v.setField('Home', 'servings', 4)
  await v.addMember('Home', 'topic', 'p2p')
  await v.addMember('Home', 'topic', { ref: 'Recipe' })
  await v.setField('Home', 'tags', ['demo', 'wiki'])
  await v.setField('Home', 'mood', 'blue') // unmapped: no context mapping
  await v.setBody('Home', null, 'Hello **world**')

  // a note pinned off its reconstructable default (vld:path material)
  await v.setField('Pinned', 'title', 'pinned note')
  await v.append('set-path', { s: 'Pinned', path: 'Notes/Deep/Pinned', scope: null })

  await v.update()
}

/** Sorted rel -> sha256 map of every file under dir (byte identity). */
export async function treeHashes(dir) {
  const out = new Map()
  await walk(dir, '', out)
  return new Map([...out.entries()].sort())
}

async function walk(root, rel, out) {
  const abs = rel === '' ? root : join(root, rel)
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  for (const e of entries) {
    const childRel = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) await walk(root, childRel, out)
    else if (e.isFile()) {
      out.set(childRel, createHash('sha256').update(await readFile(join(root, childRel))).digest('hex'))
    }
  }
}

/** One comparable digest for a whole tree. */
export async function treeHash(dir) {
  const h = createHash('sha256')
  for (const [rel, hash] of await treeHashes(dir)) h.update(rel + '\x00' + hash + '\n')
  return h.digest('hex')
}

/** Wrap a watcher's append so every emitted op is captured. */
export function captureOps(watcher) {
  const ops = []
  const inner = watcher.append
  watcher.append = (type, payload) => {
    ops.push({ type, payload })
    return inner(type, payload)
  }
  return ops
}

export const readText = (dir, rel) => readFile(join(dir, rel), 'utf8')
