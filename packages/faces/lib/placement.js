// Note placement (SPEC-FINAL §9.3/§10.1, vault-ld §5.1 resource-per-file
// layout, verified against the vault-ld SPEC.md table):
//
//   owl:Ontology                              Ontologies/{Name}/{Name}.md
//   owl:Class                                 Ontologies/{Name}/Classes/{ClassName}.md
//   owl:ObjectProperty / owl:DatatypeProperty Ontologies/{Name}/Properties/{propertyName}.md
//   skos:ConceptScheme                        Vocabularies/{Scheme}/{Scheme}.md
//   skos:Concept                              Vocabularies/{Scheme}/{Concept}.md
//   everything else (instances)               <name>.md at the context root
//     ("Only notes at their reconstructable default — an unpinned instance
//      at the context root, a flatly placed schema note — need no such
//      [vld:path] triple.")
//
// Paths handled here are context-relative and carry NO '.md' extension;
// n/<s>/path stores the extensionless form and the faces add '.md' at the
// file boundary (§10.4 emits `vld:path "<path>.md"` by appending it).
import { isSafePath, canonical } from '@autovault-ld/core'

const { nfc } = canonical

// Recognized meta-types, mirrored from core's §10.1 layer rule.
const CLASS_TYPES = new Set(['owl:Class', 'rdfs:Class'])
const PROPERTY_TYPES = new Set(['owl:ObjectProperty', 'owl:DatatypeProperty', 'rdf:Property'])

/**
 * Classify a subject's schema role from its '@type' names, in a fixed
 * priority order (deterministic when a note carries several meta-types):
 * ontology > class > property > scheme > concept > null.
 */
export function classifyTypes(types) {
  if (types.includes('owl:Ontology')) return 'ontology'
  if (types.some((t) => CLASS_TYPES.has(t))) return 'class'
  if (types.some((t) => PROPERTY_TYPES.has(t))) return 'property'
  if (types.includes('skos:ConceptScheme')) return 'scheme'
  if (types.includes('skos:Concept')) return 'concept'
  return null
}

/**
 * The reconstructable default location (extensionless, context-relative)
 * for a subject — the location vld:path may be omitted for (§10.4).
 */
export function defaultRelPath(subject, layer, scope, types) {
  if (layer === 'schema' && scope) {
    switch (classifyTypes(types)) {
      case 'class':
        return `Ontologies/${scope}/Classes/${subject}`
      case 'property':
        return `Ontologies/${scope}/Properties/${subject}`
      case 'scheme':
      case 'concept':
        return `Vocabularies/${scope}/${subject}`
      case 'ontology':
      default:
        return `Ontologies/${scope}/${subject}`
    }
  }
  return subject // unpinned instance at the context root
}

/** Scope implied by an authored path's top segments (§9.3 ingest capture). */
export function scopeFromPath(relPath) {
  const segs = String(relPath).split('/')
  if ((segs[0] === 'Ontologies' || segs[0] === 'Vocabularies') && segs.length > 1) {
    return segs[1]
  }
  return null
}

/** Layer implied by an authored path (§10.1 priority (1)). */
export function layerFromPath(relPath) {
  const top = String(relPath).split('/')[0]
  return top === 'Ontologies' || top === 'Vocabularies' ? 'schema' : 'data'
}

/**
 * Materialize-side placement (§9.1/§9.3/§9.4): authored path when present,
 * else the reconstructable default. Returns
 *   { rel }            extensionless context-relative path, or
 *   { unsafe: reason } when the file must be skipped (§9.4 (a)–(c); the
 *                      case-collision check (d) is done across the whole
 *                      file set by the caller).
 */
export function placeSubject(subject, state) {
  const authored = state.path ? state.path.path : undefined
  if (authored !== undefined) {
    // apply already rejected unsafe SetPath values (§9.4), but materialize
    // re-validates: defense in depth against a view produced by a peer
    // running different code.
    if (!isSafePath(authored)) return { unsafe: 'unsafe-authored-path' }
    return { rel: nfc(authored) }
  }
  // §9.4 (a): a path separator in the subject position is unsafe — the
  // subject name is a vault-ld file NAME, never a path. Namespaced
  // subjects (e.g. 'agents/alice/Note', §8.6) materialize only once they
  // carry an authored path (SetPath).
  if (subject.includes('/') || subject.includes('\\')) {
    return { unsafe: 'separator-in-subject' }
  }
  if (!isSafePath(subject)) return { unsafe: 'unsafe-subject' }
  const scope = state.base ? state.base.scope : null
  const rel = defaultRelPath(subject, state.layer, scope, typeNamesOf(state))
  if (!isSafePath(rel)) return { unsafe: 'unsafe-default-path' }
  return { rel }
}

function typeNamesOf(state) {
  const rec = state.fields.get('@type')
  const out = []
  if (rec && rec.els) {
    for (const el of Object.values(rec.els)) {
      const v = el.v
      out.push(v !== null && typeof v === 'object' && typeof v.ref === 'string' ? v.ref : String(v))
    }
  }
  return out
}
