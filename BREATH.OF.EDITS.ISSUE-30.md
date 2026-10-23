---
targets:
  - "GitHub issue #30 (directory-move ingest data-loss)"
governs: technical-product-writer (BLUF) + Paley (#5, #8, #11)
glossary: BREATH.OF.GLOSSARY.md
---

# Edit plan — issue #30

## BLUF
This one is close, because it was written for a task (fix-or-defer). Two small
moves finish it: put the governing question at the very top, and split the
measured failure from the proposed fix direction.

## What already breathes (do not change)
The repro-as-code honors Paley #8 (exact syntax → code) and the product-writer
"show, don't tell." The root-cause table matches representation to relation.
The `file:line` anchors are good return targets. Leave all of it.

## Beats that do not land
- **The decision is implied, not stated first.** The reader's question is "can
  this be hotfixed — yes or no — and what unblocks it." The answer (no, because
  it needs a semantics decision plus a core-determinism change) is spread
  across the body. Lead with it in one block (BLUF).
- **Measured failure and fix direction touch.** The observed data loss
  (measured: exit 2, file unlinked) and the suggested fix (inference: add
  ingest-before-delete ordering) share a region. Separate them (#11) so a
  reader can trust the failure without adopting the proposed fix.
- **"The delete wins" is the finding; it arrives mid-paragraph.** Signal it as
  the headline consequence (#7 — spend surprise on the finding).

## Open obligations (term drift → glossary)
- `SetPath`, `DeleteConcept`, `tombstone`, `_id`, `writer` all appear. Link
  first uses. The sentence "SetPath on a tombstoned concept is a silent no-op"
  is the crux — its terms must be unambiguous, or the reader cannot judge the
  severity.
- The severity claim ("major, not a determinism blocker") leans on the glossary
  definition. Link `blocker`/`major` so the classification is checkable, not
  asserted.

## The open design question is the real payload
The resurrect-vs-reject decision is what actually unblocks the fix. Right now
it is the last section; it is arguably the *point* of the issue. Consider
raising it directly under the BLUF: "this cannot be fixed until you decide X."
That serves the reader whose task is to prioritize.

## What not to touch
The repro, the root-cause table, the safe-path workaround, the §7 cross-note.
The issue is 80% right; it needs a BLUF and one seam cut.
