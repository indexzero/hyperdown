// @autovault-ld/faces — the generated faces of a Vault-LD vault (SPEC-FINAL
// §2/§13): the Markdown/Obsidian vault on disk (materialize + ingest
// watcher) and the Turtle export. Faces are projections; the op log is the
// source of truth and human edits re-enter the system as ops (§9).
export { materialize, buildContextDocument, frontmatterPairs, CONTEXT_FILE } from './lib/materialize.js'
export { createIngestWatcher, IngestWatcher } from './lib/ingest.js'
export { exportTurtle } from './lib/turtle.js'
export { parseNote, renderNote, parseWikiLink, wikiLink } from './lib/note.js'
export { defaultRelPath, classifyTypes, scopeFromPath, layerFromPath } from './lib/placement.js'
export { readVaultState, faceMetadata } from './lib/state.js'
export { MANIFEST_FILE } from './lib/fsatomic.js'
