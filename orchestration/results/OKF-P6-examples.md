# OKF-P6 — Examples (T8)

**Status:** DONE. Branch `15/okf-examples` (off `14/okf-cli`), PR #26 → base
`14/okf-cli`, titled "feat(okf): three examples — agent-session, slop-archive,
vlurp-library (T8)". **Not merged.** Assumptions comment posted on the PR.

Built the three v1 auto-okf examples under `okf/examples/`. Each is a committed
script whose committed `out/` regenerates **byte-identically** (asserted by a
test), and every emitted bundle passes the independent OKF v0.1 conformance
check. No autobase, no `@autovault-ld/*` imports, no package internals touched.

## Deliverables

| example | script | shows |
| --- | --- | --- |
| `okf/examples/agent-session/` (flagship) | `session.js` | four agents co-author on one shared vault while **partitioned, then heal**; OR-set tag union (I5), LWW clobber (§5/I4), body conflict + `ResolveConflict` (§5), `wanted/` demand (§9), materialize to `out/` (concepts + `index.md` + `log.md`); ThreadMode → DocumentMode |
| `okf/examples/slop-archive/` | `archive.js` | durable append-only LLM archive; delete = recoverable tombstone; `appendOnly` constant + zero byte-destroying ops = an agent cannot rm the archive (§8) |
| `okf/examples/vlurp-library/` | `import.js` | `vlurpfile` → staging → `_id`-stamped bundle with provenance frontmatter (source/ref/sha256); vlurp immutable with **offline committed-fixture fallback**; re-import reuses `_id`s via path→id lookup (no duplicates) |

Tests: `okf/test/example-{agent-session,slop-archive,vlurp-library}.test.js`
(+ shared `okf/test/example-helpers.js`). Each runs the committed script into a
fresh scratch dir under `sslop/035/tmp/`, asserts `out/` regenerates
byte-identically (sha256 tree map), asserts the narrative semantics, and runs
the OKF v0.1 conformance check. vlurp-library runs fully offline.

## Byte-determinism approach

Two nondeterminism sources are pinned in every script: **fixed-seed writer key
pairs** (via `hypercore-crypto`, so `_id = writerKey‖seq` is stable) and
**pinned `at` timestamps** (the sole input to `log.md` date headings). The
flagship additionally starts each concurrent phase from a fully converged
barrier, so the linearized op order is reproducible (I9). `out/` trees are
committed (un-ignored in `.gitignore`, mirroring the `examples/recipe-book`
precedent), including the deterministic `.okf-manifest.json`. Each example was
verified byte-identical across two independent runs before commit.

## Verification

Clean `pnpm install`; all three scripts run; full repo suite green.

```
✔ writer add/remove round trip (1209.274875ms)
ℹ tests 228
ℹ suites 0
ℹ pass 228
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 21116.954084
```

225 existing + 3 new example tests = **228/228 pass**.

### Flagship narrative (excerpt)

```
--- the agents reconnect: merge, audit, converge ---
[all  ] overview tags UNIONED across writers: [reviewed, urgent] (OR-set, I5)
[all  ] overview status: LWW register resolved to "under-review" (deterministic linearization, §5)
[all  ] cross-writer overwrites are NOT silent: 1 flag/clobber record(s) (§5, I4)
[all  ] body conflict detected and BOTH revisions kept: 1 flag/conflict record(s) (§5)
[all  ] the graph WANTS unwritten concepts: determinations/sharding (1 ref) (wanted/, §9 — never a flag)

--- editorial pass: alpha resolves the RFC body conflict ---
[alpha] ResolveConflict on the RFC: keep beta's revision, supersede gamma's, append the merged text (§5)
[all  ] flag/conflict drained by the ResolveConflict op: 0 left
```

## Commits (atomic, on `15/okf-examples`, no AI footers in PR body)

1. `chore(okf)`: workspace glob `okf/examples/*` + un-ignore example `out/`
2. `feat(okf-example)`: agent-session flagship
3. `feat(okf-example)`: slop-archive
4. `feat(okf-example)`: vlurp-library
5. `test(okf)`: three byte-determinism + conformance tests

## Notes

- Scratch confined to `sslop/035/tmp/` (unique per run, handles closed, never
  deleted); committed `out/` bundles live in the example dirs.
- vlurp binary path is opt-in (`OKF_VLURP_USE_BINARY=1` + on PATH) with per-file
  sha256 verification against the vlurpfile pins and fixture fallback; default
  and test are hermetic/offline.
- Three pre-existing untracked `orchestration/results/OKF-*.md` files were left
  untouched (not mine).
