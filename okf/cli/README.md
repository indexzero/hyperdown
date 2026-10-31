# @auto-okf/cli

The `auto-okf` command line (okf SPEC §13): a thin veneer over
[`@auto-okf/store`](../store) (vault lifecycle + §8 governance ops) and
[`@auto-okf/faces`](../faces) (materialize, ingest watcher, the `wanted/`
demand index, the import of a face into a new vault). The CLI never writes the view or the
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
| `init <dir>` | create a new vault at `<dir>`; prints the vault key, this peer's writer key and swarm key, and the generation namespace; refuses a dir already pinned. `<dir>/okf-vault.json` is the invite: share it with the vault key. `--swarm-allow <hex64>` (repeatable, one key per value, as for `join`) pins each key in the invite (`metadata.swarm.allow`); the creator's own swarm key is always pinned. A bad or repeated key is a usage error (exit 2) before the store exists. See [Private swarm](#private-swarm) |
| `join <dir> <vault-key> --metadata <okf-vault.json>` | join an existing vault by key, with its invite: the creator's `okf-vault.json`. Fresh storage needs `--metadata`. Without it `join` refuses by name (exit 2) and creates nothing: the vault key alone pins metadata that is not the creator's, with no swarm key of the invite, and pinned metadata never changes. A `--metadata` file that is not metadata of this release fails by name, with its path (exit 1). A directory that the store API joined with the vault key alone refuses the invite later with `VAULT_JOINED_WITHOUT_INVITE` (exit 1): join again in a new directory with the invite. `--encryption-key <hex64>` carries the encryption key; when `<dir>` is already pinned the key and `--metadata` are optional (reopen + reprint keys). `--swarm-allow <hex64>` (repeatable) keeps a local list of swarm keys in `<dir>/okf-swarm-allow.json` that this peer alone admits and dials, such as the key of the indexer that admitted it; it is never written to the invite, and each `join --swarm-allow` replaces the list (see [Private swarm](#private-swarm)). A joined peer appends nothing until autobee adds it as a writer (`VAULT_NOT_WRITABLE`, `okf/store/lib/bundle.js:915-923`), and its ops take effect only once an indexer admits it (`okf/core/lib/apply.js:426`): hand the printed writer key and swarm key to an indexer (`add-writer --swarm-key`), then replicate (`watch --swarm --bootstrap`). See [Joining a vault](#joining-a-vault) |
| `add-writer <dir> <writer-key> [--indexer] [--swarm-key <hex64>]` | append an `AddWriter` governance op; reports whether it took effect (apply rejects issuers that are not confirmed indexers, §8). An `add-writer` that apply rejects still grants the key at the substrate (`okf/core/lib/apply.js:375`): the key becomes writable, and apply rejects each of its ops (see [Joining a vault](#joining-a-vault)). `--swarm-key` puts the writer's swarm key on its `gov/writer` record, and the swarm firewall of every peer admits it once it folds the op. `--swarm-key` is required unless the writer already has a bound swarm key: a `gov/writer` record that carries one, or, for the creator, the key that the invite binds (`metadata.swarm.genesis`). Without it, `add-writer` refuses by name (exit 2) and appends nothing, because a later `remove-writer` could not cut the writer's swarm connection. A promotion of a bound writer needs no flag: the record keeps its key |
| `keys <dir>` | print the vault key, this peer's writer key and its swarm key. A `<dir>` without a vault prints the swarm key only: it already exists (the store derives it from the directory's corestore, which `keys` creates when it is new), so a pre-provisioned fleet can collect every key before `init --swarm-allow` |
| `remove-writer <dir> <writer-key>` | append a `RemoveWriter` op; revocation is causal, never positional (§8). It stops cooperating clients only: a revoked key with a modified client can keep writing until the next generation. Each peer that folds the op takes the writer's bound swarm key out of its allowlist: the key on its record, or the creator's key that the invite binds. The full eviction is a new generation (see [SECURITY_MODEL.md](../SECURITY_MODEL.md), the eviction ladder) |
| `materialize <dir> <bundle-dir>` | project the OKF v0.1 bundle (concepts + per-dir `index.md` + root `log.md`); prints written/unchanged/removed counts; pending-ingest and stale files are `notice:` lines on stderr, unsafe paths `error:` lines. Exits 3 when everything owned was projected but human-authored file(s) are pending ingest (N3); an unsafe path is a real failure, exit 1. A value that the face cannot hold (a scalar `null`, a second `type` value, a reference or an object) is a `warning:` line that names the note, the key and the `_id`, then an `error:` line, and exit 1: fix it in the vault before `import` (SPEC §10). For an encrypted vault the line holds no value. `--force-mirror` restores unconditional mirroring. `materialize` is the plaintext export: for an encrypted vault it prints a `warning:` line that names `<bundle-dir>`, and the exit code does not change (see [Encryption and plaintext](#encryption-and-plaintext)) |
| `ingest <dir> <bundle-dir> [paths…]` | one-shot: fold on-disk edits under `<bundle-dir>` back into the log as minimal ops (§9). Trailing bundle-relative paths restrict the scan to exactly those concept files (ADR-001 — concurrent-writer politeness; the shell expands globs): a named path that does not exist, escapes the bundle root, or is not a `.md` file exits 1 naming the path, with zero ops appended. Zero paths = full scan, unchanged. `--confirm-deletes` lets a file deleted on disk emit `DeleteConcept` (off by default). Each op that core rejects is an `error:` line on stderr that names the file, the op and core's reason, for example `error: notes/x.md: core rejected its set-body op (policy-namespace), and the file stays pending`, and the run exits 1. Ingest does not record such a file, so it stays pending, and `materialize` keeps it. A new file that stays pending keeps the concept that its ingest created: `<bundle-dir>/.okf-pending.json` records it, and a later ingest reuses it. A `DeleteConcept` that core rejects is such a line too, and it ends `and the delete stays pending`: ingest keeps the emission manifest entry of the deleted file, so the next `ingest --confirm-deletes` tries the delete again. Sibling files still ingest |
| `watch <dir> <bundle-dir> [--swarm --bootstrap <host:port,...> \| --swarm --public-dht]` | foreground ingest watcher: human edits re-enter as ops as files change; `--swarm` also replicates over a swarm whose firewall admits only the keys of the invite, the swarm keys of live writers and the local list of `join --swarm-allow` (see [Private swarm](#private-swarm)). `--swarm` needs exactly one DHT: `--bootstrap`, the nodes of a private DHT (`auto-okf bootstrap`), or `--public-dht`, the public DHT (the commons). Without either, `watch --swarm` refuses by name (exit 2) before it opens the vault. `--confirm-deletes`, `--debounce <ms>`. An op that core rejects prints the `error:` line of `ingest`, and `watch` keeps running. No daemon — stop with Ctrl-C |
| `bootstrap --port <n> [--host <ipv4>]` | run a DHT bootstrap node (hyperdht `DHT.bootstrapper`) in the foreground until Ctrl-C: the hub of a private DHT. It binds `<host>` only, default `127.0.0.1`, so the default node takes no packet from another machine. Peers pass `--bootstrap <host>:<n>` |
| `status <dir> <bundle-dir>` | read-only per-file state porcelain (ADR-002): one `<state>\t<path>` line per file, sorted by path, states `in-log`, `pending-ingest`, `dirty`, `absent`, `foreign`; `--json` for the stable `{ path, state }` rows. Appends no ops, writes no files, touches no manifest |
| `wanted <dir>` | print the ranked demand index (`wanted/`): `<count>\t<path>\t<- <referrers>`, most-referenced first; `--json` for the structured rows |
| `flags <dir> [family]` | list/inspect the flag queue (`flag/`), optionally one family (`conflict`, `clobber`, `pathcollision`, `staletag`, `writeafterdelete`, `undelete`, `rejected`, `squat`, `copydetect`, …); `--json`. Nothing is ever lost silently (I4) |
| `import <face-dir> <dir>` | a generation's second step (§10): create a new vault at `<dir>` and fill it from the notes of a face, such as one that `materialize` wrote, with `_id` adoption. Live state and identity survive; history is shed. `<dir>` must be new or empty. `--metadata <okf-vault.json>` carries `limits`, `rate` and `schemaVersion` from the predecessor's metadata, and never the swarm allowlist; `--predecessor <vault-key>` records the predecessor; `--encryption-key <hex64>` encrypts the new vault. import refuses a face that holds a conflicted copy, and checks the new vault against the face (`IMPORT_FIDELITY`, exit 1). The face is never written. See [Generations](#generations-materialize-then-import) |
| `resolve <dir> <id> --keep <revHash> [--supersede <h>…] [--text <s>]` | resolve open body conflicts on `<id>`: pin the head to `--keep`, clearing the cited `flag/conflict` entries (§5). `--supersede` is repeatable |
| `undelete <dir> <id>` | restore a tombstoned concept (writes the `flag/undelete` audit, §8) |

There is no content-write command: content flows in through `ingest`/`watch`
(edit the markdown) or through the `@auto-okf/store` API (agents).

## Joining a vault

`join` prints this peer's own writer key and swarm key. The store refuses
every append of the peer until autobee adds that key as a writer
(`okf/store/lib/bundle.js:915-923`). The ops of the peer take effect only
once an indexer admits the key with `add-writer`
(`okf/core/lib/apply.js:426`, `:554-575`):

```sh
$ auto-okf join ./peer <vault-key> --metadata okf-vault.json
vault key:   6671cacb…
writer key:  0cf03548…
swarm key:   9e41d2a7…
hand both keys to an indexer (`auto-okf add-writer <dir> <writer-key> --swarm-key <swarm-key>`),
then replicate with `auto-okf watch <dir> <bundle-dir> --swarm --bootstrap <host:port>`

# on an indexer's replica
$ auto-okf add-writer ./vault 0cf03548… --swarm-key 9e41d2a7…
```

Until the peer has replicated an `add-writer` op that names its key, the
store refuses every append on it (`VAULT_NOT_WRITABLE`,
`okf/store/lib/bundle.js:915-923`), and nothing is appended. `ingest`,
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

## Private swarm

`watch --swarm` replicates over a private hyperswarm. The vault key is not
a capability to connect. Each peer has a persistent swarm key (`keys`),
and the swarm firewall of each peer rejects every remote key except:

- the keys of the invite, `metadata.swarm.allow`,
- the swarm key on each `gov/writer` record that has no `gov/removed`
  record (`add-writer --swarm-key`), and
- the keys of this peer's local list (`join --swarm-allow`), which no
  other peer admits.

The bound swarm key of a removed writer leaves the allowlist when a peer
folds the `remove-writer`, also after a reopen, also when the invite or
the local list names the key, and also when another, live `gov/writer`
record carries it. Its open connections close. The bound key is the key
on the writer's record (`add-writer --swarm-key`), and for the creator
the key that the invite binds to the vault key (`metadata.swarm.genesis`,
which `init` writes). So a removal of the creator cuts it too. A peer that holds the vault key and the invite, but no
admitted swarm key, never connects (`okf/test/store-swarm.test.js`).

**A private DHT.** One `auto-okf bootstrap` node is the hub. Every peer
passes its address to `--bootstrap`:

```sh
$ auto-okf bootstrap --port 49737
bootstrap node: 127.0.0.1:49737 (foreground; Ctrl-C to stop)

$ auto-okf watch ./vault ./bundle --swarm --bootstrap 127.0.0.1:49737
```

For peers on more than one machine, run the node with
`--host <its IPv4 address>`. `--public-dht` uses hyperdht's default
bootstrap nodes instead: the public DHT, which hyperdht describes as
"publicly served on behalf of the commons". It is explicit opt-in.

**A late joiner.** The joiner runs `join --metadata okf-vault.json` and
hands its writer key and swarm key to an indexer, who runs
`add-writer <dir> <writer-key> --swarm-key <swarm-key>`. Each peer admits
the joiner when it folds the `add-writer`, and finds it on the vault's
`auto-okf/2` topic. The joiner holds no `gov/writer` record before it
connects, so its firewall admits only the keys of the invite. The
creator's swarm key is always there. So the joiner needs a peer of the
invite online, or it never learns its admission.

When no peer of the invite is online, for example when the creator is
offline and another indexer admits the joiner, the recovery is this: the
admitting indexer hands the joiner its swarm key with the invite, and the
joiner lists that key with `--swarm-allow`. `watch --swarm` then admits and
dials it, on this peer only:

```sh
# on the joiner: join, and hand both keys to the indexer
$ auto-okf join ./peer <vault-key> --metadata okf-vault.json
writer key:  0cf03548…
swarm key:   9e41d2a7…

# on the admitting indexer: admit the joiner, and read its own swarm key
$ auto-okf add-writer ./indexer 0cf03548… --swarm-key 9e41d2a7…
$ auto-okf keys ./indexer
swarm key:   7d3a90b4…

# on the joiner: list the indexer's swarm key, then replicate
$ auto-okf join ./peer --swarm-allow 7d3a90b4…
local allow:  7d3a90b4…
$ auto-okf watch ./peer ./bundle --swarm --bootstrap 127.0.0.1:49737
```

Take the key only from the indexer, by the channel that carries the
invite. Never list a key that a discovery alone names.

**A pre-provisioned fleet.** A pre-provisioned fleet needs no topic:

```sh
# on each peer of the fleet: the swarm key exists before the vault
$ auto-okf keys ./peer-1
swarm key:   9e41d2a7…

# the creator pins every key in the invite
$ auto-okf init ./vault --swarm-allow 9e41d2a7… --swarm-allow 52c0f1e8…

# each peer joins with the invite
$ auto-okf join ./peer-1 <vault-key> --metadata ./vault/okf-vault.json
```

Each peer then dials every listed key directly (hyperswarm `joinPeer`), so
the fleet connects without a topic announcement. `watch --swarm` still
joins the topic for writers that join later. The invite binds only the
creator's key to a writer key, so `add-writer` needs `--swarm-key` for
each writer of the fleet too. A later `remove-writer` then takes its
swarm key out of every allowlist.

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

- **A generation never drops encryption.** The import of a generation of
  an encrypted vault needs `--encryption-key <hex64>` for the new vault.
  With `--metadata` of an encrypted predecessor and no key, `import`
  refuses with `IMPORT_ENCRYPTION_KEY_REQUIRED` and exits 1, before it
  creates or writes anything. No flag makes an unencrypted copy. A key is
  never carried over, so you name the key of the new generation: the same
  key or a new one.
- **A plaintext write is announced.** `materialize` is the plaintext export.
  For an encrypted vault it prints this line on stderr, where `<dir>` is the
  bundle directory. The exit code does not change.

  ```
  warning: <dir>: now holds the contents of an encrypted vault as plaintext
  ```

The face of a generation is that plaintext export: it holds the live
contents of the vault as plaintext. Keep it as safe as the key, or
destroy it out-of-band once the import succeeded. `import` reads the face
and writes no plaintext: no stage, no verification copy and no side file
in `<dir>`, so it prints no warning.

## Generations: materialize, then import

A generation reclaims bytes (SPEC §10). It is two commands, and the old
vault is never touched:

```sh
auto-okf flags ./vault conflict            # resolve open body conflicts first
auto-okf materialize ./vault ./face        # 1. the face of the live vault
#    (exit 1 names each value that the face cannot hold: fix it in
#    ./vault, then materialize again)
# 2. resolve in ./face what must not cross: give each conflicted copy
#    (*.conflict-<hex>.md) a path of its own, or merge it and remove it
auto-okf import ./face ./vault-e1 \
  --metadata ./vault/okf-vault.json \
  --predecessor <vault key of ./vault>      # 3. the new vault
```

`import` refuses, by name and before it writes anything (exit 1):

- `IMPORT_DIR_NOT_EMPTY`: `<dir>` is a vault (`okf-vault.json` exists), is
  not empty, or is not a directory. Give a new `<dir>`.
- `IMPORT_CONFLICT_COPY`: the face holds a `.conflict-<hex>` note, so a
  path collision is still open. Resolve it in the face.
- `IMPORT_RESERVED_NAME`: the face holds a note at a reserved `.okf-` name.
- `IMPORT_FACE_ENTRY`: the face holds an entry that is not a regular file
  or a directory, such as a symlink.
- `IMPORT_ENCRYPTION_KEY_REQUIRED`: see above.
- `IMPORT_DIR_CLAIMED`: another `import` holds `<dir>`. Before it creates
  the vault, `import` creates the claim file `okf-import-claim` in `<dir>`
  with an exclusive open, and it removes the claim when it ends. So two
  imports into one `<dir>` never both run: the second refuses, and it
  removes nothing that the first wrote.

A bad key or predecessor key is a usage error (exit 2). `--metadata` must
be an `okf-vault.json` of this release, else exit 1, by name.

Then `import` reads every `.md` note of the face, dot paths included, and
imports it with `_id` adoption. It ignores the emission manifest and every
`_rev` line. An op larger than `maxOpBytes` when encoded fails with
`IMPORT_OVERSIZE`, and an op that apply rejects fails with
`IMPORT_REJECTED`. After the import, the notes of the new vault must equal
the notes of the face, byte for byte, without `_rev` lines (`index.md` and
`log.md` are not compared). A difference exits 1 with `IMPORT_FIDELITY`,
which names each difference. On each failure, `import` removes only what
it created while it held the claim: the entries that it wrote in `<dir>`,
the claim, and `<dir>` itself when `import` made it. An existing empty
`<dir>` stays, empty. On success it prints
the note counts
(`notes: <n> read, <n> imported`), a `fidelity:` line, and the file that a
joiner passes as `--metadata`: a joiner of the new vault needs it to derive
the same generation namespace.

The face holds the head body of each concept only. So resolve each open
`flag/conflict` in the vault before you materialize the face, or the
losing body stays behind in the old vault.

A generation is the eviction point, so `--metadata` never carries the
swarm allowlist (`metadata.swarm.allow`) into the new vault
(`okf/faces/lib/import.js:44`). The invite of the new vault lists only
the swarm key of the peer that ran `import`. Admit each writer of the new
vault with `add-writer <dir> <writer-key> --swarm-key <hex64>`, and leave
out each key that you evict. Each joiner needs the new `okf-vault.json`
as its `--metadata`.

A signal such as Ctrl-C stops `import` before its cleanup, so `<dir>` can
keep a partial vault and the claim. A rerun refuses that `<dir>` by name
(`IMPORT_DIR_NOT_EMPTY`, or `IMPORT_DIR_CLAIMED` when only the claim
stays): when no `import` runs, remove `<dir>` and run `import` again. The
face is never written, and with `--encryption-key` the partial vault is
encrypted too.

## Exit codes

`0` success · `1` operational error (including a governance op that apply
rejected, an op of `ingest` that core rejected, an unsafe path skipped
during `materialize`, or a value that the face cannot hold, reported by
`materialize`) · `2` usage
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
- All commands operate on the local replica and return; only `watch` and
  `bootstrap` stay in the foreground (with `--swarm`, `watch` is also the
  replication process).
- `watch --swarm` announces the vault on the `auto-okf/2` topic of the DHT
  that `--bootstrap` or `--public-dht` chooses. The firewall admits only
  the keys of its allowlist, so an outsider with the vault key gets no connection
  and cannot reach autobee's wakeup protocol (G44 in
  [SECURITY_MODEL.md](../SECURITY_MODEL.md)). On the public DHT, a peer
  that knows the vault key can still look up the topic announcement. It
  names the swarm keys of the announcing peers and the DHT nodes that
  relay to them. Each attempt of a rejected peer also costs a member one
  handshake message, hyperdht's record of the attempt for 10 s, and a ban
  record that the store bounds at 64 (the oldest ban is lifted first, and
  the firewall still rejects that key).
- Governance commands verify their effect in the view after appending: if the
  issuing peer is not a confirmed indexer, apply rejects the op
  (`flag/rejected`, reason `policy-governance`) and the command exits 1 with
  the reason.
- The encryption key is needed at `init`/`join`, and at `import` of a
  generation of an encrypted vault, for the new vault. The store pins the
  encrypted bit in vault metadata, and autobee keeps the key in the local
  core's user data, so a reopen needs no key.
- A body travels in one `set-body` op, and the encoded op may not exceed
  `maxOpBytes` (65,536 bytes by default). The op is the body plus its
  `_id`, its base and its clock, and the clock grows with each admitted
  writer (SPEC §8). `ingest` encodes the op before it appends anything
  (`okf/faces/lib/ingest.js:355-359`), and
  refuses an oversize file by name (exit 1, siblings unaffected). Split
  the document into smaller linked concepts. Test: "the oversize preflight
  encodes the set-body op: a body just below maxOpBytes whose op is over
  it appends nothing and stays pending (D-048 F02)".
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
lists an unresolved link; `flags` lists a seeded conflict, and after
`resolve` a generation runs as `materialize`, then `import`; `materialize`
exits 1 and names each value that the face cannot hold, without the value
for an encrypted vault; `materialize` warns when it writes an encrypted
vault as plaintext, before the first plaintext write; `import` prints its counts and its fidelity check, writes
nothing to the face, carries `--metadata` and records `--predecessor`;
`import --encryption-key` makes a vault in which no file holds the
plaintext of the face, checked against an unencrypted control, and prints
no warning; `import` refuses a pinned or non-empty `<dir>`, a vault-ld
`<dir>`, a face with an open collision, a missing face, and an encrypted
predecessor without a key, before it writes; its usage errors exit 2;
`IMPORT_FIDELITY` names every difference; an unadmitted peer cannot issue
`add-writer`; `undelete` restores a tombstone; `watch` ingests a foreground
edit and exits cleanly on SIGINT;
`keys` prints the writer key and the swarm key, and the swarm key before a
vault exists; `init --swarm-allow` pins every key, and refuses a bad or repeated key before the store exists; `add-writer --swarm-key`
puts the key on `gov/writer`, and `add-writer` refuses a writer with no
bound swarm key; `join` refuses fresh storage without the invite, reads
the invite by name, and a directory that joined without it refuses it
later by name; `join --swarm-allow` keeps a local list apart
from the invite, and refuses a bad or repeated key; `watch --swarm` refuses
by name without `--bootstrap` or `--public-dht`; `bootstrap` refuses a bad
port or host, and runs a node through which `watch --swarm --bootstrap`
replicates to an admitted peer; with the local list of `join
--swarm-allow`, a late joiner whose creator is offline connects to the
admitting indexer and becomes writable.

## License

Apache-2.0
