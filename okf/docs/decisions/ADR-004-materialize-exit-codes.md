# ADR-004: Materialize exit-code taxonomy — 0 clean / 3 pending-only / 1 failure

## Status
Proposed

## Date
2026-07-31

## Context
Confusion finding F3: a materialize that wrote everything the caller
owned and correctly left a concurrent writer's pending file in place
exited 1 — the agent logged that it "momentarily looked like a failure."
Under multi-writer use, a *normal* state (someone else mid-authoring)
surfaces as failure on a *healthy* operation.

The implementation is a single line — `return report.ok ? 0 : 1`
(`okf/cli/lib/run.js`, the N3 comment) — and the amendment window was
verified open (proposals doc Q2, resolved 2026-07-31):

- Library tests (`okf/test/faces-preservation.test.js`) assert on the
  `report.pendingIngest` object, not the exit code — unaffected.
- The CLI test asserts exit 1 only for "not a vault" (real failure) and
  exit 0 for clean materialize — both preserved.
- No test or harness code anywhere pins exit 1 for the pending case.
- The packages are unpublished; external Hyrum exposure is ~nil.

## Decision
Three named outcomes, in the SPEC:

| exit | meaning |
| --- | --- |
| 0 | projected everything; no pending files encountered |
| 3 | projected everything owned; N pending-ingest file(s) left in place — stderr lists them prefixed `notice:`, not `error:` |
| 1 | real failure (I/O, corrupt vault, bad args) |

Scripts treating any nonzero as failure degrade gracefully (exit 3 is
still nonzero — today's semantics). The `unsafe` and `stale` report
lists must also be placed in the taxonomy: `stale` (left in place, per
spec) accompanies exit 0/3 as a notice; `unsafe` paths (a §9 defense)
stay on the failure side unless the SPEC review concludes otherwise —
decided in this ADR's spec delta, once.

## Alternatives Considered

### Exit 0 + notice for pending
Reads best for agents, but silently un-fails any pipeline that *relied*
on the stop. Rejected as the riskier flip; exit 3 keeps the stop while
naming the state.

### Leave exit 1, document harder
The Auditor agent had read the docs and still flinched. An exit code is
the API here; prose can't fix a conflated code.

## Consequences
- SPEC §9 (N3 behavior) + §13 updated; CHANGELOG line for the 1 → 3
  narrowing.
- One new CLI test pins each of the three codes (the pending case has no
  test today — this ADR adds the missing one).

## Acceptance
- [ ] Foreign-pending scenario exits 3 with `notice:` stderr lines.
- [ ] "Not a vault" and I/O failure still exit 1.
- [ ] Clean run still exits 0.
