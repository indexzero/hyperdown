// Schema and dispatch builder for the op wire contract (SPEC §3). toDisk()
// writes okf/core/spec/.
//
// WIRE CONTRACT (SPEC §3): this file is APPEND-ONLY for the life of a
// vault. Never reorder or remove a struct, a field or a command. Add a new
// op as a new command with a new id. A deprecated op keeps its decoder
// forever.
import { fileURLToPath } from 'url'
import path from 'path'
import Hyperschema from 'hyperschema'
import Hyperdispatch from 'hyperdispatch'

const dir = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_DIR = path.join(dir, '..', 'spec', 'hyperschema')
const DISPATCH_DIR = path.join(dir, '..', 'spec', 'hyperdispatch')

const schema = Hyperschema.from(SCHEMA_DIR)
const okf = schema.namespace('okf')

// Common fields (SPEC §3). `clock` is the vector clock of the writer, JSON
// [[writerKeyHex, seq], ...]. It is optional on the wire so that decode
// never throws. apply rejects a missing one. `at` is the wall-clock
// milliseconds at append time, informational only, never a rejection. The
// tag (opId) is not on the wire. apply derives it from the node.

okf.register({
  name: 'create-concept',
  fields: [
    // id absent: mint. id present: adopt (§6).
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
    // LWW array register value (§5): a scalar or an array of JSON scalars.
    // The JSON bytes are fixed at append time, so decode is deterministic.
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
    // every observed tag (opId hex) that maps to the value (§5 OR-set remove)
    { name: 'tags', type: 'string', array: true, required: true },
    { name: 'clock', type: 'json' },
    { name: 'at', type: 'uint' }
  ]
})

okf.register({
  name: 'set-body',
  fields: [
    { name: 'id', type: 'string', required: true },
    // the 64-char lowercase hex revHash of the cited base revision, or
    // null for no base (§5, §6)
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
    { name: 'at', type: 'uint' },
    // The 32-byte hyperswarm public key of the writer, or null. apply
    // checks the length (§8). The firewall admits the swarm keys of live
    // gov/writer records. It is a field of schema version 1, because no
    // vault of an earlier release carries over.
    { name: 'swarmKey', type: 'buffer' }
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

// Command ids follow registration order from 0, and dispatch.json freezes
// them. APPEND-ONLY (§3).
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
