---
targets:
  - DEVIATIONS.md
governs: technical-documentation-architect (Diataxis Explanation, consistent terminology) + Paley (#2 one beat, #4 stops)
glossary: BREATH.OF.GLOSSARY.md
---

# Edit plan — DEVIATIONS.md

## BLUF
This is the strongest existing doc and the one most at risk. Its lead-sentence
pattern (bold claim, then the why) is exactly Paley's signaling — keep it. The
danger is the long entries: three of them are single paragraphs that change
subject four times. Split each into beats; touch nothing else.

## What already breathes (do not change)
Each entry is one beat with a bold signal (#23). The gutted-to-true-deviations
discipline is single-source-of-truth done right. The autobase→autobee entry
closes its obligation cleanly. Leave the short entries alone.

## Beats that do not land
- **The §13 store port-mapping entry is a 30-line paragraph carrying four
  changes** — node shape, host surface, signedLength, revocation — under one
  breath, with sub-lettered clauses (a)(b)(c)(d) doing the work paragraph
  breaks should do. The reader holds all four ports at once. Fix: one paragraph
  (or a short sub-list) per port. The (d) revocation clause alone is three
  beats (why positional was rejected, what replaces it, the two store
  consequences); it needs stops at those boundaries (#4).
- **The uniform-weight entry buries its consequence.** It explains the
  autobee topo bug for six lines before stating what the store *does* about it
  (admit at weight 2). Put the decision first, the mechanism second (#2 — land
  the guarantee, then its boundary).
- **The percent-encoding entry mixes evidence and inference.** The fetched spec
  quote (evidence) and "encodeName over-encodes" (the finding) run together.
  Separate them (#11).

## Open obligations (term drift → glossary)
- `seq`, `ordinal`, `seen-count`, `tag` all appear in the ordinal-resolution
  entry, which is precisely where they are hardest to keep apart. This entry
  should link every one of them to the glossary — it is the entry the glossary
  exists to protect.
- "the store," "the core," "core's apply," "the store build" drift as subjects
  across the store entry. Fix the subject per beat.

## Diataxis placement (doc-architect)
DEVIATIONS is Explanation (understanding-oriented: *why* the build diverged).
It should not carry Reference detail that belongs in the spec. Where an entry
has become normative (e.g. the ordinal resolution the upstream PRs already
folded into the spec), leave a one-line pointer here and let the spec hold the
Reference. Avoid duplication.

## Recovery points
Add nothing mid-document; the entries are short enough that a per-entry
recovery point would be noise. The single win is a one-line header note: "each
entry is one deviation; skim the bold leads." That serves the skimmer without
padding.

## What not to touch
The 5-entry gutted structure, the bold-lead signaling, the sign-off lines on
open items. This doc is 80% right; only the three long entries need the knife.
