# ADR-001: Path-scoped ingest — `ingest <vault> <bundle> [paths…]`

## Status
Proposed

## Date
2026-07-31

## Context
From the six-writer confusion experiment (AGENT-CONFUSION-LOG.md, finding
F1; log kept outside this repo at
`0x/lpmq/0/elements-of-documentation/`): the CLI's only ingest form scans
the entire bundle. Under concurrent writers this produced a complete
three-perspective incident — one agent refused the command ("to avoid
folding other agents' possibly half-written pending files") and dropped
to the store API; a second ran it and ingested a third agent's pending
file as a side effect ("If the-clerk's file had been mid-write, I would
have ingested a partial draft"); the third then saw its own ingest report
`0 op(s) from 0 file(s)` (see ADR-003).

The concurrent-writer case is in-scope by design: the flagship example is
four agents on one vault.

## Decision
Accept optional trailing bundle-relative paths (or globs) that restrict
the ingest scan set:

```sh
auto-okf ingest ./vault ./bundle drafts/mine.md   # only this file
auto-okf ingest ./vault ./bundle                  # unchanged: full scan
```

A named path that does not exist, or that resolves outside the bundle
root, is an error (exit 1, path named, no ops appended). The zero-path
form is byte-identical in behavior to today — extension, not
modification.

## Alternatives Considered

### Per-file claim/lock protocol in the bundle
Rejected. The experiment recorded zero corruption and zero lock errors
across ~17 concurrent invocations (F6); the failure mode is *selection
and reporting*, not safety. Locks import the coordination complexity the
log exists to avoid.

### Make per-file ingest the default / refuse multi-file sweeps
Rejected. Breaks the documented single-human workflow (edit many files,
ingest once).

## Consequences
- SPEC §9: the ingest scan-set definition gains "restricted to the
  argument set when paths are given." §13: CLI surface line updated.
- Agents get concurrent-writer politeness without leaving the CLI (the
  workaround today is the store API's `ingestFile`, which one agent had
  to discover unaided).

## Acceptance
- [ ] Two files pending; path-scoped ingest of one emits ops for that
      file only; the other remains pending-ingest.
- [ ] Path outside the bundle root → exit 1, zero ops appended.
- [ ] Zero-path invocation unchanged (existing invariant suite passes
      untouched).
