# recipe-book: four agents, one shared vault

We told four agents to write a recipe book from scratch. They created a
knowledge graph — negotiating an ontology, writing concurrently while
disconnected, disagreeing, merging, auditing every disagreement — and that
knowledge graph was then represented as the Markdown files you can read,
right now, under [`out/vault/`](./out/vault/) and as RDF under
[`out/rdf/`](./out/rdf/). This is the end-of-session dump a human operator
takes from a multi-agent writing session.

Run it yourself (from the repo root, after `pnpm install`):

```sh
node vault-ld/examples/recipe-book
```

The script is non-interactive and deterministic: writer key pairs come from
fixed seeds and every concurrent phase starts from a converged barrier, so
`out/` regenerates **byte-identically** on every run (invariant I9 — asserted
by `test/example-recipe-book.test.js`). Never hand-edit `out/`; it is
generated. Per-run vault storage goes to a fresh directory under
`sslop/015/tmp/recipe-book/` (override with `RECIPE_BOOK_STORAGE`; output
with `RECIPE_BOOK_OUT`).

## The cast

| agent | role |
| --- | --- |
| **Nova** | ontology architect; vault creator and genesis indexer |
| **Basil** | soups & starters |
| **Clove** | bakes & breads |
| **Dill** | mains, the pantry, end-of-session editorial pass |

Each agent is a real vault peer with its own writer core. Nova admits the
other three with `AddWriter` ops — governance is in the same log as the
recipes (§8.0).

## What the run demonstrates

1. **The schema is content.** Nova's `DefineScope`/`DefineTerm` ops (Recipe,
   Ingredient, `hasIngredient`, `prepTime`, …) travel through the same
   linearized log, the same `apply`, the same governance as the data they
   govern.
2. **Concurrent writing, visible semantics.** Offline and in parallel:
   Basil and Clove both add members to Tomato Soup's `hasIngredient` — the
   OR-set **unions** (I5). Basil and Dill both set `servings` — the LWW
   register picks one deterministic winner and writes `flag/clobber` so the
   overwrite is never silent (§5.4, I4).
3. **Dangling links mint and heal.** `[[Tomato]]` is referenced before the
   note exists; the IRI is minted and `flag/dangling` written (§7). When
   Dill's pantry notes land, the flags clear. `[[Herbes de Provence]]` is
   never written — it stays flagged, an honest TODO.
4. **Prose conflicts are kept, then resolved.** Basil and Dill write the
   soup's body from the same base revision; both revisions are kept and
   `flag/conflict` raised (§6). Dill drains it with a `ResolveConflict` op
   carrying merged text — an ordinary logged write, not a storage-level guess.
5. **The dump.** `materialize()` projects the Obsidian-readable vault;
   `exportTurtle()` writes `schema.ttl` + `data.ttl`.

## The roundtrip

```
                 ┌───────────────────────────────┐
                 │   op log on autobee           │
                 │   (source of truth, §2)       │
                 └──────────────┬────────────────┘
                     apply ⇒ one deterministic view
                                │
        ┌───────────────────────┼──────────────────────┐
        ▼                       ▼                      ▼
   RDF ◀─ingest──────────── markdown ──────export▶ Turtle
 (vld:path roundtrip)     out/vault/*.md      out/rdf/{schema,data}.ttl
```

The Markdown face is not a rendering — it is a full citizen: edit
`out/vault/Tomato Soup.md` under `autovault-ld watch` and the edit re-enters
the log as minimal semantic ops (§9), converging with whatever the agents
write next.

## Beyond recipes

A recipe book is just a friendly ontology. Agentic communication structures
— sessions, findings, determinations, RFCs — are sibling representations
the same substrate supports: define the terms (`Finding`, `supersedes`,
`determinedBy`, …) with the same `DefineTerm` ops and the same vault gives
you a multi-agent, auditable, conflict-surfacing record of the conversation,
readable as Markdown and queryable as RDF.
