# DEVIATIONS

Deviations from SPEC-FINAL (`prompts/01-implementation-spec-prompt.v5.md`),
one paragraph each (§0 rule 3). Only true deviations and spec-instructed
recordings live here; implementation resolutions where the spec is silent are
documented in code comments (with source citations) and package READMEs.

**node:test instead of brittle.** User mandate (project owner). The Holepunch
convention is the brittle runner; this repo's entire suite runs on the Node
core test runner (`node --test`). No test-runner code is imported by library
packages, so brittle/bare compatibility of the libraries is unaffected.

**§1 dependency choice: autobee.** The store layer depends on autobee (user
directive, 2026-07-04, resolving the spec's MAY): the repo is a wiki
implementation on top of autobee. `@hyperwiki/core` stays pure and encodes
ops with hyperschema/hyperdispatch/compact-encoding per §3 (no JSON-op
deviation); where a capability is not exposed on autobee's surface, the store
reaches the underlying Autobase through autobee, and each reach-through is
recorded below by the store build.

**§8.2/§8.4 ordinal resolution (spec-instructed).** The autobase README
documents no per-writer sequence on apply nodes, so option (b) applies: the
view-kept seen-count `seen/<W>` (top-level family, outside `ctx/`, incremented
for every node from `W` regardless of disposition) keys all `<seq>`-bearing
families. Excluded from materialize/export walks; included in the I2 view
hash. If a future autobase exposes a stable per-writer index, switching is a
new entry here.

**§10.1 layer inference (spec-instructed).** Folder-based schema/data
partition is honored only when an authored path is present; absent a path,
layer is inferred from the `@type` element set, which MAY diverge from a
folder-only vault-ld tool for locally-typed schema notes.

**UNVERIFIED.** (1) `host.removeWriter` is guarded by `host.removeable(key)`;
the autobase README does not state whether `removeable` is exact under all
quorum states. (2) The exact reserved-character set of vault-ld §4.5
percent-encoding was not confirmed against the vault-ld SPEC.md text;
`encodeURIComponent`-after-NFC is used, centralized in one function
(`encodeName`) if adjustment is needed. Both are marked in code and are P4
harness targets.
