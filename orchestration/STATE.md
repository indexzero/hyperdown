# STATE — Vault-LD-on-Autobase Pipeline Ledger

**Last updated:** 2026-07-03T21:37:52Z
**Operating instruction:** `prompts/04-supervisor-prompt.md` (adopted)
**Confirmed intent:** `orchestration/INTENT.md` (user-confirmed 2026-07-03; wins over recollection)
**Subagent model:** Claude Fable 5, pinned (`model: fable` on every Agent dispatch)

## Phase

- **Current phase:** P2 (spec remediation, loop 2/3)
- **Next action:** dispatch D-004 (author: v2 + P2-1-SPEC-REVIEW.md → v3, apply B1..B3, disposition M1..M10) then D-005 (fresh closure reviewer). If iteration 3 fails G1 → BLOCKED.md per ceiling.

## Gates

| Gate | Status | Evidence |
|------|--------|----------|
| G1 (spec: zero open blockers) | FAIL iter2 (2026-07-03) | iter1: P1-1-SPEC-REVIEW.md (6 blockers). iter2: P2-1-SPEC-REVIEW.md — 18/20 closed, B1 (F6 reopened: causal clock unimplementable in apply), B2 (fresh: no issuer-authority on AddWriter/RemoveWriter), B3 (rate-window not reorg-stable vs I10), M1..M10, m1..m7, n1..n2 |
| G3 (clean install, unit green, DEVIATIONS.md, acceptance mapped) | OPEN | — |
| G4 (code review: zero blockers, S1..S10 green x3 profiles) | OPEN | — |
| G6 (independent final verification) | OPEN | — |

## Loop counters (ceiling 3 each)

- P2 spec remediation: 2/3 (iteration 2 in progress; iteration 1 closed 18/20 but reopened F6→B1, F8→M1, plus fresh B2/B3)
- P5 code remediation: 0/3

## Goal checklist (from /goal; evidence paths required)

- [ ] SPEC-FINAL pinned — evidence: —
- [ ] Clean-clone install; unit green; I1..I10 mapped — evidence: —
- [ ] Harness real (multi-process, seeded fault proxy, barriers, permutation replay, hash oracle) — evidence: —
- [ ] S1..S10 green at clean/lossy/partitioned — evidence: —
- [ ] CODE-REVIEW.md zero open blockers; fuzz repros committed — evidence: —
- [ ] DEVIATIONS.md current; minors in BACKLOG.md — evidence: —
- [ ] Independent clean-clone verification, raw output — evidence: —
- [ ] DELIVERY.md written — evidence: —

## Pinned decisions

- SPEC-FINAL: not yet pinned (P1/P2 pending). All phases after P2 MUST reference SPEC-FINAL, never the v1 file, once pinned.
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
| D-004 | P2 | (author instr) | spec v2 + P2-1-SPEC-REVIEW.md | prompts/01-implementation-spec-prompt.v3.md + orchestration/results/P2-2-DISPOSITIONS.md | PREPARING |
