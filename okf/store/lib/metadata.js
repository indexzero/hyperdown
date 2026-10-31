// Vault metadata pinning (okf SPEC §8, §10, §13): every peer of a vault
// MUST fold under identical createApply config — metadata is a
// convergence-relevant input (I2). The document is written once at init,
// loaded at open, and carried to joining peers in the invite; its canonical
// bytes (stableStringify: sorted keys, fixed JSON, trailing newline) are
// identical across peers regardless of how the object was assembled, so
// `metadataHash` is a cross-peer pin.
//
// §8 append-only: `appendOnly: true` is an IMMUTABLE vault-metadata
// constant. It lives OUTSIDE the op log — there is no op that can flip it
// (nothing in the §3 wire contract mentions it), no code path in this
// package rewrites the metadata file after init, and validateMetadata
// refuses any document where it is not exactly `true`, so a tampered file
// cannot open. createMetadata likewise refuses an input trying to set it
// to anything but true: an append-only:false vault is unrepresentable.
//
// §10 generation chain: `predecessorKey` (null for a root vault) records
// the vault key of the predecessor whose face this vault imported
// (`auto-okf import --predecessor`). It is the operator's claim: provenance
// metadata, not proof (consumers MUST treat cross-generation identity as
// trusted-operator scope). Nothing here checks it against a vault.
//
// §10 writer-key freshness: writer cores derive under a per-generation
// corestore namespace recorded in the metadata (`generation`). The generation id is
// a PURE FUNCTION of predecessorKey — 'root' for a first-generation vault,
// else sha256(predecessorKey bytes) — so every peer of one vault derives the
// same namespace from the same pinned metadata, an operator re-initing in a
// REUSED corestore directory still gets fresh writer keypairs (the
// namespace differs from the predecessor's), and a joiner handed only
// predecessorKey can reconstruct it (implementation resolution where §10 is
// silent on HOW the namespace is derived; code-comment scope per SPEC §0
// rule 4).
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { canonical } from '@auto-okf/core'

// The release states that it is v2: it writes version 2, and
// validateMetadata (so loadMetadata) refuses every other version.
export const METADATA_VERSION = 2
export const METADATA_FILE = 'okf-vault.json'
export const ROOT_GENERATION = 'root'

const HEX64 = /^[0-9a-f]{64}$/

// limits/rate defaults mirror @auto-okf/core lib/apply.js DEFAULTS exactly
// (§3 limits; §8 rate — defaultCeiling, the only rate setting, is the
// spec-silent admitted-writer ceiling pinned here and in core).
// swarm.allow (T25) is the static allowlist of the swarm firewall: the
// hyperswarm public keys, 64 hex each, that every peer of the vault admits
// and dials (Bundle.swarm()). swarm.genesis (D-060 F01) is the creator's
// swarm key, one key of allow, or null: the invite binds it to genesisKey,
// so a folded RemoveWriter of genesisKey cuts it (Bundle
// _refreshAllowlistOnce). The genesis record of gov/ holds no swarm key,
// because core seeds it from the apply config alone. Neither field is an
// input of apply, so applyConfig leaves the group out, but it is in the
// pinned hash like every other field.
export const METADATA_DEFAULTS = {
  limits: { maxOpBytes: 65536, maxPathBytes: 1024, maxPathDepth: 64 },
  rate: { defaultCeiling: 1024 },
  swarm: { allow: [], genesis: null },
  schemaVersion: 1,
  encrypted: false,
  predecessorKey: null
}

/**
 * The §10 per-generation namespace id: 'root' when there is no predecessor,
 * else sha256 over the predecessor key bytes. Deterministic from pinned
 * metadata on every peer.
 */
export function generationId(predecessorKey) {
  if (predecessorKey == null) return ROOT_GENERATION
  return createHash('sha256').update(Buffer.from(keyHex(predecessorKey), 'hex')).digest('hex')
}

/**
 * Build a complete, validated metadata document. `genesisKey` (hex string
 * or 32-byte Buffer) is required — it is both the §8 genesis indexer and
 * the vault (bootstrap) key: a creator passes autobee no key, and autobee
 * then takes the key of the creator's local writer core as the vault key
 * (autobee@2.12.1 lib/boot.js:65-89: with no key, and no `referrer` in the
 * user data of the local core, `result.key = result.local.key` at :86), so
 * the two coincide by construction on every peer.
 */
export function createMetadata(input = {}) {
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
 * The swarm group of an input. A default applies only when its field is
 * absent: no swarm, or a swarm without allow or without genesis (G3-P9
 * F04). A swarm that is not an object is refused by name. genesis is null
 * or a swarm key, 32 bytes or 64 hex characters in any case, else
 * VAULT_BAD_SWARM_GENESIS. Every other key of the group passes through, and
 * validateMetadata refuses it by name.
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
export function swarmGenesis(genesis) {
  if (genesis === undefined || genesis === null) return null
  const hex = swarmKeyHex(genesis)
  if (hex === null) throw swarmGenesisError('metadata.swarm.genesis is not a swarm key (32 bytes or 64 hex characters)')
  return hex
}

export function swarmGenesisError(message) {
  const err = new TypeError(`VAULT_BAD_SWARM_GENESIS: ${message}`)
  err.code = 'VAULT_BAD_SWARM_GENESIS'
  return err
}

/**
 * A supplied list of swarm keys (T25) in canonical form: lowercase hex,
 * sorted, so peers that assemble the same list in another order pin the
 * same bytes. Each entry is 32 bytes or 64 hex characters, in any case.
 * `field` names the list in the error. A value that is not an array, an
 * entry that is not a swarm key, and a key that the list holds twice each
 * throw VAULT_BAD_SWARM_ALLOW (G3-P9 F04). No entry is dropped or merged
 * in silence.
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

/** A swarm key as 64 lowercase hex, from 32 bytes or 64 hex characters in any case; else null. */
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
  if (typeof meta.genesisKey !== 'string' || !HEX64.test(meta.genesisKey)) {
    throw new TypeError('metadata.genesisKey must be a 64-char lowercase-hex key')
  }
  if (meta.appendOnly !== true) {
    // §8: outside the log, no op — and no edited file — can flip it.
    throw new Error('metadata.appendOnly must be exactly true (§8 append-only guarantee)')
  }
  validateGenerationChain(meta)
  // limits and rate are closed groups. applyConfig hands each one whole to
  // createApply, so every key in them is a key of this version: version 2
  // has one shape, and a key outside it is refused, never carried.
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
 * T25: swarm is a closed group of two keys in canonical form. allow is a
 * sorted list of distinct keys. genesis (D-060 F01) is null or one key of
 * allow.
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

function validateGenerationChain(meta) {
  const pk = meta.predecessorKey
  if (pk != null && (typeof pk !== 'string' || !HEX64.test(pk))) {
    throw new TypeError('metadata.predecessorKey must be a 64-char lowercase-hex key')
  }
  if (meta.generation !== generationId(pk)) {
    throw new Error('metadata.generation does not match its predecessorKey (§10 generation chain)')
  }
}

/** Canonical on-disk / hash bytes: sorted-key JSON + trailing newline. */
export function canonicalMetadataBytes(meta) {
  return Buffer.from(canonical.stableStringify(validateMetadata(meta)) + '\n', 'utf8')
}

/** Cross-peer metadata pin: sha256 of the canonical bytes. */
export function metadataHash(meta) {
  return createHash('sha256').update(canonicalMetadataBytes(meta)).digest('hex')
}

/** The createApply(config) slice of the metadata (core apply.js contract). */
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

/** Load pinned metadata; null when the file does not exist. */
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
