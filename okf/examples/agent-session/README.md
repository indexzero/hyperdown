# agent-session — the auto-okf flagship

Four AI agents co-author a knowledge bundle on **one shared multi-writer
vault** while **partitioned**, then heal — and a human operator dumps the
session as a readable [OKF v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
markdown bundle (the committed [`out/`](./out) tree).

```sh
node okf/examples/agent-session/session.js   # from the repo root, after pnpm install
```

## ThreadMode → DocumentMode

The agents emit a **thread**: an append-only op log of findings,
determinations, and an RFC, written concurrently by four peers. `out/` is the
refactored **document**: one markdown file per concept, a derived `index.md`
per directory, and a root `log.md` that narrates the op log newest-day-first.
The log stays the source of truth; `out/` is a face regenerated from it,
byte-for-byte (I9). A human operator reads `out/` at the end of the session —
open it in any markdown reader.

## The cast

Each agent is its own vault peer with its own writer core (fixed-seed key
pairs, so the run is deterministic):

| agent | role |
| --- | --- |
| `alpha` | session coordinator — vault creator, genesis indexer |
| `beta` | investigator |
| `gamma` | investigator |
| `delta` | reviewer |

## What each agent does, and what it proves

1. **Governance (§8).** `alpha` admits `beta`/`gamma`/`delta` as writers with
   logged `AddWriter` ops.
2. **Authorship (§5).** Findings, determinations, and an RFC are ordinary
   concepts in the same log, cross-linked with markdown links
   (`[RFC](/rfc/caching-layer.md)`).
3. **Partition.** The four peers **disconnect** and write in parallel:
   - **OR-set union (I5).** `beta` tags the shared `overview` note `reviewed`
     while `gamma` tags it `urgent`. On heal the `tags` OR-set **unions** to
     `[reviewed, urgent]` — concurrent adds never clobber.
   - **LWW clobber (§5, I4).** Both also set the `status` register
     concurrently (`triage` vs `under-review`). The LWW register picks one
     deterministic winner; the loser is recorded under `flag/clobber` — no
     silent loss.
   - **Body conflict (§5).** `beta` and `gamma` both rewrite the RFC body from
     the *same converged base*. The system keeps **both** revisions and raises
     exactly one `flag/conflict`; `alpha` drains it with a `ResolveConflict`
     op that appends a merged body.
   - **`wanted/` demand (§9).** `beta`'s finding links a
     `/determinations/sharding.md` that nobody has written. It lands in
     `wanted/`, the ranked demand index ("what does the graph want written?"),
     **never a flag** — OKF §5.3 tolerates dangling links.
4. **Heal + dump.** The peers reconnect, converge (I2), and `alpha`
   materializes the OKF bundle to `out/`.

## The roundtrip

```
agents write ops  ──▶  shared partitioned autobee log  ──▶  converged view
                                                              │
                                          materialize (I9)    ▼
                          out/  ◀──  index.md · log.md · one .md per concept
```

Everything the agents did survives in `out/`: the merged RFC body, the unioned
tags, the LWW winner, the resolved conflict, and — in `log.md` — a dated
narration of the creations and the resolution. The one unwritten concept the
graph still wants is not in `out/` (nothing to write yet); it lives in the
vault's `wanted/` index, ready for the next session.

## Determinism

Writer key pairs derive from fixed seeds and every concurrent phase starts from
a fully converged barrier, so the final view — and therefore every byte under
`out/`, including the `_id` frontmatter, the `log.md` dates (from each op's
informational `at`), and the wanted ranking — is identical on every run.
`okf/test/example-agent-session.test.js` runs this script into a scratch dir
and asserts the output is byte-identical to the committed `out/`. **Do not
hand-edit `out/`** — regenerate it with the command above.
