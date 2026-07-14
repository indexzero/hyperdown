# BACKLOG — minors, nits, and out-of-checklist work

(empty — populated by review phases)

## Minors (batched, non-gating)

- Lint sweep: unused vars flagged by tsserver in packages (apply.js ord@781, turtle.js pred@231, ingest.js eventType@92, several test-file unused imports). Behavior-neutral cleanup.
- TS declaration noise for untyped JS deps (autobee, corestore, hyperswarm, @hyperwiki/*) — plain-JS repo; add d.ts stubs only if the owner wants editor types.
- O1 (CODE-REVIEW.md minor): sole-indexer self-removal is unguarded — a genesis indexer can RemoveWriter itself, bricking governance (still convergent). Guard belongs in cli/store emission path.
- L1 (CODE-REVIEW-2.md minor): post-load bulk catch-up quiesce stall under extreme unthrottled backlog — liveness/tail-delivery only, proven non-divergent (delivered-prefix hashes identical); pre-existing, orthogonal to M1/M2.
- harness/README.md still says "S6 fails by design" — stale since the B1 fix made S6 green; one-line doc correction.

## auto-okf open majors / minors (for Charlie's disposition)

- **C1 (MAJOR, open — needs sign-off):** under a 22-min sustained lossy
  multi-writer flood (backpressure ON), RSS grew ~85MB→~3.1GB with no plateau
  on merge-heavy writers and a third peer failed to converge in the 5-min heal
  window. VERIFIED liveness/throughput, NOT determinism: caught-up peers are
  byte-identical, no divergent hash under any seed; FDs flat (33); no crash.
  Worse band than vault-ld's analogous M2/L1 (which were backlogged). No
  isolated per-op okf repro (substrate-entangled: autobee replication
  throughput + memory under flood). okf-attributable lead: the `tags` OR-set
  retains one add-token per add (never coalesced on re-add of a present
  value) — a candidate optimization, but coalescing risks convergence
  semantics and needs its own review. Fix is architectural (reduce per-op
  view writes: link/ bl/ wanted/ wantedrank/ revbybase/ …, and/or bound the
  heal window). Deliberately NOT auto-fixed overnight (determinism-risk on
  green code). Repro: `node okf/harness/soak/soak.js`. See OKF-CODE-REVIEW.md.
  Sign-off: ____________ (Charlie)
- **P7 (minor):** ingest strips only one `.conflict-<hex>` suffix; a
  human-authored double-suffix file → permanent pending-ingest. GitHub issue #28.
- Lint: a few unused-var/tsserver-noise items across okf packages (behavior-neutral).
