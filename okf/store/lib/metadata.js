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
// §10 epoch chain: `{ predecessorKey, predecessorCheckpoint }` (both null
// for a genesis vault) record which vault this one was compacted from.
// `predecessorCheckpoint = { viewHash, writerLengths, signer?, signature? }`
// — signed by the operator key that ran compact; provenance metadata, not
// proof (consumers MUST treat cross-epoch identity as trusted-operator
// scope), so the signature is carried, never verified here.
//
// §10 writer-key freshness: writer cores derive under a per-epoch
// corestore namespace recorded in the metadata (`epoch`). The epoch id is
// a PURE FUNCTION of the predecessor fields — 'genesis' for a first-epoch
// vault, else sha256(predecessorKey bytes || stableStringify(checkpoint))
// — so every peer of one vault derives the same namespace from the same
// pinned metadata, an operator re-initing in a REUSED corestore directory
// still gets fresh writer keypairs (the namespace differs from the
// predecessor's), and a joiner handed only the predecessor fields can
// reconstruct it (implementation resolution where §10 is silent on HOW the
// namespace is derived; code-comment scope per SPEC §0 rule 4).
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { canonical } from '@auto-okf/core'

export const METADATA_VERSION = 1
export const METADATA_FILE = 'okf-vault.json'
export const GENESIS_EPOCH = 'genesis'

const HEX64 = /^[0-9a-f]{64}$/
const HEX = /^[0-9a-f]+$/

// limits/rate defaults mirror @auto-okf/core lib/apply.js DEFAULTS exactly
// (§3 limits; §8 rate — unackedCeiling 64 and holdMax 512 are spec-pinned,
// defaultCeiling is the spec-silent admitted-writer ceiling pinned here
// and in core).
export const METADATA_DEFAULTS = {
  limits: { maxOpBytes: 65536, maxPathBytes: 1024, maxPathDepth: 64 },
  rate: { defaultCeiling: 1024, unackedCeiling: 64, holdMax: 512 },
  schemaVersion: 1,
  encrypted: false,
  predecessorKey: null,
  predecessorCheckpoint: null
}

/**
 * The §10 per-epoch namespace id: 'genesis' when there is no predecessor,
 * else sha256 over the predecessor key bytes and the checkpoint's
 * canonical JSON. Deterministic from pinned metadata on every peer.
 */
export function epochId(predecessorKey, predecessorCheckpoint) {
  if (predecessorKey == null && predecessorCheckpoint == null) return GENESIS_EPOCH
  if (predecessorKey == null || predecessorCheckpoint == null) {
    throw new TypeError('predecessorKey and predecessorCheckpoint must be set together (§10)')
  }
  const h = createHash('sha256')
  h.update(Buffer.from(keyHex(predecessorKey), 'hex'))
  h.update(canonical.stableStringify(predecessorCheckpoint))
  return h.digest('hex')
}

/**
 * Build a complete, validated metadata document. `genesisKey` (hex string
 * or 32-byte Buffer) is required — it is both the §8 genesis indexer and
 * the vault (bootstrap) key: autobee derives the creator's vault key from
 * the creator's local writer core (autobee@1.0.10 lib/boot.js: with no key
 * and no keyPair, `result.key = result.local.key`), so the two coincide by
 * construction on every peer.
 */
export function createMetadata(input = {}) {
  if (input.appendOnly !== undefined && input.appendOnly !== true) {
    throw new TypeError('appendOnly is an immutable vault constant and MUST be true (§8)')
  }
  const predecessorKey = input.predecessorKey != null ? keyHex(input.predecessorKey) : null
  const predecessorCheckpoint = input.predecessorCheckpoint ?? null
  const meta = {
    version: METADATA_VERSION,
    genesisKey: keyHex(input.genesisKey),
    appendOnly: true,
    epoch: epochId(predecessorKey, predecessorCheckpoint),
    predecessorKey,
    predecessorCheckpoint,
    limits: { ...METADATA_DEFAULTS.limits, ...(input.limits || {}) },
    rate: { ...METADATA_DEFAULTS.rate, ...(input.rate || {}) },
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
  if (typeof meta.genesisKey !== 'string' || !HEX64.test(meta.genesisKey)) {
    throw new TypeError('metadata.genesisKey must be a 64-char lowercase-hex key')
  }
  if (meta.appendOnly !== true) {
    // §8: outside the log, no op — and no edited file — can flip it.
    throw new Error('metadata.appendOnly must be exactly true (§8 append-only guarantee)')
  }
  validateEpochChain(meta)
  for (const [group, keys] of [
    ['limits', ['maxOpBytes', 'maxPathBytes', 'maxPathDepth']],
    ['rate', ['defaultCeiling', 'unackedCeiling', 'holdMax']]
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

function validateEpochChain(meta) {
  const pk = meta.predecessorKey
  const cp = meta.predecessorCheckpoint
  if ((pk == null) !== (cp == null)) {
    throw new TypeError('predecessorKey and predecessorCheckpoint must be set together (§10)')
  }
  if (pk != null) {
    if (typeof pk !== 'string' || !HEX64.test(pk)) {
      throw new TypeError('metadata.predecessorKey must be a 64-char lowercase-hex key')
    }
    if (typeof cp !== 'object' || Array.isArray(cp)) {
      throw new TypeError('metadata.predecessorCheckpoint must be an object')
    }
    if (typeof cp.viewHash !== 'string' || !HEX64.test(cp.viewHash)) {
      throw new TypeError('predecessorCheckpoint.viewHash must be the 64-hex I2 full-range hash')
    }
    if (
      !Array.isArray(cp.writerLengths) ||
      cp.writerLengths.some(
        (e) =>
          !Array.isArray(e) ||
          e.length !== 2 ||
          typeof e[0] !== 'string' ||
          !HEX64.test(e[0]) ||
          !Number.isInteger(e[1]) ||
          e[1] < 0
      )
    ) {
      throw new TypeError('predecessorCheckpoint.writerLengths must be [[64-hex key, length], ...]')
    }
    for (const f of ['signer', 'signature']) {
      if (cp[f] !== undefined && (typeof cp[f] !== 'string' || !HEX.test(cp[f]))) {
        throw new TypeError(`predecessorCheckpoint.${f} must be a hex string when present`)
      }
    }
  }
  if (meta.epoch !== epochId(pk, cp)) {
    throw new Error('metadata.epoch does not match its predecessor fields (§10 epoch chain)')
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
