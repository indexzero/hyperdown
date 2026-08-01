# ADR-007: First-contact documentation pack (no behavior change)

## Status
Proposed

## Date
2026-07-31

## Context
Three findings from the confusion experiment are pure documentation gaps,
each measured by what first-contact agents did instead of reading a
sentence that didn't exist (F5, Stylist #1, Engineer #1, plus an
orchestrator observation): three independent source-dives to confirm the
emission manifest is per-directory; a store README headline snippet that
uses `initVault` where reopen is meant ("had I copied the headline
snippet verbatim I might have hit a refusal or worse"); a vestigial
top-level `packages/` directory that presents a second plausible bin
location; and an asymmetric workspace `.bin` (only `autovault-ld`
linked).

Counter-evidence that docs carry weight here (F2): the README's explicit
"there is NO content-write command" pre-empted the same wrong guess in
four of six agents — zero failed attempts.

## Decision
Four changes, no code behavior touched:

1. **Manifest scoping sentence** in `okf/faces` and `okf/cli` READMEs:
   "A vault has no privileged bundle directory; the emission manifest
   (`.okf-manifest.json`) lives in each target directory, so
   materializing to a scratch directory never disturbs another bundle."
   Under a heading that blesses the idiom four agents invented
   independently: *Verifying content is in the log* (materialize to an
   empty scratch dir; everything that appears came from the log).
2. ~~**`initVault` vs `openVault`** in the store README headline
   snippet.~~ Superseded by ADR-008: maintainer review identified the
   snippet as a symptom of redundant wrapper vocabulary — the fix is
   deleting the `initVault`/`openVault`/`joinVault` wrappers in favor of
   the `Vault.init`/`Vault.open`/`Vault.join` statics both systems
   already share. The README snippets get rewritten as part of that
   sweep, not as a doc patch.
3. **Delete top-level `packages/`** — verified vestigial 2026-07-30:
   empty scaffold dirs plus stray `node_modules`, no `package.json`,
   outside the workspace globs (`vault-ld/*`, `okf/*`).
4. **Workspace `.bin` symmetry:** link `auto-okf` alongside
   `autovault-ld`, or neither.

## Alternatives Considered

### Fold into each feature ADR
These are shippable today with zero risk; batching them behind feature
review would delay the cheapest wins.

## Consequences
- First-contact agents stop source-diving for F5-class questions.
- Deleting `packages/` removes a wrong-bin trap (Engineer: "a less
  careful reader could grab the wrong bin").

## Acceptance
- [ ] A re-run of the six-agent experiment produces zero source-dives
      for manifest-scoping questions.
- [ ] `packages/` gone; workspace install and both test suites green.
- [ ] Both bins resolvable the same way (or documented identically).
