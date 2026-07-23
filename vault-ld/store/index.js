// @autovault-ld/store — Vault-LD on autobee (SPEC-FINAL §14 "store"): vault
// lifecycle over a standalone multiwriter Hyperbee (autobee), core-apply
// wiring through the view adapter, metadata pinning, writer governance
// plumbing, and hyperswarm replication.
export { Vault } from './lib/vault.js'
export { ViewAdapter } from './lib/view.js'
export { viewHash } from './lib/hash.js'
export {
  METADATA_VERSION,
  METADATA_FILE,
  METADATA_DEFAULTS,
  createMetadata,
  validateMetadata,
  canonicalMetadataBytes,
  metadataHash,
  applyConfig,
  saveMetadata,
  loadMetadata
} from './lib/metadata.js'
