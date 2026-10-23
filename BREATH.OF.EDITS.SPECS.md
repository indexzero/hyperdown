---
targets:
  - okf/SPEC.md
  - prompts/01-implementation-spec-prompt.v5.md
governs: technical-documentation-architect (Diataxis Reference, progressive disclosure, return targets) + Paley (#6 second pass, #12 degraded conditions)
glossary: BREATH.OF.GLOSSARY.md
---

# Edit plan — the two SPECs

## BLUF
Specs are the highest-stakes second-pass documents in the repo: an implementer
returns to a named invariant or op under fatigue and must relocate it by
structure, not by re-reading. The single highest-leverage change is *return
targets* — make every invariant, op, and gate a heading or stable anchor.

## The reader here is the tired expert (Paley #12, #27)
A spec is read in a degraded state — hours in, reconstructing one clause. Every
buried definition taxes that reader. Progressive disclosure (doc-architect):
the op table and invariant list are the map; the clauses are the territory;
both must be findable at a glance.

## Beats that do not land
- **Invariants live mid-paragraph.** I1–I11 are stated in a running list where
  a returning reader cannot land on "I8" by eye. Make each invariant a stable
  anchor (a definition-list term or a short heading). This is the #1 return
  target (Paley #6, doc-architect "require-heading-ids").
- **Ops are defined in a code block but discussed in distant prose.** Keep the
  wire-contract block (Reference, exact syntax → code, Paley #8) but give each
  op a named anchor where its semantics are explained, so `SetPath`'s rules are
  one jump from its declaration, not a scroll away (#15 — keep evidence near
  the claim).
- **§8 governance is one long movement** through authority, revocation, rate,
  optimistic onboarding. Four beats. Sub-headings at each state change (#22 —
  one state transition per beat).

## Open obligations (term drift → glossary)
- The specs are where terms *must* be canonical, because implementers copy
  them. Every load-bearing term's first use in each spec should link the
  glossary: `writer`, `indexer`, `tag`, `seq`, `_id`, `_rev`, `path`, `apply`,
  `view`, `flag`, `wanted/`, `blocker`. The glossary was built for this file
  above all.
- vault-ld spec: the autobase→autobee reconciliation (PR #31) added a substrate
  note but the body still says "Autobase op log" throughout. That is a
  deliberate, documented choice — but it is an open obligation for the reader
  unless the substrate note is a *return target* they can re-find. Make it an
  anchored section, not a one-time blockquote.

## The §7 win to preserve (okf/SPEC.md)
The §7 category-error fix (PR #32) is a model of Paley #11: it separated the
wrong inference (TPDS cycles) from the correct descriptive tail (N SetPaths).
Keep that separation visible — do not let a future edit re-fuse them.

## Progressive disclosure (doc-architect)
Consider a short "read this first" map at the top of each spec: the op table,
the invariant anchors, the gate list — the three things a returner relocates.
This is the Diataxis Reference index, and it directly serves the skimmer and
the tired expert at once.

## What not to touch
The normative clause wording that survived three adversarial review rounds. RFC
2119 usage. The novelty framing. Structure and anchors change; design does not.
