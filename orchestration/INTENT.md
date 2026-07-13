# Confirmed Statement of Intent (interview-me, confirmed by Charlie 2026-07-03)

This file is the user-confirmed intent for the unattended pipeline run. It was
explicitly confirmed ("Yes, that's it") before the user left. On any conflict
between a supervisor's recollection and this file, this file wins (subject to
STATE.md for pipeline state).

- **Outcome:** Vault-LD-on-Autobase delivered via the P1–P6 supervisor pipeline
  (`prompts/04-supervisor-prompt.md`) to COMPLETE (or a genuine loop-ceiling /
  human-only BLOCKED), every gate backed by artifact evidence in
  `orchestration/STATE.md`.
- **User:** Charlie (indexzero), reviewing post-hoc via a stack of open PRs —
  each PR based on the previous one's branch, **never merged by the supervisor**,
  with every assumption the supervisor would have asked about posted as PR
  comments on the PR it affects, as the PR is opened.
- **Why now:** unattended run; resumable via `/goal` (installed at
  `.claude/commands/goal.md`) after compaction, stall, or session loss.
- **Success:** the `/goal` checklist fully checked with evidence paths in
  STATE.md; G3/G6 clean-clone verification runs against the **tip of the PR
  stack** (main never advances during the run).
- **Constraints:**
  - Subagents pinned to Claude Fable 5; if unavailable, ledger-record and BLOCK.
  - source-driven-development for build dispatches: fetch + cite official docs
    (Holepunch READMEs, vault-ld SPEC.md); no framework code from memory.
  - doubt-driven-development framing for adversarial review dispatches
    (reviewer gets ARTIFACT + CONTRACT, never authoring lineage). Cross-model
    review is skipped and the skip announced: non-interactive context.
  - Subagent scratch/context files go in `sslop/{nnn}` (nnn = dispatch number,
    e.g. `sslop/001` for D-001), NEVER /tmp. `sslop/` is gitignored.
  - `orchestration/` ledger is committed into the PR stack so it survives.
  - **pnpm** for all dependency management; monorepo via `pnpm-workspace.yaml`
    is approved for the spec §13 package layout.
  - **node core test runner (`node:test`) only** — no jest/mocha/vitest/brittle.
    Record as user-directed deviation vs the spec's "Brittle/bare compatibility
    SHOULD be preserved where cheap" line.
  - No AI/Claude attribution footers on any PR body or commit (global rule).
- **Out of scope:** merging any PR; spec §12 non-goals (text CRDT, HTTP API,
  SPARQL engine, Obsidian plugin); gold-plating beyond the `/goal` checklist
  (excess goes to BACKLOG.md).
- **Stopping rule:** COMPLETE or BLOCKED only. Anything askable is NOT a reason
  to stop — make the best assumption, record it in the ledger, post it as a PR
  comment, continue.
