# ADR-002: `status` — per-file vault/bundle state porcelain

## Status
Proposed

## Date
2026-07-31

## Context
The strongest cross-agent signal in the confusion experiment (findings
F1/F5): three of six first-contact agents read this repo's *source* to
answer what are all per-file state questions. One diagnosed a
`0 op(s) from 0 file(s)` result by reading `okf/faces/lib/ingest.js`
("the wording gave no hint the file was already ingested vs. never
seen"); another grepped `fsatomic.js` to learn the emission manifest is
per-directory; a third read docs mid-flight to confirm materialize would
not clobber a foreign pending file. Agents source-dive where the surface
is ambiguous; humans mostly won't.

## Decision
Add a read-only command:

```sh
auto-okf status <vault> <bundle> [--json]
```

One line per file, one state from a fixed vocabulary:

| state | meaning |
| --- | --- |
| `in-log` | on-disk bytes match the log's canonical projection (hash match) |
| `pending-ingest` | hand-authored/edited; not yet in the log |
| `dirty` | in the log but on-disk bytes diverge from the projection |
| `absent` | in the log, missing from disk (materialize would restore) |
| `foreign` | not in the log, not manifest-tracked (e.g. another writer's WIP) |

`--json` emits the same as a machine-readable array. Strictly read-only:
appends no ops, writes no files, touches no manifest.

## Alternatives Considered

### Fold flag-queue reporting into `status`
Deferred (open question Q3 in the proposals doc). `flags` already
exists; one command, one question.

### Richer prose messages on existing commands instead
Insufficient alone — messages answer the question for the command you
ran; `status` answers it before you run anything (and ADR-003 improves
the message anyway).

## Consequences
- The state vocabulary becomes contract (Hyrum's law applies to the
  `--json` schema especially — it will be the most machine-depended-on
  surface in the CLI; review it with API-design care, once).
- SPEC §9 names the state vocabulary (it exists implicitly in the
  ingest/materialize rules today); §13 adds the command.
- The scratch-materialize verification idiom four agents independently
  invented becomes unnecessary for state questions (still valid for
  proof-from-log; see ADR-007).

## Acceptance
- [ ] Reproduce the swept-writer incident: write a file, have a second
      process ingest+materialize it, run `status` → `in-log`, not
      `pending-ingest`.
- [ ] A foreign mid-write file reports `foreign` and is not ingested.
- [ ] `--json` parses and is identical across two consecutive runs with
      no intervening ops.
