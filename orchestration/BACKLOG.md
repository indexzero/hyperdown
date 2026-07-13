# BACKLOG — minors, nits, and out-of-checklist work

(empty — populated by review phases)

## Minors (batched, non-gating)

- Lint sweep: unused vars flagged by tsserver in packages (apply.js ord@781, turtle.js pred@231, ingest.js eventType@92, several test-file unused imports). Behavior-neutral cleanup.
- TS declaration noise for untyped JS deps (autobee, corestore, hyperswarm, @hyperwiki/*) — plain-JS repo; add d.ts stubs only if the owner wants editor types.
- O1 (CODE-REVIEW.md minor): sole-indexer self-removal is unguarded — a genesis indexer can RemoveWriter itself, bricking governance (still convergent). Guard belongs in cli/store emission path.
- L1 (CODE-REVIEW-2.md minor): post-load bulk catch-up quiesce stall under extreme unthrottled backlog — liveness/tail-delivery only, proven non-divergent (delivered-prefix hashes identical); pre-existing, orthogonal to M1/M2.
- harness/README.md still says "S6 fails by design" — stale since the B1 fix made S6 green; one-line doc correction.
