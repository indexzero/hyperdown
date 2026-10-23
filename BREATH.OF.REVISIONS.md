---
title: Breath Revisions
purpose: >
  What I actually did on branch 18/let-it-breathe, and every place it deviated
  from the stated plans in BREATH.OF.EDITS.*.md. Read this against those plans.
branch: 18/let-it-breathe (stacked on 17/okf-review)
status: working note — deleted with the other BREATH.OF.* files when done.
---

# Breath Revisions

## What landed (five commits)
1. `docs: per-system glossaries` — `okf/GLOSSARY.md`, `vault-ld/GLOSSARY.md`.
2. `docs(deviations): let the long entries breathe` — DEVIATIONS.md.
3. `docs(delivery): lead with the bottom line` — DELIVERY.md, DELIVERY-OKF.md.
4. `docs(readme): map the two stacks` — README.md.
5. `docs: add 'severity' to both glossaries; fix delivery links`.

Plus: merge-decision headers prepended to eleven PR bodies (#20–#32).

## Deviations from the plans

### 1. The glossary split (the biggest deviation, per your directive)
**Plan:** one unified `BREATH.OF.GLOSSARY.md`.
**Did:** two per-system glossaries, `okf/GLOSSARY.md` and
`vault-ld/GLOSSARY.md`, holding **long-lived terms only**. The unified draft is
retired (stays uncommitted, deleted with the other BREATH.OF.* files).
**Why:** your call — a unified glossary muddles `concept`/`_id`/`path` (okf)
with `subject`/`term`/`@context` (vault-ld). Shared substrate terms (`writer`,
`apply`, `view`, `vault`, `autobee`, `tag`) are restated in each file so each is
self-contained; that intentional duplication is the price of two clean models.
**Excluded as short-lived:** `gate` (G1–G6), `SPEC-FINAL`, `stacked PR`, and the
edit vocabulary (`beat`, `open obligation`, `recovery point`). Those live in the
delivery record and the BREATH.OF.* notes, not the durable glossaries.

### 2. `severity` reversed back into the glossaries (a judgment I changed mid-task)
**Plan / first instinct:** exclude severity (`blocker`/`major`/`minor`) as
process vocabulary.
**Did:** added a `severity` entry to both glossaries after all, and pointed the
DELIVERY BLUFs at it.
**Why:** I had linked "major" from the delivery records, which left a dangling
link; and severity here has a *system-specific, long-lived* definition (blocker
= a divergent view hash), not a pipeline definition. It earns a place. This is
the one spot where the delivered glossaries knowingly diverge from a strict
"process terms out" reading.

### 3. Specs deferred entirely (conflict avoidance, not skipped work)
**Plan:** `BREATH.OF.EDITS.SPECS.md` — anchor every invariant/op, ground terms.
**Did:** nothing to `okf/SPEC.md` or `prompts/…v5.md` on this branch.
**Why:** `okf/SPEC.md` is the sole conflict surface of PR #32, and
`prompts/…v5.md` is the sole surface of PR #31. Editing either here would
collide at merge. **Recommendation:** fold the return-target anchoring into #31
and #32 directly, or into a follow-up rebased on top of them. The plan stands;
only its branch is wrong.

### 4. Package READMEs scoped down to the top-level README
**Plan:** `BREATH.OF.EDITS.READMES.md` — ground terms across all package
READMEs; move API prose into Reference shape.
**Did:** the top-level `README.md` only — a two-stack navigation pointer and
the glossary links. The eight package READMEs' grounding sweep is **not done.**
**Why:** editorial judgment over mechanical grinding. The top-level README is
the most-read doc and had a real content gap (it named only Vault-LD, never
auto-okf, and no glossary). Link-grounding eight package READMEs one term at a
time is the low-value, high-volume kind of change the essay itself warns
against as decoration. Deferred, with the plan intact for a later pass.

### 5. OKF-STATE left as-is (the concern went moot)
**Plan:** `BREATH.OF.EDITS.OKF-STATE.md` — make "Next action" one scannable
beat; dedupe the stack table against the checklist.
**Did:** nothing.
**Why:** the ledger is at COMPLETE. Its "Next action" now reads "NONE —
PIPELINE COMPLETE," so the during-run "grew into a paragraph" concern no longer
exists. Editing a closed archival ledger for breath is low value; the
stack/checklist duplication is harmless once nothing is resuming from it.

### 6. Issue #30 not touched (your scope)
**Plan:** `BREATH.OF.EDITS.ISSUE-30.md` — add a BLUF, split evidence from fix.
**Did:** nothing.
**Why:** you scoped the final step to "update the PR bodies." Issue #30 is a
GitHub issue, not a PR. The plan is ready if you want it applied.

### 7. PR bodies: decision headers only, not the full plan
**Plan:** `BREATH.OF.EDITS.PR-BODIES.md` — headers *plus* beat-splits, table
conversions, word-hygiene sweep per body.
**Did:** prepended a tailored `## Merge decision` header (base · mergeable ·
verified · position · what-this-is · glossary) to all eleven bodies, preserving
the existing content beneath.
**Why:** the header is the single highest-value uniform change (first-pass
sufficiency for a merging reviewer) and the one you asked for. Rewriting each
body's internals (beat-splits, word hygiene) is a per-PR pass I did not run;
the existing bodies keep their content, now with a decision on top.

### 8. DELIVERY: BLUF applied; human-story and recovery-points not
**Plan:** BLUF + a human-story paragraph + per-table recovery points.
**Did:** the BLUF (and the C1-as-major framing, and glossary links).
**Why:** the BLUF carries the plan's core value. The human-story material
already exists (the cross-model-review section; the pipeline catching its own
blocker), and adding recovery lines after every table risked the padding the
essay warns against. Judgment call, not an omission of substance.

## Net
The foundation (two glossaries) and the highest-leverage breath fixes
(DEVIATIONS long entries, DELIVERY BLUFs, README two-stack map, PR decision
headers) are in, as five clean commits. The deferred items (specs on the right
branch, package-README grounding, issue #30, per-PR body internals) have intact
plans and clear reasons. Nothing was changed for elegance alone.
