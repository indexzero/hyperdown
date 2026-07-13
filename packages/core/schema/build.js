// Schema + dispatch builder for the vault op wire contract (SPEC-FINAL §3).
//
// Sources verified 2026-07-03:
// - https://github.com/holepunchto/hyperschema README: Hyperschema.from(dir),
//   schema.namespace(name), ns.register({ name, fields: [{ name, type,
//   required, array }] }), Hyperschema.toDisk(schema) — append-only versioned
//   encodings ("you can always encode/decode objects with any previous schema
//   version"). 'json' is in SupportedTypes (hyperschema/lib/types.js).
// - https://github.com/holepunchto/hyperdispatch example.js: Hyperdispatch
//   .from(SCHEMA_DIR, DISPATCH_DIR), hd.namespace(ns).register({ name,
//   requestType }), Hyperdispatch.toDisk(hd). Generated spec/hyperdispatch
//   exports { Router, encode, decode, version }.
// - ESM output: importing the .mjs builders sets `static esm = true`, which
//   toDisk() uses to emit ESM (verified in hyperdispatch/builder.cjs and
//   builder.mjs of the installed packages).
//
// WIRE CONTRACT (SPEC-FINAL §3.3): this file is APPEND-ONLY for the life of a
// vault. Never reorder or remove structs, fields, or commands; add new ops as
// new commands with new ids. Deprecated ops keep their decoder forever.
import { fileURLToPath } from 'url'
import path from 'path'
import Hyperschema from 'hyperschema'
import Hyperdispatch from 'hyperdispatch'

const dir = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_DIR = path.join(dir, '..', 'spec', 'hyperschema')
const DISPATCH_DIR = path.join(dir, '..', 'spec', 'hyperdispatch')

const schema = Hyperschema.from(SCHEMA_DIR)
const vault = schema.namespace('vault')

// Common field notes:
// - `clock` (§3.2): the writer's observed vector clock at append time,
//   JSON-encoded as [[writerKeyHex, seq], ...]. Sole normative consumer is
//   the revocation rule (§8.3). Optional on the wire; a missing clock on an
//   op from a revoked writer rejects with reason 'revoked' (§8.3).
// - `tag` (§3.2): opId = writerKey || seq, a 40-byte buffer
//   (32-byte writer key || 8-byte big-endian seq).
// - `o` / `def` use the compact-encoding 'json' type: op values are
//   polymorphic (scalar | array | { ref } | typed literal). JSON bytes are
//   fixed at append time by the writer, so decode is deterministic (§3.3).

vault.register({
  name: 'set-field',
  fields: [
    { name: 's', type: 'string', required: true },
    { name: 'p', type: 'string', required: true },
    { name: 'o', type: 'json', required: true },
    { name: 'tag', type: 'buffer', required: true },
    { name: 'ctxKind', type: 'string' },
    { name: 'clock', type: 'json' }
  ]
})

vault.register({
  name: 'add-member',
  fields: [
    { name: 's', type: 'string', required: true },
    { name: 'p', type: 'string', required: true },
    { name: 'o', type: 'json', required: true },
    { name: 'tag', type: 'buffer', required: true },
    { name: 'ctxKind', type: 'string' },
    { name: 'clock', type: 'json' }
  ]
})

vault.register({
  name: 'rem-member',
  fields: [
    { name: 's', type: 'string', required: true },
    { name: 'p', type: 'string', required: true },
    { name: 'tags', type: 'buffer', array: true, required: true },
    { name: 'ctxKind', type: 'string' },
    { name: 'clock', type: 'json' }
  ]
})

vault.register({
  name: 'unset-field',
  fields: [
    { name: 's', type: 'string', required: true },
    { name: 'p', type: 'string', required: true },
    { name: 'tag', type: 'buffer', required: true },
    { name: 'clock', type: 'json' }
  ]
})

vault.register({
  name: 'set-body',
  fields: [
    { name: 's', type: 'string', required: true },
    // base: 64-char lowercase-hex revHash of the cited base revision,
    // or null for a root revision (§6).
    { name: 'base', type: 'string' },
    { name: 'text', type: 'string', required: true },
    { name: 'clock', type: 'json' }
  ]
})

vault.register({
  name: 'set-path',
  fields: [
    { name: 's', type: 'string', required: true },
    { name: 'path', type: 'string', required: true },
    // scope of the authored path's nearest context, computed at ingest and
    // carried on the SetPath op (§10.1 subject-scope binding rule (a)).
    { name: 'scope', type: 'string' },
    { name: 'clock', type: 'json' }
  ]
})

vault.register({
  name: 'delete-subject',
  fields: [
    { name: 's', type: 'string', required: true },
    { name: 'tag', type: 'buffer', required: true },
    { name: 'clock', type: 'json' }
  ]
})

vault.register({
  name: 'resolve-conflict',
  fields: [
    { name: 's', type: 'string', required: true },
    { name: 'keep', type: 'string', required: true },
    { name: 'supersede', type: 'string', array: true, required: true },
    { name: 'text', type: 'string' },
    { name: 'clock', type: 'json' }
  ]
})

vault.register({
  name: 'clear-flag',
  fields: [
    { name: 'flagKey', type: 'string', required: true },
    { name: 'clock', type: 'json' }
  ]
})

vault.register({
  name: 'define-term',
  fields: [
    { name: 'scope', type: 'string', required: true },
    { name: 'term', type: 'string', required: true },
    { name: 'def', type: 'json', required: true },
    { name: 'clock', type: 'json' }
  ]
})

vault.register({
  name: 'define-scope',
  fields: [
    { name: 'scope', type: 'string', required: true },
    { name: 'base', type: 'string', required: true },
    { name: 'prefix', type: 'string', required: true },
    { name: 'clock', type: 'json' }
  ]
})

vault.register({
  name: 'add-writer',
  fields: [
    { name: 'key', type: 'buffer', required: true },
    { name: 'indexer', type: 'bool', required: true },
    { name: 'clock', type: 'json' }
  ]
})

vault.register({
  name: 'remove-writer',
  fields: [
    { name: 'key', type: 'buffer', required: true },
    { name: 'clock', type: 'json' }
  ]
})

vault.register({
  name: 'set-writer-policy',
  fields: [
    { name: 'key', type: 'buffer', required: true },
    { name: 'namespacePrefixes', type: 'string', array: true, required: true },
    { name: 'rateCeiling', type: 'uint', required: true },
    { name: 'clock', type: 'json' }
  ]
})

vault.register({
  name: 'prune-revisions',
  fields: [
    { name: 's', type: 'string', required: true },
    { name: 'before', type: 'string', required: true },
    { name: 'clock', type: 'json' }
  ]
})

Hyperschema.toDisk(schema)

const hd = Hyperdispatch.from(SCHEMA_DIR, DISPATCH_DIR)
const cmds = hd.namespace('vault')

// Command ids are assigned in registration order starting at offset 0 and are
// frozen thereafter (dispatch.json pins them). APPEND-ONLY (§3.3).
for (const name of [
  'set-field',
  'add-member',
  'rem-member',
  'unset-field',
  'set-body',
  'set-path',
  'delete-subject',
  'resolve-conflict',
  'clear-flag',
  'define-term',
  'define-scope',
  'add-writer',
  'remove-writer',
  'set-writer-policy',
  'prune-revisions'
]) {
  cmds.register({ name, requestType: '@vault/' + name })
}

Hyperdispatch.toDisk(hd)

console.log('schema generated:', SCHEMA_DIR, DISPATCH_DIR)
