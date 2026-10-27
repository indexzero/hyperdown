# @auto-okf/cli

The `auto-okf` command line (okf SPEC §13): a thin veneer over
[`@auto-okf/store`](../store) (vault lifecycle + §8 governance ops) and
[`@auto-okf/faces`](../faces) (materialize, ingest watcher, the `wanted/`
demand index, generation-cycle compaction). The CLI never writes the view or the
face itself — every effect flows through the packages, so anything it does is
exactly what a library caller does. The command surface is declared once as a
[paparam](https://github.com/holepunchto/paparam) command tree (Holepunch's
own CLI parser — pear runs on it), and all help text is generated from those
declarations.

## A working example

Create a vault, hand-author a note, fold it into the log, and project the
OKF bundle back to disk:

```sh
# 1. create a vault; this peer's key is the vault key AND the genesis indexer
$ auto-okf init ./vault
vault key:   6671cacb…
writer key:  6671cacb…
storage:     ./vault
generation:  root
this peer is the genesis indexer (§8); share the vault key to invite peers

# 2. there is NO content-write command — content enters through ingest (edit
#    markdown) or the @auto-okf/store API (agents). Hand-author a note:
$ mkdir -p ./bundle
$ cat > ./bundle/hello.md <<'EOF'
---
type: note
title: Hello
---
Read the [architecture](/guides/architecture) page first.
EOF

# 3. ingest — the file re-enters the log as minimal ops (mint + set-body)
$ auto-okf ingest ./vault ./bundle
ingested hello.md: create-concept, set-field, set-body
ingest complete: 3 op(s) from 1 file(s)

# 4. materialize — one .md per live concept, plus derived index.md + log.md;
#    hello.md is rewritten canonically with its _id/_rev stamped in
$ auto-okf materialize ./vault ./bundle
materialized ./bundle: 3 written, 0 unchanged, 0 removed

# 5. the body linked an unwritten page — the ranked demand index shows it
$ auto-okf wanted ./vault
1	guides/architecture	<- 6671cacb…0
```

Ops come from **ingest** (human edits) and the `@auto-okf/store` API
(agents); **materialize** projects the log back out. The two coordinate
through an emission manifest so the system never echoes its own writes back
as ops.

## Install

```sh
pnpm add @auto-okf/cli    # or run the repo-local bin: okf/cli/bin/auto-okf.js
```

## Commands

| command | what it does |
| --- | --- |
| `init <dir>` | create a new vault at `<dir>`; prints the vault key (share it to invite peers), this peer's writer key, and the generation namespace; refuses a dir already pinned |
| `join <dir> <vault-key>` | join an existing vault by key; `--encryption-key <hex64>` and `--metadata <invite.json>` carry non-default invites; when `<dir>` is already pinned the key is optional (reopen + reprint keys). A joined peer appends nothing until autobee adds it as a writer (`VAULT_NOT_WRITABLE`, `okf/store/lib/bundle.js:791-799`), and its ops take effect only once an indexer admits it (`okf/core/lib/apply.js:426`): hand the printed writer key to an indexer (`add-writer`), then replicate (`watch --swarm`). See [Joining a vault](#joining-a-vault) |
| `add-writer <dir> <writer-key> [--indexer]` | append an `AddWriter` governance op; reports whether it took effect (apply rejects issuers that are not confirmed indexers, §8) |
| `remove-writer <dir> <writer-key>` | append a `RemoveWriter` op; revocation is causal, never positional (§8) |
| `materialize <dir> <bundle-dir>` | project the OKF v0.1 bundle (concepts + per-dir `index.md` + root `log.md`); prints written/unchanged/removed counts; pending-ingest and stale files are `notice:` lines on stderr, unsafe paths `error:` lines. Exits 3 when everything owned was projected but human-authored file(s) are pending ingest (N3); an unsafe path is a real failure, exit 1. `--force-mirror` restores unconditional mirroring. `materialize` is the plaintext export: for an encrypted vault it prints a `warning:` line that names `<bundle-dir>`, and the exit code does not change (see [Encryption and plaintext](#encryption-and-plaintext)) |
| `ingest <dir> <bundle-dir> [paths…]` | one-shot: fold on-disk edits under `<bundle-dir>` back into the log as minimal ops (§9). Trailing bundle-relative paths restrict the scan to exactly those concept files (ADR-001 — concurrent-writer politeness; the shell expands globs): a named path that does not exist, escapes the bundle root, or is not a `.md` file exits 1 naming the path, with zero ops appended. Zero paths = full scan, unchanged. `--confirm-deletes` lets a file deleted on disk emit `DeleteConcept` (off by default) |
| `watch <dir> <bundle-dir> [--swarm]` | foreground ingest watcher: human edits re-enter as ops as files change; `--swarm` also joins the vault's `auto-okf/2` hyperswarm topic for replication (on the public DHT, see [Notes](#notes)); `--confirm-deletes`, `--debounce <ms>`. No daemon — stop with Ctrl-C |
| `status <dir> <bundle-dir>` | read-only per-file state porcelain (ADR-002): one `<state>\t<path>` line per file, sorted by path, states `in-log`, `pending-ingest`, `dirty`, `absent`, `foreign`; `--json` for the stable `{ path, state }` rows. Appends no ops, writes no files, touches no manifest |
| `wanted <dir>` | print the ranked demand index (`wanted/`): `<count>\t<path>\t<- <referrers>`, most-referenced first; `--json` for the structured rows |
| `flags <dir> [family]` | list/inspect the flag queue (`flag/`), optionally one family (`conflict`, `clobber`, `pathcollision`, `staletag`, `writeafterdelete`, `undelete`, `rejected`, `squat`, `copydetect`, …); `--json`. Nothing is ever lost silently (I4) |
| `compact <dir> <out-dir> [--force]` | generation-cycle compaction (§10): materialize the live bundle, init a fresh vault at `<out-dir>`, and ingest with `_id` adoption. Live state and identity survive; history is shed. Refuses while any `flag/conflict`/`flag/pathcollision` is open unless `--force`. The hydrated face is written to `<out-dir>.face` (override with `--face <dir>`). The predecessor is never deleted. `<out-dir>` must be new or empty, and the paths must not overlap (see [Compaction paths](#compaction-paths)). compact checks the fresh vault against the face and the predecessor's live state, and exits 1 on a difference (`COMPACT_FIDELITY`). The fresh vault is encrypted only with `--encryption-key <hex64>`: compaction never carries a key over. An encrypted vault needs `--encryption-key`: without it, `compact` refuses (`COMPACT_ENCRYPTION_KEY_REQUIRED`, exit 1), and no flag makes an unencrypted copy. The face holds the vault's contents as plaintext, and for an encrypted vault `compact` prints a `warning:` line that names it (see [Encryption and plaintext](#encryption-and-plaintext)) |
| `resolve <dir> <id> --keep <revHash> [--supersede <h>…] [--text <s>]` | resolve open body conflicts on `<id>`: pin the head to `--keep`, clearing the cited `flag/conflict` entries (§5). `--supersede` is repeatable |
| `undelete <dir> <id>` | restore a tombstoned concept (writes the `flag/undelete` audit, §8) |

There is no content-write command: content flows in through `ingest`/`watch`
(edit the markdown) or through the `@auto-okf/store` API (agents).

## Joining a vault

`join` prints this peer's own writer key. The store refuses every append
of the peer until autobee adds that key as a writer
(`okf/store/lib/bundle.js:791-799`). The ops of the peer take effect only
once an indexer admits the key with `add-writer`
(`okf/core/lib/apply.js:426`, `:526-534`):

```sh
$ auto-okf join ./peer <vault-key>
vault key:   6671cacb…
writer key:  0cf03548…
hand the writer key to an indexer (`auto-okf add-writer`), then replicate
with `auto-okf watch <dir> <bundle-dir> --swarm`

# on an indexer's replica
$ auto-okf add-writer ./vault 0cf03548…
```

Until the peer has replicated an `add-writer` op that names its key, the
store refuses every append on it (`VAULT_NOT_WRITABLE`,
`okf/store/lib/bundle.js:791-799`), and nothing is appended. `ingest`,
`add-writer`, `remove-writer`, `resolve` and `undelete` then exit 1 when
they would append an op. `watch` exits 1 the same way when its first scan
finds an edit. After that it prints each refusal as a `watch error:` line
and keeps watching. The CLI names the step:

```
auto-okf ingest: Not writable: autobee has not added this peer as a writer yet. Hand its writer key 0cf03548… to an indexer (`auto-okf add-writer`), then replicate and try again
```

The store gate reads substrate admission, not okf membership. Core grants
the key of every `add-writer` op that it folds, a rejected one too
(`okf/core/lib/apply.js:375`). So a writer that is not an indexer can make
the peer writable. The appends of the peer then go through, but apply
rejects each of its ops until an indexer admits it
(`okf/core/lib/apply.js:407-412`, `:426`).

## Per-file state: `status`

`auto-okf status ./vault ./bundle` answers the per-file state question
*before* you run anything — one `<state>\t<path>` line per file, sorted by
path, strictly read-only (it appends no ops, writes no files, touches no
manifest; ADR-002). Five states:

- `in-log` — on-disk bytes match the log's canonical projection (hash match)
- `pending-ingest` — hand-authored, not yet in the log; `ingest` would fold
  it in as a new concept
- `dirty` — in the log but on-disk bytes diverge from the projection (a hand
  edit `ingest` folds in as diffs, or a log that moved past the last
  `materialize`)
- `absent` — in the log, missing from disk (`materialize` would restore it)
- `foreign` — not in the log, not manifest-tracked, and not (yet) ingestable
  (e.g. another writer's mid-write WIP without a parseable `type`)

`--json` emits the same rows as a stable array of `{ path, state }` objects —
byte-identical across runs with no intervening ops (the schema is contract).

## Verifying content is in the log

`status` is the quick check: `in-log` means the on-disk bytes hash-match the
log's projection. For proof *from* the log, materialize to a scratch
directory — a vault has no privileged bundle directory; the emission manifest
(`.okf-manifest.json`) lives in each target directory, so materializing to
a scratch directory never disturbs another bundle:

```sh
$ mkdir ./scratch && auto-okf materialize ./vault ./scratch
```

An empty scratch dir that fills on materialize is proof the content is in
the log — everything that appears came from it.

## Encryption and plaintext

A vault made with `--encryption-key` is encrypted at rest. Two rules make
sure that its contents never become plaintext without a word:

- **Compaction never drops encryption.** `compact` of an encrypted vault
  needs `--encryption-key <hex64>` for the fresh vault. Without it, `compact`
  refuses with `COMPACT_ENCRYPTION_KEY_REQUIRED` and exits 1, before it
  creates or writes anything. No flag makes an unencrypted copy. Compaction
  never carries a key over, so you name the key of the new generation: the
  same key or a new one.
- **A plaintext write is announced.** `materialize` is the plaintext export.
  For an encrypted vault it prints this line on stderr, where `<dir>` is the
  bundle directory. The exit code does not change.

  ```
  warning: <dir>: now holds the contents of an encrypted vault as plaintext
  ```

  `compact` prints the same warning for its face (`<out-dir>.face`, or
  `--face <dir>`). It prints it also when the compaction fails after it
  wrote the face.

The face is the plaintext artifact that compaction leaves: it holds the
live contents of the vault as plaintext. Keep it as safe as the key, or
destroy it out-of-band. Compaction also writes two plaintext copies for its
own work: a staging copy (`<out-dir>.compact-src`) and a verification copy
beside it. It removes both, on success and on failure. It never removes a
staging directory that existed before it ran: it refuses to start (see
below).

## Compaction paths

`compact` normalizes a trailing slash on each path argument: `<out-dir>/`
names the same directory as `<out-dir>`, so the face `<out-dir>.face` and
the stage `<out-dir>.compact-src` stay siblings of the out-dir. Then it
checks its paths before it opens the predecessor, so a refusal leaves the
predecessor's bytes as they were. Each refusal exits 1, names the paths,
and writes nothing:

- `COMPACT_PATH_OVERLAP`: two of the predecessor, the out-dir, the face,
  the stage and the verification directory are the same directory, or one
  is inside another. The check follows symlinks.
- `COMPACT_OUT_DIR_NOT_EMPTY`: `<out-dir>` exists and is not an empty
  directory, for example an earlier generation. Give a new out-dir.
- `COMPACT_STAGE_EXISTS`: `<out-dir>.compact-src` exists, for example
  from a run that stopped. It can hold plaintext: examine it and remove
  it, or give another out-dir.

After the ingest, `compact` materializes the fresh vault into the
verification directory and compares it with the face (`_rev` lines and
`log.md` excluded), and it compares the live state of the fresh vault with
the predecessor's. A difference exits 1 with `COMPACT_FIDELITY`, which
names each difference, and `compact` removes what it wrote to
`<out-dir>`. On success it prints the note counts
(`notes: <n> walked, <n> staged, <n> ingested`) and a `fidelity:` line.

Known limitation: these checks run before compaction writes. Another
process that writes into the out-dir or the stage during a compaction can
still lose its files. The fix, a private build directory and an atomic
rename, is [#59](https://github.com/indexzero/hyperdown/issues/59).

## Exit codes

`0` success · `1` operational error (including a governance op that apply
rejected, or an unsafe path skipped during `materialize`) · `2` usage
error — unknown flags and commands, missing or extra arguments, and malformed
values all exit 2 (paparam parses strictly; the wrapper maps every parse
failure to 2) · `3` (`materialize` only) everything owned was projected but
human-authored file(s) were left in place pending ingest — a normal
multi-writer state, listed as `notice:` lines on stderr, not a failure
(ADR-004). `-h`/`--help` prints the paparam-generated help (top-level and
per command) and exits 0.

## Notes

- This release opens only vaults with metadata version 2 (`"version": 2`
  in `okf-vault.json`). Any other version exits 1 with
  `unsupported vault metadata version: <n>`. Vaults of an earlier release
  are not carried over.
- All commands operate on the local replica and return; only `watch` stays in
  the foreground (with `--swarm` it is also the replication process).
- `watch --swarm` announces the vault on the public hyperswarm DHT, on the
  `auto-okf/2` topic. Any peer that learns the vault key can connect, and
  an outsider with the key can still make members open writer cores (G44
  in [SECURITY_MODEL.md](../SECURITY_MODEL.md)).
- Governance commands verify their effect in the view after appending: if the
  issuing peer is not a confirmed indexer, apply rejects the op
  (`flag/rejected`, reason `policy-governance`) and the command exits 1 with
  the reason.
- The encryption key is needed at `init`/`join`, and at `compact` of an
  encrypted vault, for the fresh vault. The store pins the encrypted bit in
  vault metadata, and autobee keeps the key in the local core's user data,
  so a reopen needs no key.
- A single body may not exceed `maxOpBytes` — 65,536 bytes; `ingest` refuses
  an oversize file by name (exit 1, siblings unaffected) — split the document
  into smaller linked concepts.
- `auto-okf` refuses vault-ld storage by marker file (`vault-ld.json`),
  naming the right tool (exit 1, storage untouched); `autovault-ld` refuses
  `okf-vault.json` symmetrically — the twin CLIs never open each other's
  vaults (ADR-006).

## Tests

From the repo root: `pnpm test` (or `pnpm test:okf`). The CLI smoke suite
(`okf/test/cli.test.js`) spawns the real `auto-okf` binary against real
vaults on disk: init→materialize produces a bundle; a hand-authored file
ingests to the expected ops; path-scoped ingest folds only the named files;
`status` reports the five per-file states read-only; add-writer/remove-writer round trip; `wanted`
lists an unresolved link; `flags` lists a seeded conflict; `compact` refuses
on an open conflict and succeeds after `resolve`; `compact` refuses an
encrypted vault without `--encryption-key`, and with a key makes an
encrypted vault whose raw blocks lack the plaintext; `materialize` and
`compact` warn when they write an encrypted vault as plaintext; `compact`
leaves no staging or verification copy; `compact` refuses an existing stage,
a re-run into an existing generation and overlapping paths before it opens
the predecessor, and normalizes a trailing slash; an unadmitted peer
cannot issue `add-writer`; `undelete`
restores a tombstone; `watch` ingests a foreground edit and exits cleanly on SIGINT.
`okf/test/i11-roundtrip.test.js` also spawns `auto-okf compact`: it reports
its counts and its fidelity check, and exits 1 on `COMPACT_FIDELITY`.

## License

Apache-2.0
