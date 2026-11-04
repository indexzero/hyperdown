// The auto-okf CLI (SPEC §13) over @auto-okf/store and @auto-okf/faces.
// The CLI never writes the view or the bundle itself. Every effect goes
// through the packages, so a library caller gets the same result.
//
// paparam's parse() returns null on every parse failure, and run maps that
// to exit 2. Do not let paparam pick the code.
import { access, stat } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { join, relative, resolve, sep } from 'node:path'
import b4a from 'b4a'
import { command, flag, arg, rest, summary, header, footer, bail, validate } from 'paparam'
import { keyspace as K } from '@auto-okf/core'
import {
  Bundle,
  METADATA_FILE,
  LOCAL_ALLOW_FILE,
  loadMetadata,
  loadLocalAllow,
  saveLocalAllow,
  startBootstrapNode
} from '@auto-okf/store'
import { materialize, createIngestWatcher, wanted, importFace, status } from '@auto-okf/faces'

const TITLE = 'auto-okf — multi-writer OKF bundles on autobee (okf SPEC §13)'
const FOOTER = 'exit codes: 0 ok, 1 error, 2 usage, 3 pending-ingest only (materialize)'

class UsageError extends Error {}

// The marker file of vault-ld. auto-okf refuses a vault-ld directory and
// names the right tool (ADR-006). Do not rename it: both CLIs rely on it.
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
    // null with no bail: paparam printed --help. null with a bail: a parse
    // failure.
    if (captured.bail === null) return 0
    const b = captured.bail
    process.stderr.write(`${formatBail(b, root)}\n\n${(b.command || root).help()}`)
    return 2
  }

  if (parsed === root) {
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
      // The refusal shape is pinned (ADR-006).
      process.stderr.write(`error: ${err.message}\n`)
      return 1
    }
    process.stderr.write(`auto-okf ${parsed.name}: ${errorText(err)}\n`)
    return 1
  }
}

/**
 * The text of an operational error. VAULT_NOT_WRITABLE is substrate
 * admission, not membership (store/lib/bundle.js _assertWritable), so the
 * text names the one step that does both: an indexer's add-writer.
 */
function errorText(err) {
  if (err && err.code === 'VAULT_NOT_WRITABLE') {
    const key = err.writerKey ? ` ${err.writerKey}` : ''
    return (
      'Not writable: autobee has not added this peer as a writer yet. ' +
      `Hand its writer key${key} to an indexer (\`auto-okf add-writer\`), ` +
      'then replicate and try again'
    )
  }
  return err && err.message ? err.message : String(err)
}

// ---------- command tree (paparam) ----------

/**
 * Build the paparam command tree. Returns { root, captured }. captured.bail
 * holds the paparam bail object after a failed parse, else null, so run
 * maps every parse failure to exit 2.
 */
function buildCli() {
  const captured = { bail: null }

  // The root adds a literal usage line, because paparam's own renders as
  // `auto-okf [flags] [command]`.
  const sub = (name, sum, ...mods) => command(name, header(TITLE), summary(sum), ...mods)

  const cmds = [
    sub(
      'init',
      "create a new vault; this peer's key is the vault key and the genesis indexer",
      arg('<dir>', 'vault storage directory'),
      flag('--encryption-key <hex64>', 'encrypt the vault with this key (64 hex chars)'),
      flag(
        '--swarm-allow <hex64>',
        "pin this swarm key in the invite (metadata.swarm.allow; repeatable); this peer's own swarm key is always pinned"
      ).multiple(),
      requiredArgs('<dir>')
    ),
    sub(
      'join',
      'join an existing vault by key (key optional when <dir> is pinned)',
      arg('<dir>', 'vault storage directory'),
      arg('[vault-key]', 'vault key (64 hex chars; optional when <dir> is pinned)'),
      flag('--encryption-key <hex64>', 'encrypt the vault with this key (64 hex chars)'),
      flag('--metadata <invite.json>', 'invite metadata file'),
      flag(
        '--swarm-allow <hex64>',
        `a swarm key that this peer alone admits and dials, such as the key of the indexer that admitted it (repeatable; kept in <dir>/${LOCAL_ALLOW_FILE}, never in the invite)`
      ).multiple(),
      requiredArgs('<dir>')
    ),
    sub(
      'add-writer',
      'admit a writer (indexer-issued op)',
      arg('<dir>', 'vault storage directory'),
      arg('<writer-key>', 'writer public key (64 hex chars)'),
      flag('--indexer', 'admit the writer as an indexer'),
      flag(
        '--swarm-key <hex64>',
        "the writer's swarm key, required unless a gov/writer record already binds one; the swarm firewall of every peer then admits it, and a remove-writer cuts it"
      ),
      requiredArgs('<dir>', '<writer-key>')
    ),
    sub(
      'keys',
      "print this peer's writer key and swarm key (the swarm key also before <dir> holds a vault)",
      arg('<dir>', 'vault storage directory'),
      requiredArgs('<dir>')
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
      'foreground ingest watcher (+ optional private swarm)',
      arg('<dir>', 'vault storage directory'),
      arg('<bundle-dir>', 'OKF bundle directory'),
      flag('--swarm', 'replicate over a swarm that admits only members (needs --bootstrap or --public-dht)'),
      flag('--bootstrap <host:port,...>', 'with --swarm: the bootstrap nodes of a private DHT (`auto-okf bootstrap`)'),
      flag('--public-dht', 'with --swarm: announce on the public DHT, the commons, instead'),
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
      'import',
      'create a new vault in <dir> from the notes of a face (a generation: materialize, then import)',
      arg('<face-dir>', 'face directory to read, such as one that materialize wrote'),
      arg('<dir>', 'storage directory for the new vault (new or empty)'),
      flag('--encryption-key <hex64>', 'encrypt the new vault with this key (64 hex chars)'),
      flag('--metadata <okf-vault.json>', "carry limits, rate and schemaVersion from the predecessor's okf-vault.json"),
      flag('--predecessor <vault-key>', "record the predecessor's vault key in the new vault's metadata (64 hex chars)"),
      requiredArgs('<face-dir>', '<dir>')
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
    ),
    sub(
      'bootstrap',
      'run a DHT bootstrap node for a private swarm, in the foreground until Ctrl-C',
      flag('--port <n>', 'UDP port to bind (required)'),
      flag('--host <ipv4>', 'IPv4 address to bind and announce (default 127.0.0.1)')
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
 * Enforce the required positionals of a subcommand. paparam reports
 * MISSING_ARG only on the command that parse() ran on, the root. The thrown
 * err.bail routes through the root bail handler to exit 2. It runs after
 * paparam handles --help, so `auto-okf <cmd> -h` prints help without
 * arguments.
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
  keys: cmdKeys,
  'remove-writer': cmdRemoveWriter,
  materialize: cmdMaterialize,
  ingest: cmdIngest,
  watch: cmdWatch,
  status: cmdStatus,
  wanted: cmdWanted,
  flags: cmdFlags,
  import: cmdImport,
  resolve: cmdResolve,
  undelete: cmdUndelete,
  bootstrap: cmdBootstrap
}

// ---------- argument helpers ----------

function hexKey(value, what) {
  const s = String(value).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(s)) throw new UsageError(`${what} must be 64 hex characters`)
  return b4a.from(s, 'hex')
}

/**
 * The `--swarm-allow` keys of `init` and of `join`. A bad or repeated key
 * is a usage error, before the store exists or opens.
 */
function swarmAllowKeys(values) {
  const keys = []
  for (const value of values) {
    const hex = b4a.toString(hexKey(value, '--swarm-allow'), 'hex')
    if (keys.includes(hex)) throw new UsageError(`--swarm-allow lists ${hex} twice`)
    keys.push(hex)
  }
  return keys
}

/**
 * The swarm configuration of `watch`, or null without --swarm. Every
 * usage error comes here, before the vault opens.
 */
function swarmOptions(flags) {
  if (!flags.swarm) {
    if (flags.bootstrap !== undefined || flags.publicDht) {
      throw new UsageError('--bootstrap and --public-dht need --swarm')
    }
    return null
  }
  if (flags.bootstrap !== undefined && flags.publicDht) {
    throw new UsageError('give --bootstrap or --public-dht, not both')
  }
  if (flags.publicDht) return { publicDht: true }
  if (flags.bootstrap === undefined) {
    throw new UsageError(
      '--swarm needs --bootstrap <host:port,...>, the nodes of a private DHT (run one with `auto-okf bootstrap`), ' +
        'or --public-dht to announce the vault on the public DHT (the commons)'
    )
  }
  const nodes = String(flags.bootstrap).split(',').map((n) => n.trim())
  const valid = nodes.every((n) => {
    const m = /^([^\s:]+):(\d+)$/.exec(n)
    return m !== null && Number(m[2]) >= 1 && Number(m[2]) <= 65535
  })
  if (!valid) throw new UsageError('--bootstrap must be host:port[,host:port...] with ports from 1 to 65535')
  return { bootstrap: nodes }
}

async function isPinned(dir) {
  try {
    await access(join(dir, METADATA_FILE))
    return true
  } catch {
    return false
  }
}

/** Open an existing vault and close it after fn. */
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

/**
 * `error: drafts/big.md: its set-body op is 71,290 bytes encoded; maxOpBytes
 * is 65,536`. The line names the size of the encoded op, not of the body,
 * because the preflight measures the op (faces/lib/ingest.js, ADR-005).
 */
function oversizeLine({ path, opBytes, limit }) {
  const n = (v) => v.toLocaleString('en-US')
  return `error: ${path}: its set-body op is ${n(opBytes)} bytes encoded; maxOpBytes is ${n(limit)}\n`
}

/**
 * `error: notes/x.md: core rejected its set-body op (policy-namespace), and
 * the file stays pending`, one line per rejected op. A rejected
 * delete-concept ends `and the delete stays pending`. Why each stays
 * pending: see faces/lib/ingest.js.
 */
function rejectedLine({ path, op, reason }) {
  const pending = op === 'delete-concept' ? 'the delete' : 'the file'
  return `error: ${path}: core rejected its ${op} op (${reason}), and ${pending} stays pending\n`
}

function printIdentity(vault) {
  console.log(`vault key:   ${vault.keyHex}`)
  console.log(`writer key:  ${localHex(vault)}`)
  console.log(`swarm key:   ${b4a.toString(vault.swarmKey, 'hex')}`)
}

/** The rejection reason of this peer's own op at `seq`, or null. See core/lib/apply.js. */
async function rejectionFor(vault, seq) {
  const rec = await vault.val(K.flagRejected(localHex(vault), seq))
  return rec ? rec.reason || 'rejected' : null
}

// ---------- commands ----------

async function cmdInit({ args, flags }) {
  const dir = args.dir
  const allow = flags.swarmAllow !== undefined ? swarmAllowKeys([].concat(flags.swarmAllow)) : null
  await refuseSiblingVault(dir)
  if (await isPinned(dir)) {
    throw new Error(`'${dir}' is already a vault (${METADATA_FILE} exists)`)
  }
  const opts = {}
  if (flags.encryptionKey) {
    opts.encryptionKey = hexKey(flags.encryptionKey, '--encryption-key')
  }
  if (allow !== null) opts.metadata = { swarm: { allow } }
  const vault = await Bundle.init(dir, opts)
  try {
    printIdentity(vault)
    console.log(`storage:     ${dir}`)
    console.log(`generation:  ${vault.generation}`)
    console.log('this peer is the genesis indexer (§8); to invite a peer, share the vault key and')
    console.log(`${join(dir, METADATA_FILE)} (the invite: it lists the swarm keys every peer admits)`)
  } finally {
    await vault.close()
  }
  return 0
}

/**
 * The invite of `join --metadata`: the creator's pinned document. A file
 * that is not metadata of this release fails in loadMetadata by name, with
 * its path, before the store exists.
 */
async function inviteMetadata(path) {
  let meta
  try {
    meta = await loadMetadata(path)
  } catch (err) {
    throw new Error(`--metadata ${path}: ${err.message}`)
  }
  if (meta === null) throw new Error(`--metadata ${path}: no such file`)
  return meta
}

async function cmdJoin({ args, flags }) {
  const { dir } = args
  const key = args.vaultKey !== undefined ? hexKey(args.vaultKey, 'vault key') : undefined
  const allow = flags.swarmAllow !== undefined ? swarmAllowKeys([].concat(flags.swarmAllow)) : null
  await refuseSiblingVault(dir)
  const pinned = await isPinned(dir)
  if (!pinned && key === undefined) {
    throw new UsageError('a vault key is required to join fresh storage')
  }
  // Fresh storage needs the invite. Without it the peer pins metadata that
  // is not the creator's: no swarm key of the invite, so the private swarm
  // admits nobody, and pinned metadata never changes.
  if (!pinned && !flags.metadata) {
    throw new UsageError(
      "join needs the invite to join fresh storage: --metadata <okf-vault.json>, the creator's pinned file"
    )
  }
  const opts = {}
  if (flags.encryptionKey) {
    opts.encryptionKey = hexKey(flags.encryptionKey, '--encryption-key')
  }
  if (flags.metadata) opts.metadata = await inviteMetadata(flags.metadata)
  const vault = pinned && key === undefined ? await Bundle.open(dir, opts) : await Bundle.join(dir, key, opts)
  try {
    printIdentity(vault)
    if (allow !== null) {
      for (const hex of await saveLocalAllow(dir, allow)) console.log(`local allow:  ${hex}`)
      console.log(`(this peer alone admits these keys: ${join(dir, LOCAL_ALLOW_FILE)}, never the invite)`)
    }
    console.log('hand both keys to an indexer (`auto-okf add-writer <dir> <writer-key> --swarm-key <swarm-key>`),')
    console.log('then replicate with `auto-okf watch <dir> <bundle-dir> --swarm --bootstrap <host:port>`')
    return 0
  } finally {
    await vault.close()
  }
}

/**
 * True when the view or the invite binds a swarm key to the writer: its
 * gov/writer record carries one, or the writer is genesisKey and the invite
 * binds the creator's key (metadata.swarm.genesis). A folded remove-writer
 * cuts only a bound key (store/lib/bundle.js _refreshAllowlistOnce).
 */
async function boundSwarmKey(vault, writerHex) {
  const rec = await vault.val(K.govWriter(writerHex))
  if (rec && typeof rec.swarmKey === 'string') return true
  return writerHex === vault.metadata.genesisKey && vault.metadata.swarm.genesis !== null
}

async function cmdAddWriter({ args, flags }) {
  const key = hexKey(args.writerKey, 'writer key')
  const swarmKey = flags.swarmKey !== undefined ? hexKey(flags.swarmKey, '--swarm-key') : null
  return withVault(args.dir, {}, async (vault) => {
    // Every writer that the CLI admits has a bound swarm key, so a later
    // remove-writer cuts it on every peer. The refusal comes before the
    // append.
    const writerHex = b4a.toString(key, 'hex')
    if (swarmKey === null && !(await boundSwarmKey(vault, writerHex))) {
      throw new UsageError(
        `add-writer needs --swarm-key <hex64>: no gov/writer record binds a swarm key to ${writerHex}, ` +
          "so a later remove-writer could not cut the writer's swarm connection"
      )
    }
    const { seq } = await vault.addWriter(key, { indexer: flags.indexer === true, swarmKey })
    await vault.update()
    const rec = await vault.val(K.govWriter(writerHex))
    // "Did not take effect" means no gov/writer record, so no membership.
    // The grant still happened, so the key is writable and apply rejects
    // each of its ops. See core/lib/apply.js.
    if (!rec) {
      const reason = await rejectionFor(vault, seq)
      process.stderr.write(
        `add-writer did not take effect${reason ? ` (rejected: ${reason})` : ''}; ` +
          'only a confirmed indexer may issue governance ops (§8)\n'
      )
      return 1
    }
    console.log(`writer added: ${writerHex} (indexer: ${rec.indexer === true})`)
    if (rec.swarmKey) {
      console.log(`swarm key:   ${rec.swarmKey} (each peer's swarm firewall admits it once it folds this op)`)
    }
    return 0
  })
}

/**
 * The writer key and the swarm key of a vault directory. A directory
 * without a vault has no writer key yet, but its swarm key exists: the
 * store derives it from the corestore of the directory, which this creates
 * when new. So a fleet can collect every swarm key before the creator runs
 * `init --swarm-allow`.
 */
async function cmdKeys({ args }) {
  const { dir } = args
  await refuseSiblingVault(dir)
  if (await isPinned(dir)) {
    return withVault(dir, {}, async (vault) => {
      printIdentity(vault)
      return 0
    })
  }
  console.log(`swarm key:   ${b4a.toString(await Bundle.readSwarmKey(dir), 'hex')}`)
  process.stderr.write(
    `${dir} holds no vault yet, so it has no writer key until \`auto-okf init\` or \`auto-okf join\`. ` +
      'The swarm key stays the same: list it in the invite (`init --swarm-allow`) or hand it to an indexer\n'
  )
  return 0
}

/** A DHT bootstrap node in the foreground until SIGINT or SIGTERM. See store/lib/dht.js. */
async function cmdBootstrap({ flags }) {
  if (flags.port === undefined) throw new UsageError('--port <n> is required')
  const port = Number(flags.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError('--port must be an integer from 1 to 65535')
  }
  const host = flags.host ?? '127.0.0.1'
  if (!isIPv4(host) || host === '0.0.0.0') {
    throw new UsageError('--host must be an IPv4 address of this machine, such as 127.0.0.1')
  }
  const node = await startBootstrapNode({ port, host })
  try {
    console.log(`bootstrap node: ${host}:${port} (foreground; Ctrl-C to stop)`)
    console.log(`peers replicate with: auto-okf watch <dir> <bundle-dir> --swarm --bootstrap ${host}:${port}`)
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
    return 0
  } finally {
    await node.destroy()
  }
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
      forceMirror: flags.forceMirror === true,
      onPlaintext: announcePlaintext
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
    // A value that the bundle cannot hold (SPEC §10). A generation loses
    // it, so the operator fixes it in the vault before the import.
    const encrypted = vault.metadata.encrypted === true
    for (const l of report.lossy) process.stderr.write(lossyLine(l, encrypted))
    if (report.lossy.length > 0) {
      process.stderr.write(
        `error: ${report.lossy.length} value(s) that the face cannot hold; fix each one in the vault before import (SPEC §10)\n`
      )
    }
    // ADR-004: an unsafe path means part of the owned projection was not
    // written, so exit 1. A lossy value also exits 1 (SPEC §10).
    // Pending-ingest files are a healthy multi-writer state: everything
    // owned was written, so exit 3. Stale is a notice either way.
    if ((report.unsafe || []).length > 0 || report.lossy.length > 0) return 1
    return report.ok ? 0 : 3
  })
}

/**
 * `warning: notes/a.md: the face cannot hold the value of 'reference'
 * (_id <id>): the vault holds [...], the face holds [...]`. For an encrypted
 * vault the line names the `_id` alone, because stderr can reach a log: no
 * path, no key and no value.
 */
function lossyLine({ id, path, key, before, after }, encrypted) {
  if (encrypted) {
    return `warning: the face cannot hold a value of the concept with _id ${id}; the path, the key and the values are not printed: the vault is encrypted\n`
  }
  const head = `warning: ${path}: the face cannot hold the value of '${key}' (_id ${id})`
  return `${head}: the vault holds ${JSON.stringify(before)}, the face holds ${JSON.stringify(after)}\n`
}

/**
 * Resolve the trailing path arguments to bundle-relative concept files,
 * before any op is appended (ADR-001). Literal paths only: the shell
 * expands globs. A path that does not exist, resolves outside the bundle
 * root, or is not a `.md` file is an error that names it. Returns null for
 * the zero-path form, the full scan.
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
  // paparam's rest is greedy: once both positionals are filled, every
  // remaining token lands in rest, flags included. So ingest recognizes its
  // own flags here, and the remainder is the path set.
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
    // Count the unchanged skips, so "0 op(s) from 0 file(s)" cannot mean
    // both nothing found and all converged (ADR-003).
    watcher.on('skip', ({ reason }) => {
      if (reason === 'unchanged') upToDate++
    })
    let oversize = 0
    watcher.on('oversize', (o) => {
      oversize++
      process.stderr.write(oversizeLine(o))
    })
    let rejected = 0
    watcher.on('rejected', (r) => {
      rejected++
      process.stderr.write(rejectedLine(r))
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
      const skips = upToDate > 0 ? `; ${upToDate} file(s) already up to date` : ''
      console.log(`ingest complete: ${ops} op(s) from ${files} file(s)${skips}`)
      return oversize > 0 || rejected > 0 ? 1 : 0
    } finally {
      await watcher.close()
    }
  })
}

async function cmdWatch({ args, flags }) {
  const { dir, bundleDir } = args
  const swarmOpts = swarmOptions(flags) // a usage error comes before the open
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
    watcher.on('rejected', (r) => process.stderr.write(rejectedLine(r))) // unlike ingest, watch keeps running
    watcher.on('warning', (w) =>
      process.stderr.write(`warning: ${w && w.message ? w.message : JSON.stringify(w)}\n`)
    )
    watcher.on('delete-skipped', ({ path }) =>
      process.stderr.write(`delete skipped (no --confirm-deletes): ${path}\n`)
    )
    watcher.on('error', (err) => process.stderr.write(`watch error: ${errorText(err)}\n`))
    vault.on('error', (err) => process.stderr.write(`vault error: ${err.message}\n`))
    if (swarmOpts) {
      const allow = await loadLocalAllow(dir)
      await vault.swarm({ ...swarmOpts, allow })
      swarmed = true
      console.log(
        swarmOpts.publicDht
          ? "joined the public DHT (the commons) on the vault's auto-okf/2 topic"
          : `joined the private swarm on the vault's auto-okf/2 topic (bootstrap ${swarmOpts.bootstrap.join(',')})`
      )
      console.log(
        `swarm key:   ${b4a.toString(vault.swarmKey, 'hex')} (the firewall admits only the keys of the invite, of live writers and of the local list)`
      )
      if (allow.length > 0) console.log(`local allow:  ${allow.length} key(s) from ${join(dir, LOCAL_ALLOW_FILE)}`)
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
    // status is read-only: no ops, no files, no manifest (ADR-002). The
    // five states and the --json rows are a contract.
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

/**
 * `import <face-dir> <dir>`: a new vault from a bundle (SPEC §10). What
 * importFace refuses, claims and removes on failure: see
 * faces/lib/import.js. import reads plaintext and writes none, so it prints
 * no plaintext warning.
 */
async function cmdImport({ args, flags }) {
  const { faceDir, dir } = args
  const opts = {}
  if (flags.encryptionKey !== undefined) opts.encryptionKey = hexKey(flags.encryptionKey, '--encryption-key')
  if (flags.predecessor !== undefined) {
    opts.predecessorKey = b4a.toString(hexKey(flags.predecessor, '--predecessor'), 'hex')
  }
  if (flags.metadata !== undefined) opts.metadata = await predecessorMetadata(flags.metadata)
  await refuseSiblingVault(dir)
  let res
  try {
    res = await importFace(Bundle.init, faceDir, dir, opts)
  } catch (err) {
    // run() prints err.message and exits 1. The warnings before it say why
    // a note did not import.
    for (const w of err.warnings || []) process.stderr.write(warningLine(w))
    if (err.code === 'IMPORT_FIDELITY') process.stderr.write(`notes:       ${importCountsLine(err.counts)}\n`)
    throw err
  }
  try {
    printIdentity(res.vault)
    console.log(`storage:     ${res.dir}`)
    console.log(`generation:  ${res.generation}`)
    console.log(`predecessor: ${res.vault.metadata.predecessorKey ?? '(none: a root vault)'}`)
    console.log(`notes:       ${importCountsLine(res.counts)}`)
    console.log('fidelity:    every note of the new vault matches the face (_rev lines excluded; index.md and log.md not compared)')
    console.log(
      `invite:      a joiner needs the vault key and ${join(res.dir, METADATA_FILE)} ` +
        '(auto-okf join <dir> <vault-key> --metadata <that file>)'
    )
    return 0
  } finally {
    // importFace returns the vault open. The caller closes it.
    await res.vault.close()
  }
}

/** The predecessor's okf-vault.json of `--metadata`. It must be metadata of this release. */
async function predecessorMetadata(path) {
  let meta
  try {
    meta = await loadMetadata(path)
  } catch (err) {
    throw new Error(`--metadata ${path}: ${err.message}`)
  }
  if (meta === null) throw new Error(`--metadata ${path}: no such file`)
  return meta
}

/** `3 read, 3 imported`: the notes that import read, and the notes that made a concept. */
function importCountsLine({ notes, imported }) {
  return `${notes} read, ${imported} imported`
}

/** `warning: notes/a.md: cannot create concept: ...`: one warning line on stderr. */
function warningLine({ path, message }) {
  return `warning: ${path}: ${message}\n`
}

/**
 * Print `warning: <dir>: now holds the contents of an encrypted vault as
 * plaintext` on stderr, and resolve when the line is written. materialize
 * awaits it before its first plaintext write, so a crash after that write
 * finds the warning already printed.
 */
function announcePlaintext(warning) {
  return new Promise((resolve, reject) => {
    process.stderr.write(warningLine(warning), (err) => (err ? reject(err) : resolve()))
  })
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
