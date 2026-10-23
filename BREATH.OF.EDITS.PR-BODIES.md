---
targets:
  - "PR #21 feat(okf): @auto-okf/core + invariant suite"
  - "PR #22 feat(okf): @auto-okf/store on autobee"
  - "PR #23 feat(okf): @auto-okf/faces"
  - "PR #24 feat(okf): epoch-cycle compaction + I11"
  - "PR #25 feat(okf): @auto-okf/cli"
  - "PR #26 feat(okf): three examples"
  - "PR #27 test(okf): multi-process fault harness"
  - "PR #29 review(okf): adversarial code review + fixes"
  - "PR #31 docs(vault-ld): upstream into SPEC v5.1"
  - "PR #32 docs(okf): upstream into SPEC v1.3"
governs: technical-product-writer (BLUF + word hygiene) + Paley (#5 first pass, #24 skimmer)
glossary: BREATH.OF.GLOSSARY.md
---

# Edit plan — PR bodies

## BLUF
The reviewer's task is one decision: *merge this, on what base, in what order,
verified how.* Every PR body I wrote buries that decision under narrative and
opens with implementation history. Add a four-line decision header to each;
the prose beneath becomes the second pass, not the first.

## The shared breath failure (all ten)
The governing relation arrives last. A body opens "Phase P3: D-014 built the
faces package…" — a beat about *process history* — when the reader's first
fixation needs the *state*: base branch, mergeability, what verified it, its
slot in the merge order. Paley #5: make the first pass sufficient. The
skimmer's fovea lands at the top (#24); the answer must be there.

**Fix, uniform:** a `## Merge decision` header before any narrative, four
lines: base · mergeable · verified-by · position-in-order. Borrow the
product-writer's BLUF shape directly.

## Beats that do not land
- **One paragraph, three model changes.** My store PR opens a single paragraph
  that moves through vault lifecycle, then governance, then the autobee port,
  then encryption. Four beats wearing one comma-chain (the "run on everything"
  failure). Split: one paragraph per model change.
- **Evidence fused to inference.** "234/234, so the rebase preserved the tree"
  is one breath doing two jobs. Separate: the count is measured; the
  preservation is concluded. Paley #11.
- **The finding buried mid-paragraph.** The T10 body states the poison-op
  blocker three sentences into a paragraph about test counts. A blocker is the
  headline; signal it as one (#23, #7 — spend surprise on the finding, not the
  grammar).

## Open obligations (term drift → glossary)
- `writer`, `tag`, `seq`, `_id` alternate freely across the store and core
  bodies. Link each first use to the glossary and hold the name stable. The
  worst offender: prose that says "the writer's tag" where it means the op's
  tag — link `[tag]` and the drift closes.
- Naked `this` and "the above" in the harness and review bodies point at no
  single antecedent. Replace with the named noun (Paley #17, #6 — design the
  second pass with visible destinations).

## Representation mismatch (Paley #8, doc-architect)
- Each body narrates its "what changed" list in prose. That is a repeated
  comparison — a table. The per-PR specifics below are already table-shaped.

## Word hygiene (product-writer forbidden list)
Sweep every body for: comprehensive, notably, crucial, significantly, moreover,
"it's important to note," and em-dashes used more than once per section. My
bodies overuse the em-dash as a universal joint; most should become a period
(a stop at a model boundary, #4) or a colon.

## Per-PR specifics (the second-pass detail)
| PR | The one decision-header fact the reviewer needs first | The biggest buried beat |
|----|-------------------------------------------------------|-------------------------|
| #21 | base **main** (retargeted); contains the spec commits, so **#20 is superseded** | the #20 redundancy is the headline, not a footnote |
| #22 | base 10/okf-core; the delivered substrate is **autobee**, autobase forbidden | the core hold-hydration bug found here is a real result, give it its own beat |
| #23 | base 11/okf-store; **codex cross-model review found 2 deletion-safety bugs** | that external review is the story; surface it in the header |
| #24 | base 12/okf-faces; I11 epoch roundtrip proven | "history is shed by design" is a guarantee — state it plainly, not defensively |
| #25 | base 13/okf-compact; thin CLI veneer | shortest body; mostly fine — just add the header |
| #26 | base 14/okf-cli; three examples regenerate byte-identically | the flagship agent-session narrative is the human story (product-writer) — lead with it |
| #27 | base 15/okf-examples; **matrix 12/12 × 3 profiles, no divergence** | **S8 converges where vault-ld's B1 diverged** — that is the headline finding, currently mid-body |
| #29 | base 16/okf-harness; **G4-PASS, no open determinism blocker** | C1 is a major, not a blocker — say which, and why, in one beat (glossary: blocker/major) |
| #31 | independent on main; **autobase→autobee framing reconciled** | the reconciliation is the whole point; header it |
| #32 | base 17/okf-review; SPEC v1.3; **§7 category-error corrected** | three spec-corrects-code changes need one beat each, not a comma-list |

## What not to touch
Do not rewrite the mapping tables — they already match representation to
relation. Do not add cross-model-review drama where none happened. The header
and the beat-splits earn their place; elegance passes do not.
