# ADR-006: Twin CLIs refuse each other's vaults by marker file

## Status
Accepted

## Date
2026-07-31

## Context
Confusion finding F4: across the six-agent experiment, zero cross-system
invocations occurred between `auto-okf` and `autovault-ld` — but the log
attributes that to five of six agents *finding and reading*
`vault/okf-vault.json`, and one agent stated the counterfactual: "Had
that marker file not existed I would likely have had to guess." The
repo ships two near-identical CLIs over the same substrate; the marker
is currently informational, not enforced. The experiment's luckiest
non-failure should become a guarantee.

## Decision
Each CLI checks for the sibling system's marker on vault open and refuses
pointedly, naming the right tool:

```
error: ./vault is an auto-okf vault (okf-vault.json present);
use auto-okf, not autovault-ld
```

Symmetric: `auto-okf` refuses vault-ld storage identically. One stat plus
one read on the open path; exit 1; storage untouched.

## Alternatives Considered

### Auto-detect and delegate to the right CLI
Rejected: silent delegation hides which contract (and which SPEC) the
caller is under. Make the wrong thing hard and the right thing findable —
the error message does the routing.

### Rely on the marker file being read (status quo)
That is the luck this ADR removes.

## Consequences
- The one cross-system change in this batch: okf §13 and the vault-ld
  SPEC's CLI section update together.
- Requires the marker-file names of both systems to be stable contract
  (they already are in practice).

## Acceptance
- [ ] `autovault-ld <cmd>` against an auto-okf vault → the refusal, exit
      1, storage untouched.
- [ ] `auto-okf <cmd>` against a vault-ld vault → symmetric refusal.
- [ ] Both CLIs against their own vaults: unchanged.
