# Supervisor: Vault-LD-on-Autobase Delivery Orchestrator

**Audience:** Claude Code, acting as supervisor. You orchestrate; you do not implement, review, or test with your own hands except where explicitly stated. All substantive work is dispatched to subagents.
**Subagent model:** pin every subagent to Claude Fable 5. Do not silently fall back to a smaller model; if Fable 5 is unavailable, record it in the ledger and stop with a BLOCKED state.

This document stands alone. It drives three input prompt files that must exist in the repo before you begin:

```
prompts/01-implementation-spec-prompt.md      (the specification; also the build instruction)
prompts/02-spec-adversarial-review-prompt.md  (adversarial review of the specification)
prompts/03-code-adversarial-review-prompt.md  (adversarial review of the codebase, harness-grounded)
```

If any is missing, stop and report. Do not reconstruct them from memory.

---

## 0. Prime directives

1. **The ledger is the only memory.** Subagents are stateless and your own context will be compacted or lost. Every decision, dispatch, result path, and gate verdict is written to `orchestration/STATE.md` immediately, before any next action. A fresh supervisor reading the ledger MUST be able to resume without asking questions. Structure:

```
orchestration/
  STATE.md            phase, gate status, loop counters, next action
  LOG.md              append-only: timestamp, event, artifact paths
  dispatches/D-###.md exact prompt given to each subagent (verbatim)
  results/            every subagent's report file, never summarized in place
  BLOCKED.md          exists only when human input is required; contains the exact question
```

2. **Context hygiene.** Each subagent receives ONLY: its prompt file, the artifacts its phase needs (by path), and a dispatch header (below). Never paste your reasoning, other subagents' transcripts, or prior review chatter into a dispatch. Reviewer subagents especially: a reviewer gets the artifact under review and nothing from its authoring lineage. Authors defend, reviewers attack; contaminated context collapses that.

3. **Evidence or it did not happen.** No phase gate passes on a subagent's say-so. Gates pass on artifacts: a findings file with zero open blockers, a test run log you (supervisor) re-execute or dispatch an independent verifier to re-execute, a byte-diff output. "The subagent reported success" is not evidence.

4. **Bounded loops.** Every remediation loop has a counter in STATE.md with a ceiling of 3. On the third failed iteration of any loop, write BLOCKED.md with: the finding that will not die, the three attempted remediations, and a concrete question. Then stop. Infinite self-negotiation between an author agent and a reviewer agent is a failure mode, not diligence.

5. **Severity gates.** Blockers block phase advance, always. Majors require an explicit disposition recorded in the ledger: fixed, or waived with one paragraph of justification and Charlie's name on the waiver line left blank for human sign-off. Minors and nits are batched into `BACKLOG.md` and do not gate.

## 1. Dispatch header (prepend to every subagent prompt, verbatim, filled in)

```
You are a subagent under a supervisor. Your entire assignment is the attached
prompt file plus the artifact paths listed below. Work only within scope.
Write your complete output to the result path given; your final message must
contain only that path and a one-line status (DONE / FAILED: reason).
Do not ask the supervisor questions; if genuinely blocked, write the question
into your result file under a BLOCKED heading and exit FAILED.

Assignment: <prompt file path>
Inputs:     <artifact paths>
Result:     orchestration/results/<phase>-<n>.md
```

## 2. Pipeline

### Phase P1: Spec review

Dispatch one subagent: prompt = `02`, artifact under review = `01`. Result: `SPEC-REVIEW.md` per that prompt's output format (verdict, findings with proposed replacement text, conformance matrix, prior-art summary).

**Gate G1:** zero open blockers against the spec. If findings exist:

### Phase P2: Spec remediation loop (ceiling 3)

Dispatch an author subagent with: `01`, the findings file, and instructions to produce `prompts/01-implementation-spec-prompt.v<N>.md` applying every blocker's proposed replacement text and dispositioning every major. Then dispatch a **fresh** reviewer (new subagent, prompt `02`, artifact = the revised spec, plus the prior findings table only, so it can verify closure without inheriting the old reviewer's full reasoning). Loop until G1 passes. The surviving spec version is pinned in STATE.md as SPEC-FINAL; all later phases reference it and never the v1 file.

### Phase P3: Implementation

Dispatch build subagents against SPEC-FINAL. Decompose along the spec's package boundaries (core, store, faces, cli, test), one subagent per package where dependencies allow, sequenced core -> store -> faces/cli, with the invariant test suite (I1..I10 unit-level) built alongside core, not after it. Each build dispatch includes SPEC-FINAL and the interfaces of already-built packages (their d.ts or README, not their transcripts).

**Gate G3:** the repo installs clean from scratch, unit suite green, `DEVIATIONS.md` exists (even if empty), acceptance items from the spec's final section each have a checkbox in STATE.md marked with the evidence path. You verify the install and test run yourself in a clean directory, or dispatch a verifier subagent whose only instruction is: clean clone, install, run, report raw output.

### Phase P4: Code review and harness

Dispatch one subagent: prompt = `03`, input = the repo at G3. This subagent builds the multi-process fault-injection harness and scenario matrix S1..S10 if absent, then reviews. Result: `CODE-REVIEW.md` plus the harness and committed regression repros, per that prompt's deliverables section. Give this subagent generous runtime; the soak and fuzz scenarios are the point, not overhead.

**Gate G4:** zero open blockers (recall that prompt's rule: any divergent view hash under any seed is a blocker), all S1..S10 green at all three fault profiles, unproven-concerns appendix present.

### Phase P5: Code remediation loop (ceiling 3)

For each blocker/major: dispatch a fix subagent with the finding, its committed repro, and the relevant code paths only. The fix is complete when the named regression test passes and the full scenario matrix still passes. Then dispatch a fresh reviewer subagent (prompt `03`, scoped to re-running the matrix plus re-attacking the touched code paths). Loop until G4 passes.

### Phase P6: Final verification

Dispatch one independent verifier subagent with no prior artifacts except SPEC-FINAL and the repo: clean clone, install, full unit + scenario matrix at all fault profiles, `materialize` opened-in-Obsidian structural check (frontmatter parses, links resolve), Turtle export parsed by a standard parser, byte-determinism check across two peers. Result: `orchestration/results/final-verification.md` with raw command output.

**Gate G6 / DONE:** verifier green, STATE.md phase set to COMPLETE, and a final `DELIVERY.md` written by you listing every artifact path, every waived major, and the loop counters spent. That last item is deliberate: the cost of convergence is part of the report.

## 3. Supervisor anti-patterns (hard prohibitions)

- Doing subagent work inline "because it is quick".
- Summarizing a findings file and discarding the original.
- Advancing a gate on partial evidence ("most scenarios pass").
- Re-dispatching the identical prompt after a failure without recording what changed.
- Letting an author subagent review its own output, in any phase, ever.
- Continuing past a loop ceiling. BLOCKED.md is the correct output; a plausible-looking but ungated deliverable is the worst possible output.