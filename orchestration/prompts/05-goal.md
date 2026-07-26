# /goal: Drive the Vault-LD-on-Autobase Pipeline to Completion

**Installation:** save this file as `.claude/commands/goal.md` in the repo root. Invoke as `/goal`. It is safe and intended to be invoked repeatedly: on session start, after compaction, after any stall, or from a hook. Every invocation is idempotent: read state, verify claims, advance, persist.

This document stands alone. Context: the repo contains a supervisor prompt (`prompts/04-supervisor-prompt.md`) orchestrating Fable 5 subagents through three phases defined by three prompt files (implementation spec, adversarial spec review, adversarial code review with a multi-process fault-injection harness). The supervisor persists all state to `orchestration/STATE.md` and gates phases G1 through G6 on artifact evidence.

---

## The goal

The pipeline is COMPLETE when, and only when, every line of this checklist has a verified evidence path in `orchestration/STATE.md`:

- [ ] SPEC-FINAL pinned: a spec revision with zero open blockers from adversarial review, all majors dispositioned
- [ ] Implementation installs from clean clone; unit suite green; invariants I1..I10 each mapped to at least one passing test
- [ ] Harness exists: real multi-process writers, seeded fault proxy (latency, jitter, partition, crash), barrier-driven race stimulation, permutation replay, convergence hash oracle
- [ ] Scenario matrix S1..S10 green at clean, lossy, and partitioned fault profiles
- [ ] CODE-REVIEW.md: zero open blockers; every shrunk fuzz repro committed as a named regression test
- [ ] DEVIATIONS.md current; BACKLOG.md holds all minors
- [ ] Final independent verification from a clean clone, raw output on file
- [ ] DELIVERY.md written, including waived majors and loop counters spent

## Procedure (every invocation, in order)

1. **Orient.** Read `orchestration/STATE.md` and the tail of `orchestration/LOG.md`. If they do not exist, this is invocation zero: initialize the ledger, then adopt the supervisor prompt at `prompts/04-supervisor-prompt.md` as your operating instruction and begin at Phase P1. Do not re-plan the pipeline; the plan exists.

2. **Audit before trusting.** The ledger records claims; you verify the most recent one before building on it. If STATE.md says G3 passed, re-run the unit suite now. If it says S1..S10 are green, re-run at minimum the clean profile now. A claim that fails re-verification is reverted in the ledger with a note, and the phase reopens. Compaction and session loss make unverified resumption the primary corruption vector; this step is not optional.

3. **Advance.** Execute the next action recorded in STATE.md, or derive it from the supervisor prompt's pipeline if the field is stale. Dispatch subagents per the supervisor's rules (context hygiene, dispatch header, Fable 5 pinned). Continue advancing through as many actions as the session allows; there is no per-invocation quota.

4. **Persist relentlessly.** After every dispatch, result, and gate decision: update STATE.md before doing anything else. Assume this session ends without warning at any moment.

5. **Terminate correctly.** There are exactly two legitimate stopping states:
   - **COMPLETE:** every checklist line above verified, DELIVERY.md written. Say so, with paths.
   - **BLOCKED:** a loop ceiling was hit or an external decision is required. `orchestration/BLOCKED.md` exists and contains one concrete question with the attempts already made. Say so, with the question inline.

   Everything else is a stall, and stalls are prohibited. Specifically prohibited stopping behaviors:
   - Ending with a summary of progress and no next action taken
   - Asking permission for work that is in scope ("shall I proceed to P4?": yes, always, the supervisor prompt already authorized it)
   - Declaring success on partial evidence ("the core scenarios pass")
   - Deferring long-running work ("the soak test can be run later"): run it
   - Waiting for anything that is not a human answer to BLOCKED.md

6. **Do not gold-plate.** The checklist is the goal, whole and entire. Work not on the checklist (extra features, refactors of green code, speculative hardening beyond the review findings) goes to BACKLOG.md, not into the pipeline. Completion discipline cuts both ways: never stop early, never wander past done.

## Guardrails

- **Never weaken a gate to pass it.** Deleting a failing scenario, raising a timeout to mask a hang, marking a blocker as minor, or editing an invariant so the test passes are all ledger-recorded integrity violations; if a gate is genuinely wrong, that is a BLOCKED question, not a unilateral edit.
- **Determinism failures outrank everything.** A single divergent view hash under any seed preempts the current phase; capture the seed and schedule into a committed repro before any other work continues.
- **The ledger outranks your memory.** On any conflict between what you recall and what STATE.md says, the file wins; investigate the discrepancy, record the resolution.

Now execute step 1.