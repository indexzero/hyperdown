# @auto-okf/cli

The `auto-okf` command line (SPEC §13). It runs
[`@auto-okf/store`](../store) and [`@auto-okf/faces`](../faces). The CLI
never writes the view or the bundle itself. Every effect goes through the
packages, so a library caller gets the same result.

[paparam](https://github.com/holepunchto/paparam) declares the commands
once, and generates all help text from those declarations.

## A working example

Create a vault, write a note by hand, ingest it, and materialize the
bundle:

```sh
# 1. Create a vault. This peer's key is the vault key, and this peer is
#    the genesis indexer.
$ auto-okf init ./vault
vault key:   6671cacb…
writer key:  6671cacb…
swarm key:   9e41d2a7…
storage:     ./vault
generation:  root
this peer is the genesis indexer (§8); to invite a peer, share the vault key and
vault/okf-vault.json (the invite: it lists the swarm keys every peer admits)

# 2. No command writes content. Write a note by hand:
$ mkdir -p ./bundle
$ cat > ./bundle/hello.md <<'EOF'
---
type: note
title: Hello
---
Read the [architecture](/guides/architecture) page first.
EOF

# 3. Ingest: the file enters the log as ops.
$ auto-okf ingest ./vault ./bundle
ingested hello.md: create-concept, set-field, set-body
ingest complete: 3 op(s) from 1 file(s)

# 4. Materialize: one .md file per live concept, plus index.md and log.md.
#    hello.md now holds its _id and its _rev.
$ auto-okf materialize ./vault ./bundle
materialized ./bundle: 3 written, 0 unchanged, 0 removed

# 5. The body links a page that nobody wrote. The demand index lists it.
$ auto-okf wanted ./vault
1	guides/architecture	<- 6671cacb…0
```

No command writes content. Content enters the log through `ingest` and
`watch`, or through the `@auto-okf/store` API. `ingest` and `materialize`
share an emission manifest, so `ingest` never turns a file that
`materialize` wrote into ops (SPEC §9, "The emission manifest").

## Install

```sh
pnpm add @auto-okf/cli    # or run the repo-local bin: okf/cli/bin/auto-okf.js
```

## Commands

| Command | Effect |
| --- | --- |
| `init <dir> [--encryption-key <hex64>] [--swarm-allow <hex64>]...` | Create a new vault at `<dir>`. |
| `join <dir> [vault-key] [--metadata <okf-vault.json>] [--encryption-key <hex64>] [--swarm-allow <hex64>]...` | Join an existing vault with its key and its invite. |
| `add-writer <dir> <writer-key> [--indexer] [--swarm-key <hex64>]` | Append an `AddWriter` op, and report its effect. |
| `remove-writer <dir> <writer-key>` | Append a `RemoveWriter` op, and report its effect. |
| `keys <dir>` | Print the vault key, the writer key and the swarm key. |
| `materialize <dir> <bundle-dir> [--force-mirror]` | Write the bundle of the vault to `<bundle-dir>`. |
| `ingest <dir> <bundle-dir> [paths...] [--confirm-deletes]` | Turn the edits under `<bundle-dir>` into ops, one time. |
| `watch <dir> <bundle-dir> [--swarm] [--bootstrap <host:port,...>] [--public-dht] [--confirm-deletes] [--debounce <ms>]` | Ingest edits while files change. With `--swarm`, also replicate. |
| `bootstrap --port <n> [--host <ipv4>]` | Run the bootstrap node of a private DHT. |
| `status <dir> <bundle-dir> [--json]` | Print the state of each file. |
| `wanted <dir> [--json]` | Print the ranked demand index (`wanted/`). |
| `flags <dir> [family] [--json]` | Print the flag queue (`flag/`), or one family. |
| `import <face-dir> <dir> [--metadata <okf-vault.json>] [--predecessor <vault-key>] [--encryption-key <hex64>]` | Create a new vault at `<dir>` from the notes of a bundle. |
| `resolve <dir> <id> --keep <revHash> [--supersede <revHash>]... [--text <string>]` | Resolve the open body conflicts of a concept. |
| `undelete <dir> <id>` | Restore a tombstoned concept. |

These rules hold for every command:

- Each key is 64 hex characters. A key of another shape is a usage error
  (exit 2).
- A command that needs a vault exits 1 on a `<dir>` that holds none, and
  names `init` and `join`.
- `watch` and `bootstrap` stay in the foreground until Ctrl-C. Every
  other command works on the local replica and returns.

### `init`

`init` prints the lines of the working example. `<dir>/okf-vault.json` is
the invite. Share it with the vault key.

- `--encryption-key <hex64>` encrypts the vault.
- `--swarm-allow <hex64>` pins one swarm key in the invite
  (`metadata.swarm.allow`). You can repeat the flag, with one key per
  value. The invite always pins the creator's own swarm key.
- A bad or repeated `--swarm-allow` key is a usage error (exit 2), before
  the store exists.
- `init` refuses a `<dir>` that already holds a vault (exit 1).

### `join`

[Joining a vault](#joining-a-vault) shows the lines that `join` prints.

- New storage needs `[vault-key]` and `--metadata`, the creator's
  `okf-vault.json`. Without one of them, `join` refuses by name (exit 2)
  and creates nothing.
- A `--metadata` file that is not metadata of this release fails by name,
  with its path (exit 1).
- A directory that the store API joined with the vault key alone fails
  `VAULT_JOINED_WITHOUT_INVITE` (exit 1). See the
  [store README](../store/README.md#api) for the reason and the repair.
- When `<dir>` already holds the vault, the key and `--metadata` are
  optional. `join` opens the vault and prints the keys again.
- `--encryption-key <hex64>` is the key of an encrypted vault.
- `--swarm-allow <hex64>` keeps a local list of swarm keys in
  `<dir>/okf-swarm-allow.json`. This peer alone admits and dials those
  keys, and `join` never writes them to the invite. You can repeat the
  flag. Each `join --swarm-allow` replaces the list.

### `add-writer` and `remove-writer`

Each command appends its op, and then reads the view. On success, each
prints one of these lines:

```
writer added: <writer-key> (indexer: <true|false>)
swarm key:   <hex64> (each peer's swarm firewall admits it once it folds this op)
writer removed: <writer-key> (causal revocation recorded, §8)
```

The `swarm key:` line follows `writer added:` when the record holds a
swarm key. apply rejects a governance op whose issuer is not an indexer
(`flag/rejected`, reason `policy-governance`, SPEC §8). The command then
exits 1, with the reason on stderr:

```
add-writer did not take effect (rejected: policy-governance); only a confirmed indexer may issue governance ops (§8)
```

The flags of `add-writer`:

- `--indexer` admits the writer as an indexer.
- `--swarm-key <hex64>` puts the swarm key of the writer on its
  `gov/writer` record. The firewall of each peer admits the key when the
  peer folds the op.
- `--swarm-key` is required unless the writer already has a bound swarm
  key: a `gov/writer` record that holds one. For the creator, the key
  that the invite binds (`metadata.swarm.genesis`) is a bound key too.
- Without a bound key and without the flag, `add-writer` refuses by name
  (exit 2) and appends nothing. A later `remove-writer` could not cut the
  swarm connection of that writer.
- The promotion of a bound writer needs no flag, because the record keeps
  its key.

`remove-writer` stops cooperating clients only. See SPEC §8,
"Revocation", and [SECURITY_MODEL.md](../SECURITY_MODEL.md), "The
eviction ladder".

### `keys`

`keys` prints the `vault key:`, `writer key:` and `swarm key:` lines of
`init`. For a `<dir>` that holds no vault, it prints the `swarm key:` line
only, and exits 0. The store derives that key from the corestore of the
directory, which `keys` creates when it is new. So each peer of a
pre-provisioned fleet can read its key before `init --swarm-allow`.

### `materialize`

`materialize` prints one line on stdout:

```
materialized <bundle-dir>: <n> written, <n> unchanged, <n> removed
```

It prints these lines on stderr, one for each file or value:

| Line | Exit code |
| --- | --- |
| `notice: pending ingest (unsaved external edit, left in place): <path>` | 3 |
| `notice: stale (no longer produced, left in place): <path>` | no change |
| `error: unsafe path (skipped, §9): <path> (<reason>)` | 1 |
| `warning: <path>: the face cannot hold the value of '<key>' (_id <id>): the vault holds <json>, the face holds <json>` | 1 |
| `warning: <bundle-dir>: now holds the contents of an encrypted vault as plaintext` | no change |

Exit 1 comes before exit 3. After the `the face cannot hold` lines,
`materialize` prints one `error:` line with their count. Fix each value in
the vault before `import`. SPEC §10, "What the bundle cannot hold", lists
those values.

For an encrypted vault, that warning names the `_id` only, because stderr
can reach a log. It prints no path, no key and no value:

```
warning: the face cannot hold a value of the concept with _id <id>; the path, the key and the values are not printed: the vault is encrypted
```

`--force-mirror` restores unconditional mirroring (SPEC §9, "The emission
manifest").

### `ingest`

`ingest` prints one line for each file that gave ops, and then a total:

```
ingested <path>: <op>, <op>
ingest complete: <n> op(s) from <n> file(s); <n> file(s) already up to date
```

The total holds its last clause only when `ingest` found unchanged files.

- `[paths...]` restricts the scan to those concept files, as paths
  relative to `<bundle-dir>` (ADR-001). The shell expands globs. Without
  paths, `ingest` scans the whole bundle.
- A named path that does not exist, that resolves outside the bundle
  root, or that is not a `.md` file exits 1. The error names the path,
  and `ingest` appends no op.
- `--confirm-deletes` lets a file that is gone from the disk emit a
  `DeleteConcept`. Without the flag, `ingest` prints
  `delete skipped (no --confirm-deletes): <path>` on stderr.

`ingest` exits 1 after each of these `error:` lines on stderr. Sibling
files still ingest.

```
error: notes/x.md: core rejected its set-body op (policy-namespace), and the file stays pending
error: other/x.md: core rejected its delete-concept op (policy-namespace), and the delete stays pending
error: drafts/big.md: its set-body op is 71,290 bytes encoded; maxOpBytes is 65,536
```

- The first line names the file, the op and the reason of core. `ingest`
  does not record that file, so it stays pending and `materialize` keeps
  it.
- The second line is a `DeleteConcept` that core rejected. `ingest`
  keeps the emission manifest entry of the deleted file, so the next
  `ingest --confirm-deletes` tries the delete again.
- The third line is the oversize preflight. A body travels in one
  `set-body` op, and the encoded op must not exceed `maxOpBytes` (65,536
  bytes by default). `ingest` refuses the file before it appends
  anything. Split the document into smaller linked concepts.

SPEC §9, "Ingest: preflight, pending files and scope", states what a
pending file keeps, and how `--confirm-deletes` deletes its concept.

### `watch` and `bootstrap`

`watch` scans the bundle one time, prints
`watching <bundle-dir> (foreground; Ctrl-C to stop)`, and then ingests
each edit. It prints the `ingested` line of `ingest` for each file. It is
not a daemon.

- `--confirm-deletes` works as for `ingest`. `--debounce <ms>` sets the
  quiet time for a path before `watch` reads it.
- An op that core rejects prints the `error:` line of `ingest`, and
  `watch` keeps running.
- `--swarm` also replicates over a private swarm. It needs exactly one
  DHT: `--bootstrap <host:port,...>`, the nodes of a private DHT, or
  `--public-dht`, the public DHT (the commons).
- Without either, `watch --swarm` refuses by name (exit 2), before it
  opens the vault. Both DHT flags, a DHT flag without `--swarm`, and a
  bad `--bootstrap` value are usage errors too.

With `--swarm`, `watch` prints these lines first. The `local allow:` line
shows only when the local list holds a key.

```
joined the private swarm on the vault's auto-okf/2 topic (bootstrap <host:port,...>)
swarm key:   <hex64> (the firewall admits only the keys of the invite, of live writers and of the local list)
local allow:  <n> key(s) from <dir>/okf-swarm-allow.json
```

With `--public-dht`, the first line is
`joined the public DHT (the commons) on the vault's auto-okf/2 topic`.

`bootstrap` runs a DHT bootstrap node (hyperdht `DHT.bootstrapper`), the
hub of a private DHT. `--port <n>` is required. `--host <ipv4>` is the
one address that the node binds. The default is `127.0.0.1`, so the
default node takes no packet from another machine. A missing or bad
value is a usage error (exit 2).

### `status`, `wanted` and `flags`

Each command prints one line for each row on stdout, and a count on
stderr. `--json` prints the rows as a JSON array.

| Command | Line |
| --- | --- |
| `status` | `<state>\t<path>`, sorted by path |
| `wanted` | `<count>\t<path>\t<- <referrers>`, most-referenced first |
| `flags` | `<key>\t<JSON value>` |

`status` is read-only (ADR-002): it appends no op, writes no file and
touches no manifest. The states are `in-log`, `pending-ingest`, `dirty`,
`absent` and `foreign`. SPEC §9, "Per-file state vocabulary (ADR-002)",
gives the meaning of each one. The `{ path, state }` rows of
`status --json` are a contract. Two runs with no op between them print
the same bytes.

`[family]` restricts `flags` to one family: `conflict`, `clobber`,
`pathcollision`, `staletag`, `writeafterdelete`, `undelete`, `rejected`
or `squat`. Nothing is ever lost silently (I4), so read this queue.

### `resolve` and `undelete`

`resolve` pins the head of `<id>` to `--keep`, and clears the
`flag/conflict` entries that it cites (SPEC §5). `--keep <revHash>` is
required: without it, `resolve` exits 2. You can repeat `--supersede`.
`--text <string>` gives a replacement body.

`undelete` restores a tombstoned concept, and apply writes the
`flag/undelete` audit record (SPEC §8).

On success, each command prints one of these lines:

```
resolved <id>: head := <revHash>; <n> conflict flag(s) still open on this concept
undeleted <id>: concept restored (audit flag/undelete recorded, §8)
```

Each command exits 1 when apply rejects its op, and prints the reason.
`undelete` also exits 1 when no concept has that `<id>`.

## Joining a vault

`join` prints the keys of this peer, and the next step:

```sh
$ auto-okf join ./peer <vault-key> --metadata okf-vault.json
vault key:   6671cacb…
writer key:  0cf03548…
swarm key:   9e41d2a7…
hand both keys to an indexer (`auto-okf add-writer <dir> <writer-key> --swarm-key <swarm-key>`),
then replicate with `auto-okf watch <dir> <bundle-dir> --swarm --bootstrap <host:port>`

# on the replica of an indexer
$ auto-okf add-writer ./vault 0cf03548… --swarm-key 9e41d2a7…
```

The store refuses every append of the peer (`VAULT_NOT_WRITABLE`) until
autobee adds its key as a writer. That needs a replicated `add-writer`
op that names the key. Until then, nothing is appended:

- `ingest`, `add-writer`, `remove-writer`, `resolve` and `undelete` exit
  1 when they would append an op.
- `watch` exits 1 the same way when its first scan finds an edit. After
  that scan, it prints each refusal as a `watch error:` line and keeps
  watching.

The CLI names the step:

```
auto-okf ingest: Not writable: autobee has not added this peer as a writer yet. Hand its writer key 0cf03548… to an indexer (`auto-okf add-writer`), then replicate and try again
```

Writable is not the same as admitted. The ops of the peer take effect
only once an indexer admits its key with `add-writer`. Core grants the
key of every `add-writer` op that it folds, a rejected one too. So a
writer that is not an indexer can make the peer writable, and apply then
rejects each op of the peer. See SPEC §8, "The grant, and admission
before effect".

## Private swarm

`watch --swarm` replicates over a private hyperswarm. The vault key is
not a capability to connect. Each peer has a persistent swarm key
(`keys`), and the firewall of each peer rejects every remote key except
these:

- The keys of the invite (`init --swarm-allow`).
- The swarm key of each live writer (`add-writer --swarm-key`).
- The keys of this peer's local list (`join --swarm-allow`).

A peer that holds the vault key and the invite, but no admitted swarm
key, never connects. See [okf/store/README.md](../store/README.md),
"Replication", for the rules of the allowlist.

### A private DHT

One `auto-okf bootstrap` node is the hub. Every peer passes its address
to `--bootstrap`:

```sh
$ auto-okf bootstrap --port 49737
bootstrap node: 127.0.0.1:49737 (foreground; Ctrl-C to stop)
peers replicate with: auto-okf watch <dir> <bundle-dir> --swarm --bootstrap 127.0.0.1:49737

$ auto-okf watch ./vault ./bundle --swarm --bootstrap 127.0.0.1:49737
```

For peers on more than one machine, run the node with
`--host <its IPv4 address>`. `--public-dht` uses the default bootstrap
nodes of hyperdht instead: the public DHT. You must ask for it by name.

### A late joiner

[Joining a vault](#joining-a-vault) shows the commands. The joiner needs
a peer of the invite online, such as the creator.

When no peer of the invite is online, the indexer that admits the joiner
hands it its own swarm key, with the invite. The joiner lists that key
with `--swarm-allow`:

```sh
# on the indexer: admit the joiner, and read the indexer's own swarm key
$ auto-okf add-writer ./indexer 0cf03548… --swarm-key 9e41d2a7…
$ auto-okf keys ./indexer
vault key:   6671cacb…
writer key:  b81e44d0…
swarm key:   7d3a90b4…

# on the joiner: list the swarm key of the indexer, then replicate
$ auto-okf join ./peer --swarm-allow 7d3a90b4…
vault key:   6671cacb…
writer key:  0cf03548…
swarm key:   9e41d2a7…
local allow:  7d3a90b4…
(this peer alone admits these keys: peer/okf-swarm-allow.json, never the invite)
$ auto-okf watch ./peer ./bundle --swarm --bootstrap 127.0.0.1:49737
```

`join` also prints the two lines of the next step, which this example
leaves out. Take the key only from the indexer, by the channel that
carries the invite. Never list a key that a discovery alone names.

### A pre-provisioned fleet

A pre-provisioned fleet needs no topic, because each peer dials every
key of the invite directly:

```sh
# on each peer of the fleet: the swarm key exists before the vault
$ auto-okf keys ./peer-1
swarm key:   9e41d2a7…

# the creator pins every key in the invite
$ auto-okf init ./vault --swarm-allow 9e41d2a7… --swarm-allow 52c0f1e8…

# each peer joins with the invite
$ auto-okf join ./peer-1 <vault-key> --metadata ./vault/okf-vault.json
```

`add-writer` needs `--swarm-key` for each writer of the fleet too. See
[`add-writer` and `remove-writer`](#add-writer-and-remove-writer).

## Verifying content is in the log

`status` is the fast answer: `in-log` says that the bytes on disk match
the log. For proof from the log, materialize to an empty directory:

```sh
$ mkdir ./scratch && auto-okf materialize ./vault ./scratch
```

Every file that appears there came from the log. A vault has no
privileged bundle directory. The emission manifest (`.okf-manifest.json`)
lives in each target directory, so this run never disturbs another
bundle.

## Encryption and plaintext

A vault made with `--encryption-key` is encrypted at rest. Two rules
make sure that its contents never become plaintext without a word. SPEC
§10 states both.

1. `materialize` is the plaintext export. For an encrypted vault it
   prints this line on stderr, and the exit code does not change:

   ```
   warning: <bundle-dir>: now holds the contents of an encrypted vault as plaintext
   ```

   It also writes the file `.okf-encrypted` at the root of
   `<bundle-dir>`.
2. `import` of a bundle that holds `.okf-encrypted` needs
   `--encryption-key <hex64>` for the new vault. Without a key it refuses
   with `IMPORT_ENCRYPTION_KEY_REQUIRED`, also without `--metadata`. With
   `--metadata` of an encrypted predecessor and no key, it refuses the
   same way.

A key is never carried over, so you name the key of the new generation:
the same key or a new one. `init`, `join` and `import` take the key. A
reopen needs no key.

That bundle holds the live contents of the vault as plaintext. Keep it as
safe as the key, or destroy it out-of-band after the import succeeds.
`import` writes no plaintext, so it prints no warning.

## Generations: materialize, then import

A generation reclaims bytes (SPEC §10). It is two commands, and the old
vault is never touched:

```sh
auto-okf flags ./vault conflict            # resolve open body conflicts first
auto-okf materialize ./vault ./face        # 1. the bundle of the live vault
#    (exit 1 names each value that the bundle cannot hold: fix it in
#    ./vault, then materialize again)
# 2. resolve in ./face what must not cross: give each conflicted copy
#    (*.conflict-<hex>.md) a path of its own, or merge it and remove it
auto-okf import ./face ./vault-e1 \
  --metadata ./vault/okf-vault.json \
  --predecessor <vault key of ./vault>      # 3. the new vault
#    (add --encryption-key <hex64> for the bundle of an encrypted vault:
#    import refuses that bundle without a key)
```

The bundle holds only the head body of each concept. So resolve each open
`flag/conflict` in the vault first, or the losing body stays behind in
the old vault.

- `<dir>` must be new or empty. `import` never writes to the bundle.
- `--metadata <okf-vault.json>` carries `limits`, `rate` and
  `schemaVersion` from the metadata of the predecessor. The file must be
  an `okf-vault.json` of this release, else `import` exits 1, by name.
- `--predecessor <vault-key>` records the key of the predecessor.
- `--encryption-key <hex64>` encrypts the new vault.
- A bad key or predecessor key is a usage error (exit 2).

On success, `import` prints the three key lines of `init`, and then:

```
storage:     <dir>
generation:  <generation namespace>
predecessor: <vault-key>
notes:       <n> read, <n> imported
fidelity:    every note of the new vault matches the face (_rev lines excluded; index.md and log.md not compared)
invite:      a joiner needs the vault key and <dir>/okf-vault.json (auto-okf join <dir> <vault-key> --metadata <that file>)
```

Without `--predecessor`, the `predecessor:` line reads
`(none: a root vault)`.

### What `import` refuses

A refusal prints `auto-okf import: <CODE>: <text>` on stderr and exits 1.
`import` refuses each of these by name, before it writes anything:

| Code | Cause |
| --- | --- |
| `IMPORT_DIR_NOT_EMPTY` | `<dir>` holds a vault, is not empty, or is not a directory |
| `IMPORT_DIR_CLAIMED` | another `import` holds `<dir>`, with the claim file `okf-import-claim` |
| `IMPORT_CONFLICT_COPY` | a `.conflict-<hex>` note: a path collision is still open |
| `IMPORT_RESERVED_NAME` | a note at a reserved `.okf-` name, or under such a directory |
| `IMPORT_MISSING_ID` | a note with no `_id`: give the note its `_id`, or remove it |
| `IMPORT_FACE_ENTRY` | an entry that is not a regular file or a directory, such as a symlink |
| `IMPORT_ENCRYPTION_KEY_REQUIRED` | an encrypted predecessor, and no `--encryption-key` |

Two imports into one `<dir>` never both run. The second refuses, and it
removes nothing that the first wrote.

`import` fails with one of these codes after it created the new vault:

| Code | Cause |
| --- | --- |
| `IMPORT_OVERSIZE` | an op is larger than `maxOpBytes` when encoded |
| `IMPORT_REJECTED` | apply rejected an op |
| `IMPORT_FIDELITY` | a note of the new vault is not equal to the note of the bundle |

`IMPORT_FIDELITY` names each difference. Before it, `import` prints a
`warning: <path>: <message>` line for each note that did not import, such
as one without `type`. So a successful `import` prints no warning.

On each failure, `import` removes what it created. A `<dir>` that existed
stays, empty. See SPEC §10, "Rules of import", for the claim file, the
fidelity check and the cleanup.

### After a signal

A signal such as Ctrl-C stops `import` before its cleanup.

- A signal before the store creates the vault leaves only the claim file
  in `<dir>`. A rerun refuses that `<dir>` with `IMPORT_DIR_CLAIMED`.
- A signal after it leaves a partial vault, with the claim file in
  `<dir>/db/`. A rerun refuses that `<dir>` with `IMPORT_DIR_NOT_EMPTY`.
- When no `import` runs, remove `<dir>` and run `import` again.

The bundle is never written. With `--encryption-key`, the partial vault
is encrypted too.

### The writers of the new vault

The new vault admits only the peer that ran `import` (SPEC §10, "Rules
of import").

1. Admit each writer of the new vault with
   `add-writer <dir> <writer-key> --swarm-key <hex64>`.
2. Leave out each key that you evict.
3. Give each joiner the new `okf-vault.json` as its `--metadata`. The
   joiner needs it to derive the same generation namespace.

See [SECURITY_MODEL.md](../SECURITY_MODEL.md), "The eviction ladder".

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | operational error |
| `2` | usage error |
| `3` | `materialize` only: pending ingest |

- Exit 1 includes a governance op that apply rejected, an op of `ingest`
  that core rejected, and an unsafe path that `materialize` skipped. It
  also includes a value that the bundle cannot hold, which `materialize`
  reports.
- Exit 2 covers unknown flags and commands, missing or extra arguments,
  and malformed values. paparam parses strictly, and the wrapper maps
  every parse failure to 2. `auto-okf` with no command prints the help
  and exits 2.
- Exit 3 says that `materialize` wrote all that it owns, and left in
  place the files that a person wrote and nobody ingested yet. That is a
  normal state with several writers, not a failure (ADR-004).
  `materialize` lists those files as `notice:` lines on stderr.
- `-h` and `--help` print the help that paparam generates, for the top
  level and for each command, and exit 0. `auto-okf help` prints the
  top-level help and exits 0.

## Notes

- This release opens only vaults with metadata version 2 (`"version": 2`
  in `okf-vault.json`). Any other version exits 1 with
  `unsupported vault metadata version: <n>`. Vaults of an earlier release
  are not carried over.
- With `--swarm`, `watch` is also the replication process.
- `watch --swarm` announces the vault on the `auto-okf/2` topic of the
  DHT that `--bootstrap` or `--public-dht` chooses. The firewall admits
  only the keys of its allowlist. So an outsider with the vault key gets
  no connection, and cannot start the writer-core flood.
- On the public DHT, a peer that knows the vault key can still look up
  the topic announcement. Each attempt of a rejected peer also costs a
  member a bounded amount of state. See
  [SECURITY_MODEL.md](../SECURITY_MODEL.md), "What the substrate decides,
  and what okf decides", point (b).
- `auto-okf` refuses vault-ld storage by its marker file
  (`vault-ld.json`). It names the right tool, exits 1 and leaves the
  storage untouched. `autovault-ld` refuses `okf-vault.json` the same
  way, so the two CLIs never open each other's vaults (ADR-006).

## Tests

From the repo root: `pnpm test` (or `pnpm test:okf`).
`okf/cli/test/commands.test.js` runs the real `auto-okf` binary against
vaults on disk. It tests the contract of each command: the arguments and
the usage errors, the exit codes, and the exact lines that a caller
parses. It does not test what a command does to a vault. The tests of
`@auto-okf/faces` and `@auto-okf/store` test that, in `okf/faces/test` and
`okf/store/test`.

## License

Apache-2.0
