---
targets:
  - README.md (top-level, both stacks)
  - vault-ld/{core,store,faces,cli}/README.md
  - okf/{core,store,faces,cli}/README.md
  - okf/examples/*/README.md
  - harness/README.md and okf/harness/README.md
governs: technical-documentation-architect (Diataxis, progressive disclosure) + Paley (#8 representation, #1 grounding)
glossary: BREATH.OF.GLOSSARY.md
---

# Edit plan — the READMEs

## BLUF
The package READMEs are already usage-first (a working example before prose) —
that is the doc-architect quickstart done right, keep it. Their gap is
consistency, not structure: eight READMEs ground the same terms eight
different ways. Point them all at one glossary and they become one system.

## What already breathes (do not change)
The example-first pattern in every package README. The top-level README's
architecture diagram and the registry-tuple framing. These are Diataxis
Tutorial/quickstart and Explanation done correctly. Do not touch the examples.

## The shared breath failure: eight groundings of one vocabulary
Each README re-explains `writer`, `vault`, `concept`, `_id`, `apply` in its own
words, and the words have drifted apart (a store README calls a `writer` "a
peer"; a faces README calls a `concept` "a note"). This is the exact
consistent-terminology failure the glossary fixes. Each README should ground a
term once by linking the glossary, then use it stably (Paley #1). One meaning,
eight files.

## Beats that do not land
- **Top-level README mixes two audiences in one breath.** It swings between the
  learner ("here's a working example") and the architect ("op log on autobee is
  the source of truth") without a boundary. Diataxis: separate the Tutorial
  beat from the Explanation beat with a heading (#4, #21 — a real subject
  change gets a real stop).
- **Package READMEs state the API in prose.** The API surface is Reference
  (repeated, structured) — a table or a signature list, not sentences
  (Paley #8, doc-architect Reference quadrant).
- **`autobee` grounding is inconsistent and sometimes drifts toward
  "autobase."** Every README that names the substrate must link
  `[autobee](BREATH.OF.GLOSSARY.md#autobee)`; the glossary's "not this: not
  autobase" then travels with it.

## Progressive disclosure (doc-architect)
The top-level README should be the map: one-liner, smallest working example,
install, then links *out* to the package READMEs (Reference) and the examples
(Tutorial). It should not try to be all four Diataxis quadrants at once. Layer
it: quickstart here, depth behind links.

## The examples' READMEs are the Tutorial quadrant
The recipe-book, agent-session, slop-archive, and vlurp-library READMEs are
learning-oriented. They should lead with *what you'll see* and the runnable
command (product-writer's human story: "we told four agents to write a recipe
book"), then the roundtrip diagram. Most already do; align the stragglers.

## What not to touch
The working examples, the diagrams, the recipe-book narrative. The fix is
grounding-by-link and moving API prose into Reference shape — not rewriting
what already lands.
