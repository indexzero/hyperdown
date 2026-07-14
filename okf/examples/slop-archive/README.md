# slop-archive — deletion is dangerous, so make it impossible

A durable, append-only archive for long-running LLM output — the charlie.dev
`slop/` + `ctx/` pattern — that must never be `rm -rf`'ed by an agent or lost
in `/tmp`. The **append-only vault is the structural guarantee**.

```sh
node okf/examples/slop-archive/archive.js   # from the repo root, after pnpm install
```

## Deletion is dangerous

An agent working a long session accumulates raw model output: reviews,
brainstorms, migration plans, retros — some of it wrong, all of it evidence.
The failure mode this example forecloses is an agent (or a stray `rm`)
destroying that record. auto-okf makes destruction **unrepresentable**:

- **`DeleteConcept` is a tombstone, not an erase (§8).** The concept vanishes
  from `materialize`, `index.md`, and the `path/` index — it *looks* gone — but
  its bytes and its `_id` stay in the log. The script deletes the
  "hallucinated API" session, then recovers its body **byte-for-byte** straight
  out of history (`c/<id>/rev/<head>`), and `UndeleteConcept` brings the whole
  concept back with a `flag/undelete` audit record.
- **`appendOnly` is an immutable vault-metadata constant.** It is written at
  `init`, loaded at open, identical on every peer, and **not representable as
  an op** — no message in the 12-op wire contract can flip it, and a tampered
  `okf-vault.json` refuses to open.
- **The wire contract has no byte-destroying op at all.** The script prints all
  12 ops and counts the ones that prune/compact/gc/destroy: **zero**. An agent
  cannot even *express* "erase this from history."

Byte reclamation does exist — but only as an **operator-run epoch cycle**
(`compact`, SPEC §10), which materializes the live bundle into a fresh vault
and sheds history by design. It is a deliberate human act, never something an
agent can do mid-session.

## What the run shows

1. **Archive** — four `session` concepts (raw LLM output) written under
   `sessions/`, each tagged `llm-output`.
2. **Deletion** — an agent deletes the session it thinks is junk; it drops out
   of the materialized bundle, but the body is recovered from history.
3. **Recovery** — `UndeleteConcept` restores it; `flag/undelete` is the audit
   trail.
4. **Guarantee** — `appendOnly: true` and the zero-destructive-ops wire
   contract, printed as proof.

The committed [`out/`](./out) tree is the readable dump — all four sessions
live, because the deleted one was recovered. `okf/test/example-slop-archive.test.js`
runs the script into a scratch dir and asserts `out/` regenerates
byte-identically (a fixed writer key pair and pinned `at` timestamps make it
deterministic). **Do not hand-edit `out/`.**
