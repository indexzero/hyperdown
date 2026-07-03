# STATE — Vault-LD-on-Autobase Pipeline Ledger

**Last updated:** 2026-07-03T21:37:52Z
**Operating instruction:** `prompts/04-supervisor-prompt.md` (adopted)
**Confirmed intent:** `orchestration/INTENT.md` (user-confirmed 2026-07-03; wins over recollection)
**Subagent model:** Claude Fable 5, pinned (`model: fable` on every Agent dispatch)

## Phase

- **Current phase:** P2 (spec remediation, loop 1/3)
- **Next action:** dispatch D-002 (author: apply F1..F6 blocker replacement text, disposition F7..F16 majors → `prompts/01-implementation-spec-prompt.v2.md`), then D-003 (fresh reviewer verifies closure)

## Gates

| Gate | Status | Evidence |
|------|--------|----------|
| G1 (spec: zero open blockers) | FAIL (2026-07-03) | orchestration/results/P1-1-SPEC-REVIEW.md — 6 blockers F1..F6, 10 majors F7..F16, 3 minors, 1 nit |
| G3 (clean install, unit green, DEVIATIONS.md, acceptance mapped) | OPEN | — |
| G4 (code review: zero blockers, S1..S10 green x3 profiles) | OPEN | — |
| G6 (independent final verification) | OPEN | — |

## Loop counters (ceiling 3 each)

- P2 spec remediation: 1/3 (iteration 1 in progress)
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
| D-002 | P2 | (author instr) | prompts/01 + P1-1-SPEC-REVIEW.md | prompts/01-implementation-spec-prompt.v2.md + orchestration/results/P2-1-DISPOSITIONS.md | PREPARING |
