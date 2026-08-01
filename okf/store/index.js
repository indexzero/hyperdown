// @auto-okf/store — auto-okf's substrate package (okf SPEC §13): vault
// lifecycle ON AUTOBEE (a standalone multiwriter Hyperbee; hyperbee2 +
// hypercore 11), vault-metadata pinning (the §8 append-only constant + the
// §10 generation chain), §8 governance plumbing, hyperswarm replication, and
// opt-in append backpressure. @auto-okf/core supplies the deterministic
// apply; this package supplies the transport it folds over.
export { Bundle } from './lib/bundle.js'
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
