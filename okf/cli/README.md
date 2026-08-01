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
generation:  root

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
| `join <dir> <vault-key>` | join an existing vault by key; `--encryption-key <hex64>` and `--metadata <invite.json>` carry non-default invites; when `<dir>` is already pinned the key is optional (reopen + reprint keys) |
| `add-writer <dir> <writer-key> [--indexer]` | append an `AddWriter` governance op; reports whether it took effect (apply rejects issuers that are not confirmed indexers, §8) |
| `remove-writer <dir> <writer-key>` | append a `RemoveWriter` op; revocation is causal, never positional (§8) |
| `materialize <dir> <bundle-dir>` | project the OKF v0.1 bundle (concepts + per-dir `index.md` + root `log.md`); prints written/unchanged/removed counts; pending-ingest and stale files are `notice:` lines on stderr, unsafe paths `error:` lines. Exits 3 when everything owned was projected but human-authored file(s) are pending ingest (N3); an unsafe path is a real failure, exit 1. `--force-mirror` restores unconditional mirroring |
| `ingest <dir> <bundle-dir>` | one-shot: fold on-disk edits under `<bundle-dir>` back into the log as minimal ops (§9); `--confirm-deletes` lets a file deleted on disk emit `DeleteConcept` (off by default) |
| `watch <dir> <bundle-dir> [--swarm]` | foreground ingest watcher: human edits re-enter as ops as files change; `--swarm` also joins the vault's hyperswarm topic for replication; `--confirm-deletes`, `--debounce <ms>`. No daemon — stop with Ctrl-C |
| `wanted <dir>` | print the ranked demand index (`wanted/`): `<count>\t<path>\t<- <referrers>`, most-referenced first; `--json` for the structured rows |
| `flags <dir> [family]` | list/inspect the flag queue (`flag/`), optionally one family (`conflict`, `clobber`, `pathcollision`, `staletag`, `writeafterdelete`, `undelete`, `rejected`, `squat`, `copydetect`, …); `--json`. Nothing is ever lost silently (I4) |
| `compact <dir> <out-dir> [--force]` | generation-cycle compaction (§10): materialize the live bundle, init a fresh vault at `<out-dir>`, and ingest with `_id` adoption. Live state and identity survive; history is shed. Refuses while any `flag/conflict`/`flag/pathcollision` is open unless `--force`. The hydrated face is written to `<out-dir>.face` (override with `--face <dir>`). The predecessor is never deleted |
| `resolve <dir> <id> --keep <revHash> [--supersede <h>…] [--text <s>]` | resolve open body conflicts on `<id>`: pin the head to `--keep`, clearing the cited `flag/conflict` entries (§5). `--supersede` is repeatable |
| `undelete <dir> <id>` | restore a tombstoned concept (writes the `flag/undelete` audit, §8) |

There is no content-write command: content flows in through `ingest`/`watch`
(edit the markdown) or through the `@auto-okf/store` API (agents).

## Verifying content is in the log

A vault has no privileged bundle directory; the emission manifest
(`.okf-manifest.json`) lives in each target directory, so materializing to
a scratch directory never disturbs another bundle:

```sh
$ mkdir ./scratch && auto-okf materialize ./vault ./scratch
```

An empty scratch dir that fills on materialize is proof the content is in
the log — everything that appears came from it.

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

- All commands operate on the local replica and return; only `watch` stays in
  the foreground (with `--swarm` it is also the replication process).
- Governance commands verify their effect in the view after appending: if the
  issuing peer is not a confirmed indexer, apply rejects the op
  (`flag/rejected`, reason `policy-governance`) and the command exits 1 with
  the reason.
- The encryption key is only needed at `init`/`join`; the store pins the
  encrypted bit in vault metadata so a reopen needs no key.

## Tests

From the repo root: `pnpm test` (or `pnpm test:okf`). The CLI smoke suite
(`okf/test/cli.test.js`) spawns the real `auto-okf` binary against real
vaults on disk: init→materialize produces a bundle; a hand-authored file
ingests to the expected ops; add-writer/remove-writer round trip; `wanted`
lists an unresolved link; `flags` lists a seeded conflict; `compact` refuses
on an open conflict and succeeds after `resolve`; `undelete` restores a
tombstone; `watch` ingests a foreground edit and exits cleanly on SIGINT.

## License

Apache-2.0
