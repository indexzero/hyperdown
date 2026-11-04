// @auto-okf/store (SPEC §13): the vault lifecycle on autobee, metadata
// pinning, governance plumbing, private hyperswarm replication behind a
// firewall, the DHT bootstrap node, and append backpressure. @auto-okf/core
// supplies apply. This package supplies the transport that apply folds
// over.
export { Bundle } from './lib/bundle.js'
export { startBootstrapNode } from './lib/dht.js'
export { LOCAL_ALLOW_FILE, saveLocalAllow, loadLocalAllow } from './lib/local-allow.js'
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
