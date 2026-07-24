# OKF-STATE — auto-okf v1 build ledger

**Purpose:** the only memory for the overnight build. A fresh/compacted
supervisor reads this + `okf/SPEC.md` and resumes without questions.
**Last updated:** 2026-07-13 (T4 dispatched).
**SPEC-FINAL:** `okf/SPEC.md` v1.2 (SPEC-PASS, PR #20). Normative.
**Intent contract:** `~/Git/indexzero/0x/slop/intent/autokf.intent.md`.
**Milestone:** GitHub "auto-okf v1", issues #10–#19 (T1–T10) + residual-minors issue.
**Subagent model:** T4 (in flight) = Claude Fable 5. **T5 onward = Claude Opus 4.8** (owner directive 2026-07-13, effective once T4 lands: model='opus' on every T5–T10 dispatch). If the pinned model is unavailable → record + BLOCK.

## Standing rules (every dispatch)

- **autobee only; autobase forbidden** (dep, import, docs framing).
- **Copy-don't-depend:** no `@autovault-ld/*` imports from `okf/*`; the three
  leaves (keyspace/canonical/revhash) are already copied into okf/core with
  provenance headers.
- pnpm only; `node:test` only; Node 20+.
- Scratch in `sslop/{nnn}` (nnn = dispatch number), never /tmp; **never delete
  anything under sslop/**.
- No AI/Claude attribution footers on any commit or PR.
- **Stacked PRs, each based on the previous task's branch; supervisor NEVER
  merges** (owner reviews in the morning). Open PR, post an assumptions
  comment, move on.
- Each dispatch gets SPEC-FINAL + already-built package READMEs/interfaces
  (not transcripts). Reviewers get the artifact + contract, no authoring
  lineage.

## Stack so far

| PR | Branch → base | Contents | State |
|----|---------------|----------|-------|
| #9  | 8/vault-ld → main | T1 restructure (packages→vault-ld) | open, verified 114/114 |
| #20 | 9/okf-spec → main | SPEC-FINAL v1.2 (SPEC-PASS) | open |
| #21 | 10/okf-core → 8/vault-ld | T2/T3 core + invariant suite | open, verified 176/176 |

Merge-order note for the owner: land #20 before #21 (10/okf-core has the spec
merged in). Supervisor does not merge.

## Task sequence (dependency order; each: base branch, done-when)

- **T4 @auto-okf/store** (#13) — base `10/okf-core`, branch `11/okf-store`.
  autobee vault lifecycle (D-013 pattern: uniform writer weight, ackWriter,
  hyperbee2 view adapter), metadata w/ append-only constant + epoch-chain,
  governance, hyperswarm, encryptionKey, backpressure. Done-when: two-writer
  convergence + restart-rebuild + encryption + metadata-determinism green on
  real autobee; full repo suite green.
- **T5 @auto-okf/faces** (#14) — base `11/okf-store`, branch `12/okf-faces`.
  materialize (+index.md/log.md derived), ingest watcher (_id rules,
  conflict-suffix round-trip, manifest-gated reconciliation — never delete
  un-ingested human files, N3), wanted/ index. Done-when: roundtrip stability
  + independent OKF v0.1 conformance check green; I9 met.
- **T6 epoch compact** (#15) — base `12/okf-faces`, branch `13/okf-compact`.
  SPEC §10. Done-when: I11 epoch cycle byte+identity fidelity incl. drained
  conflict + _id adoption + key-freshness; refuses on open conflicts.
- **T7 @auto-okf/cli** (#16) — base `13/okf-compact`, branch `14/okf-cli`.
  init/join/add-writer/remove-writer/materialize/ingest/watch/wanted/flags/
  compact/resolve/undelete. Done-when: smoke tests green.
- **T8 examples** (#17) — base `14/okf-cli`, branch `15/okf-examples`.
  agent-session (flagship), slop-archive, vlurp-library (staging + _id-stamp,
  vlurp immutable, committed fixture fallback). Done-when: all three
  regenerate byte-identically in tests.
- **T9 harness retarget** (#18) — base `15/okf-examples`, branch `16/okf-harness`.
  Reuse /harness fault proxy+controller+oracle; okf scenarios (LWW clobber,
  tag OR-set race, rename+edit merge, rename+rename, path collision,
  revocation race, epoch cycle under concurrency, fuzz). Done-when: matrix
  green at clean/lossy/partitioned, no divergent hash any seed.
- **T10 review + remediation** (#19) — base `16/okf-harness`, branch
  `17/okf-review`. Harness-grounded hostile review (prompt-03 pattern); no
  repro no finding; divergent hash any seed = blocker; loop ceiling 3 with
  fresh re-review. Address the 7 residual spec minors (P1–P7) where their
  mechanism is touched. Done-when: zero open blockers; fuzz repros committed.

## Gates

- **Build gate (T4–T8):** clean install + FULL repo suite green (vault-ld's
  count must not drop) + task's own done-when tests, re-run by the supervisor.
- **Harness gate (T9/T10 / G4-equiv):** S-matrix green at all 3 profiles;
  divergent view hash under any seed = blocker → capture seed+schedule as a
  committed regression first.
- **Final (G6-equiv):** independent clean-clone verification — full suite +
  matrix + epoch-cycle + all examples + OKF conformance — raw output on file;
  then `DELIVERY-OKF.md`.

## Loop counters (ceiling 3 each)

- T4:1(in progress) T5:0 T6:0 T7:0 T8:0 T9:0 T10:0

## Completion checklist (COMPLETE only when all have evidence paths here)

- [ ] T4 store green   - [ ] T5 faces green + OKF conformance
- [ ] T6 I11 epoch cycle   - [ ] T7 cli   - [ ] T8 three examples byte-identical
- [ ] T9 matrix green x3 profiles   - [ ] T10 zero blockers, repros committed
- [ ] I1..I11 each mapped to a passing test
- [ ] Independent clean-clone final verification, raw output on file
- [ ] DELIVERY-OKF.md written (artifacts, waived majors, loop counters)

## Next action

T4 DISPATCHED (D-okf-T4) on branch `11/okf-store` off `10/okf-core`; awaiting result + supervisor re-verify. Audit 2026-07-13: full suite re-run 176/176 green, T2/T3 confirmed.
