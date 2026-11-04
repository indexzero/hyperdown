// okf-vault.json: the constants of a vault. See SPEC §8, §10 and §13.
//
// Every peer must fold under the same createApply configuration, or the
// views diverge (I2). So the creator writes the metadata once, a joiner
// takes it from the invite, and no code path rewrites the file.
// canonicalMetadataBytes is the same on every peer, so metadataHash is a
// cross-peer pin.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { canonical } from '@auto-okf/core'

export const METADATA_VERSION = 2
export const METADATA_FILE = 'okf-vault.json'
export const ROOT_GENERATION = 'root'

const HEX64 = /^[0-9a-f]{64}$/

// limits and rate must equal DEFAULTS of @auto-okf/core lib/apply.js.
// swarm is not an input of apply, so applyConfig leaves it out, but the
// pinned hash covers it like every other field. See validateSwarm.
export const METADATA_DEFAULTS = {
  limits: { maxOpBytes: 65536, maxPathBytes: 1024, maxPathDepth: 64 },
  rate: { defaultCeiling: 1024 },
  swarm: { allow: [], genesis: null },
  schemaVersion: 1,
  encrypted: false,
  predecessorKey: null
}

// Version 2 is a closed document: a key outside FIELDS is refused by
// name, never carried.
const FIELDS = [
  'version',
  'genesisKey',
  'appendOnly',
  'generation',
  'predecessorKey',
  'limits',
  'rate',
  'swarm',
  'schemaVersion',
  'encrypted'
]

function refuseUnknownFields(doc) {
  for (const k of Object.keys(doc)) {
    if (!FIELDS.includes(k)) throw new TypeError(`metadata.${k} is not a metadata version ${METADATA_VERSION} field`)
  }
}

/**
 * The corestore namespace of the writer cores of one generation: 'root'
 * without a predecessor, else sha256 of the predecessor key bytes. It
 * depends on predecessorKey alone, so every peer derives the same namespace
 * from the invite, and a re-init in a reused corestore directory still gets
 * fresh writer key pairs. See SPEC §10.
 */
export function generationId(predecessorKey) {
  if (predecessorKey == null) return ROOT_GENERATION
  return createHash('sha256').update(Buffer.from(keyHex(predecessorKey), 'hex')).digest('hex')
}

/**
 * Build a complete metadata document that passes validateMetadata.
 * `genesisKey` (hex string or 32-byte Buffer) is required. It is the
 * genesis indexer (SPEC §8) and also the vault key: a creator passes
 * autobee no key, so autobee takes the key of the local writer core
 * (autobee lib/boot.js, `boot` with no key and no `referrer`).
 */
export function createMetadata(input = {}) {
  refuseUnknownFields(input)
  if (input.appendOnly !== undefined && input.appendOnly !== true) {
    throw new TypeError('appendOnly is an immutable vault constant and MUST be true (§8)')
  }
  const predecessorKey = input.predecessorKey != null ? keyHex(input.predecessorKey) : null
  const meta = {
    version: METADATA_VERSION,
    genesisKey: keyHex(input.genesisKey),
    appendOnly: true,
    generation: generationId(predecessorKey),
    predecessorKey,
    limits: { ...METADATA_DEFAULTS.limits, ...(input.limits || {}) },
    rate: { ...METADATA_DEFAULTS.rate, ...(input.rate || {}) },
    swarm: swarmGroup(input.swarm),
    schemaVersion: input.schemaVersion ?? METADATA_DEFAULTS.schemaVersion,
    encrypted: input.encrypted === true
  }
  validateMetadata(meta)
  return meta
}

/**
 * The swarm group of an input. A default fills only an absent field, never
 * a null one. Every other key passes through, and validateMetadata refuses
 * it by name.
 */
function swarmGroup(swarm) {
  if (swarm === undefined) return { allow: [...METADATA_DEFAULTS.swarm.allow], genesis: METADATA_DEFAULTS.swarm.genesis }
  if (swarm === null || typeof swarm !== 'object' || Array.isArray(swarm)) {
    throw new TypeError('metadata.swarm must be an object with an allow list')
  }
  const allow = swarm.allow === undefined ? [...METADATA_DEFAULTS.swarm.allow] : swarmKeyList(swarm.allow, 'metadata.swarm.allow')
  return { ...swarm, allow, genesis: swarmGenesis(swarm.genesis) }
}

/** An input swarm.genesis as 64 lowercase hex, or null when it is absent or null. */
function swarmGenesis(genesis) {
  if (genesis === undefined || genesis === null) return null
  const hex = swarmKeyHex(genesis)
  if (hex === null) throw swarmGenesisError('metadata.swarm.genesis is not a swarm key (32 bytes or 64 hex characters)')
  return hex
}

function swarmGenesisError(message) {
  const err = new TypeError(`VAULT_BAD_SWARM_GENESIS: ${message}`)
  err.code = 'VAULT_BAD_SWARM_GENESIS'
  return err
}

/**
 * A list of swarm keys in canonical form: lowercase hex, sorted, so peers
 * that assemble one list in another order pin the same bytes. A value that
 * is not an array, an entry that is not a swarm key, or a key listed twice
 * throws VAULT_BAD_SWARM_ALLOW, named by `field`.
 */
export function swarmKeyList(list, field) {
  if (!Array.isArray(list)) {
    throw swarmAllowError(`${field} must be an array of swarm keys (32 bytes or 64 hex characters each)`)
  }
  const keys = new Set()
  for (let i = 0; i < list.length; i++) {
    const hex = swarmKeyHex(list[i])
    if (hex === null) throw swarmAllowError(`${field}[${i}] is not a swarm key (32 bytes or 64 hex characters)`)
    if (keys.has(hex)) throw swarmAllowError(`${field} lists the swarm key ${hex} twice`)
    keys.add(hex)
  }
  return [...keys].sort()
}

/** A swarm key as 64 lowercase hex, from 32 bytes or 64 hex characters in any case, or null. */
export function swarmKeyHex(key) {
  if (key instanceof Uint8Array) return key.byteLength === 32 ? Buffer.from(key).toString('hex') : null
  if (typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key)) return key.toLowerCase()
  return null
}

function swarmAllowError(message) {
  const err = new TypeError(`VAULT_BAD_SWARM_ALLOW: ${message}`)
  err.code = 'VAULT_BAD_SWARM_ALLOW'
  return err
}

export function validateMetadata(meta) {
  if (!meta || typeof meta !== 'object') throw new TypeError('metadata must be an object')
  if (meta.version !== METADATA_VERSION) {
    throw new Error(`unsupported vault metadata version: ${meta.version}`)
  }
  refuseUnknownFields(meta)
  if (typeof meta.genesisKey !== 'string' || !HEX64.test(meta.genesisKey)) {
    throw new TypeError('metadata.genesisKey must be a 64-char lowercase-hex key')
  }
  if (meta.appendOnly !== true) {
    // No op and no edited file can flip appendOnly. See SPEC §8.
    throw new Error('metadata.appendOnly must be exactly true (§8 append-only guarantee)')
  }
  validateGenerationChain(meta)
  // limits and rate are closed groups. applyConfig hands each one whole to
  // createApply, so a key outside this version is refused, never carried.
  for (const [group, keys] of [
    ['limits', ['maxOpBytes', 'maxPathBytes', 'maxPathDepth']],
    ['rate', ['defaultCeiling']]
  ]) {
    for (const k of keys) {
      const v = meta[group] && meta[group][k]
      if (!Number.isInteger(v) || v < 0) {
        throw new TypeError(`metadata.${group}.${k} must be a non-negative integer`)
      }
    }
    for (const k of Object.keys(meta[group])) {
      if (!keys.includes(k)) {
        throw new TypeError(`metadata.${group}.${k} is not a metadata version ${METADATA_VERSION} field`)
      }
    }
  }
  validateSwarm(meta.swarm)
  if (!Number.isInteger(meta.schemaVersion) || meta.schemaVersion < 1) {
    throw new TypeError('metadata.schemaVersion must be a positive integer')
  }
  if (typeof meta.encrypted !== 'boolean') {
    throw new TypeError('metadata.encrypted must be a boolean')
  }
  return meta
}

/**
 * allow is the static allowlist of the firewall. genesis is the swarm key
 * of the creator, or null. The invite binds it to genesisKey (SPEC §8), so
 * a folded RemoveWriter of genesisKey cuts it. The gov/ record of genesis
 * holds no swarm key, because core seeds it from the apply configuration
 * alone.
 */
function validateSwarm(swarm) {
  if (!swarm || typeof swarm !== 'object' || Array.isArray(swarm)) {
    throw new TypeError('metadata.swarm must be an object with an allow list')
  }
  for (const k of Object.keys(swarm)) {
    if (k !== 'allow' && k !== 'genesis') {
      throw new TypeError(`metadata.swarm.${k} is not a metadata version ${METADATA_VERSION} field`)
    }
  }
  const { allow, genesis } = swarm
  if (!Array.isArray(allow) || allow.some((k) => typeof k !== 'string' || !HEX64.test(k))) {
    throw new TypeError('metadata.swarm.allow must be an array of 64-char lowercase-hex keys')
  }
  for (let i = 1; i < allow.length; i++) {
    if (!(allow[i - 1] < allow[i])) {
      throw new TypeError('metadata.swarm.allow must be sorted and hold each key once')
    }
  }
  if (genesis !== null && (typeof genesis !== 'string' || !HEX64.test(genesis))) {
    throw new TypeError('metadata.swarm.genesis must be null or a 64-char lowercase-hex key')
  }
  if (genesis !== null && !allow.includes(genesis)) {
    throw new TypeError('metadata.swarm.genesis must be one of metadata.swarm.allow')
  }
}

// predecessorKey is the claim of the operator. Nothing here compares it
// with a vault. See SECURITY_MODEL.md, "The generation chain is
// provenance, not proof".
function validateGenerationChain(meta) {
  const pk = meta.predecessorKey
  if (pk != null && (typeof pk !== 'string' || !HEX64.test(pk))) {
    throw new TypeError('metadata.predecessorKey must be a 64-char lowercase-hex key')
  }
  if (meta.generation !== generationId(pk)) {
    throw new Error('metadata.generation does not match its predecessorKey (§10 generation chain)')
  }
}

/** The canonical bytes of the file and of the hash: sorted-key JSON and a trailing newline. */
export function canonicalMetadataBytes(meta) {
  return Buffer.from(canonical.stableStringify(validateMetadata(meta)) + '\n', 'utf8')
}

/** The cross-peer pin: sha256 of the canonical bytes. */
export function metadataHash(meta) {
  return createHash('sha256').update(canonicalMetadataBytes(meta)).digest('hex')
}

/** The createApply(config) slice of the metadata. See core/lib/apply.js. */
export function applyConfig(meta) {
  validateMetadata(meta)
  return {
    genesisKey: meta.genesisKey,
    limits: { ...meta.limits },
    rate: { ...meta.rate }
  }
}

export async function saveMetadata(path, meta) {
  await writeFile(path, canonicalMetadataBytes(meta))
  return meta
}

/** The pinned metadata, or null when the file does not exist. */
export async function loadMetadata(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  return validateMetadata(JSON.parse(raw))
}

export function keyHex(key) {
  if (typeof key === 'string') return key.toLowerCase()
  if (Buffer.isBuffer(key) || key instanceof Uint8Array) {
    return Buffer.from(key).toString('hex')
  }
  throw new TypeError('key is required (hex string or 32-byte buffer)')
}
