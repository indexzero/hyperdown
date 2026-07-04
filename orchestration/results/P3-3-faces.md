# P3-3 — Build report: `@hyperwiki/faces` (SPEC-FINAL §13, faces scope)

Status: **DONE**. Branch `4/faces`, commits `fe12de8` (feat), `424c270`
(test), `cc931cb` (docs/deviations). No push, no PRs. Full repo suite
green: **104/104** (72 prior core+store tests + 32 new faces tests).

## Deliverables

```
packages/faces/
  package.json            @hyperwiki/faces (deps: @hyperwiki/core workspace, yaml)
  index.js                materialize / createIngestWatcher / exportTurtle (+ helpers)
  lib/state.js            §4 view walk (n/ + ctx/), reserved n/hold handling, alias lookup
  lib/note.js             canonical YAML emitter (hand-rolled), yaml-pkg parser,
                          wiki-link grammar (vault-ld §4.4.1), note render/parse
  lib/placement.js        vault-ld §5.1 layout, reconstructable defaults, §9.4 checks
  lib/fsatomic.js         atomic temp+fsync+rename, lexical+realpath containment,
                          per-path in-flight lock registry, materialize manifest
  lib/materialize.js      §9.1/§9.3/§9.4 vault projection, context.jsonld, I9
  lib/ingest.js           §9.2 watcher: per-field diff engine, minimal op sets,
                          debounce+write-settle, DeleteSubject confirmation guard
  lib/turtle.js           §10 export: idx/spo range scan, layer partition, §10.2
                          canonical ordering/lexicals, §10.4 vld:path
  README.md               usage-first (example → install → API → semantics → tests)
test/faces-helpers.js     sslop/014/tmp scratch dirs, seed fixture, tree hashing
test/faces-{materialize,ingest,roundtrip,turtle,race}.test.js   32 tests
```

Root `package.json`: `n3` added as devDependency (Turtle-parse tests only).

## Scope items vs. delivery

1. **materialize(dir)** — walks `n/`/`ctx/`, emits YAML-LD frontmatter in
   canonical sorted order with §10.2 scalar forms (hand-rolled emitter;
   the `yaml` package is used for *parsing* only — determinism beats
   convenience), body from head revision, `context.jsonld` from `ctx/`
   (`@base` from pinned metadata + scope prefixes + term defs), host keys
   and unmapped terms round-trip, explicit `@id` verbatim under its
   declared alias, tombstones suppressed, `n/<s>/path` honored first with
   vault-ld §5.1 reconstructable defaults otherwise, byte-deterministic
   (I9), atomic writes + lexical/realpath containment + per-path locks +
   manifest skip-if-externally-modified (§9.4).
2. **Ingest watcher** — recursive `fs.watch` (caveats handled: events are
   only "path dirty"; null filename ⇒ rescan; debounce + write-settle),
   per-field frontmatter diff and head-cited body diff emitting the
   minimal op set through the provided append function (default
   `vault.append`, which fills §3.2 clock/tag): one `SetField` per edited
   lww field (pinned `ctxKind`), `AddMember`/`RemMember` with the full
   §5.3 citation set for or-sets, `UnsetField` for removed lines,
   `DeleteSubject` behind the §9.2 confirmation guard (never emitted
   without a handler), wiki-link alias/fragment/path grammar with
   ambiguity left to apply, `vld:path` consumed never stored, NFC file
   names, lock/manifest coordination with materialize.
3. **exportTurtle(dir)** — `schema.ttl` + `data.ttl` from an `idx/spo`
   range scan partitioned by `n/<s>/layer`; byte-deterministic: sorted
   prefix/subject/predicate(expanded-IRI bytes)/object(canonical byte
   form), canonical XSD lexicals, fixed-order string escaping, `a`
   shorthand, `'@type': '@id'` coercion; `vld:path` emitted iff authored
   path ≠ reconstructable default and only under `{ roundtrip: true }`;
   unmapped terms structurally never exported (they never reach `idx/*`).
4. **Tests** — 32, all invariant-mapped (see raw tail below); real
   `@hyperwiki/store` vaults (autobee + corestore) on unique
   `sslop/014/tmp/run-*/` dirs, handles closed, no cleanup.
5. **README** — usage-first per the assignment; Apache-2.0.

## Sources (fetched, cited in code)

- vault-ld `SPEC.md` (normative format semantics): §4.5 IRI minting +
  percent-encoding text (settles DEVIATIONS UNVERIFIED item (2) — see
  below), §4.3 host keys/keyword aliases, §4.4.1 wiki-link grammar,
  §5.1/§5.4/§5.5 export layout + `vld:path` + percent-decoding, `vld:`
  namespace IRI (`https://github.com/The-Knowledge-Graph-Guys/vault-ld#`).
- `https://eemeli.org/yaml/` — parser choice; YAML 1.2 core schema.
  Emission is hand-rolled canonical (justified in `lib/note.js` header).
- `https://github.com/rdfjs/N3.js` — Turtle parser (devDependency only).
- `https://www.w3.org/TR/turtle/` — IRIREF/STRING_LITERAL_QUOTE grammar.
- `https://nodejs.org/api/fs.html#fswatchfilename-options-listener` —
  fs.watch caveats (platform inconsistency, unreliable event types,
  nullable filename, recursive support incl. Linux on Node ≥ 20).

## DEVIATIONS.md (two new entries)

- **§4.5 percent-encoding verified; `encodeName` over-encodes** —
  resolves UNVERIFIED item (2). Spec text mandates minimal RFC 3987
  encoding of *offending* characters; core's `encodeURIComponent`-after-
  NFC matches the spec's own `Red%20Lentil%20Soup` example but
  over-encodes ucschar/sub-delims (`Café` → `Caf%C3%A9`). Injective and
  uniform ⇒ §3.1 identity and I2 unaffected in-vault; cross-tool IRI
  equality diverges for such names. Core is a frozen input to this build,
  so the fix site is recorded (core `encodeName` + the mirrored fallback
  mint in `faces/lib/turtle.js`) rather than patched.
- **§9.4 `flag/unsafepath` is a materialize report, not a view row** —
  only `apply` writes the view (§9.3) and core exposes no flag op;
  materialize returns `unsafe: [{ subject, reason }]`, while apply's
  `flag/rejected` (reason `unsafe-path`) remains the view-side audit.

Implementation resolutions kept in code comments/README (not deviations):
materialize never deletes files (stale files reported); ingest
canonicalizes bodies to no trailing newline; or-set faces show the
deduplicated value set; whole-note ingest legitimately re-asserts the
file's observed field state under per-field LWW (§5.4-audited).

## Verification

`pnpm install` clean (`Already up to date … Done in 263ms`). Full suite
(`pnpm test`, Node v24.16.0, pnpm 10.34.0) — raw tail:

```
✔ metadata canonical bytes are independent of input key order (1.357875ms)
✔ metadata defaults mirror the core vault-metadata table (0.452792ms)
✔ metadata is written at init, loaded at open, and pinned to the vault key (397.688125ms)
✔ metadata is identical across peers of the same vault (413.311625ms)
✔ a divergent invite or mismatched key is refused (269.434125ms)
✔ restart from disk: reopened view equals the pre-close view (I3) (890.465333ms)
✔ fresh peer rebuild from the log equals the restarted view (1046.484583ms)
✔ two vaults replicate over hyperswarm (discoveryKey join) (973.03725ms)
✔ writer add/remove round trip (1614.618041ms)
ℹ tests 104
ℹ suites 0
ℹ pass 104
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7059.469084
```

Faces-suite lines from the same run (head of the log,
`sslop/014/full-suite.log`):

```
✔ editing one frontmatter field emits exactly one SetField (§9.2 minimality) (1873.009833ms)
✔ deleting a frontmatter line emits exactly one UnsetField (§9.2) (987.534875ms)
✔ a body edit emits exactly one SetBody citing the observed head (§9.2) (724.98ms)
✔ or-set edits: one AddMember per added value, one RemMember citing every tag (§5.3) (858.469125ms)
✔ a new file becomes semantic ops, never a whole-file op (§3/§9.2) (549.5535ms)
✔ file moves emit SetPath with the authored context-relative path (§9.3) (487.932833ms)
✔ wiki-link grammar: alias ignored, fragment discarded with warning, path kept (§9.2/vault-ld §4.4.1) (297.376542ms)
✔ vld:path frontmatter is consumed, never stored as a field (§9.3/§10.4) (200.421709ms)
✔ host keys: whole-value SetField, stored under host/, never flagged unmapped (§5.6) (198.081166ms)
✔ deleting a file: guarded DeleteSubject; deletion survives a materialize cycle (§9.2) (206.565083ms)
✔ unmapped values round-trip; removals rebuild the accumulation (§5.6/§10.3) (261.879625ms)
✔ NFC normalization: NFD file names from the filesystem ingest as NFC subjects (§3.1) (196.810042ms)
✔ materialize is byte-deterministic: same view, two dirs, two passes (I9) (1869.640834ms)
✔ materialize on a rebuilt store and a replicated peer yields identical bytes (I9) (1841.743208ms)
✔ materialized vault has the Obsidian/vault-ld shape (§9.1) (580.439875ms)
✔ explicit @id is emitted verbatim and deleted subjects are suppressed (§5.8/§9.2) (621.344959ms)
✔ adversarial containment: ../escape and unsafe SetPath never write outside root (§9.4) (198.090625ms)
✔ case-insensitive collisions keep one deterministic winner (§9.4 (d)) (228.413167ms)
✔ turtle files and manifest are part of no note walk (bookkeeping stays out of the face) (344.323291ms)
✔ materialize never clobbers an unsaved human edit (§9.4) (2154.007541ms)
✔ the per-path in-flight lock serializes materialize against ingest (§9.4) (1016.987541ms)
✔ concurrent materialize passes and ingest scans reach a consistent fixed point (799.429084ms)
✔ the real fs.watch pipeline ingests a disk edit (debounce + write-settle) (1311.399875ms)
✔ materialize → edit → ingest → materialize reaches a stable fixed point (2079.938625ms)
✔ note placement roundtrips: authored path → vld:path → identical rebuild (§9.3/§10.4) (958.036208ms)
✔ human edits ingest on one writer and converge to identical faces on another (I2 → I9) (1427.88375ms)
✔ exportTurtle output parses with a standard Turtle parser (N3.js) (1800.861625ms)
✔ export is byte-deterministic across passes, rebuilds, and peers (I9) (1736.484292ms)
✔ layer partition: schema notes in schema.ttl, instances in data.ttl (§10.1) (489.196459ms)
✔ unmapped terms are never exported as triples but stay on the Markdown face (§10.3) (662.298667ms)
✔ wiki-link refs export as object IRIs; dangling targets use their minted IRI (§7) (511.46975ms)
✔ roundtrip flag gates vld:path emission (§10.4) (414.797917ms)
```

## Notes for the P4 harness

- Namespaced subjects (`agents/x/Note`) materialize only with an authored
  path (§9.4(a) letter-of-spec); the CLI should `SetPath` on agent
  onboarding or document the convention.
- `renderIriName`'s no-colon fallback mint mirrors core's `encodeName`;
  if the §4.5 encoding set is fixed in core, change both together (see
  DEVIATIONS entry).
- Race-test scratch and smoke scripts preserved under `sslop/014/`
  (`smoke1–3.mjs`, `full-suite.log`, `tmp/run-*/`).
