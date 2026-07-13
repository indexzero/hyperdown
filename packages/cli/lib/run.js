// autovault-ld CLI (SPEC-FINAL §13): a thin veneer over @autovault-ld/store
// (vault lifecycle + governance ops) and @autovault-ld/faces (materialize,
// ingest watcher, Turtle export). The CLI never writes the view or the
// face itself — every effect flows through the packages, so everything it
// does is the same thing library callers do.
//
// Exit codes: 0 success, 1 operational error, 2 usage error.
import { parseArgs } from 'node:util'
import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import b4a from 'b4a'
import { keyspace as K } from '@autovault-ld/core'
import { Vault, METADATA_FILE } from '@autovault-ld/store'
import { materialize, exportTurtle, createIngestWatcher } from '@autovault-ld/faces'

const USAGE = `autovault-ld — multi-writer Vault-LD knowledge graphs on autobee

Usage: autovault-ld <command> [arguments] [options]

Commands:
  init <storage>                         create a new vault; this peer's key is
                                         the vault key and the genesis indexer
  join <storage> <vault-key>             join an existing vault by key
                                         (key optional when storage is pinned)
  add-writer <storage> <writer-key>      admit a writer (indexer-issued op)
  remove-writer <storage> <writer-key>   revoke a writer (indexer-issued op)
  materialize <storage> <dir>            project the Markdown/Obsidian face
  export <storage> <dir>                 export schema.ttl + data.ttl
  flags <storage> [family]               list/inspect the flag queue
  watch <storage> <dir>                  foreground ingest watcher (+ swarm)

Options (per command):
  init          --encryption-key <hex64>  --root-base <iri>
  join          --encryption-key <hex64>  --metadata <invite.json>
  add-writer    --indexer
  export        --roundtrip
  flags         --json
  watch         --swarm  --confirm-deletes  --debounce <ms>

Global: -h, --help          exit codes: 0 ok, 1 error, 2 usage
`

class UsageError extends Error {}

/** Run the CLI. Returns the process exit code. */
export async function run(argv) {
  const [command, ...rest] = argv
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(USAGE)
    return command ? 0 : 2
  }
  const handler = COMMANDS[command]
  if (!handler) {
    process.stderr.write(`autovault-ld: unknown command '${command}'\n\n${USAGE}`)
    return 2
  }
  try {
    return await handler(rest)
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`autovault-ld ${command}: ${err.message}\n\n${USAGE}`)
      return 2
    }
    process.stderr.write(`autovault-ld ${command}: ${err && err.message ? err.message : err}\n`)
    return 1
  }
}

const COMMANDS = {
  init: cmdInit,
  join: cmdJoin,
  'add-writer': cmdAddWriter,
  'remove-writer': cmdRemoveWriter,
  materialize: cmdMaterialize,
  export: cmdExport,
  flags: cmdFlags,
  watch: cmdWatch
}

// ---------- argument helpers ----------

function parse(rest, options, positionals) {
  let parsed
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...options, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true
    })
  } catch (err) {
    throw new UsageError(err.message)
  }
  if (parsed.values.help) {
    process.stdout.write(USAGE)
    return null
  }
  const [min, max] = positionals
  if (parsed.positionals.length < min || parsed.positionals.length > max) {
    throw new UsageError(`expected ${min === max ? min : `${min}..${max}`} argument(s), got ${parsed.positionals.length}`)
  }
  return parsed
}

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

async function cmdInit(rest) {
  const parsed = parse(rest, {
    'encryption-key': { type: 'string' },
    'root-base': { type: 'string' }
  }, [1, 1])
  if (!parsed) return 0
  const [storage] = parsed.positionals
  if (await isPinned(storage)) {
    throw new Error(`'${storage}' is already a vault (${METADATA_FILE} exists)`)
  }
  const opts = {}
  if (parsed.values['encryption-key']) {
    opts.encryptionKey = hexKey(parsed.values['encryption-key'], '--encryption-key')
  }
  if (parsed.values['root-base']) opts.metadata = { rootBase: parsed.values['root-base'] }
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

async function cmdJoin(rest) {
  const parsed = parse(rest, {
    'encryption-key': { type: 'string' },
    metadata: { type: 'string' }
  }, [1, 2])
  if (!parsed) return 0
  const [storage, key] = parsed.positionals
  const opts = {}
  if (key !== undefined) opts.key = hexKey(key, 'vault key')
  if (parsed.values['encryption-key']) {
    opts.encryptionKey = hexKey(parsed.values['encryption-key'], '--encryption-key')
  }
  if (parsed.values.metadata) {
    opts.metadata = JSON.parse(await readFile(parsed.values.metadata, 'utf8'))
  }
  return withVault(storage, opts, async (vault) => {
    printIdentity(vault)
    console.log('hand the writer key to an indexer (`autovault-ld add-writer`), then replicate')
    console.log('with `autovault-ld watch <storage> <dir> --swarm`')
    return 0
  })
}

async function cmdAddWriter(rest) {
  const parsed = parse(rest, { indexer: { type: 'boolean' } }, [2, 2])
  if (!parsed) return 0
  const [storage, writer] = parsed.positionals
  const key = hexKey(writer, 'writer key')
  return withVault(storage, {}, async (vault) => {
    await vault.addWriter(key, { indexer: parsed.values.indexer === true })
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

async function cmdRemoveWriter(rest) {
  const parsed = parse(rest, {}, [2, 2])
  if (!parsed) return 0
  const [storage, writer] = parsed.positionals
  const key = hexKey(writer, 'writer key')
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

async function cmdMaterialize(rest) {
  const parsed = parse(rest, {}, [2, 2])
  if (!parsed) return 0
  const [storage, dir] = parsed.positionals
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

async function cmdExport(rest) {
  const parsed = parse(rest, { roundtrip: { type: 'boolean' } }, [2, 2])
  if (!parsed) return 0
  const [storage, dir] = parsed.positionals
  return withVault(storage, {}, async (vault) => {
    const out = await exportTurtle(vault, dir, { roundtrip: parsed.values.roundtrip === true })
    console.log(`schema.ttl: ${out.schema.triples} triple(s) (${out.schema.path})`)
    console.log(`data.ttl:   ${out.data.triples} triple(s) (${out.data.path})`)
    return 0
  })
}

async function cmdFlags(rest) {
  const parsed = parse(rest, { json: { type: 'boolean' } }, [1, 2])
  if (!parsed) return 0
  const [storage, family] = parsed.positionals
  const prefix = family ? `flag/${family}/` : 'flag/'
  return withVault(storage, {}, async (vault) => {
    await vault.update()
    const rows = []
    for await (const { key, value } of vault.scan(prefix)) rows.push({ key, value })
    if (parsed.values.json) {
      console.log(JSON.stringify(rows, null, 2))
    } else {
      for (const { key, value } of rows) console.log(`${key}\t${JSON.stringify(value)}`)
      process.stderr.write(`${rows.length} flag(s)${family ? ` in flag/${family}/` : ''}\n`)
    }
    return 0
  })
}

async function cmdWatch(rest) {
  const parsed = parse(rest, {
    swarm: { type: 'boolean' },
    'confirm-deletes': { type: 'boolean' },
    debounce: { type: 'string' }
  }, [2, 2])
  if (!parsed) return 0
  const [storage, dir] = parsed.positionals
  if (!(await isPinned(storage))) {
    throw new Error(`'${storage}' is not a vault (no ${METADATA_FILE}); run \`autovault-ld init\` or \`autovault-ld join\` first`)
  }
  const vault = await Vault.open(storage)
  let watcher = null
  try {
    watcher = await createIngestWatcher(vault, dir, {
      confirmDelete: parsed.values['confirm-deletes'] ? async () => true : undefined,
      debounce: parsed.values.debounce ? Number(parsed.values.debounce) : undefined
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
    if (parsed.values.swarm) {
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
    if (parsed.values.swarm) await vault.leaveSwarm().catch(() => {})
    await vault.close()
  }
}
