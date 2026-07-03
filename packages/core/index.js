// @hyperwiki/core — Vault-LD on Autobase, core package (SPEC-FINAL §14):
// ops, encodings (hyperdispatch), deterministic apply, view keyspace codec,
// canonical forms, revHash. Pure: apply operates only on the view interface
// autobase hands it; no wall clock, no randomness (I1).
export * as keyspace from './lib/keyspace.js'
export * as canonical from './lib/canonical.js'
export { revHash, rawHashHex } from './lib/revhash.js'
export { MemView } from './lib/memview.js'
export {
  encodeOp,
  decodeOp,
  makeTag,
  tagHex,
  parseTag,
  normalizeClock,
  OP_TYPES,
  GOVERNANCE_OPS
} from './lib/ops.js'
export {
  createApply,
  isSafePath,
  namespaceMatches,
  normalizeTermDef
} from './lib/apply.js'
