# ADR-003: Ingest report distinguishes "already in log" from "nothing found"

## Status
Proposed

## Date
2026-07-31

## Context
Confusion finding F1 (victim side): `ingest complete: 0 op(s) from 0
file(s)` is emitted both when the bundle has no candidates and when every
candidate is already converged (hash match against the emission
manifest). An agent whose brand-new file had been swept into the log by a
concurrent writer's whole-bundle ingest received this message and "had to
read source to distinguish" already-ingested from never-seen — the
scanner computes the hash-match skips either way; it just doesn't say so.

## Decision
Report the skip count:

```
ingest complete: 0 op(s) from 0 file(s); 7 file(s) already up to date
```

Message-text change only; exit codes untouched. Land now while the
message is young — the packages are unpublished, so external
message-parsing dependents are ~nil, and ADR-002's `--json` is the
durable machine answer regardless.

## Alternatives Considered

### `--json` on ingest instead of rewording
Not instead — the human/log-reading case deserves the plain sentence;
structured output arrives with ADR-002 where the evidence is.

### Leave it to `status` (ADR-002)
`status` answers the question when you think to ask it; the ingest
report is what you are already looking at when the confusion strikes.

## Consequences
- SPEC §9 ingest-reporting sentence updated.
- The one-line report becomes slightly longer only when skips occurred.

## Acceptance
- [ ] The swept-writer scenario re-run prints a nonzero
      "already up to date" count.
- [ ] An empty bundle prints no skip clause (or "0", decided once,
      consistently).
