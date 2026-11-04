// @auto-okf/core (SPEC §13): the 12-op wire contract, apply, the view
// keyspace, canonical forms, revHash and the MemView test double. Nothing
// in this package imports autobee. apply is pure over the view that it is
// given (I1).
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
  DEFAULT_LIMITS,
  normalizePath,
  casefoldPath,
  validatePath,
  namespaceMatches,
  strictlyPrecedes
} from './lib/apply.js'
