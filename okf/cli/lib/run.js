// auto-okf CLI (okf SPEC §13): a thin veneer over @auto-okf/store (vault
// lifecycle + §8 governance ops) and @auto-okf/faces (materialize, ingest
// watcher, per-file status, wanted index, and the import of a face into a
// new vault, §10). The CLI never writes the view or the face itself — every
// effect flows through the packages, so everything it does is exactly what
// a library caller does.
//
// The command surface is declared once as a paparam command tree (paparam is
// Holepunch's own parser — pear's CLI runs on it): a root command composing
// the 15 subcommands from command()/flag()/arg(), with --help|-h and all help
// text generated from the declarations.
//
// Exit codes: 0 success, 1 operational error (for materialize also a value
// that the face cannot hold, §10), 2 usage error, 3 materialize projected
// everything owned but left pending-ingest file(s) in place (ADR-004).
// paparam's parse() returns null on any parse failure; the wrapper maps that
// — unknown flag/command, extra arguments, bad flag values, and (via
// per-command validate()) missing required arguments — to 2, never letting
// paparam pick the code. Unknown flags are rejected strictly, as before.
import { readFile, access, stat } from 'node:fs/promises'
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
    process.stderr.write(`auto-okf ${parsed.name}: ${errorText(err)}\n`)
    return 1
  }
}

/**
 * The text for an operational error. The store refuses every append until
 * autobee has added this peer's key as a writer (VAULT_NOT_WRITABLE, §8).
 * That is substrate admission, not okf membership (store/lib/bundle.js
 * _assertWritable). So the error names the writer key and the honest step
 * that grants it and admits it: an indexer's add-writer.
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
      flag(
        '--swarm-allow <hex64,...>',
        "pin these swarm keys in the invite (metadata.swarm.allow); this peer's own swarm key is always pinned"
      ),
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

/** `--swarm-allow k1,k2`: 64-hex swarm keys, comma-separated (T25). */
function swarmAllow(value) {
  const keys = String(value).split(',').map((k) => k.trim().toLowerCase())
  if (!keys.every((k) => /^[0-9a-f]{64}$/.test(k))) {
    throw new UsageError('--swarm-allow must be a comma-separated list of 64-hex swarm keys')
  }
  return keys
}

/**
 * `join --swarm-allow <hex64>` (G3-P9 F03): each value is one 64-hex swarm
 * key, and no key twice. A bad or repeated key is a usage error, before
 * the vault opens.
 */
function localAllow(values) {
  const keys = []
  for (const value of values) {
    const hex = b4a.toString(hexKey(value, '--swarm-allow'), 'hex')
    if (keys.includes(hex)) throw new UsageError(`--swarm-allow lists ${hex} twice`)
    keys.push(hex)
  }
  return keys
}

/**
 * The swarm options of `watch` (T25): null without --swarm. With --swarm,
 * exactly one DHT: --bootstrap (a private DHT) or --public-dht (the
 * commons, explicit opt-in). Anything else is a usage error, named, and it
 * comes before the vault opens.
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

/**
 * `error: notes/x.md: core rejected its set-body op (policy-namespace), and
 * the file stays pending` (D-048 F02, D-055 Q1): one line per op of a file
 * that core rejected. Ingest does not record such a file, so it stays
 * pending, and materialize keeps it. A delete-concept that core rejected
 * ends `and the delete stays pending` (G3-P8 F02): ingest keeps the
 * manifest entry of the deleted file, so the next ingest retries it.
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
  if (flags.swarmAllow !== undefined) {
    opts.metadata = { swarm: { allow: swarmAllow(flags.swarmAllow) } }
  }
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

async function cmdJoin({ args, flags }) {
  const { dir, vaultKey: key } = args
  const allow = flags.swarmAllow !== undefined ? localAllow([].concat(flags.swarmAllow)) : null
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
    if (allow !== null) {
      // G3-P9 F03: this peer's own list, apart from the invite. It replaces
      // the list that an earlier join wrote.
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
 * D-060 F01: true when the view or the invite binds a swarm key to the
 * writer: its gov/writer record carries one, or the writer is genesisKey
 * and the pinned invite binds the creator's key (metadata.swarm.genesis).
 * A folded remove-writer cuts only a bound key (store/lib/bundle.js
 * _refreshAllowlistOnce).
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
    // D-060 F01: every writer that the CLI admits has a bound swarm key, so
    // a later remove-writer cuts it on every peer, also when the invite or a
    // local list names the key. The refusal comes before the append.
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
    // "Did not take effect" means okf membership: apply wrote no gov/writer
    // record. The substrate grant still happened, because core grants the
    // key of every AddWriter op that it folds (AD7, core/lib/apply.js:375).
    // So the key is writable, and apply rejects each of its ops (D-047 F14,
    // okf/cli/README.md, the add-writer row).
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
 * T25: the writer key and the swarm key of a vault directory. A directory
 * without a vault has no writer key yet, but its swarm key already exists:
 * the store derives it from the directory's corestore, which this creates
 * when it is new. So a pre-provisioned fleet can collect every key before
 * the creator runs `init --swarm-allow`.
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

/**
 * T25: a DHT bootstrap node in the foreground until SIGINT or SIGTERM. The
 * peers of a private swarm pass `--bootstrap <host>:<port>`. The node binds
 * <host> alone, so the default 127.0.0.1 keeps it on this machine.
 */
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
    // materialize is the plaintext export. For an encrypted vault, it names
    // the directory that holds its contents as plaintext before its first
    // write (announcePlaintext). The exit code does not change.
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
    // §10: a value that the face cannot hold. A generation (materialize,
    // then import) would lose it, so the operator fixes it in the vault
    // before the import. The values stay off stderr for an encrypted vault:
    // stderr can reach a log.
    const encrypted = vault.metadata.encrypted === true
    for (const l of report.lossy) process.stderr.write(lossyLine(l, encrypted))
    if (report.lossy.length > 0) {
      process.stderr.write(
        `error: ${report.lossy.length} value(s) that the face cannot hold; fix each one in the vault before import (SPEC §10)\n`
      )
    }
    // N3 exit taxonomy (ADR-004): an unsafe path means part of the owned
    // projection was NOT written — a real failure (1). So is a value that
    // the face cannot hold (1, §10). Pending-ingest files are a healthy
    // multi-writer state: everything owned was projected and the foreign
    // files were left in place (3). Otherwise clean (0); stale is a notice
    // either way (left in place, per spec).
    if ((report.unsafe || []).length > 0 || report.lossy.length > 0) return 1
    return report.ok ? 0 : 3
  })
}

/**
 * One `warning:` line for a value that the face cannot hold (§10):
 * `warning: notes/a.md: the face cannot hold the value of 'reference'
 * (_id <id>): the vault holds [...], the face holds [...]`. For an encrypted
 * vault the line holds no value.
 */
function lossyLine({ id, path, key, before, after }, encrypted) {
  const head = `warning: ${path}: the face cannot hold the value of '${key}' (_id ${id})`
  if (encrypted) return `${head}; values not printed: the vault is encrypted\n`
  return `${head}: the vault holds ${JSON.stringify(before)}, the face holds ${JSON.stringify(after)}\n`
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
    // D-055 Q1: each op that core rejects is named, and the run exits 1.
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
      // The skip clause is omitted (never "0") when no skips occurred.
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
    watcher.on('rejected', (r) => process.stderr.write(rejectedLine(r))) // D-055 Q1: watch keeps running
    watcher.on('warning', (w) =>
      process.stderr.write(`warning: ${w && w.message ? w.message : JSON.stringify(w)}\n`)
    )
    watcher.on('delete-skipped', ({ path }) =>
      process.stderr.write(`delete skipped (no --confirm-deletes): ${path}\n`)
    )
    watcher.on('error', (err) => process.stderr.write(`watch error: ${errorText(err)}\n`))
    vault.on('error', (err) => process.stderr.write(`vault error: ${err.message}\n`))
    if (swarmOpts) {
      // G3-P9 F03: the local list that `join --swarm-allow` kept, this peer only.
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

/**
 * T24: `import <face-dir> <dir>` (SPEC §10). importFace refuses a pinned,
 * non-empty or non-directory <dir>, and a face that holds a conflicted copy,
 * a reserved .okf- note or a symlink, before it writes anything. It claims
 * <dir> before it creates the vault, so a second import into the same <dir>
 * refuses (IMPORT_DIR_CLAIMED, G3-P8 F01). It checks the new vault against
 * the face, and on a difference (IMPORT_FIDELITY) it removes only what it
 * created. import reads plaintext and writes none, so it prints no
 * plaintext warning.
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
    // run() prints the message and exits 1. The warnings say why a note did
    // not import, and IMPORT_FIDELITY names every difference in its message.
    for (const w of err.warnings || []) process.stderr.write(warningLine(w))
    if (err.code === 'IMPORT_FIDELITY') process.stderr.write(`notes:       ${importCountsLine(err.counts)}\n`)
    throw err
  }
  try {
    for (const w of res.warnings) process.stderr.write(warningLine(w))
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
    // importFace returns the new vault OPEN; the caller owns closing it.
    await res.vault.close()
  }
}

/** --metadata: the predecessor's okf-vault.json, which must be metadata of this release. */
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

/** `3 read, 3 imported`: the notes that import read from the face, and the notes that established a concept. */
function importCountsLine({ notes, imported }) {
  return `${notes} read, ${imported} imported`
}

/** `warning: notes/a.md: cannot create concept: ...`: one warning line on stderr. */
function warningLine({ path, message }) {
  return `warning: ${path}: ${message}\n`
}

/**
 * Print a plaintext warning on stderr (decision 8), and resolve when the
 * line is written: `warning: <dir>: now holds the contents of an encrypted
 * vault as plaintext`. materialize awaits it before its first plaintext
 * write, so a failure or a crash after that write finds the warning already
 * printed.
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
