// auto-okf example: the DURABLE SLOP ARCHIVE — long-running LLM output that
// must never be `rm -rf`'ed by an agent or lost in /tmp. The append-only
// vault is the STRUCTURAL guarantee: deletion is a tombstone, never a
// byte-destroying act, and no wire op can turn that off.
//
//   node okf/examples/slop-archive/archive.js   (from the repo root, after pnpm install)
//
// What it demonstrates, in order:
//   1. archive     — several "session" concepts (raw LLM output) are written
//                    to a persistent, replicable log
//   2. deletion    — an agent "deletes" a session it thinks is junk. It
//                    vanishes from the materialized bundle (a tombstone) — but
//                    its BYTES and its `_id` remain in the log, fully
//                    recoverable from history (§8)
//   3. recovery    — `UndeleteConcept` restores it and writes a
//                    `flag/undelete` audit record; the body comes back
//                    byte-for-byte
//   4. guarantee   — the archive CANNOT be rm'ed: `appendOnly: true` is an
//                    immutable vault-metadata constant (loaded at open, refuses
//                    a tampered document), and the entire 12-op wire contract
//                    contains NO prune / compact / byte-destroying op at all
//
// Determinism: a fixed writer key pair and pinned `at` timestamps make every
// byte under out/ identical on every run (I9; asserted by
// okf/test/example-slop-archive.test.js). Do not hand-edit out/.
import { mkdir } from 'node:fs/promises'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'hypercore-crypto'
import { initVault } from '@auto-okf/store'
import { materialize } from '@auto-okf/faces'
import { keyspace as K, OP_TYPES } from '@auto-okf/core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')

const OUT = process.env.OKF_SLOP_ARCHIVE_OUT ? resolve(process.env.OKF_SLOP_ARCHIVE_OUT) : join(HERE, 'out')
const STORAGE = process.env.OKF_SLOP_ARCHIVE_STORAGE
  ? resolve(process.env.OKF_SLOP_ARCHIVE_STORAGE)
  : join(REPO, 'sslop', '035', 'tmp', 'slop-archive', `run-${process.pid}-${Date.now()}`)

// §8: `at` is informational (never a merge input) — the sole source of the
// log.md date headings. Pin it so the dump is byte-deterministic.
const DAY = Date.UTC(2026, 6, 10) // 2026-07-10
let ticks = 0
const at = () => ({ at: DAY + ticks++ * 1000 })
const say = (msg) => console.log(msg)

// A few "sessions" of raw LLM output — the kind of thing that accretes in a
// charlie.dev-style slop/ + ctx/ working set and must survive across weeks.
const SESSIONS = [
  {
    path: 'sessions/2026-07-08-schema-review',
    title: 'Schema review — caching layer',
    body: 'Model reviewed the caching schema. Flagged a missing TTL index; suggested a composite key. Kept for provenance.'
  },
  {
    path: 'sessions/2026-07-09-hallucinated-api',
    title: 'API brainstorm (contains a hallucination)',
    body: 'Model proposed a `vault.gc()` API that does not exist. WRONG — auto-okf has no such op. Archived anyway: a wrong answer is still evidence.'
  },
  {
    path: 'sessions/2026-07-09-migration-plan',
    title: 'Migration plan draft',
    body: 'Step 1: snapshot. Step 2: dual-write. Step 3: cut over. Solid; promote to an RFC next session.'
  },
  {
    path: 'sessions/2026-07-10-retro',
    title: 'Retro notes',
    body: 'What worked: append-only archive. What to change: tag sessions by project.'
  }
]

async function main() {
  await mkdir(STORAGE, { recursive: true })
  console.log('=== slop-archive: an append-only archive an agent cannot rm ===\n')

  const vault = await initVault(join(STORAGE, 'vault'), { keyPair: crypto.keyPair(Buffer.alloc(32, 42)) })
  say(`opened the archive vault (key ${vault.keyHex.slice(0, 16)}…)`)
  say(`vault-metadata constant: appendOnly = ${vault.metadata.appendOnly} (§8, loaded from disk, immutable)\n`)

  // ---- 1. archive several sessions ----------------------------------------
  say('--- archiving LLM sessions ---')
  const ids = {}
  for (const s of SESSIONS) {
    const { tag } = await vault.createConcept(s.path, 'session', at())
    ids[s.path] = tag
    await vault.setField(tag, 'title', s.title, at())
    await vault.addTag(tag, 'llm-output', at())
    await vault.setBody(tag, null, s.body, at())
    say(`  archived ${s.path}  (_id ${tag.slice(0, 12)}…)`)
  }
  await vault.update()

  // ---- 2. an agent "deletes" the hallucinated session ---------------------
  console.log('\n--- an agent tries to erase the hallucinated session ---')
  const victim = ids['sessions/2026-07-09-hallucinated-api']
  await vault.deleteConcept(victim, at())
  await vault.update()
  const metaAfter = await vault.val(K.cMeta(victim))
  say(`DeleteConcept applied. c/${victim.slice(0, 12)}…/meta now carries a \`deleted\` tag: ${metaAfter.deleted.slice(0, 12)}…`)
  say('the session is now SUPPRESSED from materialize / index.md / path/ — it looks gone.')

  // ...but it is a tombstone, not destruction: the bytes are still in the log.
  const head = await vault.val(K.cBody(victim))
  const rev = await vault.val(K.cRev(victim, head))
  say('\nbut the archive is append-only — the bytes were NOT destroyed:')
  say(`  recovered body from history (c/…/rev/${head.slice(0, 12)}…):`)
  say(`    "${rev.text}"`)

  // ---- 3. recover it ------------------------------------------------------
  console.log('\n--- recovery: undelete restores it byte-for-byte ---')
  await vault.undeleteConcept(victim, at())
  await vault.update()
  const restored = await vault.val(K.cMeta(victim))
  let undeletes = 0
  for await (const _ of vault.scan(K.flagPrefix('undelete'))) undeletes++
  say(`UndeleteConcept applied. \`deleted\` tag cleared: ${restored.deleted === undefined}. flag/undelete audit records: ${undeletes} (§8)`)

  // ---- 4. why an agent cannot rm the archive ------------------------------
  console.log('\n--- the structural guarantee ---')
  const destructive = OP_TYPES.filter((t) => /prune|compact|gc|destroy|purge|rm|drop/.test(t))
  say(`the entire wire contract is ${OP_TYPES.length} ops; ops that destroy bytes: ${destructive.length}`)
  say(`  ${OP_TYPES.join(', ')}`)
  say('DeleteConcept is a tombstone; there is no prune/compact/gc op to represent, so an agent')
  say('literally cannot express "erase this from history". appendOnly lives OUTSIDE the log — no')
  say('op can flip it, and a tampered okf-vault.json refuses to open. Byte reclamation is an')
  say('operator-only epoch-cycle (compact), never an agent action.')

  // ---- 5. dump the archive ------------------------------------------------
  console.log('\n--- archive dump ---')
  const report = await materialize(vault, OUT)
  if (report.pendingIngest.length > 0 || report.unsafe.length > 0) {
    throw new Error(
      `out/ has hand-edited or unsafe files (${[...report.pendingIngest, ...report.unsafe.map((u) => u.rel)].join(', ')}); ` +
        'out/ is generated — revert it and re-run'
    )
  }
  const files = [...report.written, ...report.unchanged].sort()
  say(`materialized ${files.length} files to ${relative(process.cwd(), OUT)}/ (all ${SESSIONS.length} sessions live — the deleted one was recovered):`)
  for (const f of files) console.log(`  ${f}`)

  console.log(`
=== what just happened ===
We archived four LLM sessions, an agent deleted one, and we recovered it. The
delete was a tombstone — the bytes never left the log, and \`UndeleteConcept\`
brought the session back verbatim with a \`flag/undelete\` audit trail. Deletion
is dangerous, so auto-okf makes destruction UNREPRESENTABLE: append-only is a
vault-metadata constant no op can touch, and the wire contract has no
byte-destroying op at all. out/ is the readable dump; the log is the durable,
recoverable source of truth.
`)

  await vault.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
