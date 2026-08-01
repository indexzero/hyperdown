// autovault-ld CLI (SPEC-FINAL §13): a thin veneer over @autovault-ld/store
// (vault lifecycle + governance ops) and @autovault-ld/faces (materialize,
// ingest watcher, Turtle export). The CLI never writes the view or the
// face itself — every effect flows through the packages, so everything it
// does is the same thing library callers do.
//
// The command surface is declared once as a paparam command tree (paparam
// is Holepunch's own parser — pear's CLI runs on it); --help/-h and all
// help text are paparam-generated.
//
// Exit codes: 0 success, 1 operational error, 2 usage error.
import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import b4a from 'b4a'
import { command, flag, arg, summary, description, header, footer, validate, bail } from 'paparam'
import { keyspace as K } from '@autovault-ld/core'
import { Vault, METADATA_FILE } from '@autovault-ld/store'
import { materialize, exportTurtle, createIngestWatcher } from '@autovault-ld/faces'

const TAGLINE = 'autovault-ld — multi-writer Vault-LD knowledge graphs on autobee'
const ROOT_HEADER = `${TAGLINE}\nUsage: autovault-ld <command> [arguments] [options]`
const FOOTER = 'exit codes: 0 ok, 1 error, 2 usage'

class UsageError extends Error {}

// Wrong-tool guardrail (okf ADR-006): the sibling system's marker file is
// stable contract between the twin CLIs; autovault-ld refuses auto-okf
// storage pointedly (naming the right tool) instead of opening it.
const SIBLING_MARKER = 'okf-vault.json'

class WrongToolError extends Error {}

async function refuseSiblingVault(storage) {
  try {
    await access(join(storage, SIBLING_MARKER))
  } catch {
    return
  }
  throw new WrongToolError(
    `${storage} is an auto-okf vault (${SIBLING_MARKER} present); use auto-okf, not autovault-ld`
  )
}

/** Run the CLI. Returns the process exit code. */
export async function run(argv) {
  let code = 0
  let bailed = false

  // Every subcommand runner owns the exit code and swallows its own errors,
  // so paparam's bail path only ever sees parse/validation failures (exit 2).
  const action = (name, fn) => async ({ args, flags }) => {
    try {
      code = await fn(args, flags)
    } catch (err) {
      if (err instanceof WrongToolError) {
        // ADR-006: the refusal shape is pinned — `error: <dir> is a … vault
        // (<marker> present); use <tool>, not <this tool>`.
        process.stderr.write(`error: ${err.message}\n`)
        code = 1
        return
      }
      process.stderr.write(`autovault-ld ${name}: ${err && err.message ? err.message : err}\n`)
      code = err instanceof UsageError ? 2 : 1
    }
  }

  // paparam 1.10.1 enforces required args only on the root command
  // (Command#parse checks the root's _definedArgs against the matched
  // subcommand), so each subcommand validates its own arg modifiers.
  const requires = (...argMods) => validate((parsed) => {
    for (const a of argMods) {
      if (!a.optional && !(a.name in parsed.args)) {
        const err = new Error(`missing required argument ${a.help}`)
        err.bail = { reason: err.message }
        throw err
      }
    }
    return true
  })

  // One subcommand: summary/description/args/flags declared once; paparam
  // derives help, strict flag rejection, and camelCased args/flags from it.
  const sub = ({ name, sum, desc, args = [], flags = [], run: fn }) => command(
    name,
    header(TAGLINE),
    summary(sum),
    ...(desc ? [description(desc)] : []),
    ...args,
    ...flags,
    requires(...args),
    action(name, fn)
  )

  const init = sub({
    name: 'init',
    sum: 'create a new vault; this peer\'s key is the vault key and the genesis indexer',
    args: [arg('<storage>', 'vault storage directory')],
    flags: [
      flag('--encryption-key <hex64>', 'encryption key (64 hex characters)'),
      flag('--root-base <iri>', 'root base IRI recorded in the vault metadata')
    ],
    run: cmdInit
  })

  const joinCmd = sub({
    name: 'join',
    sum: 'join an existing vault by key (key optional when storage is pinned)',
    args: [
      arg('<storage>', 'vault storage directory'),
      arg('[vault-key]', 'vault key (64 hex characters); optional when storage is pinned')
    ],
    flags: [
      flag('--encryption-key <hex64>', 'encryption key (64 hex characters)'),
      flag('--metadata <invite.json>', 'invite metadata JSON file for non-default invites')
    ],
    run: cmdJoin
  })

  const addWriter = sub({
    name: 'add-writer',
    sum: 'admit a writer (indexer-issued op)',
    args: [
      arg('<storage>', 'vault storage directory'),
      arg('<writer-key>', 'writer key (64 hex characters)')
    ],
    flags: [flag('--indexer', 'admit the writer as an indexer')],
    run: cmdAddWriter
  })

  const removeWriter = sub({
    name: 'remove-writer',
    sum: 'revoke a writer (indexer-issued op)',
    args: [
      arg('<storage>', 'vault storage directory'),
      arg('<writer-key>', 'writer key (64 hex characters)')
    ],
    run: cmdRemoveWriter
  })

  const materializeCmd = sub({
    name: 'materialize',
    sum: 'project the Markdown/Obsidian face',
    args: [
      arg('<storage>', 'vault storage directory'),
      arg('<dir>', 'face directory to write')
    ],
    run: cmdMaterialize
  })

  const exportCmd = sub({
    name: 'export',
    sum: 'export schema.ttl + data.ttl',
    args: [
      arg('<storage>', 'vault storage directory'),
      arg('<dir>', 'output directory for the Turtle files')
    ],
    flags: [flag('--roundtrip', 'emit vld:path for notes off their default location (§10.4)')],
    run: cmdExport
  })

  const flagsCmd = sub({
    name: 'flags',
    sum: 'list/inspect the flag queue',
    args: [
      arg('<storage>', 'vault storage directory'),
      arg('[family]', 'flag family (conflict, clobber, dangling, unmapped, rejected, …)')
    ],
    flags: [flag('--json', 'print the flag rows as JSON')],
    run: cmdFlags
  })

  const watch = sub({
    name: 'watch',
    sum: 'foreground ingest watcher (+ swarm)',
    args: [
      arg('<storage>', 'vault storage directory'),
      arg('<dir>', 'face directory to watch')
    ],
    flags: [
      flag('--swarm', 'join the vault\'s hyperswarm topic for replication'),
      flag('--confirm-deletes', 'allow deleted files to emit DeleteSubject'),
      flag('--debounce <ms>', 'ingest debounce in milliseconds')
    ],
    run: cmdWatch
  })

  const root = command(
    'autovault-ld',
    header(ROOT_HEADER),
    footer(FOOTER),
    summary('multi-writer Vault-LD knowledge graphs on autobee'),
    bail((b) => {
      bailed = true
      const c = b.command
      const atRoot = c === root
      const msg = bailMessage(b, atRoot)
      const where = atRoot ? 'autovault-ld' : `autovault-ld ${c.name}`
      process.stderr.write(`${where}: ${msg}\n\n${c.help()}`)
      return msg
    }),
    init,
    joinCmd,
    addWriter,
    removeWriter,
    materializeCmd,
    exportCmd,
    flagsCmd,
    watch
  )

  if (argv.length === 0) {
    process.stdout.write(root.help())
    return 2
  }
  if (argv[0] === 'help') {
    process.stdout.write(root.help())
    return 0
  }

  const parsed = root.parse(argv)
  // parse() returns null both when it bailed (usage error) and when it
  // printed --help; the bail handler above disambiguates.
  if (parsed === null) return bailed ? 2 : 0
  if (parsed === root) {
    // flags-only invocation with no subcommand: same as no command at all
    process.stdout.write(root.help())
    return 2
  }
  if (parsed.running) await parsed.running
  return code
}

/** Human message for a paparam bail (reasons per paparam 1.10.1). */
function bailMessage(b, atRoot) {
  switch (b.reason) {
    case 'UNKNOWN_FLAG':
      return `unknown flag --${b.flag.name}`
    case 'INVALID_FLAG':
      return `invalid usage of flag --${b.flag.name} (missing or malformed value?)`
    case 'UNKNOWN_ARG': {
      const value = String((b.arg && b.arg.value) || '').split(' ')[0]
      return atRoot ? `unknown command '${value}'` : `unexpected argument '${value}'`
    }
    case 'MISSING_ARG':
      return `missing required argument ${b.arg && b.arg.value}`
    default:
      return b.reason
  }
}

// ---------- argument helpers ----------

function hexKey(value, what) {
  const s = String(value).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(s)) throw new UsageError(`${what} must be 64 hex characters`)
  return b4a.from(s, 'hex')
}

async function isPinned(storage) {
  try {
    await access(join(storage, METADATA_FILE))
    return true
  } catch {
    return false
  }
}

/** Open an EXISTING vault (pinned storage) and close it after fn. */
async function withVault(storage, opts, fn) {
  await refuseSiblingVault(storage)
  if (!opts.key && !(await isPinned(storage))) {
    throw new Error(`'${storage}' is not a vault (no ${METADATA_FILE}); run \`autovault-ld init\` or \`autovault-ld join\` first`)
  }
  const vault = await Vault.open(storage, opts)
  try {
    return await fn(vault)
  } finally {
    await vault.close()
  }
}

function printIdentity(vault) {
  console.log(`vault key:   ${vault.keyHex}`)
  console.log(`writer key:  ${b4a.toString(vault.localKey, 'hex')}`)
}

// ---------- commands ----------

async function cmdInit(args, flags) {
  const { storage } = args
  await refuseSiblingVault(storage)
  if (await isPinned(storage)) {
    throw new Error(`'${storage}' is already a vault (${METADATA_FILE} exists)`)
  }
  const opts = {}
  if (flags.encryptionKey) {
    opts.encryptionKey = hexKey(flags.encryptionKey, '--encryption-key')
  }
  if (flags.rootBase) opts.metadata = { rootBase: flags.rootBase }
  const vault = await Vault.init(storage, opts)
  try {
    printIdentity(vault)
    console.log(`storage:     ${storage}`)
    console.log('this peer is the genesis indexer (§8.0); share the vault key to invite peers')
  } finally {
    await vault.close()
  }
  return 0
}

async function cmdJoin(args, flags) {
  const { storage, vaultKey } = args
  const opts = {}
  if (vaultKey !== undefined) opts.key = hexKey(vaultKey, 'vault key')
  if (flags.encryptionKey) {
    opts.encryptionKey = hexKey(flags.encryptionKey, '--encryption-key')
  }
  if (flags.metadata) {
    opts.metadata = JSON.parse(await readFile(flags.metadata, 'utf8'))
  }
  return withVault(storage, opts, async (vault) => {
    printIdentity(vault)
    console.log('hand the writer key to an indexer (`autovault-ld add-writer`), then replicate')
    console.log('with `autovault-ld watch <storage> <dir> --swarm`')
    return 0
  })
}

async function cmdAddWriter(args, flags) {
  const { storage } = args
  const key = hexKey(args.writerKey, 'writer key')
  return withVault(storage, {}, async (vault) => {
    await vault.addWriter(key, { indexer: flags.indexer === true })
    await vault.update()
    const rec = await vault.val(K.govWriter(b4a.toString(key, 'hex')))
    if (!rec) {
      const reason = await lastRejection(vault)
      process.stderr.write(`add-writer did not take effect${reason ? ` (rejected: ${reason})` : ''}; only a confirmed indexer may issue governance ops (§8.0)\n`)
      return 1
    }
    console.log(`writer added: ${b4a.toString(key, 'hex')} (indexer: ${rec.indexer === true})`)
    return 0
  })
}

async function cmdRemoveWriter(args) {
  const { storage } = args
  const key = hexKey(args.writerKey, 'writer key')
  return withVault(storage, {}, async (vault) => {
    await vault.removeWriter(key)
    await vault.update()
    const rec = await vault.val(K.govRemoved(b4a.toString(key, 'hex')))
    if (rec === undefined) {
      const reason = await lastRejection(vault)
      process.stderr.write(`remove-writer did not take effect${reason ? ` (rejected: ${reason})` : ''}; only a confirmed indexer may issue governance ops (§8.0)\n`)
      return 1
    }
    console.log(`writer removed: ${b4a.toString(key, 'hex')} (causal revocation recorded, §8.3)`)
    return 0
  })
}

/** Most recent flag/rejected entry from this peer's own writer (§8.4). */
async function lastRejection(vault) {
  const w = b4a.toString(vault.localKey, 'hex')
  let last = null
  for await (const { value } of vault.scan(`flag/rejected/${w}/`)) last = value
  return last ? last.reason : null
}

async function cmdMaterialize(args) {
  const { storage, dir } = args
  return withVault(storage, {}, async (vault) => {
    const report = await materialize(vault, dir)
    console.log(`materialized ${dir}: ${report.written.length} written, ${report.unchanged.length} unchanged`)
    for (const rel of report.pendingIngest) {
      process.stderr.write(`pending ingest (unsaved external edit, skipped): ${rel}\n`)
    }
    for (const { subject, reason } of report.unsafe) {
      process.stderr.write(`unsafe path (skipped, §9.4): ${subject} (${reason})\n`)
    }
    for (const rel of report.stale) {
      process.stderr.write(`stale (no longer produced, left in place): ${rel}\n`)
    }
    return 0
  })
}

async function cmdExport(args, flags) {
  const { storage, dir } = args
  return withVault(storage, {}, async (vault) => {
    const out = await exportTurtle(vault, dir, { roundtrip: flags.roundtrip === true })
    console.log(`schema.ttl: ${out.schema.triples} triple(s) (${out.schema.path})`)
    console.log(`data.ttl:   ${out.data.triples} triple(s) (${out.data.path})`)
    return 0
  })
}

async function cmdFlags(args, flags) {
  const { storage, family } = args
  const prefix = family ? `flag/${family}/` : 'flag/'
  return withVault(storage, {}, async (vault) => {
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

async function cmdWatch(args, flags) {
  const { storage, dir } = args
  await refuseSiblingVault(storage)
  if (!(await isPinned(storage))) {
    throw new Error(`'${storage}' is not a vault (no ${METADATA_FILE}); run \`autovault-ld init\` or \`autovault-ld join\` first`)
  }
  const vault = await Vault.open(storage)
  let watcher = null
  try {
    watcher = await createIngestWatcher(vault, dir, {
      confirmDelete: flags.confirmDeletes ? async () => true : undefined,
      debounce: flags.debounce ? Number(flags.debounce) : undefined
    })
    watcher.on('ops', ({ path, ops }) => {
      console.log(`ingested ${path}: ${ops.map((o) => o.type).join(', ')}`)
    })
    watcher.on('warning', (w) => process.stderr.write(`warning: ${w && w.message ? w.message : JSON.stringify(w)}\n`))
    watcher.on('delete-skipped', ({ subject }) => {
      process.stderr.write(`delete skipped (no --confirm-deletes): ${subject}\n`)
    })
    watcher.on('error', (err) => process.stderr.write(`watch error: ${err.message}\n`))
    vault.on('error', (err) => process.stderr.write(`vault error: ${err.message}\n`))
    if (flags.swarm) {
      await vault.joinSwarm()
      console.log('joined hyperswarm on the vault discovery key')
    }
    await watcher.scan() // pick up edits made while the watcher was down
    console.log(`watching ${dir} (foreground; Ctrl-C to stop)`)
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
    return 0
  } finally {
    if (watcher) await watcher.close()
    if (flags.swarm) await vault.leaveSwarm().catch(() => {})
    await vault.close()
  }
}
