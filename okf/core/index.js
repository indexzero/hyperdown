// @auto-okf/core — auto-okf core package (okf SPEC §13): the 12-op wire
// contract (hyperschema + hyperdispatch), the deterministic apply, the view
// keyspace codec, canonical forms, revHash, and the MemView test double.
// Pure: apply operates only on the view interface the substrate hands it;
// no wall clock, no randomness (I1). Transport-agnostic: nothing in this
// package imports autobee.
export * as keyspace from './lib/keyspace.js'
export * as canonical from './lib/canonical.js'
export { revHash, rawHashHex } from './lib/revhash.js'
export { MemView } from './lib/memview.js'
export { extractLinks, normalizeLinkTarget, resolveTarget, dirOf } from './lib/links.js'
export {
  encodeOp,
  decodeOp,
  makeTag,
  parseTag,
  normalizeClock,
  OP_TYPES,
  GOVERNANCE_OPS
} from './lib/ops.js'
export {
  createApply,
  normalizePath,
  casefoldPath,
  validatePath,
  namespaceMatches,
  strictlyPrecedes
} from './lib/apply.js'
