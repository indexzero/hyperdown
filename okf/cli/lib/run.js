// auto-okf CLI (okf SPEC §13): a thin veneer over @auto-okf/store (vault
// lifecycle + §8 governance ops) and @auto-okf/faces (materialize, ingest
// watcher, per-file status, wanted index, generation-cycle compact). The
// CLI never writes the view or the face itself — every effect flows through
// the packages, so everything it does is exactly what a library caller does.
//
// The command surface is declared once as a paparam command tree (paparam is
// Holepunch's own parser — pear's CLI runs on it): a root command composing
// the 13 subcommands from command()/flag()/arg(), with --help|-h and all help
// text generated from the declarations.
//
// Exit codes: 0 success, 1 operational error, 2 usage error, 3 materialize
// projected everything owned but left pending-ingest file(s) in place
// (ADR-004). paparam's
// parse() returns null on any parse failure; the wrapper maps that — unknown
// flag/command, extra arguments, bad flag values, and (via per-command
// validate()) missing required arguments — to 2, never letting paparam pick
// the code. Unknown flags are rejected strictly, as before.
import { readFile, access, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import b4a from 'b4a'
import { command, flag, arg, rest, summary, header, footer, bail, validate } from 'paparam'
import { keyspace as K } from '@auto-okf/core'
import { Bundle, METADATA_FILE } from '@auto-okf/store'
import { materialize, createIngestWatcher, wanted, compact, status } from '@auto-okf/faces'

const TITLE = 'auto-okf — multi-writer OKF bundles on autobee (okf SPEC §13)'
const FOOTER = 'exit codes: 0 ok, 1 error, 2 usage, 3 pending-ingest only (materialize)'

class UsageError extends Error {}

// ADR-006 wrong-tool guardrail: the sibling system's marker file is stable
// contract between the twin CLIs; auto-okf refuses vault-ld storage
// pointedly (naming the right tool) instead of opening it.
const SIBLING_MARKER = 'vault-ld.json'

class WrongToolError extends Error {}

async function refuseSiblingVault(dir) {
  try {
    await access(join(dir, SIBLING_MARKER))
  } catch {
    return
  }
  throw new WrongToolError(
    `${dir} is a vault-ld vault (${SIBLING_MARKER} present); use autovault-ld, not auto-okf`
  )
}

/** Run the CLI. Returns the process exit code. */
export async function run(argv) {
  const { root, captured } = buildCli()

  // Parity with the pre-paparam CLI: `auto-okf help` prints help and exits 0.
  if (argv[0] === 'help') {
    process.stdout.write(root.help())
    return 0
  }

  let parsed = null
  try {
    parsed = root.parse(argv, { run: false })
  } catch (err) {
    process.stderr.write(`auto-okf: ${err && err.message ? err.message : err}\n`)
    return 2
  }

  if (parsed === null) {
    // Either --help|-h (paparam printed the generated help; success) or a
    // parse bail (captured by the bail handler; usage error).
    if (captured.bail === null) return 0
    const b = captured.bail
    process.stderr.write(`${formatBail(b, root)}\n\n${(b.command || root).help()}`)
    return 2
  }

  if (parsed === root) {
    // Bare `auto-okf` with no command: print help, exit 2 (usage).
    process.stdout.write(root.help())
    return 2
  }

  const handler = HANDLERS[parsed.name]
  try {
    return await handler(parsed)
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`auto-okf ${parsed.name}: ${err.message}\n\n${parsed.help()}`)
      return 2
    }
    if (err instanceof WrongToolError) {
      // ADR-006: the refusal shape is pinned — `error: <dir> is a … vault
      // (<marker> present); use <tool>, not <this tool>`.
      process.stderr.write(`error: ${err.message}\n`)
      return 1
    }
    process.stderr.write(`auto-okf ${parsed.name}: ${err && err.message ? err.message : err}\n`)
    return 1
  }
}

// ---------- command tree (paparam) ----------

/**
 * Build the paparam command tree. Returns { root, captured }; captured.bail
 * holds the paparam bail object after a failed parse (null otherwise), so the
 * wrapper can map every parse failure to exit 2.
 */
function buildCli() {
  const captured = { bail: null }

  // Every subcommand carries the title header; the root adds the literal
  // usage synopsis line beneath it (paparam's own oneliner renders as
  // `auto-okf [flags] [command]`).
  const sub = (name, sum, ...mods) => command(name, header(TITLE), summary(sum), ...mods)

  const cmds = [
    sub(
      'init',
      "create a new vault; this peer's key is the vault key and the genesis indexer",
      arg('<dir>', 'vault storage directory'),
      flag('--encryption-key <hex64>', 'encrypt the vault with this key (64 hex chars)'),
      requiredArgs('<dir>')
    ),
    sub(
      'join',
      'join an existing vault by key (key optional when <dir> is pinned)',
      arg('<dir>', 'vault storage directory'),
      arg('[vault-key]', 'vault key (64 hex chars; optional when <dir> is pinned)'),
      flag('--encryption-key <hex64>', 'encrypt the vault with this key (64 hex chars)'),
      flag('--metadata <invite.json>', 'invite metadata file'),
      requiredArgs('<dir>')
    ),
    sub(
      'add-writer',
      'admit a writer (indexer-issued op)',
      arg('<dir>', 'vault storage directory'),
      arg('<writer-key>', 'writer public key (64 hex chars)'),
      flag('--indexer', 'admit the writer as an indexer'),
      requiredArgs('<dir>', '<writer-key>')
    ),
    sub(
      'remove-writer',
      'revoke a writer (indexer-issued op)',
      arg('<dir>', 'vault storage directory'),
      arg('<writer-key>', 'writer public key (64 hex chars)'),
      requiredArgs('<dir>', '<writer-key>')
    ),
    sub(
      'materialize',
      'project the OKF v0.1 bundle to disk',
      arg('<dir>', 'vault storage directory'),
      arg('<bundle-dir>', 'OKF bundle directory'),
      flag('--force-mirror', 'restore unconditional mirroring'),
      requiredArgs('<dir>', '<bundle-dir>')
    ),
    sub(
      'ingest',
      'fold on-disk edits back in as ops (one-shot)',
      arg('<dir>', 'vault storage directory'),
      arg('<bundle-dir>', 'OKF bundle directory'),
      rest('[...paths]', 'bundle-relative concept files restricting the scan set (ADR-001)'),
      flag('--confirm-deletes', 'let a file deleted on disk emit DeleteConcept'),
      requiredArgs('<dir>', '<bundle-dir>')
    ),
    sub(
      'watch',
      'foreground ingest watcher (+ optional swarm)',
      arg('<dir>', 'vault storage directory'),
      arg('<bundle-dir>', 'OKF bundle directory'),
      flag('--swarm', "join the vault's hyperswarm topic for replication"),
      flag('--confirm-deletes', 'let a file deleted on disk emit DeleteConcept'),
      flag('--debounce <ms>', 'ingest debounce in milliseconds'),
      requiredArgs('<dir>', '<bundle-dir>')
    ),
    sub(
      'status',
      'per-file vault/bundle state, read-only (in-log, pending-ingest, dirty, absent, foreign)',
      arg('<dir>', 'vault storage directory'),
      arg('<bundle-dir>', 'OKF bundle directory'),
      flag('--json', 'print the structured rows'),
      requiredArgs('<dir>', '<bundle-dir>')
    ),
    sub(
      'wanted',
      'print the ranked demand index (wanted/)',
      arg('<dir>', 'vault storage directory'),
      flag('--json', 'print the structured rows'),
      requiredArgs('<dir>')
    ),
    sub(
      'flags',
      'list/inspect the flag queue (flag/)',
      arg('<dir>', 'vault storage directory'),
      arg('[family]', 'flag family (conflict, clobber, pathcollision, …)'),
      flag('--json', 'print the structured rows'),
      requiredArgs('<dir>')
    ),
    sub(
      'compact',
      'generation-cycle compaction into a fresh vault',
      arg('<dir>', 'vault storage directory'),
      arg('<out-dir>', 'directory for the fresh generation vault'),
      flag('--force', 'compact despite open conflict/pathcollision flags'),
      flag('--face <dir>', 'hydrated face directory (default: <out-dir>.face)'),
      flag('--encryption-key <hex64>', 'encrypt the fresh vault with this key (64 hex chars)'),
      requiredArgs('<dir>', '<out-dir>')
    ),
    sub(
      'resolve',
      'resolve an open body conflict on <id>',
      arg('<dir>', 'vault storage directory'),
      arg('<id>', 'concept id'),
      flag('--keep <revHash>', 'revision hash to pin as the head (required)'),
      flag('--supersede <revHash>', 'conflict revision to supersede (repeatable)').multiple(),
      flag('--text <string>', 'replacement body text'),
      requiredArgs('<dir>', '<id>')
    ),
    sub(
      'undelete',
      'restore a tombstoned concept',
      arg('<dir>', 'vault storage directory'),
      arg('<id>', 'concept id'),
      requiredArgs('<dir>', '<id>')
    )
  ]

  const root = command(
    'auto-okf',
    header(`${TITLE}\nUsage: auto-okf <command> [arguments] [options]`),
    footer(FOOTER),
    bail((b) => {
      captured.bail = b
      return formatBail(b, root)
    }),
    ...cmds
  )
  return { root, captured }
}

/**
 * validate() modifier enforcing required positionals on a subcommand.
 * paparam's own MISSING_ARG check inspects only the command parse() was
 * called on (the root), so subcommands enforce theirs here; the thrown
 * err.bail routes through the root bail handler to exit 2. Runs after the
 * --help check, so `auto-okf <cmd> -h` still prints help without arguments.
 */
function requiredArgs(...specs) {
  return validate((parsed) => {
    for (const spec of specs) {
      if (!(argName(spec) in parsed.args)) {
        const reason = `missing required argument ${spec}`
        const err = new Error(reason)
        err.bail = { reason }
        throw err
      }
    }
    return true
  })
}

/** camelCase an arg spec ('<writer-key>' → 'writerKey') the way paparam does. */
function argName(spec) {
  const parts = spec.match(/([a-zA-Z0-9-]+)/)[1].split(/-+/)
  for (let i = 1; i < parts.length; i++) {
    parts[i] = parts[i].slice(0, 1).toUpperCase() + parts[i].slice(1)
  }
  return parts.join('')
}

/** One usage-error line for a paparam bail object. */
function formatBail(b, root) {
  const where =
    b.command && b.command !== root && b.command.name ? `auto-okf ${b.command.name}` : 'auto-okf'
  switch (b.reason) {
    case 'UNKNOWN_FLAG':
      return `${where}: unknown flag ${flagLabel(b.flag)}`
    case 'INVALID_FLAG':
      return `${where}: invalid flag ${flagLabel(b.flag)} (missing or unexpected value)`
    case 'UNKNOWN_ARG':
      return b.command === root
        ? `auto-okf: unknown command '${String(b.arg.value).split(' ')[0]}'`
        : `${where}: unexpected argument '${b.arg.value}'`
    case 'MISSING_ARG':
      return `${where}: missing required argument ${b.arg.value}`
    default:
      return `${where}: ${b.reason}`
  }
}

function flagLabel(f) {
  return f ? (f.long ? `--${f.name}` : `-${f.name}`) : ''
}

const HANDLERS = {
  init: cmdInit,
  join: cmdJoin,
  'add-writer': cmdAddWriter,
  'remove-writer': cmdRemoveWriter,
  materialize: cmdMaterialize,
  ingest: cmdIngest,
  watch: cmdWatch,
  status: cmdStatus,
  wanted: cmdWanted,
  flags: cmdFlags,
  compact: cmdCompact,
  resolve: cmdResolve,
  undelete: cmdUndelete
}

// ---------- argument helpers ----------

function hexKey(value, what) {
  const s = String(value).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(s)) throw new UsageError(`${what} must be 64 hex characters`)
  return b4a.from(s, 'hex')
}

async function isPinned(dir) {
  try {
    await access(join(dir, METADATA_FILE))
    return true
  } catch {
    return false
  }
}

/** Open an EXISTING vault (pinned dir) and close it after fn. */
async function withVault(dir, opts, fn) {
  await refuseSiblingVault(dir)
  if (!(await isPinned(dir))) {
    throw new Error(
      `'${dir}' is not a vault (no ${METADATA_FILE}); run \`auto-okf init\` or \`auto-okf join\` first`
    )
  }
  const vault = await Bundle.open(dir, opts)
  try {
    return await fn(vault)
  } finally {
    await vault.close()
  }
}

function localHex(vault) {
  return b4a.toString(vault.localKey, 'hex')
}

/** `error: drafts/big.md body is 71,204 bytes; maxOpBytes is 65,536` (ADR-005). */
function oversizeLine({ path, bytes, limit }) {
  const n = (v) => v.toLocaleString('en-US')
  return `error: ${path} body is ${n(bytes)} bytes; maxOpBytes is ${n(limit)}\n`
}

function printIdentity(vault) {
  console.log(`vault key:   ${vault.keyHex}`)
  console.log(`writer key:  ${localHex(vault)}`)
}

/** Rejection reason recorded against this peer's own op at `seq` (§3/§8), or null. */
async function rejectionFor(vault, seq) {
  const rec = await vault.val(K.flagRejected(localHex(vault), seq))
  return rec ? rec.reason || 'rejected' : null
}

// ---------- commands ----------

async function cmdInit({ args, flags }) {
  const dir = args.dir
  await refuseSiblingVault(dir)
  if (await isPinned(dir)) {
    throw new Error(`'${dir}' is already a vault (${METADATA_FILE} exists)`)
  }
  const opts = {}
  if (flags.encryptionKey) {
    opts.encryptionKey = hexKey(flags.encryptionKey, '--encryption-key')
  }
  const vault = await Bundle.init(dir, opts)
  try {
    printIdentity(vault)
    console.log(`storage:     ${dir}`)
    console.log(`generation:  ${vault.generation}`)
    console.log('this peer is the genesis indexer (§8); share the vault key to invite peers')
  } finally {
    await vault.close()
  }
  return 0
}

async function cmdJoin({ args, flags }) {
  const { dir, vaultKey: key } = args
  await refuseSiblingVault(dir)
  const opts = {}
  if (flags.encryptionKey) {
    opts.encryptionKey = hexKey(flags.encryptionKey, '--encryption-key')
  }
  if (flags.metadata) {
    opts.metadata = JSON.parse(await readFile(flags.metadata, 'utf8'))
  }
  // A pinned dir reopens without a key; a fresh dir needs the vault key.
  const pinned = await isPinned(dir)
  if (!pinned && key === undefined) {
    throw new UsageError('a vault key is required to join fresh storage')
  }
  const vault = pinned && key === undefined
    ? await Bundle.open(dir, opts)
    : await Bundle.join(dir, hexKey(key, 'vault key'), opts)
  try {
    printIdentity(vault)
    console.log('hand the writer key to an indexer (`auto-okf add-writer`), then replicate')
    console.log('with `auto-okf watch <dir> <bundle-dir> --swarm`')
    return 0
  } finally {
    await vault.close()
  }
}

async function cmdAddWriter({ args, flags }) {
  const key = hexKey(args.writerKey, 'writer key')
  return withVault(args.dir, {}, async (vault) => {
    const { seq } = await vault.addWriter(key, { indexer: flags.indexer === true })
    await vault.update()
    const rec = await vault.val(K.govWriter(b4a.toString(key, 'hex')))
    if (!rec) {
      const reason = await rejectionFor(vault, seq)
      process.stderr.write(
        `add-writer did not take effect${reason ? ` (rejected: ${reason})` : ''}; ` +
          'only a confirmed indexer may issue governance ops (§8)\n'
      )
      return 1
    }
    console.log(`writer added: ${b4a.toString(key, 'hex')} (indexer: ${rec.indexer === true})`)
    return 0
  })
}

async function cmdRemoveWriter({ args }) {
  const key = hexKey(args.writerKey, 'writer key')
  return withVault(args.dir, {}, async (vault) => {
    const { seq } = await vault.removeWriter(key)
    await vault.update()
    const rec = await vault.val(K.govRemoved(b4a.toString(key, 'hex')))
    if (rec === undefined) {
      const reason = await rejectionFor(vault, seq)
      process.stderr.write(
        `remove-writer did not take effect${reason ? ` (rejected: ${reason})` : ''}; ` +
          'only a confirmed indexer may issue governance ops (§8)\n'
      )
      return 1
    }
    console.log(`writer removed: ${b4a.toString(key, 'hex')} (causal revocation recorded, §8)`)
    return 0
  })
}

async function cmdMaterialize({ args, flags }) {
  const { dir, bundleDir } = args
  return withVault(dir, {}, async (vault) => {
    const report = await materialize(vault, bundleDir, {
      forceMirror: flags.forceMirror === true
    })
    console.log(
      `materialized ${bundleDir}: ${report.written.length} written, ` +
        `${report.unchanged.length} unchanged, ${report.removed.length} removed`
    )
    for (const rel of report.pendingIngest) {
      process.stderr.write(`notice: pending ingest (unsaved external edit, left in place): ${rel}\n`)
    }
    for (const u of report.unsafe || []) {
      const label = typeof u === 'string' ? u : `${u.rel || u.path || u.id} (${u.reason})`
      process.stderr.write(`error: unsafe path (skipped, §9): ${label}\n`)
    }
    for (const rel of report.stale || []) {
      process.stderr.write(`notice: stale (no longer produced, left in place): ${rel}\n`)
    }
    // N3 exit taxonomy (ADR-004): an unsafe path means part of the owned
    // projection was NOT written — a real failure (1). Pending-ingest files
    // are a healthy multi-writer state: everything owned was projected and
    // the foreign files were left in place (3). Otherwise clean (0); stale
    // is a notice either way (left in place, per spec).
    if ((report.unsafe || []).length > 0) return 1
    return report.ok ? 0 : 3
  })
}

/**
 * ADR-001: resolve the trailing path arguments to bundle-relative concept
 * files, validating BEFORE any op is appended. Literal paths only — the
 * shell expands globs; a path that does not exist, resolves outside the
 * bundle root, or is not a concept `.md` file is an error naming it.
 * Returns null for the zero-path form (full scan, unchanged).
 */
async function scopedIngestPaths(bundleDir, given) {
  if (given.length === 0) return null
  const root = resolve(bundleDir)
  const rels = new Set()
  for (const p of given) {
    const abs = resolve(root, p)
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`path resolves outside the bundle root: ${p}`)
    }
    let st = null
    try {
      st = await stat(abs)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    if (st === null) throw new Error(`no such file in the bundle: ${p}`)
    if (!st.isFile() || !abs.endsWith('.md')) throw new Error(`not a concept file (.md): ${p}`)
    rels.add(relative(root, abs).split(sep).join('/'))
  }
  return [...rels].sort()
}

async function cmdIngest(parsed) {
  const { args, flags } = parsed
  const { dir, bundleDir } = args
  // paparam's rest is greedy: once both positionals are filled, everything
  // remaining — flags included — lands in rest. Re-recognize ingest's own
  // flags so the pre-ADR-001 `ingest <dir> <bundle> --confirm-deletes` form
  // keeps working; the remainder is the ADR-001 path set.
  const trailing = []
  for (const t of parsed.rest || []) {
    if (t === '--confirm-deletes') flags.confirmDeletes = true
    else if (t === '--help' || t === '-h') {
      process.stdout.write(parsed.help())
      return 0
    } else if (t.startsWith('-')) throw new UsageError(`unknown flag ${t}`)
    else trailing.push(t)
  }
  const paths = await scopedIngestPaths(bundleDir, trailing)
  return withVault(dir, {}, async (vault) => {
    const watcher = await createIngestWatcher(vault, bundleDir, {
      watch: false,
      confirmDelete: flags.confirmDeletes ? async () => true : undefined
    })
    let files = 0
    let ops = 0
    let upToDate = 0
    watcher.on('ops', ({ path, ops: emitted }) => {
      files++
      ops += emitted.length
      console.log(`ingested ${path}: ${emitted.map((o) => o.type).join(', ') || '(no-op)'}`)
    })
    // ADR-003: count the hash-match skips so "0 op(s) from 0 file(s)" cannot
    // mean both "nothing found" and "everything already converged".
    watcher.on('skip', ({ reason }) => {
      if (reason === 'unchanged') upToDate++
    })
    // ADR-005: an oversize body is refused per file, before any of its ops;
    // sibling files in the same run still ingest, but the run exits 1.
    let oversize = 0
    watcher.on('oversize', (o) => {
      oversize++
      process.stderr.write(oversizeLine(o))
    })
    watcher.on('warning', ({ path, message }) =>
      process.stderr.write(`warning (${path}): ${message}\n`)
    )
    watcher.on('delete-skipped', ({ path }) =>
      process.stderr.write(`delete skipped (no --confirm-deletes): ${path}\n`)
    )
    try {
      if (paths === null) await watcher.scan()
      else for (const rel of paths) await watcher.ingestFile(rel)
      await vault.update()
      // The skip clause is omitted (never "0") when no skips occurred.
      const skips = upToDate > 0 ? `; ${upToDate} file(s) already up to date` : ''
      console.log(`ingest complete: ${ops} op(s) from ${files} file(s)${skips}`)
      return oversize > 0 ? 1 : 0
    } finally {
      await watcher.close()
    }
  })
}

async function cmdWatch({ args, flags }) {
  const { dir, bundleDir } = args
  await refuseSiblingVault(dir)
  if (!(await isPinned(dir))) {
    throw new Error(
      `'${dir}' is not a vault (no ${METADATA_FILE}); run \`auto-okf init\` or \`auto-okf join\` first`
    )
  }
  const vault = await Bundle.open(dir)
  let watcher = null
  let swarmed = false
  try {
    watcher = await createIngestWatcher(vault, bundleDir, {
      confirmDelete: flags.confirmDeletes ? async () => true : undefined,
      debounce: flags.debounce ? Number(flags.debounce) : undefined
    })
    watcher.on('ops', ({ path, ops }) => {
      console.log(`ingested ${path}: ${ops.map((o) => o.type).join(', ') || '(no-op)'}`)
    })
    watcher.on('oversize', (o) => process.stderr.write(oversizeLine(o)))
    watcher.on('warning', (w) =>
      process.stderr.write(`warning: ${w && w.message ? w.message : JSON.stringify(w)}\n`)
    )
    watcher.on('delete-skipped', ({ path }) =>
      process.stderr.write(`delete skipped (no --confirm-deletes): ${path}\n`)
    )
    watcher.on('error', (err) => process.stderr.write(`watch error: ${err.message}\n`))
    vault.on('error', (err) => process.stderr.write(`vault error: ${err.message}\n`))
    if (flags.swarm) {
      await vault.swarm()
      swarmed = true
      console.log("joined hyperswarm on the vault's auto-okf/2 topic")
    }
    await watcher.scan() // pick up edits made while the watcher was down
    console.log(`watching ${bundleDir} (foreground; Ctrl-C to stop)`)
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
    return 0
  } finally {
    if (watcher) await watcher.close()
    if (swarmed) await vault.leaveSwarm().catch(() => {})
    await vault.close()
  }
}

async function cmdStatus({ args, flags }) {
  const { dir, bundleDir } = args
  return withVault(dir, {}, async (vault) => {
    // ADR-002: strictly read-only — status appends no ops, writes no files,
    // touches no manifest. The five-state vocabulary and the --json
    // [{ path, state }] rows are contract.
    const rows = await status(vault, bundleDir)
    if (flags.json) {
      console.log(JSON.stringify(rows, null, 2))
    } else {
      for (const { path, state } of rows) console.log(`${state}\t${path}`)
      process.stderr.write(`${rows.length} file(s)\n`)
    }
    return 0
  })
}

async function cmdWanted({ args, flags }) {
  return withVault(args.dir, {}, async (vault) => {
    await vault.update()
    const rows = await wanted(vault)
    if (flags.json) {
      console.log(JSON.stringify(rows, null, 2))
    } else {
      for (const { path, count, referrers } of rows) {
        console.log(`${count}\t${path}\t<- ${referrers.join(', ')}`)
      }
      process.stderr.write(`${rows.length} wanted path(s), most-referenced first\n`)
    }
    return 0
  })
}

async function cmdFlags({ args, flags }) {
  const { dir, family } = args
  const prefix = family ? `flag/${family}/` : 'flag/'
  return withVault(dir, {}, async (vault) => {
    await vault.update()
    const rows = []
    for await (const { key, value } of vault.scan(prefix)) rows.push({ key, value })
    if (flags.json) {
      console.log(JSON.stringify(rows, null, 2))
    } else {
      for (const { key, value } of rows) console.log(`${key}\t${JSON.stringify(value)}`)
      process.stderr.write(`${rows.length} flag(s)${family ? ` in flag/${family}/` : ''}\n`)
    }
    return 0
  })
}

async function cmdCompact({ args, flags }) {
  const { dir, outDir } = args
  const faceDir = flags.face || `${outDir}.face`
  return withVault(dir, {}, async (vault) => {
    const res = await compact(vault, {
      initBundle: Bundle.init,
      toDir: faceDir,
      vaultDir: outDir,
      force: flags.force === true,
      ...encryptionOpt(flags)
    })
    try {
      console.log(`compacted ${dir} -> ${outDir} (generation ${res.generation})`)
      console.log(`hydrated face:    ${faceDir}`)
      console.log(`predecessor:      ${res.predecessorPath} (NOT deleted — archive out-of-band)`)
      console.log(`new vault key:    ${res.vault.keyHex}`)
      if (res.conflictCopies && res.conflictCopies.length) {
        console.log(`conflicted copies carried across (--force): ${res.conflictCopies.length}`)
        for (const c of res.conflictCopies) console.log(`  ${c.from} -> ${c.to}`)
      }
      return 0
    } finally {
      // compact returns the fresh vault OPEN; the caller owns closing it.
      await res.vault.close()
    }
  })
}

/** compact's fresh vault is encrypted only when asked: a key is never inherited. */
function encryptionOpt(flags) {
  return flags.encryptionKey ? { encryptionKey: hexKey(flags.encryptionKey, '--encryption-key') } : {}
}

async function cmdResolve({ args, flags }) {
  const { dir, id } = args
  const keep = flags.keep
  if (!keep) throw new UsageError('--keep <revHash> is required')
  return withVault(dir, {}, async (vault) => {
    const opts = { supersede: flags.supersede || [] }
    if (flags.text !== undefined) opts.text = flags.text
    const { seq } = await vault.resolveConflict(id, keep, opts)
    await vault.update()
    const reason = await rejectionFor(vault, seq)
    if (reason) {
      process.stderr.write(`resolve did not take effect (rejected: ${reason})\n`)
      return 1
    }
    let open = 0
    for await (const _ of vault.scan(K.flagPrefix('conflict', id))) open++
    console.log(`resolved ${id}: head := ${keep}; ${open} conflict flag(s) still open on this concept`)
    return 0
  })
}

async function cmdUndelete({ args }) {
  const { dir, id } = args
  return withVault(dir, {}, async (vault) => {
    const { seq } = await vault.undeleteConcept(id)
    await vault.update()
    const reason = await rejectionFor(vault, seq)
    if (reason) {
      process.stderr.write(`undelete did not take effect (rejected: ${reason})\n`)
      return 1
    }
    const meta = await vault.val(K.cMeta(id))
    if (!meta) {
      process.stderr.write(`undelete: no concept with id '${id}' exists\n`)
      return 1
    }
    if (meta.deleted) {
      process.stderr.write(`undelete: concept '${id}' is still tombstoned\n`)
      return 1
    }
    console.log(`undeleted ${id}: concept restored (audit flag/undelete recorded, §8)`)
    return 0
  })
}
