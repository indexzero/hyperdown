# ADR-009: Align okf with upstream OKF v0.2 — vocabulary migration + conformance audit

## Status
Accepted

## Date
2026-08-01

## Context
`okf/OKF.SPEC.v2.md` pins upstream: the head OKF spec at
`GoogleCloudPlatform/knowledge-catalog` now declares **v0.2**. Checked
2026-08-01:

- Bundle remains the unit: "A self-contained, hierarchical collection of
  knowledge documents. The unit of distribution." No vault concept
  exists in OKF.
- **Breaking changes from v0.1** that touch what auto-okf emits and
  ingests: `timestamp` replaced by `generated: { by, at }`; the body
  `# Citations` list superseded by a frontmatter `sources` field.
- **New in v0.2**: the actor convention for identity fields; lifecycle
  fields `status`, `stale_after`; credibility signals (`author`,
  `usage_count`, `last_modified`); the "Attested Computation" concept
  type.

Separately, ADR-008 renamed okf's API class to `Bundle` but deliberately
left the rest of okf's "vault" vocabulary in place, creating a tracked
inconsistency.

## Decision
One deliberate alignment pass, two parts:

1. **Vocabulary migration (vault → bundle) across okf surfaces**, with an
   inventory decided item-by-item: GLOSSARY entries (the store and the
   tree become two forms of one bundle — authoritative form vs emitted
   form); the `okf-vault.json` marker filename (coordinate with ADR-006,
   whose guardrail reads it in both CLIs); CLI messages ("not a vault")
   and argument names (`<vault-dir>`); SPEC.md prose; harness/example
   identifiers. vault-ld keeps its vault vocabulary throughout — the
   migration is okf-only.
2. **v0.2 conformance audit of the emitted/ingested bundle format**:
   frontmatter emission (`timestamp` → `generated: { by, at }`),
   citations → `sources`, whether/what auto-okf adopts of the actor
   convention and the new lifecycle/credibility fields, and what the
   conformance section (§ numbering per v0.2) now requires of
   `index.md`/`log.md`. Each divergence lands in DEVIATIONS.md or gets
   fixed — no silent drift.

## Alternatives Considered

### Fold into ADR-008's sweep
Rejected by the maintainer: the API rename is mechanical and safe today;
the vocabulary/format migration touches on-disk contract (marker
filename, frontmatter fields) and deserves its own review — "would be a
separate issue."

### Track upstream head continuously
Rejected for now: pin what was audited (v0.2 as of 2026-08-01) and
re-audit on upstream release, rather than chasing main.

## Consequences
- Closes ADR-008's accepted inconsistency window.
- The marker-filename change interacts with ADR-006's guardrail and with
  every existing vault on disk (the experiment vault included) —
  migration/back-compat for the marker must be part of this ADR's
  implementation, not an afterthought.
- The `generated`/`sources` changes may ripple to consumers of emitted
  bundles (e.g. downstream corpus tooling that read `timestamp`).

## Acceptance
- [ ] Written inventory of every okf "vault" surface with a
      migrate/keep decision per item.
- [ ] Emitted bundles conform to v0.2 (or each divergence is recorded in
      DEVIATIONS.md with rationale).
- [ ] Existing vaults created before the marker change still open
      (back-compat path tested).
- [ ] ADR-006's guardrail updated in the same change as any marker
      rename.
