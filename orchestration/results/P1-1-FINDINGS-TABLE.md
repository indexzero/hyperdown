# Prior findings table (P1 iteration 1) — closure verification input

The artifact under review previously received these findings (IDs, severities,
sections, titles only). Verify each is closed in the revised spec; then attack
the revised spec fresh.

| ID | Sev | Spec § (v1) | Title |
|----|-----|--------|-------|
| F1 | blocker | §3, §9, I1/I2 | Subject-key Unicode normalization is unspecified; NFC/NFD divergence → divergent IRIs/keys across peers |
| F2 | blocker | §4, §5, §3, I2 | op-type × term-kind mismatches (AddMember on scalar, SetField on @set, RemMember on scalar) have no defined behavior |
| F3 | blocker | §8, I4 | An op that fails decoding cannot be flagged (no subject to key on) → silent loss |
| F4 | blocker | §5, §6, I4/I6 | Losing LWW scalar write disappears with no flag → contradicts I4 as written |
| F5 | blocker | §10, §9, I9 | Schema-vs-data export split is folder-decided (vault-ld §5.4) but the log/view carries no folders |
| F6 | blocker | §8, I10 | "Revocation point" undefined under reorg; linearized-index pin is not reorg-stable |
| F7 | major | §5, §10, I1/I9 | YAML/Turtle literal formatting unspecified → byte-nondeterministic export |
| F8 | major | §5 | Policy-epoch reordering merely documented; no epoch-pinning option |
| F9 | major | §3, §5, I5 | RemMember citing unknown/unobserved tags undefined; tag-citation contract unstated |
| F10 | major | §5, §7, §9 | Unmapped values stored + flagged but never re-exported (trapped in view) |
| F11 | major | §9 | Host-tool keys (tags, aliases, cssclasses) wrongly flagged unmapped (vault-ld MUST NOT warn) |
| F12 | major | §7 | Dangling-IRI mint does not specify governing @base → takeover fails |
| F13 | major | §9, §10 | vld:path roundtrip triples never emitted or consumed → placement lost |
| F14 | major | §8 | Flag flooding: rate ceilings are ops in the same log; burst linearizes ahead of the limiting op |
| F15 | major | §5, §6, §8 | No compaction / GC / revision pruning; unbounded growth unaccepted and unmitigated |
| F16 | major | §8 | Per-writer namespace restrictions named but unspecified (no op, no merge rule) |
| F17 | minor | §5 | flag/shadow over-fires on identical redeclarations (vault-ld: warn only on different definition) |
| F18 | minor | §8 | Optimistic-writer op visibility before confirmation unpinned |
| F19 | minor | §9 | On-disk materialize/ingest race unaddressed |
| F20 | nit | §1, §3 | hyperdispatch schema evolution (append-only ids) not stated as determinism constraint |
