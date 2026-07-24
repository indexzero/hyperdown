# OKF-STATE — auto-okf v1 build ledger

**Purpose:** the only memory for the overnight build. A fresh/compacted
supervisor reads this + `okf/SPEC.md` and resumes without questions.
**Last updated:** 2026-07-14 — **COMPLETE**.
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
| #22 | 11/okf-store → 10/okf-core | T4 store on autobee | open, verified 191/191 |
| #23 | 12/okf-faces → 11/okf-store | T5 faces + codex review (2 N3 bugs fixed) | open, verified 212/212 |
| #24 | 13/okf-compact → 12/okf-faces | T6 epoch compact + I11 | open, verified 216/216 |
| #25 | 14/okf-cli → 13/okf-compact | T7 cli | open, verified 225/225 |
| #26 | 15/okf-examples → 14/okf-cli | T8 three examples | open, verified 228/228 |
| #27 | 16/okf-harness → 15/okf-examples | T9 fault harness + matrix | open, verified 228/228 + 12/12x3 |
| #29 | 17/okf-review → 16/okf-harness | T10 review: F1 blocker + F2 major FIXED; C1 major open | open, verified 234/234 + 12/12 |

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

- T4-T10:done. G6 next. Loop counters: all tasks 1 iteration (no remediation loops hit ceiling). T6:0 T7:0 T8:0 T9:0 T10:0

## Completion checklist (COMPLETE only when all have evidence paths here)

- [x] T4 store green — PR #22, 191/191 (114 vault-ld + 62 core + 15 store), re-verified; core hold-hydration bug found+fixed (d68a9fc)   - [x] T5 faces green + OKF conformance — PR #23, 212/212; codex (gpt-5.5) cross-model review found+fixed 2 N3 deletion-safety bugs (8402a6f, 03a4a19); independent OKF v0.1 conformance checker green
- [x] T6 I11 epoch cycle — PR #24, 216/216; byte+identity fidelity across a length-2 epoch chain, history-shed asserted positively, conflict-drain guardrail   - [x] T7 cli — PR #25, 225/225; auto-okf bin, all §13 commands + smoke tests   - [x] T8 three examples byte-identical — PR #26, 228/228; flagship agent-session + slop-archive + vlurp-library; AI-attribution footers stripped from commits (standing-rule enforcement)
- [x] T9 matrix green x3 profiles — PR #27, 12/12 at clean/lossy/partitioned (36 runs) + 10-iter fuzz, zero divergence; S8 (vault-ld B1 revocation blocker) CONVERGES here (causal-not-positional revocation designed it out)   - [x] T10 zero open blockers, repros committed — PR #29, G4-PASS; F1 poison-op BLOCKER + F2 ingest-squat MAJOR both fixed+regression-guarded; C1 (soak memory/liveness) is an open MAJOR (not a determinism blocker) → BACKLOG for Charlie sign-off; P7 minor → issue #28
- [x] I1..I11 each mapped to a passing test: I1-I8,I10 core + I3 store + I9 faces + I11 compact; harness exercises I1/I2/I5/I6/I7/I9/I10 multi-process
- [x] Independent clean-clone final verification — orchestration/results/OKF-FINAL-VERIFICATION.md (VERDICT: FINAL-PASS; 234/234, matrix x3+fuzz, examples byte-identical, I11, conformance 0 violations, wanted/ ranked)
- [x] DELIVERY-OKF.md written — DELIVERY-OKF.md (artifacts, PR stack, gates, C1 waiver, loop counters)

## Next action

**NONE — PIPELINE COMPLETE (2026-07-14).** All acceptance items verified with evidence paths above. G6 FINAL-PASS (independent clean clone). DELIVERY-OKF.md written. 10 stacked PRs open (#9,#20,#21..#27,#29), none merged by supervisor — owner reviews in the morning. Open for owner: C1 major (BACKLOG, sign-off), P7 minor (issue #28).
