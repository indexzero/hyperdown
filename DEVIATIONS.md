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
to the autobase README in `vault-ld/core` comments predate this correction
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

**§13 store: SPEC-FINAL→autobee port mappings.** Verified against the
installed autobee@1.0.10 source. (a) Apply node shape: autobee hands
`{ key, value, length, optimistic }` (key = writer core key); the store
wraps each node as `{ from: { key }, value, length }` before core's apply.
(b) Host surface: core's `host.addWriter(key, { indexer })` maps to
autobee's `host.addWriter(key, { isIndexer, weight })`; autobee's
`removeWriter`/`removeable` are not exposed at all (see (d)).
(c) `signedLength`-scoped clauses:
autobee has no separate signing pipeline (`views()` reports
`signedLength === length`; finality is flush/anchor —
`host.createAnchor()` is the checkpoint primitive), so §8.5's
"at or below signedLength" rate-partition scope and §11's quorum-signed
snapshots have no 1:1 substrate; view convergence is asserted by full-scan
hash equality and §11 snapshot machinery stays future work (P4 harness
territory). (d) §8.3: revocation is decided solely by core's in-log clock
rule; `opRemoveWriter` records `ctx/gov/removed/<W>` and deliberately never
invokes autobee's positional `host.removeWriter` (positional removal cut
W's concurrent nodes out of the remover's linearization while peers that
had already linearized them kept them — permanent divergence; review
finding B1). The removed writer stays admitted at the substrate level, so
every node linearizes on every peer: ops linearized after the RemoveWriter
are uniformly accepted/rejected (`revoked`) by the clock rule, and a racing
op that linearizes before it (autobee orders concurrent nodes by node
timestamp) is uniformly applied — either way one convergent view (I2), the
partition a pure function of the final log (I10). Two store-side
consequences: the emitted §3.2 clock counts the appending op itself in the
writer's own entry (`seq + 1`; DAG heads alone give the pre-append length,
which a removal that never delivered the op would dominate, mis-accepting
racing ops), and containment of a revoked peer is app-level —
`Vault.append` refuses new local ops (`VAULT_REVOKED`) once
`ctx/gov/removed/<self>` exists and the op's clock does not causally
precede it.

**§8.2 optimistic onboarding on autobee (ackWriter port).** Autobee's
optimistic path requires the batch to anchor in its system during apply or
it is rolled back and the writer dropped from pending; the store's apply
wrapper therefore calls `host.ackWriter(node.key)` for optimistic nodes
("acknowledge a writer without changing their permissions"). This is
DAG-level only and deterministic (same apply, same nodes on every peer):
core's §8.2 hold buffer (`n/hold/` + `flag/optimistic/`) remains the sole
view-effect gate until an in-log `AddWriter` from a confirmed indexer
linearizes and core folds the held range. Because the hold defers the op's
*effect* to the ack position, peers converge to identical views even when
the raw optimistic node linearized at different positions on different
peers (observed and asserted in test/store-convergence.test.js).

**Uniform autobee topo weight for all writers.** autobee@1.0.10's
linearization comparators disagree for concurrent nodes of unequal weight
(lib/topo.js: `isOrderedBefore` breaks its walk on
`node.weight < link.weight` while `cmp` sorts higher weight first), so
peers that receive concurrent indexer/non-indexer (weight 2/1) nodes in
different arrival orders keep permanently divergent linearizations —
observed empirically, fatal for I2 under core's order-sensitive apply (the
reference codebases sidestep it with order-independent first-seen-wins
applies). The store therefore admits every writer with weight 2 (the
genesis auto-add weight), keeping the `isIndexer` bit for autobee's
bookkeeping; §8.0 governance authority is decided from `ctx/gov` by core,
never from autobee writer state, so spec semantics are unaffected.

**UNVERIFIED.** (1) `host.removeWriter` is guarded by `host.removeable(key)`;
the autobase README does not state whether `removeable` is exact under all
quorum states. (2) The exact reserved-character set of vault-ld §4.5
percent-encoding was not confirmed against the vault-ld SPEC.md text;
`encodeURIComponent`-after-NFC is used, centralized in one function
(`encodeName`) if adjustment is needed. Both are marked in code and are P4
harness targets. *(Item (2) resolved by the faces build; see the §4.5
entry below. Item (1) remains open.)*

**vault-ld §4.5 percent-encoding verified; `encodeName` over-encodes
(resolves UNVERIFIED item (2)).** Fetched from the vault-ld SPEC.md
(2026-07-03): "A file name may contain characters that are not legal in an
IRI (spaces are the common case); when minting an identity from a file
name, a tool MUST percent-encode the offending characters per RFC 3987, so
`Red Lentil Soup.md` mints `.../Red%20Lentil%20Soup`." Core's `encodeName`
(`encodeURIComponent` after NFC, vault-ld/core/lib/apply.js) agrees with
the spec's own example, but over-encodes characters RFC 3987 permits in an
IRI path segment — non-ASCII `ucschar` letters and sub-delims/`:`/`@` — so
`Café` mints `vault://data/Caf%C3%A9` where a minimal RFC 3987 minter
yields `.../Café`. The mapping is injective and applied uniformly after
NFC, so §3.1 same-subject identity and I2 convergence are unaffected
inside a vault; the deviation is cross-tool IRI equality with a strict
vault-ld minter for names containing such characters. Core is a frozen
input to the faces build (P3-3), so the fix site is recorded instead of
patched: `encodeName` in vault-ld/core/lib/apply.js, and the §10.1
fallback mint in vault-ld/faces/lib/turtle.js that deliberately mirrors it
(the two must change together).

**§6 a null `base` is "no base cited", never a shared base (review finding
M1).** A literal reading of §6's "two revisions citing the same `base`"
makes every pair of null-base `SetBody` revisions on a subject true
concurrency, so N independent creations yield N-choose-2 `flag/conflict`
rows and the detection rescan made every `SetBody` O(R) in the subject's
revision count — quadratic per subject, unbounded flag state, and a
single-writer DoS of every peer's apply (two soak runs died when one
setBody exceeded the 120s command budget; CODE-REVIEW.md M1). Resolution:
independent null-base creations are LWW on the head pointer and raise no
mutual `flag/conflict`; cross-writer supersession among them is still
surfaced via the §5.4 `flag/clobber` (O(1) per op), and `flag/conflict` is
reserved for two revisions citing the same NON-null base — which still
keeps both revisions, sets the head deterministically, and writes exactly
one flag per pair (I4 intact). Same-base detection now reads the
base-keyed bookkeeping index `revbybase/<s>/<base>/<rev>` (maintained by
`SetBody`, `ResolveConflict`-with-text, and `PruneRevisions`; like `seen/`
it is included in the I2 view hash and excluded from materialize/export)
in O(matches) instead of scanning `n/<s>/rev/*`.

**§9.4 `flag/unsafepath` is a materialize report, not a view row.** §9.4
directs `materialize` to record `flag/unsafepath/<s>` for skipped unsafe
paths, but §9.3 mandates that no component writes the view except `apply`
folding ops, and core exposes no flag-writing op. `materialize` therefore
returns unsafe skips in its report (`unsafe: [{ subject, reason }]`,
covering separator-in-subject, escape, absolute-path, and
case-insensitive-collision skips), while the view-side audit remains
apply's rejection of unsafe `SetPath` values (`flag/rejected`, reason
`unsafe-path`, §8.4). I4 is preserved in substance (no silent skip; every
skip is observable) at the cost of the flag living in the report instead
of the view.
