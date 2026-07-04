// Vault metadata pinning (SPEC-FINAL §13 / packages/core README
// "Vault-metadata constants"): every peer of a vault MUST run createApply
// with identical values — they are convergence-relevant inputs (I2). The
// metadata document is written at init, loaded at open, and carried to
// joining peers in the invite; its canonical bytes (stableStringify:
// sorted keys, fixed JSON) are identical across peers regardless of how
// the object was assembled, so `metadataHash` is a cross-peer pin.
//
// The §3.3 wire-contract schema version is recorded here (`schemaVersion`),
// as the spec requires ("Record the schema version in the vault metadata").
// `encrypted` pins whether the vault's cores are encrypted at rest so a
// reopen-from-disk restores encryption without being handed the key again
// (autobee persists the key itself in the local core's userData —
// verified in autobee@1.0.10 lib/boot.js).
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { canonical } from '@autovault-ld/core'

export const METADATA_VERSION = 1
export const METADATA_FILE = 'vault-ld.json'

// Defaults mirror packages/core README "Vault-metadata constants" exactly.
export const METADATA_DEFAULTS = {
  rootBase: 'vault://data/',
  hostAllowlist: ['tags', 'aliases', 'cssclasses'],
  rate: { tokensPerIndexerOp: 1, capacity: 1024, holdMax: 64 },
  limits: { maxSubjectBytes: 1024, maxOpBytes: 65536, maxDepth: 64 },
  schemaVersion: 1,
  encrypted: false
}

/**
 * Build a complete, validated metadata document. `genesisKey` (hex string
 * or 32-byte Buffer) is required — it is both the §8.0 genesis indexer and
 * the vault (bootstrap) key: autobee derives the creator's vault key from
 * the creator's local writer core (autobee@1.0.10 lib/boot.js: with no key
 * and no keyPair, `result.key = result.local.key`), so the two coincide by
 * construction on every peer.
 */
export function createMetadata(input = {}) {
  const meta = {
    version: METADATA_VERSION,
    genesisKey: keyHex(input.genesisKey),
    rootBase: input.rootBase ?? METADATA_DEFAULTS.rootBase,
    hostAllowlist: [...(input.hostAllowlist ?? METADATA_DEFAULTS.hostAllowlist)],
    rate: { ...METADATA_DEFAULTS.rate, ...(input.rate || {}) },
    limits: { ...METADATA_DEFAULTS.limits, ...(input.limits || {}) },
    schemaVersion: input.schemaVersion ?? METADATA_DEFAULTS.schemaVersion,
    encrypted: input.encrypted === true
  }
  validateMetadata(meta)
  return meta
}

export function validateMetadata(meta) {
  if (!meta || typeof meta !== 'object') throw new TypeError('metadata must be an object')
  if (meta.version !== METADATA_VERSION) {
    throw new Error(`unsupported vault metadata version: ${meta.version}`)
  }
  if (typeof meta.genesisKey !== 'string' || !/^[0-9a-f]{64}$/.test(meta.genesisKey)) {
    throw new TypeError('metadata.genesisKey must be a 64-char lowercase-hex key')
  }
  if (typeof meta.rootBase !== 'string' || meta.rootBase.length === 0) {
    throw new TypeError('metadata.rootBase must be a non-empty string')
  }
  if (!Array.isArray(meta.hostAllowlist) || meta.hostAllowlist.some((k) => typeof k !== 'string')) {
    throw new TypeError('metadata.hostAllowlist must be an array of strings')
  }
  for (const [group, keys] of [
    ['rate', ['tokensPerIndexerOp', 'capacity', 'holdMax']],
    ['limits', ['maxSubjectBytes', 'maxOpBytes', 'maxDepth']]
  ]) {
    for (const k of keys) {
      const v = meta[group] && meta[group][k]
      if (!Number.isInteger(v) || v < 0) {
        throw new TypeError(`metadata.${group}.${k} must be a non-negative integer`)
      }
    }
  }
  if (!Number.isInteger(meta.schemaVersion) || meta.schemaVersion < 1) {
    throw new TypeError('metadata.schemaVersion must be a positive integer')
  }
  if (typeof meta.encrypted !== 'boolean') {
    throw new TypeError('metadata.encrypted must be a boolean')
  }
  return meta
}

/** Canonical on-disk / hash bytes: sorted-key JSON + trailing newline. */
export function canonicalMetadataBytes(meta) {
  return Buffer.from(canonical.stableStringify(validateMetadata(meta)) + '\n', 'utf8')
}

/** Cross-peer metadata pin: sha256 of the canonical bytes. */
export function metadataHash(meta) {
  return createHash('sha256').update(canonicalMetadataBytes(meta)).digest('hex')
}

/** The createApply(config) slice of the metadata (core README table). */
export function applyConfig(meta) {
  validateMetadata(meta)
  return {
    genesisKey: meta.genesisKey,
    rootBase: meta.rootBase,
    hostAllowlist: [...meta.hostAllowlist],
    rate: { ...meta.rate },
    limits: { ...meta.limits }
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
  throw new TypeError('genesisKey is required (hex string or 32-byte buffer)')
}
