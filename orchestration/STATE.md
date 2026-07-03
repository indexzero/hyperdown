# STATE — Vault-LD-on-Autobase Pipeline Ledger

**Last updated:** 2026-07-03T21:37:52Z
**Operating instruction:** `prompts/04-supervisor-prompt.md` (adopted)
**Confirmed intent:** `orchestration/INTENT.md` (user-confirmed 2026-07-03; wins over recollection)
**Subagent model:** Claude Fable 5, pinned (`model: fable` on every Agent dispatch)

## Phase

- **Current phase:** P3 (implementation)
- **Next action:** dispatch D-010 (build packages/core + invariant unit suite + workspace scaffolding, branch 2/core), then store → faces → cli, each with SPEC-FINAL + built interfaces only. Then G3 verification (clean-clone install + unit run).

## Gates

| Gate | Status | Evidence |
|------|--------|----------|
| G1 (spec: zero open blockers) | **PASS** (2026-07-03) | orchestration/results/P2-4-CLOSURE.md — "VERDICT: G1-PASS". Chain: P1-1 (v1, 6 blockers) → P2-1 (v2, 3 blockers) → P2-2 (v3, 0 blockers + 4 majors) → P2-3 (v4, majors closed, regression R1) → P2-4 (v5, all closed). All majors FIXED (dispositions: P2-1/2/3/4-DISPOSITIONS.md), zero waivers. |
| G3 (clean install, unit green, DEVIATIONS.md, acceptance mapped) | OPEN | — |
| G4 (code review: zero blockers, S1..S10 green x3 profiles) | OPEN | — |
| G6 (independent final verification) | OPEN | — |

## Loop counters (ceiling 3 each)

- P2 spec remediation: CLOSED at 2/3 failed iterations (A: v2 blockers, C: v4 regression; B and final D passed). Total author passes: 4 (v2..v5); total reviews: 5 (D-001,3,5,7,9).
- P5 code remediation: 0/3

## Goal checklist (from /goal; evidence paths required)

- [x] SPEC-FINAL pinned — evidence: prompts/01-implementation-spec-prompt.v5.md; orchestration/results/P2-4-CLOSURE.md ("VERDICT: G1-PASS"); dispositions P2-1..P2-4-DISPOSITIONS.md (zero waivers)
- [ ] Clean-clone install; unit green; I1..I10 mapped — evidence: —
- [ ] Harness real (multi-process, seeded fault proxy, barriers, permutation replay, hash oracle) — evidence: —
- [ ] S1..S10 green at clean/lossy/partitioned — evidence: —
- [ ] CODE-REVIEW.md zero open blockers; fuzz repros committed — evidence: —
- [ ] DEVIATIONS.md current; minors in BACKLOG.md — evidence: —
- [ ] Independent clean-clone verification, raw output — evidence: —
- [ ] DELIVERY.md written — evidence: —

## Pinned decisions

- **SPEC-FINAL = `prompts/01-implementation-spec-prompt.v5.md`** (pinned 2026-07-03, G1-PASS evidence P2-4-CLOSURE.md). All later phases reference this file and never v1..v4.
- Branch/PR model: stacked PRs off `0/initial` (user's branch naming `n/name` adopted); NO PR is ever merged by the supervisor (user-confirmed). G3/G6 clean-clone verification targets the stack tip branch.
- Dependency manager: pnpm; monorepo via pnpm-workspace.yaml approved.
- Test runner: node:test only (user mandate; deviation vs spec's brittle-compat SHOULD — record in DEVIATIONS.md at P3).
- Subagent scratch: `sslop/{nnn}` where nnn = dispatch number (gitignored). Never /tmp.
- Cross-model review (doubt-driven skill): SKIPPED — non-interactive context. Announced here per skill requirement; applies to all review dispatches this run.

## PR stack

| # | Branch | Base | PR | Contents |
|---|--------|------|----|----------|
| 1 | 0/initial | main | https://github.com/indexzero/hyperwiki2/pull/1 | bootstrap: prompts, ledger, gitignore |

## Dispatch registry

| ID | Phase | Prompt | Artifact(s) | Result | Status |
|----|-------|--------|-------------|--------|--------|
| D-001 | P1 | prompts/02 | prompts/01 | orchestration/results/P1-1-SPEC-REVIEW.md | DONE — 6 blockers, G1 FAIL |
| D-002 | P2 | (author instr) | prompts/01 + P1-1-SPEC-REVIEW.md | prompts/01-implementation-spec-prompt.v2.md + orchestration/results/P2-1-DISPOSITIONS.md | DONE |
| D-003 | P2 | prompts/02 | spec v2 + P1-1-FINDINGS-TABLE.md | orchestration/results/P2-1-SPEC-REVIEW.md | DONE — 3 blockers, G1 FAIL (stalled once, resumed in place) |
| D-004 | P2 | (author instr) | spec v2 + P2-1-SPEC-REVIEW.md | prompts/01-implementation-spec-prompt.v3.md + orchestration/results/P2-2-DISPOSITIONS.md | DONE |
| D-005 | P2 | prompts/02 | spec v3 + P2-1-FINDINGS-TABLE.md | orchestration/results/P2-2-SPEC-REVIEW.md | DONE — 0 blockers, 4 majors, ship-with-changes |
| D-006 | P2 | (author instr) | spec v3 + P2-2-SPEC-REVIEW.md | prompts/01-implementation-spec-prompt.v4.md + orchestration/results/P2-3-DISPOSITIONS.md | DONE |
| D-007 | P2 | (closure instr) | spec v4 + P2-2-SPEC-REVIEW.md | orchestration/results/P2-3-CLOSURE.md | DONE — G1-FAIL (regression R1) |
| D-008 | P2 | (surgical fix) | spec v4 + P2-3-CLOSURE.md | prompts/01-implementation-spec-prompt.v5.md + P2-4-DISPOSITIONS.md | DONE |
| D-009 | P2 | (closure instr) | spec v5 + P2-3-CLOSURE.md | orchestration/results/P2-4-CLOSURE.md | DONE — **G1-PASS** |
