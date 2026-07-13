// Schema + dispatch builder for the auto-okf op wire contract (okf SPEC §3).
//
// Pattern ancestor: vault-ld/core/schema/build.js (patterns only, no code
// path shared — okf SPEC §0 copy-don't-depend). Sources verified 2026-07-13
// against the installed packages:
// - hyperschema@1.21 README + lib/types.js: Hyperschema.from(dir),
//   schema.namespace(name), ns.register({ name, fields: [{ name, type,
//   required, array }] }), Hyperschema.toDisk(schema) — append-only
//   versioned encodings; 'json' is in SupportedTypes.
// - hyperdispatch@1.6 example.js + builder.mjs: Hyperdispatch.from(
//   SCHEMA_DIR, DISPATCH_DIR), hd.namespace(ns).register({ name,
//   requestType }), Hyperdispatch.toDisk(hd); generated spec/hyperdispatch
//   exports { Router, encode, decode, version }. Importing the .mjs
//   builders sets `static esm = true`, so toDisk() emits ESM.
//
// WIRE CONTRACT (okf SPEC §3): this file is APPEND-ONLY for the life of a
// vault. Never reorder or remove structs, fields, or commands; add new ops
// as new commands with new ids. Deprecated ops keep their decoder forever.
import { fileURLToPath } from 'url'
import path from 'path'
import Hyperschema from 'hyperschema'
import Hyperdispatch from 'hyperdispatch'

const dir = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_DIR = path.join(dir, '..', 'spec', 'hyperschema')
const DISPATCH_DIR = path.join(dir, '..', 'spec', 'hyperdispatch')

const schema = Hyperschema.from(SCHEMA_DIR)
const okf = schema.namespace('okf')

// Common fields (okf SPEC §3):
// - `clock`: the writer's observed vector clock at append time, JSON-encoded
//   as [[writerKeyHex, seq], ...] including the writer's own entry (its own
//   seq). Required semantically ("every op carries clock"); optional on the
//   wire so decode never throws — apply rejects a missing/forged clock
//   (reason 'forged-clock', §8).
// - `at`: the writer's wall-clock milliseconds at append time.
//   Informational only, never an input to merge/ordering/conflict detection
//   (I1); a missing/garbage `at` materializes as 1970-01-01, so it is
//   optional on the wire and never a rejection cause.
// - `tag` (opId) is DERIVED by apply from the node (writer key + actual
//   seq), never encoded in the payload. Only RemTag.tags and
//   ResolveConflict.keep/supersede carry references to OTHER ops' tags or
//   hashes (citations, not self-identifications) — as hex strings.

okf.register({
  name: 'create-concept',
  fields: [
    // id absent = mint, id present = adopt (§6)
    { name: 'id', type: 'string' },
    { name: 'path', type: 'string', required: true },
    { name: 'type', type: 'string', required: true },
    { name: 'clock', type: 'json' },
    { name: 'at', type: 'uint' }
  ]
})

okf.register({
  name: 'set-field',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'key', type: 'string', required: true },
    // LWW-array register value (§5): scalar or array of JSON scalars;
    // JSON bytes are fixed at append time so decode is deterministic.
    { name: 'value', type: 'json', required: true },
    { name: 'clock', type: 'json' },
    { name: 'at', type: 'uint' }
  ]
})

okf.register({
  name: 'add-tag',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'value', type: 'string', required: true },
    { name: 'clock', type: 'json' },
    { name: 'at', type: 'uint' }
  ]
})

okf.register({
  name: 'rem-tag',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'value', type: 'string', required: true },
    // every observed tag (opId hex) mapped to the value (§5 OR-set remove)
    { name: 'tags', type: 'string', array: true, required: true },
    { name: 'clock', type: 'json' },
    { name: 'at', type: 'uint' }
  ]
})

okf.register({
  name: 'set-body',
  fields: [
    { name: 'id', type: 'string', required: true },
    // base: 64-char lowercase-hex revHash of the cited base revision, or
    // null for "no base cited" (§5, §6 _rev).
    { name: 'base', type: 'string' },
    { name: 'text', type: 'string', required: true },
    { name: 'clock', type: 'json' },
    { name: 'at', type: 'uint' }
  ]
})

okf.register({
  name: 'set-path',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'path', type: 'string', required: true },
    { name: 'clock', type: 'json' },
    { name: 'at', type: 'uint' }
  ]
})

okf.register({
  name: 'delete-concept',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'clock', type: 'json' },
    { name: 'at', type: 'uint' }
  ]
})

okf.register({
  name: 'undelete-concept',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'clock', type: 'json' },
    { name: 'at', type: 'uint' }
  ]
})

okf.register({
  name: 'resolve-conflict',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'keep', type: 'string', required: true },
    { name: 'supersede', type: 'string', array: true, required: true },
    { name: 'text', type: 'string' },
    { name: 'clock', type: 'json' },
    { name: 'at', type: 'uint' }
  ]
})

okf.register({
  name: 'add-writer',
  fields: [
    { name: 'key', type: 'buffer', required: true },
    { name: 'indexer', type: 'bool', required: true },
    { name: 'clock', type: 'json' },
    { name: 'at', type: 'uint' }
  ]
})

okf.register({
  name: 'remove-writer',
  fields: [
    { name: 'key', type: 'buffer', required: true },
    { name: 'clock', type: 'json' },
    { name: 'at', type: 'uint' }
  ]
})

okf.register({
  name: 'set-writer-policy',
  fields: [
    { name: 'key', type: 'buffer', required: true },
    { name: 'namespacePrefixes', type: 'string', array: true, required: true },
    { name: 'rateCeiling', type: 'uint', required: true },
    { name: 'clock', type: 'json' },
    { name: 'at', type: 'uint' }
  ]
})

Hyperschema.toDisk(schema)

const hd = Hyperdispatch.from(SCHEMA_DIR, DISPATCH_DIR)
const cmds = hd.namespace('okf')

// Command ids are assigned in registration order starting at 0 and are
// frozen thereafter (dispatch.json pins them). APPEND-ONLY (§3).
for (const name of [
  'create-concept',
  'set-field',
  'add-tag',
  'rem-tag',
  'set-body',
  'set-path',
  'delete-concept',
  'undelete-concept',
  'resolve-conflict',
  'add-writer',
  'remove-writer',
  'set-writer-policy'
]) {
  cmds.register({ name, requestType: '@okf/' + name })
}

Hyperdispatch.toDisk(hd)

console.log('schema generated:', SCHEMA_DIR, DISPATCH_DIR)
