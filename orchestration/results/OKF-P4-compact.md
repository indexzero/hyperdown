# OKF-P4 — Epoch-cycle compaction + I11 (T6)

**Branch:** `13/okf-compact` (off `12/okf-faces`) · **PR base:** `12/okf-faces`
**Scope:** `okf/faces` only (+ new test + docs). No core/store/vault-ld/prompts touched.

## What was built

`compact(vault, opts)` in `okf/faces/lib/compact.js`, exported from
`@auto-okf/faces` (`compact`), per SPEC §10:

1. **Guardrail** — refuses (`COMPACT_REFUSED`) without `force:true` while any
   `flag/conflict` **or** `flag/pathcollision` is open (SPEC §10).
2. **Materialize** the live bundle into `toDir` (heads + `_id`/`_rev`;
   tombstones suppressed; open conflicts as conflicted copies).
3. **Stage** a manifest-free, `_rev`-stripped copy of the concept notes
   (sibling of `vaultDir`), so ingest does not self-echo and each head
   re-roots at `base:null`.
4. **Init a fresh vault** with epoch-chain metadata
   `{ predecessorKey, predecessorCheckpoint }` (store derives writer cores
   under a fresh per-epoch namespace ⇒ fresh keypair ⇒ adoption never trips
   `mint-collision-risk`).
5. **Ingest** the staged bundle with `_id` **adoption** — identity lineage
   survives.
6. **Record** the epoch entry at `<vaultDir>/log/epoch.json` (with
   carried-across conflict copies under `force`). Predecessor is **not
   deleted** — its path is returned.

`initVault` is **injected** (`opts.initVault`) so faces keeps its
"substrate is injected" property (no hard `@auto-okf/store` dep). CLI wires it.

## Two load-bearing discoveries (probed under `sslop/033`, recorded in DEVIATIONS.md)

- The predecessor's `.okf-manifest.json` makes the watcher skip every file as
  a self-echo ⇒ must ingest a manifest-free copy.
- A materialized `_rev` cites a base absent in the fresh vault ⇒ head is
  flagged `flag/conflict/<id>/-/<new>` and materializes **bodyless** ⇒ must
  strip `_rev` so heads re-root at `base:null` (and `_rev` re-derives, §14).
- (bonus) `new Corestore(vaultDir)` clears the vault dir on init ⇒ staging
  must be a **sibling**, not a child, of `vaultDir`.

## What I11 asserts (`okf/test/i11-roundtrip.test.js`, real autobee, 4 tests)

- **Byte fidelity:** new materialized bundle == old, byte-identical **modulo
  the `_rev` lines and `log.md`** (§14) — non-trivial bundle: nested paths,
  OR-set tags, a rename, a body-revision edit, unmapped/`host` keys, a
  RESOLVED conflict (flag/conflict drained), a tombstone (suppressed).
- **Identity + state fidelity:** live `_id` set unchanged; per concept
  `type`/`path`/head body preserved; renamed concept at its new path only;
  tombstoned concept absent.
- **History SHED (positively):** old revisions collapse (A: 2→1, C: 3→1);
  new vault's `log/` narrates **only** `create` (old had rename/resolve/delete).
- **Epoch chain:** predecessor key/checkpoint pinned; fresh non-genesis epoch
  namespace; fresh writer keypair; `log/epoch.json` written.
- **Guardrail:** refuses an undrained conflict without force; proceeds with
  force (head wins, sibling shed, no carried conflict).
- **Length-2 chain:** genesis←epoch1←epoch2 round-trips; identity preserved
  end-to-end.
- **`--force` carry-across:** a path-collision conflict copy re-manifests at
  the same path in the new vault; `conflictCopies` enumerates `from===to`.

## Verification

- `pnpm install` clean (lockfile up to date).
- Full repo suite: **216 pass / 0 fail** (212 existing + 4 new I11).

```
ℹ tests 216
ℹ pass 216
ℹ fail 0
ℹ duration_ms 20486
```

Autobase not used; no `@autovault-ld` imports; core/store internals untouched.
Scratch under `sslop/033/` (gitignored, never deleted).
