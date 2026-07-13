# STATE — Vault-LD-on-Autobase Pipeline Ledger

**Last updated:** 2026-07-03T21:37:52Z
**Operating instruction:** `prompts/04-supervisor-prompt.md` (adopted)
**Confirmed intent:** `orchestration/INTENT.md` (user-confirmed 2026-07-03; wins over recollection)
**Subagent model:** Claude Fable 5, pinned (`model: fable` on every Agent dispatch)

## Phase

- **Current phase:** P1 (spec adversarial review)
- **Next action:** dispatch D-001 (reviewer: prompt=02, artifact=01) → result `orchestration/results/P1-1-SPEC-REVIEW.md`

## Gates

| Gate | Status | Evidence |
|------|--------|----------|
| G1 (spec: zero open blockers) | OPEN | — |
| G3 (clean install, unit green, DEVIATIONS.md, acceptance mapped) | OPEN | — |
| G4 (code review: zero blockers, S1..S10 green x3 profiles) | OPEN | — |
| G6 (independent final verification) | OPEN | — |

## Loop counters (ceiling 3 each)

- P2 spec remediation: 0/3
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
| 1 | 0/initial | main | pending | bootstrap: prompts, ledger, gitignore, /goal command |

## Dispatch registry

| ID | Phase | Prompt | Artifact(s) | Result | Status |
|----|-------|--------|-------------|--------|--------|
| D-001 | P1 | prompts/02 | prompts/01 | orchestration/results/P1-1-SPEC-REVIEW.md | PREPARING |
