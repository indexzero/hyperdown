---
targets:
  - orchestration/OKF-STATE.md
governs: Paley (#5 first pass, #13 generate by rereading) + technical-documentation-architect (single source of truth)
glossary: BREATH.OF.GLOSSARY.md
---

# Edit plan — OKF-STATE.md (the build ledger)

## BLUF
This document has exactly one reader in exactly one state: a fresh or compacted
supervisor, mid-task, reconstructing where the build stands. Its whole value is
first-pass sufficiency. It is already organized for that, so the edits are
small and specific — protect the property, do not prettify.

## The reader and task are unusually sharp (Paley protocol #1)
Not "a technical reader." A resuming agent that must, in one pass, answer:
what is done, what is the next action, what must I re-verify before trusting
the last claim. The `## Next action` and `## Gates` blocks are the entire
point; everything else is return-target detail.

## Beats that do not land
- **The "Next action" line grew into a paragraph.** After several updates it
  now carries the dispatch, an audit note, and a caveat in one breath. For a
  resuming reader this is the single most important beat and it must be
  scannable: one line for the next action, the audit note beneath it, not
  fused.
- **The stack table and the checklist drifted apart.** They encode the same
  progress twice (a single-source-of-truth violation). Let the checklist be the
  authority and the table point at PRs; or vice-versa. Do not maintain two
  truths a resumer must reconcile.
- **Loop-counter shorthand ("T4-T10:done") lost its beat.** It reads as a
  status glyph, not a fact. Fine for scanning, but pair it once with the
  evidence line so a distrustful resumer can verify rather than believe.

## Open obligations (term drift → glossary)
- `gate`, `blocker`, `major` appear in the gate rows with the loose severity
  the glossary exists to fix. Link them; a resuming supervisor must not
  re-derive whether C1 blocks.
- Dispatch IDs, PR numbers, and branch names co-occur without a stable key.
  The stack table is the key — reference it, don't restate branches inline.

## Why this doc resists the usual advice (Paley #13)
Generate-by-rereading matters most here: every update to this ledger was
written *after* an action, and the temptation was fluent continuation
(append a line). The discipline the doc needs is periodic pruning — before
adding a line, reread what the resumer now holds and cut the stale. A ledger
that only grows becomes a document no first pass can absorb.

## What not to touch
The `## Next action` / `## Gates` / `## Completion checklist` skeleton. The
audit-before-trusting instruction. This doc did its job across a real
overnight run; the edits keep it scannable, nothing more.
