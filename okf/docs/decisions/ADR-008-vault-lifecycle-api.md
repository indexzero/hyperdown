# ADR-008: okf's lifecycle API is `Bundle.init/open/join`; the free-function wrappers go

## Status
Proposed

## Date
2026-07-31 (amended 2026-08-01: `Vault` → `Bundle` per maintainer review)

## Context
The Stylist agent's confusion (experiment log, Stylist #1) was filed as a
documentation gap in ADR-007: the store README's headline snippet uses
`initVault('./vault')` where reopen is meant. Maintainer review reframed
it twice:

1. The snippet is a symptom — the API bakes a noun into every verb
   (`initVault`, `openVault`, `joinVault`) that disambiguates nothing.
   Investigation confirmed: both systems already carry identical statics
   (`init`/`open`/`join` on the store class, okf `store/lib/vault.js:151–165`,
   vault-ld `:125–139`); okf's free functions are one-line wrappers over
   them; no competing `open{Foo}`/`init{Foo}` exists (only an internal
   `openInner`); the SPEC never names the wrappers; the packages are
   unpublished.
2. The noun itself is imported vocabulary. vault-ld was written first;
   "vault" leaked into its sibling. Upstream OKF (v0.2, the pointer in
   `okf/OKF.SPEC.v2.md`) defines the **bundle** as "a self-contained,
   hierarchical collection of knowledge documents. The unit of
   distribution" — and defines no vault concept at all. auto-okf's own
   README opens with "A multi-writer knowledge **bundle** on autobee."
   The thing this class opens *is* an OKF bundle, in its authoritative
   multi-writer form.

Known collision, resolved by framing: the current GLOSSARY pins
`bundle` = the on-disk materialized face, `vault` = the store. Under
OKF's ontology these are two forms of **one** bundle — the authoritative
(log) form and the emitted (tree) form. This ADR renames only the API
class; the wholesale vocabulary migration (GLOSSARY, `okf-vault.json`
marker, CLI strings and `<vault-dir>` argument names, SPEC prose) is
ADR-009's scope.

## Decision
In okf, remove `initVault`, `openVault`, `joinVault` from the store's
exports and rename the exported class `Vault` → `Bundle`
(`store/lib/vault.js` → `store/lib/bundle.js`). The class is the sole
lifecycle entry point:

```js
import { Bundle } from '@auto-okf/store'
const bundle = await Bundle.init('./storage')    // create
const bundle = await Bundle.open('./storage')    // reopen
const bundle = await Bundle.join('./storage', key)
```

vault-ld is unchanged: it exports `Vault` with the same static shape,
and a *vault* is the correct noun for its own ontology (a wiki's
multi-writer store). The twins keep symmetry of **shape**
(`<Class>.init/open/join`) while each speaks its own domain's noun.

Update all in-repo okf callers and docs (22 files: tests, test helpers,
harness writer, CLI `lib/run.js`, three examples, faces internals, three
READMEs — whose headline snippets then teach create-vs-open by
construction).

## Alternatives Considered

### Keep wrappers, fix the README snippet (ADR-007 item 2)
Superseded. Two names for one operation caused the confusion; prose
can't fix a redundant vocabulary.

### `Vault.init/open/join` in okf (this ADR's original form)
Rejected on maintainer review. Cross-system symmetry argued for one
class name, but the symmetry that matters is the shape of the statics;
the noun should match each system's ontology, and OKF's unit is the
bundle — "vault" appears nowhere in the upstream spec.

### Bare free functions `init`/`open`/`join`
Rejected: unreadable as bare imports at call sites, and diverges from
the class idiom both systems already share.

## Consequences
- okf's API says what OKF means: you open a bundle.
- Residual "vault" vocabulary inside okf (marker filename, CLI
  messages/arg names, GLOSSARY, SPEC prose) is temporarily inconsistent
  with the class name — accepted, tracked as ADR-009 so the migration
  happens once, deliberately, alongside the v0.2 conformance audit.
- Purely in-repo mechanical migration (unpublished; no shim).

## Acceptance
- [ ] `grep -r 'initVault\|openVault\|joinVault' okf/` (excluding
      node_modules and docs/decisions) returns nothing.
- [ ] okf/store exports `Bundle`; no `Vault` export remains in okf.
- [ ] Full okf test suite green after the sweep.
- [ ] All three okf README headline snippets use `Bundle.init` /
      `Bundle.open` and compile as written against the exported surface.
