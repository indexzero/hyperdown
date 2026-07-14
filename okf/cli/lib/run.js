// auto-okf CLI (okf SPEC §13): a thin veneer over @auto-okf/store (vault
// lifecycle + §8 governance ops) and @auto-okf/faces (materialize, ingest
// watcher, wanted index, epoch-cycle compact). The CLI never writes the view
// or the face itself — every effect flows through the packages, so everything
// it does is exactly what a library caller does.
//
// Exit codes: 0 success, 1 operational error, 2 usage error.
import { parseArgs } from 'node:util'
import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import b4a from 'b4a'
import { keyspace as K } from '@auto-okf/core'
import { initVault, openVault, joinVault, METADATA_FILE } from '@auto-okf/store'
import { materialize, createIngestWatcher, wanted, compact } from '@auto-okf/faces'

const USAGE = `auto-okf — multi-writer OKF bundles on autobee (okf SPEC §13)

Usage: auto-okf <command> [arguments] [options]

Commands:
  init <dir>                             create a new vault; this peer's key is
                                         the vault key and the genesis indexer
  join <dir> <vault-key>                 join an existing vault by key
                                         (key optional when <dir> is pinned)
  add-writer <dir> <writer-key>          admit a writer (indexer-issued op)
  remove-writer <dir> <writer-key>       revoke a writer (indexer-issued op)
  materialize <dir> <bundle-dir>         project the OKF v0.1 bundle to disk
  ingest <dir> <bundle-dir>              fold on-disk edits back in as ops (one-shot)
  watch <dir> <bundle-dir>               foreground ingest watcher (+ optional swarm)
  wanted <dir>                           print the ranked demand index (wanted/)
  flags <dir> [family]                   list/inspect the flag queue (flag/)
  compact <dir> <out-dir>                epoch-cycle compaction into a fresh vault
  resolve <dir> <id> --keep <revHash>    resolve an open body conflict on <id>
  undelete <dir> <id>                    restore a tombstoned concept

Options (per command):
  init           --encryption-key <hex64>
  join           --encryption-key <hex64>  --metadata <invite.json>
  add-writer     --indexer
  materialize    --force-mirror
  ingest         --confirm-deletes
  watch          --swarm  --confirm-deletes  --debounce <ms>
  wanted         --json
  flags          --json
  compact        --force  --face <dir>
  resolve        --keep <revHash>  --supersede <revHash> (repeatable)  --text <string>

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
    process.stderr.write(`auto-okf: unknown command '${command}'\n\n${USAGE}`)
    return 2
  }
  try {
    return await handler(rest)
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`auto-okf ${command}: ${err.message}\n\n${USAGE}`)
      return 2
    }
    process.stderr.write(`auto-okf ${command}: ${err && err.message ? err.message : err}\n`)
    return 1
  }
}

const COMMANDS = {
  init: cmdInit,
  join: cmdJoin,
  'add-writer': cmdAddWriter,
  'remove-writer': cmdRemoveWriter,
  materialize: cmdMaterialize,
  ingest: cmdIngest,
  watch: cmdWatch,
  wanted: cmdWanted,
  flags: cmdFlags,
  compact: cmdCompact,
  resolve: cmdResolve,
  undelete: cmdUndelete
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
    throw new UsageError(
      `expected ${min === max ? min : `${min}..${max}`} argument(s), got ${parsed.positionals.length}`
    )
  }
  return parsed
}

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
  if (!(await isPinned(dir))) {
    throw new Error(
      `'${dir}' is not a vault (no ${METADATA_FILE}); run \`auto-okf init\` or \`auto-okf join\` first`
    )
  }
  const vault = await openVault(dir, opts)
  try {
    return await fn(vault)
  } finally {
    await vault.close()
  }
}

function localHex(vault) {
  return b4a.toString(vault.localKey, 'hex')
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

async function cmdInit(rest) {
  const parsed = parse(rest, { 'encryption-key': { type: 'string' } }, [1, 1])
  if (!parsed) return 0
  const [dir] = parsed.positionals
  if (await isPinned(dir)) {
    throw new Error(`'${dir}' is already a vault (${METADATA_FILE} exists)`)
  }
  const opts = {}
  if (parsed.values['encryption-key']) {
    opts.encryptionKey = hexKey(parsed.values['encryption-key'], '--encryption-key')
  }
  const vault = await initVault(dir, opts)
  try {
    printIdentity(vault)
    console.log(`storage:     ${dir}`)
    console.log(`epoch:       ${vault.epoch}`)
    console.log('this peer is the genesis indexer (§8); share the vault key to invite peers')
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
  const [dir, key] = parsed.positionals
  const opts = {}
  if (parsed.values['encryption-key']) {
    opts.encryptionKey = hexKey(parsed.values['encryption-key'], '--encryption-key')
  }
  if (parsed.values.metadata) {
    opts.metadata = JSON.parse(await readFile(parsed.values.metadata, 'utf8'))
  }
  // A pinned dir reopens without a key; a fresh dir needs the vault key.
  const pinned = await isPinned(dir)
  if (!pinned && key === undefined) {
    throw new UsageError('a vault key is required to join fresh storage')
  }
  const vault = pinned && key === undefined
    ? await openVault(dir, opts)
    : await joinVault(dir, hexKey(key, 'vault key'), opts)
  try {
    printIdentity(vault)
    console.log('hand the writer key to an indexer (`auto-okf add-writer`), then replicate')
    console.log('with `auto-okf watch <dir> <bundle-dir> --swarm`')
    return 0
  } finally {
    await vault.close()
  }
}

async function cmdAddWriter(rest) {
  const parsed = parse(rest, { indexer: { type: 'boolean' } }, [2, 2])
  if (!parsed) return 0
  const [dir, writer] = parsed.positionals
  const key = hexKey(writer, 'writer key')
  return withVault(dir, {}, async (vault) => {
    const { seq } = await vault.addWriter(key, { indexer: parsed.values.indexer === true })
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

async function cmdRemoveWriter(rest) {
  const parsed = parse(rest, {}, [2, 2])
  if (!parsed) return 0
  const [dir, writer] = parsed.positionals
  const key = hexKey(writer, 'writer key')
  return withVault(dir, {}, async (vault) => {
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

async function cmdMaterialize(rest) {
  const parsed = parse(rest, { 'force-mirror': { type: 'boolean' } }, [2, 2])
  if (!parsed) return 0
  const [dir, bundleDir] = parsed.positionals
  return withVault(dir, {}, async (vault) => {
    const report = await materialize(vault, bundleDir, {
      forceMirror: parsed.values['force-mirror'] === true
    })
    console.log(
      `materialized ${bundleDir}: ${report.written.length} written, ` +
        `${report.unchanged.length} unchanged, ${report.removed.length} removed`
    )
    for (const rel of report.pendingIngest) {
      process.stderr.write(`pending ingest (unsaved external edit, left in place): ${rel}\n`)
    }
    for (const u of report.unsafe || []) {
      const label = typeof u === 'string' ? u : `${u.path || u.id} (${u.reason})`
      process.stderr.write(`unsafe path (skipped, §9): ${label}\n`)
    }
    for (const rel of report.stale || []) {
      process.stderr.write(`stale (no longer produced, left in place): ${rel}\n`)
    }
    // N3: a pending-ingest file makes report.ok false — surface it as an error.
    return report.ok ? 0 : 1
  })
}

async function cmdIngest(rest) {
  const parsed = parse(rest, { 'confirm-deletes': { type: 'boolean' } }, [2, 2])
  if (!parsed) return 0
  const [dir, bundleDir] = parsed.positionals
  return withVault(dir, {}, async (vault) => {
    const watcher = await createIngestWatcher(vault, bundleDir, {
      watch: false,
      confirmDelete: parsed.values['confirm-deletes'] ? async () => true : undefined
    })
    let files = 0
    let ops = 0
    watcher.on('ops', ({ path, ops: emitted }) => {
      files++
      ops += emitted.length
      console.log(`ingested ${path}: ${emitted.map((o) => o.type).join(', ') || '(no-op)'}`)
    })
    watcher.on('warning', ({ path, message }) =>
      process.stderr.write(`warning (${path}): ${message}\n`)
    )
    watcher.on('delete-skipped', ({ path }) =>
      process.stderr.write(`delete skipped (no --confirm-deletes): ${path}\n`)
    )
    try {
      await watcher.scan()
      await vault.update()
      console.log(`ingest complete: ${ops} op(s) from ${files} file(s)`)
      return 0
    } finally {
      await watcher.close()
    }
  })
}

async function cmdWatch(rest) {
  const parsed = parse(rest, {
    swarm: { type: 'boolean' },
    'confirm-deletes': { type: 'boolean' },
    debounce: { type: 'string' }
  }, [2, 2])
  if (!parsed) return 0
  const [dir, bundleDir] = parsed.positionals
  if (!(await isPinned(dir))) {
    throw new Error(
      `'${dir}' is not a vault (no ${METADATA_FILE}); run \`auto-okf init\` or \`auto-okf join\` first`
    )
  }
  const vault = await openVault(dir)
  let watcher = null
  let swarmed = false
  try {
    watcher = await createIngestWatcher(vault, bundleDir, {
      confirmDelete: parsed.values['confirm-deletes'] ? async () => true : undefined,
      debounce: parsed.values.debounce ? Number(parsed.values.debounce) : undefined
    })
    watcher.on('ops', ({ path, ops }) => {
      console.log(`ingested ${path}: ${ops.map((o) => o.type).join(', ') || '(no-op)'}`)
    })
    watcher.on('warning', (w) =>
      process.stderr.write(`warning: ${w && w.message ? w.message : JSON.stringify(w)}\n`)
    )
    watcher.on('delete-skipped', ({ path }) =>
      process.stderr.write(`delete skipped (no --confirm-deletes): ${path}\n`)
    )
    watcher.on('error', (err) => process.stderr.write(`watch error: ${err.message}\n`))
    vault.on('error', (err) => process.stderr.write(`vault error: ${err.message}\n`))
    if (parsed.values.swarm) {
      await vault.swarm()
      swarmed = true
      console.log('joined hyperswarm on the vault discovery key')
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

async function cmdWanted(rest) {
  const parsed = parse(rest, { json: { type: 'boolean' } }, [1, 1])
  if (!parsed) return 0
  const [dir] = parsed.positionals
  return withVault(dir, {}, async (vault) => {
    await vault.update()
    const rows = await wanted(vault)
    if (parsed.values.json) {
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

async function cmdFlags(rest) {
  const parsed = parse(rest, { json: { type: 'boolean' } }, [1, 2])
  if (!parsed) return 0
  const [dir, family] = parsed.positionals
  const prefix = family ? `flag/${family}/` : 'flag/'
  return withVault(dir, {}, async (vault) => {
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

async function cmdCompact(rest) {
  const parsed = parse(rest, {
    force: { type: 'boolean' },
    face: { type: 'string' }
  }, [2, 2])
  if (!parsed) return 0
  const [dir, outDir] = parsed.positionals
  const faceDir = parsed.values.face || `${outDir}.face`
  return withVault(dir, {}, async (vault) => {
    const res = await compact(vault, {
      initVault,
      toDir: faceDir,
      vaultDir: outDir,
      force: parsed.values.force === true
    })
    try {
      console.log(`compacted ${dir} -> ${outDir} (epoch ${res.epoch})`)
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

async function cmdResolve(rest) {
  const parsed = parse(rest, {
    keep: { type: 'string' },
    supersede: { type: 'string', multiple: true },
    text: { type: 'string' }
  }, [2, 2])
  if (!parsed) return 0
  const [dir, id] = parsed.positionals
  const keep = parsed.values.keep
  if (!keep) throw new UsageError('--keep <revHash> is required')
  return withVault(dir, {}, async (vault) => {
    const opts = { supersede: parsed.values.supersede || [] }
    if (parsed.values.text !== undefined) opts.text = parsed.values.text
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

async function cmdUndelete(rest) {
  const parsed = parse(rest, {}, [2, 2])
  if (!parsed) return 0
  const [dir, id] = parsed.positionals
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
