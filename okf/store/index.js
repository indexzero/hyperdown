// @auto-okf/store — auto-okf's substrate package (okf SPEC §13): vault
// lifecycle ON AUTOBEE (a standalone multiwriter Hyperbee; hyperbee2 +
// hypercore 11), vault-metadata pinning (the §8 append-only constant + the
// §10 generation chain), §8 governance plumbing, hyperswarm replication, and
// opt-in append backpressure. @auto-okf/core supplies the deterministic
// apply; this package supplies the transport it folds over.
export { Vault } from './lib/vault.js'
export { ViewAdapter } from './lib/view.js'
export { viewHash } from './lib/hash.js'
export {
  METADATA_VERSION,
  METADATA_FILE,
  METADATA_DEFAULTS,
  ROOT_GENERATION,
  generationId,
  createMetadata,
  validateMetadata,
  canonicalMetadataBytes,
  metadataHash,
  applyConfig,
  saveMetadata,
  loadMetadata,
  keyHex
} from './lib/metadata.js'

import { Vault } from './lib/vault.js'

/**
 * SPEC §13: create a brand-new vault at `dir` — writes the pinned vault
 * metadata (okf-vault.json), including the immutable `appendOnly: true`
 * constant (§8) and the generation-chain fields `{ predecessorKey,
 * predecessorCheckpoint }` (§10, via `opts.metadata`).
 */
export function initVault(dir, opts = {}) {
  return Vault.init(dir, opts)
}

/** SPEC §13: open a vault previously initialized/joined at `dir`. */
export function openVault(dir, opts = {}) {
  return Vault.open(dir, opts)
}

/** Join an existing vault by key (plus invite metadata / encryptionKey). */
export function joinVault(dir, key, opts = {}) {
  return Vault.join(dir, key, opts)
}
