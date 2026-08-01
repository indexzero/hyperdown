# ADR-005: Ingest preflights the op-size limit; the limit joins the CLI docs

## Status
Proposed

## Date
2026-07-31

## Context
Confusion experiment, Clerk log #3: the 65,536-byte `maxOpBytes` bound on
a `set-body` op is discoverable only by reading `okf/core` source. One
agent grepped for it proactively and sized its 41KB document against it;
an agent that didn't would have learned about the limit from the
apply-side `oversize-op` rejection — after authoring, at the wrong layer,
with a flag-queue entry as the error message.

Finding F2 established the pattern that works: a counterintuitive
constraint stated plainly in the CLI README ("there is NO content-write
command") generated zero failed attempts across six first-contact agents.
This is the same treatment for the next constraint agents will hit.

## Decision
Two parts:

1. **Preflight in ingest (face-side):** a file whose body would exceed
   `maxOpBytes` is reported by name, with the limit and the actual size,
   before any op is appended —
   `error: drafts/big.md body is 71,204 bytes; maxOpBytes is 65,536` —
   exit 1, other files unaffected.
2. **One sentence in `okf/cli/README.md`:** the limit exists, its value,
   and the remedy (split the document).

The apply-side `oversize-op` defense stays untouched — validate at the
boundary, defend in depth.

## Alternatives Considered

### Raise or chunk `maxOpBytes`
Out of scope; the limit is a log-layer design decision with its own
rationale. This ADR is about *when the writer learns of it*.

### Doc-only (no preflight)
Docs prevent the first-contact case, but a generated document can exceed
the limit at runtime; the preflight names the file at the moment of
failure instead of deferring to the flag queue.

## Consequences
- SPEC §9 ingest rules gain the preflight check.
- Ingest gains one stat-and-compare per candidate file (negligible).

## Acceptance
- [ ] Oversize file → named preflight error, exit 1, zero ops appended,
      sibling files in the same run unaffected.
- [ ] A file at exactly the limit minus op overhead ingests.
- [ ] CLI README states the limit and remedy.
