# Prior findings table (P2 iteration 1 review) — closure verification input

The artifact under review previously received these findings (IDs, severities,
sections, titles only; section numbers refer to the PRIOR revision). Verify
each is closed in the current revision; then attack the current revision fresh.

| ID | Severity | Prior § | Title |
|----|----------|--------|-------|
| B1 | blocker | §8.3, I10, I1/I2 | Causal revocation unimplementable via documented Autobase API; signedLength disjunct is peer-local → divergent views |
| B2 | blocker | §8.1/§8.6, I10 | No issuer-authority check on AddWriter/RemoveWriter: any confirmed agent can appoint puppet indexers and capture the quorum |
| B3 | blocker | §8.5 vs I10 | Rate-window rejections are interleaving-dependent; I10 reorg-stable partition unachievable as specified |
| M1 | major | §5.7 | ctxEpoch subtree hash cannot identify the diverged term nor recover the cited epoch's kind |
| M2 | major | §5.2, §3.2 | Keyword-aliased terms (type→@type, id→@id) have no kind-table row; explicit @id semantics entirely unhandled |
| M3 | major | §5.1/§5.2 | Non-@set terms may be multi-valued in JSON-LD; vault-ld's own example fails roundtrip; @container:@list undefined |
| M4 | major | §10.1, §7, §9.1 | Scoped-@base machinery missing: no op declares a scope's @base; n/<s>/base derivation undefined |
| M5 | major | §9.3, §3.2, §9.1 | No op carries authored path into view; no traversal validation → adversarial ops become arbitrary file writes |
| M6 | major | §8.2, §4 | Optimistic hold-and-replay has no storage/ordering rule; payload not retained; Autobase does not re-deliver |
| M7 | major | §5.4, §6, I7, §11 | No op resolves conflicts or drains flags; conflict flags pin revisions against GC forever |
| M8 | major | §5.6, §10.3 | Host-key promotion strands existing values under n/<s>/host/; duplicate YAML keys possible |
| M9 | major | §9.2, §3.2 | Field removal and note deletion inexpressible (no UnsetField/DeleteSubject) |
| M10 | major | §10.3, §5.5 | Kind-change on term redefinition has no migration rule for existing view state |
| m1 | minor | §8.4 | seq availability inside apply not documented by autobase README |
| m2 | minor | §5.2 | AddMember on unmapped term silently overwrites prior verbatim value |
| m3 | minor | §6, §3.2 | Hash-input encodings unspecified (revHash byte construction, ctx tree-hash) |
| m4 | minor | §9.2 | Wiki-link grammar (alias, fragment, disambiguation, ambiguity warning) assigned to no component |
| m5 | minor | §10.3 | Backfill full-scan per DefineTerm; cheap apply-time DoS |
| m6 | minor | §11 | Snapshot trust model unspecified (single indexer vs quorum) |
| m7 | minor | §8.6 | namespacePrefixes matching undefined (byte-prefix vs path-segment) |
| n1 | nit | §1, §3.2 | hyperdispatch README is one sentence; required reading points at docs that do not exist |
| n2 | nit | §9.4 | mtime/hash check + rename not atomic together (TOCTOU) |
