# @hyperwiki/cli

The `hyperwiki` command line (SPEC-FINAL §13): a thin veneer over
[`@hyperwiki/store`](../store) (vault lifecycle, governance ops) and
[`@hyperwiki/faces`](../faces) (materialize, ingest watcher, Turtle export).
The CLI never writes the view or the face itself — every effect flows
through the packages, so anything it does is exactly what library callers do.

```sh
# create a vault; this peer's key is the vault key AND the genesis indexer
$ hyperwiki init ./storage
vault key:   6671cacb…
writer key:  6671cacb…

# a second machine joins by vault key and reports its writer key
$ hyperwiki join ./peer 6671cacb…
writer key:  c3392ab9…

# the indexer admits it (an ordinary logged AddWriter op, §8.0)
$ hyperwiki add-writer ./storage c3392ab9…
writer added: c3392ab9… (indexer: false)

# project the Obsidian-readable Markdown face, export the RDF
$ hyperwiki materialize ./storage ./wiki
materialized ./wiki: 14 written, 0 unchanged
$ hyperwiki export ./storage ./rdf --roundtrip
schema.ttl: 7 triple(s) (schema.ttl)
data.ttl:   40 triple(s) (data.ttl)

# stay in the foreground: ingest human edits, replicate over hyperswarm
$ hyperwiki watch ./storage ./wiki --swarm
watching ./wiki (foreground; Ctrl-C to stop)
ingested Home.md: set-field
```

## Install

```sh
pnpm add @hyperwiki/cli    # or run the repo-local bin: packages/cli/bin/hyperwiki.js
```

## Commands

| command | what it does |
| --- | --- |
| `init <storage>` | create a new vault at `<storage>`; prints the vault key (share it to invite peers) and this peer's writer key; refuses storage that is already pinned |
| `join <storage> <vault-key>` | join an existing vault by key; `--metadata <invite.json>` and `--encryption-key <hex64>` carry non-default invites; with pinned storage the key is optional (reopen + reprint keys) |
| `add-writer <storage> <writer-key> [--indexer]` | append an `AddWriter` governance op; reports whether it took effect (apply rejects issuers that are not confirmed indexers, §8.0) |
| `remove-writer <storage> <writer-key>` | append a `RemoveWriter` op; revocation is causal, not positional (§8.3) |
| `materialize <storage> <dir>` | project the Markdown/Obsidian face; prints written/unchanged counts, and reports pending-ingest, unsafe-path, and stale files on stderr (§9.1/§9.4) |
| `export <storage> <dir> [--roundtrip]` | write `schema.ttl` + `data.ttl` (§10); `--roundtrip` emits `vld:path` for notes off their default location (§10.4) |
| `flags <storage> [family] [--json]` | list/inspect the flag queue (`flag/`), optionally one family (`conflict`, `clobber`, `dangling`, `unmapped`, `rejected`, …); nothing is ever lost silently (I4) |
| `watch <storage> <dir> [--swarm] [--confirm-deletes] [--debounce <ms>]` | foreground ingest watcher: human edits under `<dir>` re-enter the log as minimal semantic ops (§9.2); `--swarm` joins the vault's hyperswarm topic for replication; `--confirm-deletes` allows deleted files to emit `DeleteSubject` (without it, deletions are skipped and reported). No daemon — stop with Ctrl-C |

There is no content-write command: content flows in through the ingest
watcher (edit the Markdown) or through the `@hyperwiki/store` API (agents).

## Exit codes

`0` success · `1` operational error (including a governance op that apply
rejected) · `2` usage error. `-h`/`--help` prints usage.

## Notes

- All commands operate on the local replica and return; only `watch` stays
  in the foreground (with `--swarm` it is also the replication process).
- Governance commands verify their effect in the view after appending: if
  the issuing peer is not a confirmed indexer, the op is rejected by apply
  (`flag/rejected/...`, reason `policy-governance`) and the command exits 1
  with the reason.
- The encryption key is only needed at `init`/`join`; autobee pins it in the
  local core's user data and the metadata pin restores the encrypted bit on
  reopen.

## Tests

From the repo root: `pnpm test`. The CLI smoke suite (`test/cli.test.js`)
spawns the real binary against real vaults on disk.

## License

Apache-2.0
