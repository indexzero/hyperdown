// @auto-okf/faces — the generated faces of auto-okf (okf SPEC §9, §13):
//   - materialize(vault, dir, opts): byte-deterministic OKF v0.1 bundle
//     (one file per live concept, per-directory index.md, root log.md),
//     reconciled through an emission manifest that never deletes or
//     overwrites human-authored files (N3).
//   - createIngestWatcher(vault, dir, opts): human edits re-enter as minimal
//     ops (per-key frontmatter diff, body diff citing _rev, the §6 _id
//     rules, conflict-copy awareness, guarded deletes).
//   - wanted(vault): the ranked demand index from wanted/ + wantedrank/.
//
// The bundle format is normative to the OKF v0.1 SPEC; the canonical YAML
// emitter is hand-rolled for byte-determinism (I9). Nothing here imports
// autobee — a @auto-okf/store Vault (or any { val, scan, update } + content
// helpers) is passed in.
export { materialize, renderIndex, renderLog } from './lib/materialize.js'
export { createIngestWatcher, IngestWatcher } from './lib/ingest.js'
export { compact } from './lib/compact.js'
export { wanted } from './lib/wanted.js'
export { readView, readLog, memViewReader } from './lib/view.js'
export {
  renderNote,
  parseNote,
  emitFrontmatter,
  emitYamlValue,
  emitYamlKey,
  yamlToValue,
  yamlToValues
} from './lib/yaml.js'
