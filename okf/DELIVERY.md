# DELIVERY — auto-okf v1

This file records the auto-okf v1 milestone of 2026-07-14: its gates,
counts, PR stack and open items as they stood then. The store now runs on
autobee@2.12.1, writes vault metadata version 2 and opens no other version
(see [store/README.md](store/README.md)).

## Bottom line

**Shipped.** All four gates pass, verified from an independent clean clone
(G6 FINAL-PASS). One [major](GLOSSARY.md#severity) awaits your
sign-off — C1, a memory/liveness limit under sustained flood — and it does not
block correctness: no [view](GLOSSARY.md#view) hash diverges under any
seed. Everything below defends those two sentences.

The overnight pipeline (milestone **auto-okf v1**) reached **COMPLETE**
2026-07-14, driven by `/goal` under `../orchestration/OKF-STATE.md`. Final
verification: `../orchestration/results/OKF-FINAL-VERIFICATION.md`
(independent clean clone of the stack tip).

## What was delivered

**auto-okf** — multi-writer Open Knowledge Format (OKF v0.1) bundles on
**autobee**: durable, append-only, merge-safe knowledge bundles humans and AI
agents co-write, dumped as plain markdown anyone can read. Two stacks in one
repo: the frozen `vault-ld/` and the new `okf/` (`@auto-okf/*`), sharing no
imports (copy-don't-depend). Identity is CouchDB-homage `_id`/`_rev`; path is
a Kleppmann-safe LWW register; deletion is whole-vault append-only with
epoch-cycle compaction; red links are a `wanted/` demand index (Cunningham's
Incremental principle); `log.md` is a real op-log projection.

## Artifact paths

| Artifact | Path |
|---|---|
| SPEC-FINAL (v1.2, SPEC-PASS) | `SPEC.md` (PR #20) |
| Spec review chain | `../orchestration/results/OKF-SPEC-REVIEW-{1,2,3}.md`, `OKF-SPEC-DISPOSITIONS-1.md` |
| Core (ops, apply, keyspace/canonical/revhash copies, MemView) | `core` (`@auto-okf/core`) |
| Store (vault lifecycle on autobee, metadata, governance, replication) | `store` (`@auto-okf/store`) |
| Faces (materialize +index.md/log.md, ingest, wanted, compact) | `faces` (`@auto-okf/faces`) |
| CLI | `cli` (`@auto-okf/cli`, bin `auto-okf`) |
| Invariant + regression suite (I1..I11) | `test`, `test/regressions` |
| Multi-process fault harness + S1..S10 + fuzz + soak | `harness` |
| Examples: agent-session (flagship), slop-archive, vlurp-library | `examples/*` (committed `out/`) |
| Deviations / backlog | `DEVIATIONS.md` / `../orchestration/BACKLOG.md` |
| Code review + final verification | `../orchestration/results/OKF-CODE-REVIEW.md`, `OKF-FINAL-VERIFICATION.md` |
| Intent contract | `~/Git/indexzero/0x/slop/intent/autokf.intent.md` |

## PR stack (owner reviews; supervisor merged nothing)

| PR | Branch → base | Contents |
|----|---------------|----------|
| #9  | 8/vault-ld → main | T1 restructure (packages → vault-ld) |
| #20 | 9/okf-spec → main | SPEC-FINAL v1.2 (SPEC-PASS) |
| #21 | 10/okf-core → 8/vault-ld | T2/T3 core + invariant suite |
| #22 | 11/okf-store → 10/okf-core | T4 store on autobee |
| #23 | 12/okf-faces → 11/okf-store | T5 faces (+ codex cross-model review) |
| #24 | 13/okf-compact → 12/okf-faces | T6 epoch compact + I11 |
| #25 | 14/okf-cli → 13/okf-compact | T7 cli |
| #26 | 15/okf-examples → 14/okf-cli | T8 three examples |
| #27 | 16/okf-harness → 15/okf-examples | T9 fault harness + matrix |
| #29 | 17/okf-review → 16/okf-harness | T10 review + F1/F2 fixes |

**Merge order for the owner:** land bottom-up. #20 (spec) before #21 (10/okf-core
carries the spec merged in). The okf stack (#21→#29) sits on #9. Each retargets
to `main` cleanly as its base merges, exactly as the vault-ld stack did.

## Gates

- **G1 (spec):** PASS — okf/SPEC.md v1.2, 3 adversarial rounds to SPEC-PASS,
  4 blockers + 20 majors + 29 minors dispositioned, zero waivers.
- **G3-equiv (build):** PASS at every task — clean install + full suite green,
  re-verified by the supervisor after each task (176 → 191 → 212 → 216 → 225
  → 228 → 234).
- **G4 (code review):** PASS — `OKF-CODE-REVIEW.md`: matrix 12/12 at all three
  fault profiles + 40-iter fuzz, no divergent view hash under any seed; the
  vault-ld B1 revocation blocker (S8) CONVERGES here (causal-not-positional
  revocation designed it out). F1 (poison-op BLOCKER) and F2 (ingest-squat
  MAJOR) found, fixed, regression-guarded.
- **G6 (final):** PASS — `OKF-FINAL-VERIFICATION.md`: independent clean clone,
  234/234, matrix x3 + fuzz, three examples byte-identical + OKF-conformant,
  I11 epoch cycle, conformance 0 violations, wanted/ ranked.

## Open items requiring your disposition (none block correctness)

- **C1 (MAJOR, sign-off pending):** under a 22-min sustained lossy flood
  (backpressure on), RSS grew to ~3.1 GB without plateau and a third peer
  failed to converge in the 5-min heal window. VERIFIED liveness/throughput,
  NOT determinism (caught-up peers byte-identical, no divergent hash, FDs
  flat, no crash). Substrate-entangled (autobee under flood), no isolated okf
  repro; okf-attributable lead is uncoalesced OR-set add-tokens. Deliberately
  not auto-fixed overnight (a fix is architectural and risks determinism on
  green code). Full analysis + waiver line in `../orchestration/BACKLOG.md` and
  `OKF-CODE-REVIEW.md`.
- **P7 (minor):** double `.conflict-<hex>` suffix → permanent pending-ingest.
  GitHub issue #28.
- Lint noise across okf packages (behavior-neutral).

## Cross-model review

Per your directive, T5 (faces — the delicate one) got a **codex (gpt-5.5)**
cross-model adversarial review, which found and fixed **2 N3 deletion-safety
bugs** the internal Fable→Opus chain missed (`OKF-P3-faces-codex-review.md`).

## Loop counters spent

- Spec: 3 doubt rounds (author + fresh reviewer each), zero blockers surviving.
- Build T4–T10: **one iteration each — no remediation loop hit its ceiling.**
- Model: T2/T3 on Fable 5; **T4 onward on Opus 4.8** (your mid-run directive).
- Incidents recovered in-place: 1 API connection drop (T8), 1 API stall (none
  fatal). No dispatches cancelled. AI-attribution footers stripped from T8
  commits (standing-rule enforcement).

## Known caveats (documented)

autobee is experimental. Each autobee@2.12.1 behaviour that okf relies on
is in `DEVIATIONS.md` ("Substrate behaviour that okf relies on"), with its
source. The substrate attacks that okf cannot close without changing
autobee are residuals in `SECURITY_MODEL.md`. The append-only guarantee
means nothing dies before a generation cycle (mistakes and secrets
included) — the generation cycle is also the redaction mechanism. C1 is
the one real scale limit.
