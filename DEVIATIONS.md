# DEVIATIONS

Every deviation from SPEC-FINAL (`prompts/01-implementation-spec-prompt.v5.md`)
taken by the core build, with a one-paragraph justification each (§0 rule 3).
Section references are to SPEC-FINAL unless noted.

## Toolchain (user mandates)

**node:test instead of brittle.** The Holepunch ecosystem convention is the
brittle test runner; this repo uses the Node core test runner (`node --test`)
for the entire invariant suite. This is a user mandate from Charlie (project
owner): the node core runner requires no test-framework dependency, and the
suite must outlive framework churn. Brittle/bare compatibility of the *library*
code is unaffected (no test-runner code is imported by `packages/core`).

**pnpm for all dependency operations.** User mandate. The repo is a pnpm
workspace (`pnpm-workspace.yaml`, `packages/*`); npm/yarn are not used for any
install, add, or script execution. This changes no runtime behavior.

## §8.2 / §8.4 — per-writer ordinal resolution (spec-instructed recording)

The autobase README (fetched 2026-07-03) documents apply nodes as carrying
`value`, `from` (writer info), and `length` only; **no per-writer
sequence/index is documented on the apply node**. Per §8.2 option (b) and
§8.4, the implementation therefore maintains the view-kept per-writer
seen-count `seen/<W>` — a top-level key family outside `ctx/`, incremented for
every node from `W` regardless of disposition — and keys **all** `<seq>`-bearing
families (`n/hold/`, `flag/rejected/`, `flag/optimistic/`, and every
namespace/rate rejection) by it. `ctx/gov/clock/<W>` (applied count) is never
used as an ordinal source. `seen/` is excluded from materialize/export walks
but included in the I2 view hash, as §8.2 requires. If a future autobase
release exposes a stable per-writer index on the node, switching to it is a
new deviation entry.

## §10.1 — layer inference and scope binding (spec-instructed recording)

Folder-based schema/data partition is honored **only when an authored path is
present** (`n/<s>/path`, priority (1)). Absent a path, layer is inferred from
the `@type` element set against the fixed meta-type list (priority (2)), which
MAY diverge from a folder-only vault-ld tool for locally-typed schema notes; a
pathless schema subject lacking a recognized meta-type defaults to `data`.
Subject-scope binding uses rule (b) (unambiguous defining scope of the
subject's `@type` terms) then rule (c) (data namespace) when no authored path
carries a scope. A pathless schema subject with no derivable scope is demoted
to `data` with `flag/noscope`; a pathed one keeps `layer=schema`, is flagged,
and mints from the root `@base`. All exactly as §10.1 specifies; recorded here
because §10.1 instructs it.

## Keyspace layout resolutions (§4)

**`ctx/` sub-layout.** §4 places user scopes at `ctx/<scope>/<term>` alongside
the reserved families `ctx/scope/` and `ctx/gov/`; a user scope literally named
`scope` or `gov` would collide. Term definitions are stored under
`ctx/d/<scope>/<term>` and the composed per-term lookup under `ctx/t/<term>`.
The composed lookup is deterministic derived state (last-linearized definition
wins), needed so §5.1 term-kind resolution is a point read rather than a scan.

**`n/hold/` reservation.** §4 places the hold buffer at `n/hold/<W>/<seq>` in
the user-subject position. The keyspace codec re-escapes a subject whose
escaped form is exactly `hold` to `%68old` (decodes to `hold`), so no user
subject can collide with the reserved family and round-tripping is lossless.

**Additional bookkeeping families.** The implementation maintains six
deterministic bookkeeping families not named in §4, all pure functions of the
linearized prefix, all included in the I2 view hash, all excluded from
materialize/export: `rate/<W>` (+ `rate/indexer-ops`) for §8.5 token-bucket
state (it cannot live in `ctx/gov` because rejected and held ops must update it
while I10 forbids rejected ops from mutating `ctx/`); `gseq/pos`, a global
linearized-position counter used for the deterministic §5.5 or-set→lww
collapse order; `iri/<iri>/<s>`, the reverse minted-or-declared IRI map that
makes §5.8 `flag/idcollision` and §9.2 `flag/linkambiguous` point checks;
`fidx/<term>/<s>`, the term-keyed reverse index of mapped field state that
makes §5.5 kind-change migration a bounded range scan (the "term-keyed scan"
§5.5 refers to; without it every kind change would be a full `n/` walk, the
DoS §10.3 forbids for the unmapped case); `hostidx/<key>/<s>` for §5.6 host-key
promotion (same bounded-scan argument); and `scopeidx/<scope>/<s>` so a
`DefineScope` redefinition can rebind exactly the subjects governed by that
scope (§10.1 "re-evaluated only by ops that change its inputs").

## Op semantics resolutions

**Kind-mismatch is flagged, not doubly recorded.** §5.2 mandates
`flag/kindmismatch/<s>/<p>/<tag>` with no `n/` mutation; §8.4's reason enum
also lists `kindmismatch`. Writing both a kindmismatch flag and a
`flag/rejected` row would double-record one event, so the table's flag is the
single record; `flag/rejected` reasons are reserved for ops rejected before
the §5.2 table (decode, limits, policy). I4 holds: the effect is auditable.

**`UnsetField` on an unmapped term clears the unmapped state.** §5.2's cell
says "remove the verbatim value + `flag/unmapped`", while §6 classifies
`unmapped` as a structural flag "cleared by its defining resolution (… a
corrected op)". A removal that leaves the flag pointing at no surviving value
would be a permanently unclearable flag; the implementation treats the
`UnsetField` as the corrected op: it removes the accumulation and clears
`flag/unmapped` + `unmapped-idx/` for that `(s, term)`.

**Host-allowlist keys under `AddMember`/`RemMember`.** §5.6 defines host keys
as Markdown-face-only whole values with no tag semantics ("MUST NOT warn").
`SetField`/`UnsetField` set/delete the stored value verbatim (authored order
preserved for lossless materialization); an `AddMember` accumulates into the
stored list (canonical dedup); a `RemMember` is a no-op (there are no element
tags to cite). None of the four flags.

**`SetWriterPolicy` for an unknown key is rejected.** §8.6 does not say what a
policy op naming a never-admitted key does. Creating a `ctx/gov/writer/`
record would *confirm* the key as a writer via a policy op, bypassing §8.0
`AddWriter` authority; the op is rejected with reason `policy-governance`.

**`rateCeiling` is clamped, not rejected.** §8.5: an explicit policy "may only
*tighten* below the default". A `SetWriterPolicy` whose `rateCeiling` exceeds
the vault default capacity stores `min(default, rateCeiling)` rather than
rejecting the whole op, so the namespace half of the policy still lands.

**`AddWriter` re-admission clears `ctx/gov/removed/<key>`.** §8.3 does not
address re-admitting a revoked writer. Keeping the revocation record would
reject the re-admitted writer's future ops (their clocks exceed the recorded
revocation clock) making re-admission a no-op, so `AddWriter` deletes it. The
sequence is fully in-log and therefore deterministic on every peer.

**Empty vector clock = missing clock under revocation.** §8.3 rejects ops with
a "missing or malformed clock" once revoked. An empty clock array vacuously
dominates below every recorded clock; treating it as valid would let a revoked
writer forge acceptance by sending `clock: []`. Empty is treated as missing.

**Synthetic element tags in lww→or-set migration.** §5.5 says register values
migrate "under a synthetic tag `writerKey || seq` of the DefineTerm op"; a
multi-valued register (canonical array, §5.1) would collide all values on one
tag. Tags are suffixed `-<i>` in canonical value order (`<synthTag>-0`, `-1`,
…), deterministic and unique. Same scheme for §5.6 host promotion and §10.3
backfill items that carry no original tag.

**Body-adjacent clobber flag keys.** §5.4 extends clobber flags to the body
head pointer, `SetPath`, and `@id` writes but assigns no `<term>` component;
the implementation uses the synthetic term components `body`, `path`, and
`@id` respectively in `flag/clobber/<s>/<term>/<tag>`. `SetBody`,
`RemMember`, and other tag-less ops synthesize `tag = writerKey || ord` from
the §8.2 ordinal.

**`DefineScope` shadowing flag.** §10.1 says scope redefinition "follows §5.5
shadowing rules" but `flag/shadow/<scope>/<term>` has no term for a scope
declaration; the synthetic term `@base` is used.

**`ResolveConflict` naming an unknown `keep` revision.** Rejected with reason
`garbage-base` (the §8.4 enum's closest member; a resolution citing a
revision the log never produced is exactly a garbage base citation). Same for
`SetBody` citing an unknown or malformed base, which §8.4 names explicitly.

**`ClearFlag` on `flag/shadow`.** §6 lists shadow in neither the clearable
audit set nor the structural set. It is treated as structural (rejects,
`flag-not-clearable`): its defining resolution is a matching redefinition.

**`flag/linkambiguous` path qualifier.** §9.2 exempts links carrying a path
qualifier; a ref target containing `/` is treated as path-qualified and not
ambiguity-checked.

## Encoding and wiring

**Hyperdispatch is used; autobee is not depended on.** §1 requires recording
the choice: core reimplements the apply/view pattern against the documented
autobase/hyperbee interfaces directly (autobee is experimental with breaking
changes expected, and core must stay pure). Ops are encoded with hyperdispatch
+ hyperschema + compact-encoding as §3 prefers — no JSON-op deviation. The
generated `packages/core/spec/` code is committed; `dispatch.json` and
`schema.json` pin message ids and field orders, making the §3.3 append-only
wire contract enforceable by inspection.

**Polymorphic fields use the compact-encoding `json` type.** `o` (values may
be scalar | array | `{ref}` | typed literal), `def`, and `clock` are declared
as hyperschema `json` fields ('json' verified in hyperschema's SupportedTypes).
The bytes are fixed by the writer at append time, so decode determinism (§3.3)
is unaffected. Buffers (`tag`, `tags`, `key`) are typed `buffer` fields.

**Held ops store raw bytes alongside the decoded payload.** §8.2 requires the
full decoded payload in `n/hold/`; the record also carries the raw op hex so a
rejection at fold time can record the §8.4 `rawHashHex` and so buffers
round-trip losslessly through the JSON view encoding.

**Revision record `at` field.** §4 shows `{base, text, writer, at}` without
defining `at`; wall-clock time is banned by I1. `at` is the writer's §8.2
per-writer ordinal at the SetBody — deterministic and monotonic per writer.

**Rate-token consumption point.** §8.5 says every op of `W` consumes one
token. The implementation consumes after the revocation check and before the
namespace check (and at hold time for optimistic ops, per §8.2); ops rejected
earlier (oversize, undecodable, revoked) consume none. Any fixed point is
deterministic; this one is recorded because the partition is view-observable.
Folding a held op at ack does not re-charge the bucket (it was charged at hold
time, per §8.2).

**`host.removeWriter` guarded by `host.removeable`.** The autobase README
states removeWriter "will throw if the writer cannot be removed" (last
indexer). A throw out of apply is banned (§8.4), so the call is guarded with
`host.removeable(key)` when present. UNVERIFIED: README does not state whether
`removeable` is synchronous-exact under all quorum states.

**Root `@base` and percent-encoding.** The data-namespace root `@base` is a
config constant (`rootBase`, default `vault://data/`) standing in for vault
metadata until the store package lands. Name→IRI percent-encoding uses
`encodeURIComponent` after NFC (§3.1 ordering honored). UNVERIFIED: the exact
reserved-character set of vault-ld §4.5 could not be checked against the
vault-ld SPEC.md text during this build; `encodeURIComponent` is deterministic
and stable, and the codec is centralized in one function (`encodeName`) if the
character set needs adjusting.

**I9 at unit level.** This phase ships canonical literal/string forms (§10.2,
§3.1) and their tests; byte-identical `.ttl` and materialized vaults are
asserted in the faces phase where `exportTurtle`/`materialize` live. The unit
suite verifies the canonical forms those functions are required to emit.
