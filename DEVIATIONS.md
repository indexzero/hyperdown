# DEVIATIONS

Deviations from SPEC-FINAL (`prompts/01-implementation-spec-prompt.v5.md`),
one paragraph each (§0 rule 3). Only true deviations and spec-instructed
recordings live here; implementation resolutions where the spec is silent are
documented in code comments (with source citations) and package READMEs.

**node:test instead of brittle.** User mandate (project owner). The Holepunch
convention is the brittle runner; this repo's entire suite runs on the Node
core test runner (`node --test`). No test-runner code is imported by library
packages, so brittle/bare compatibility of the libraries is unaffected.

**§1 dependency: autobee only; autobase is FORBIDDEN.** User directive
(2026-07-04, final): this repo is a wiki implementation on top of autobee,
and autobase appears nowhere — not as a dependency, not as an import, not as
docs framing. Verified against the fetched autobee package.json (v1.0.10,
2026-07-04): current autobee is a standalone multiwriter Hyperbee built on
hyperbee2 + hypercore 11 with NO autobase dependency; its own contract is
`new Autobee(store, key, { apply(nodes, view, host), open, close, update,
encryptionKey, encrypted, keyPair, optimistic })` with
`host.addWriter/removeWriter/ackWriter/interrupt/createAnchor`, node shape
`{key, value, length}`, and `update()/updated()/flush()` synchronization.
SPEC-FINAL's autobase-specific mechanics (apply node shape, `signedLength`
finality, indexer checkpoints) are therefore ported onto autobee's actual
contract; each port mapping is recorded by the store build below. Citations
to the autobase README in `packages/core` comments predate this correction
and are historical; core itself is transport-agnostic (its apply consumes a
node stream and a view interface) and depends only on
hyperschema/hyperdispatch/compact-encoding/b4a.

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
