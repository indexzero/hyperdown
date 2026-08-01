// auto-okf example: VLURP-LIBRARY curation — one script that turns a
// vlurpfile into an `_id`-stamped OKF bundle with provenance frontmatter
// (source repo, pinned ref, content hash).
//
//   node okf/examples/vlurp-library/import.js   (from the repo root, after pnpm install)
//
// The pipeline:  vlurpfile  ->  staging dir  ->  OKF bundle (out/)
//
//   1. vlurp is IMMUTABLE — we never modify it. If the `vlurp` binary is on
//      PATH (and OKF_VLURP_USE_BINARY=1), we shell out to fetch the pinned ref
//      into a staging dir. If it is absent or offline — the default, and
//      always in tests — we fall back to a COMMITTED FIXTURE under this example
//      dir, so the run NEVER needs the network. Either way each file is
//      verified against the `sha256` pin in the vlurpfile, so the bytes are
//      identical whichever source supplied them (this is exactly vlurp's own
//      "hash every file / pin to commits" contract).
//   2. Fetched bytes land in a STAGING dir (scratch under sslop/), never
//      directly in the bundle.
//   3. Each staged file is imported as a concept, stamped with an `_id` and
//      provenance frontmatter (`source`, `ref`, `sha256`). The `_id` comes
//      from a path -> existing-id lookup: a path already in the vault reuses
//      its id, so RE-IMPORT DOES NOT DUPLICATE concepts (the script imports
//      twice and proves the second pass mints nothing).
//   4. The bundle is materialized to out/.
//
// Determinism: a fixed writer key pair, pinned `at` timestamps, and the
// content-hash-pinned fixture make every byte under out/ identical on every
// run (I9; asserted by okf/test/example-vlurp-library.test.js, which runs
// fully offline). Do not hand-edit out/.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'hypercore-crypto'
import { Bundle } from '@auto-okf/store'
import { materialize } from '@auto-okf/faces'
import { keyspace as K, normalizePath } from '@auto-okf/core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')

const OUT = process.env.OKF_VLURP_OUT ? resolve(process.env.OKF_VLURP_OUT) : join(HERE, 'out')
const RUN = `run-${process.pid}-${Date.now()}`
const STAGING = process.env.OKF_VLURP_STAGING
  ? resolve(process.env.OKF_VLURP_STAGING)
  : join(REPO, 'sslop', '035', 'tmp', 'vlurp-library', RUN, 'staging')
const STORAGE = process.env.OKF_VLURP_STORAGE
  ? resolve(process.env.OKF_VLURP_STORAGE)
  : join(REPO, 'sslop', '035', 'tmp', 'vlurp-library', RUN, 'storage')
const FIXTURES = join(HERE, 'fixtures')

// Opt-in: only shell out to the vlurp binary when explicitly asked AND it is
// on PATH. The default (and the test) is the offline fixture — hermetic.
const USE_BINARY = process.env.OKF_VLURP_USE_BINARY === '1'

const DAY = Date.UTC(2026, 6, 12) // 2026-07-12
let ticks = 0
const at = () => ({ at: DAY + ticks++ * 1000 })
const say = (msg) => console.log(msg)
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function vlurpOnPath() {
  try {
    execFileSync('vlurp', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Stage one file: fetch with the vlurp binary if opted in and available,
 * else copy the committed fixture. Verify the content hash against the
 * vlurpfile pin; on ANY mismatch or fetch failure, fall back to the fixture
 * (drift/offline protection). Returns { bytes, source }.
 */
async function stageFile(file, spec, useBinary) {
  const stagedPath = join(STAGING, file.src)
  await mkdir(dirname(stagedPath), { recursive: true })

  if (useBinary) {
    try {
      // vlurp <user>/<repo> -d <dir> --ref <commit> --filter <glob>
      execFileSync('vlurp', [spec.repo, '-d', STAGING, '--ref', spec.ref, '--filter', spec.filter], {
        stdio: 'ignore'
      })
      const bytes = await readFile(stagedPath)
      if (sha256(bytes) === file.sha256) return { bytes, source: 'vlurp' }
    } catch {
      /* fall through to the fixture */
    }
  }

  const bytes = await readFile(join(FIXTURES, file.src))
  const hash = sha256(bytes)
  if (hash !== file.sha256) {
    throw new Error(`fixture ${file.src} hashes ${hash}, vlurpfile pins ${file.sha256} — provenance broken`)
  }
  await writeFile(stagedPath, bytes)
  return { bytes, source: 'fixture' }
}

function titleOf(text) {
  const m = text.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : null
}

/**
 * Import every staged file into the vault. Each dest path is looked up in the
 * `path/` index: a path already held by a concept REUSES that concept's `_id`
 * (no new mint); a new path mints. Returns { minted, unchanged, updated }.
 */
async function importStaged(vault, files, staged, spec) {
  const counts = { minted: 0, unchanged: 0, updated: 0 }
  for (const file of files) {
    const dest = normalizePath(file.dest)
    const text = staged.get(file.src).toString('utf8')
    const existing = await vault.val(K.path(dest)) // path -> existing _id (or undefined)

    if (existing === undefined) {
      // New path: mint an _id and stamp provenance frontmatter.
      const { tag: id } = await vault.createConcept(dest, 'context', at())
      const title = titleOf(text)
      if (title) await vault.setField(id, 'title', title, at())
      await vault.setField(id, 'source', spec.source, at())
      await vault.setField(id, 'ref', spec.ref, at())
      await vault.setField(id, 'sha256', file.sha256, at())
      await vault.setBody(id, null, text, at())
      counts.minted++
      continue
    }

    // Re-import: the path already maps to a known _id (path -> existing-id
    // lookup stamps it). If the content hash is unchanged there is nothing to
    // do; a changed hash would be an ORDINARY diff (SetField + SetBody),
    // audited by flag/clobber on the cross-writer register — never a new id.
    const prior = await vault.val(K.cField(existing, 'sha256'))
    if (prior && prior.values && prior.values[0] === file.sha256) {
      counts.unchanged++
    } else {
      await vault.setField(existing, 'sha256', file.sha256, at())
      const head = await vault.val(K.cBody(existing))
      await vault.setBody(existing, head ?? null, text, at())
      counts.updated++
    }
  }
  await vault.update()
  return counts
}

async function main() {
  await rm(STAGING, { recursive: true, force: true })
  await mkdir(STORAGE, { recursive: true })
  console.log('=== vlurp-library: vlurpfile -> staging -> _id-stamped OKF bundle ===\n')

  const spec = JSON.parse(await readFile(join(HERE, 'vlurpfile.json'), 'utf8'))
  const useBinary = USE_BINARY && vlurpOnPath()
  say(`source: ${spec.repo}@${spec.ref}  (filter ${spec.filter})`)
  say(`vlurp binary: ${useBinary ? 'on PATH — will fetch, verify against pins' : 'not used — offline committed fixture'} (vlurp is immutable, never modified)\n`)

  // ---- 1. fetch to a staging dir (never into the bundle) ------------------
  say('--- staging (fetch + content-hash verify) ---')
  const staged = new Map()
  for (const file of spec.files) {
    const { bytes, source } = await stageFile(file, spec, useBinary)
    staged.set(file.src, bytes)
    say(`  ${file.src}  <- ${source}  sha256 ${file.sha256.slice(0, 12)}… ✓`)
  }
  say(`staged ${staged.size} files under ${relative(process.cwd(), STAGING)}/ (transient scratch, never committed)\n`)

  // ---- 2. import: stamp _id + provenance ----------------------------------
  const vault = await Bundle.init(join(STORAGE, 'vault'), { keyPair: crypto.keyPair(Buffer.alloc(32, 77)) })

  say('--- first import ---')
  const first = await importStaged(vault, spec.files, staged, spec)
  say(`minted ${first.minted}, updated ${first.updated}, unchanged ${first.unchanged}`)

  say('\n--- second import of the SAME staging (re-import) ---')
  const second = await importStaged(vault, spec.files, staged, spec)
  say(`minted ${second.minted}, updated ${second.updated}, unchanged ${second.unchanged}`)

  let concepts = 0
  for await (const { key } of vault.scan(K.cRoot())) if (key.endsWith('/meta')) concepts++
  say(`\nconcepts in the vault: ${concepts} (not ${spec.files.length * 2}) — re-import reused every _id via path->id lookup, no duplicates`)

  // ---- 3. materialize ------------------------------------------------------
  console.log('\n--- materialize the curated library ---')
  const report = await materialize(vault, OUT)
  if (report.pendingIngest.length > 0 || report.unsafe.length > 0) {
    throw new Error(
      `out/ has hand-edited or unsafe files (${[...report.pendingIngest, ...report.unsafe.map((u) => u.rel)].join(', ')}); ` +
        'out/ is generated — revert it and re-run'
    )
  }
  const files = [...report.written, ...report.unchanged].sort()
  say(`materialized ${files.length} files to ${relative(process.cwd(), OUT)}/:`)
  for (const f of files) console.log(`  ${f}`)

  console.log(`
=== what just happened ===
We vlurped three upstream docs into a staging dir (offline, from a committed
fixture, verified against the vlurpfile's content-hash pins), then imported
them into an OKF bundle — each concept stamped with a minted _id and provenance
frontmatter (source repo, pinned ref, content hash). Importing the same staging
a second time minted NOTHING: the path -> existing-id lookup reused every _id,
so a re-vlurp of unchanged upstream is a no-op and a changed upstream would land
as an ordinary diff, not a duplicate. Fetched bytes stayed in staging; only the
_id-stamped bundle is under out/.
`)

  await vault.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
