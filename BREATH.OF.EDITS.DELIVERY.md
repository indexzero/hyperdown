---
targets:
  - DELIVERY.md
  - DELIVERY-OKF.md
governs: technical-product-writer (BLUF, three-sentence test, human story) + Paley (#6 second pass, #10 recovery points)
glossary: BREATH.OF.GLOSSARY.md
---

# Edit plan — DELIVERY.md and DELIVERY-OKF.md

## BLUF
These are second-pass documents by nature — a reader returns to them to answer
"is this shippable, and what's unresolved." Right now that answer is
*assembled* by the reader from a dozen sections. State it in two lines at the
top; let the sections defend it.

## The governing question is missing from the top
Both files open with a provenance sentence ("Pipeline completed … driven by
/goal …") — a beat about *how it ran*, not *what it means*. The reader's
question is the three-sentence test: what shipped, is it safe, what's open.
Add a `## Bottom line` block: shipped / verified / one open major. Everything
below is the return-target detail (Paley #6).

## Beats that do not land
- **The waived-majors line hides the one that matters.** DELIVERY-OKF folds C1
  into a "Known caveats" paragraph alongside routine items. C1 (the
  memory/liveness major awaiting your sign-off) is a decision the reader must
  make; it deserves its own beat and a visible boundary, not burial among
  epoch-sensitivity notes.
- **Loop counters read as trivia.** "one iteration per build task — no
  remediation loop hit its ceiling" is a genuine result (the build was clean on
  the first pass). Stated mid-list it reads as bookkeeping. Signal it as the
  cost-of-convergence finding it is.
- **Evidence and inference fused.** "G6 FINAL-PASS … so the milestone stands as
  delivered" — separate the verification (measured) from the standing (a
  judgment). Paley #11.

## Open obligations (term drift → glossary)
- `blocker` vs `major` is used loosely in the caveats. C1 is explicitly a
  **major, not a blocker** (glossary: blocker/major). Link it and the severity
  stops sliding.
- "the stack" appears without a stable referent as the merge-order paragraph
  shifts subject. Name it: the ten stacked PRs, #21→#32.

## The human story is under-told (product-writer)
The delivery record is dry where it has a real narrative: the pipeline caught
its own would-be blocker (the poison-op) before it shipped, and a
different-architecture model (codex) caught two bugs the internal chain missed.
That is a story about the *method working*, not just a metric. One paragraph,
told plainly, earns its place.

## Recovery points
After the gates table and after the PR-stack table, add one orienting line each
("net: shippable with one major pending your call"). A returning reader who
skimmed the tables rejoins there. Paley #10 — restore orientation in one line,
not a re-summary.

## Cross-reference, don't duplicate (doc-architect)
Both DELIVERY files restate severity and invariant meanings inline. Replace
with glossary links. Single source of truth; the files get shorter and stop
drifting from each other.

## What not to touch
The artifact-path and PR-stack tables are correct representation (repeated
data → table). Do not narrate them into prose. Do not inflate the human story
past what happened.
