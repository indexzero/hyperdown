# vlurp-library — provenance-stamped context curation

One script that turns a **vlurpfile** into an `_id`-stamped OKF bundle with
**provenance frontmatter** (source repo, pinned ref, content hash).

```sh
node okf/examples/vlurp-library/import.js   # from the repo root, after pnpm install
```

## The pipeline

```
vlurpfile.json  ──▶  staging dir (scratch)  ──▶  OKF bundle (out/)
   pins:                fetched bytes,             one _id-stamped concept
   repo/ref/sha256      hash-verified              per file, provenance in
                        (never in the bundle)      frontmatter
```

1. **vlurp is immutable.** [vlurp](https://github.com/indexzero/vlurp) fetches
   text from GitHub, pins it to a commit, and hashes every file. This example
   never modifies it. If the `vlurp` binary is on `PATH` (and
   `OKF_VLURP_USE_BINARY=1`) the script shells out to fetch the pinned ref;
   otherwise — the default, and **always in tests** — it falls back to a
   **committed fixture** under [`fixtures/`](./fixtures), so the run **never
   needs the network**. Each file is verified against the `sha256` pin in the
   vlurpfile, so the bytes are identical whichever source supplied them, and
   upstream drift is caught at stage time.
2. **Staging, never the bundle.** Fetched bytes land in a scratch staging dir
   under `sslop/` (transient, never committed) — vlurp's output is raw upstream
   text, not yet an OKF concept.
3. **`_id` stamp + provenance.** Each staged file becomes a concept stamped
   with a minted `_id` and provenance frontmatter: `source` (repo URL), `ref`
   (pinned), and `sha256` (content hash). The `_id` is chosen by a
   **path → existing-id lookup**: a path already held in the vault reuses its
   `_id`.
4. **Materialize** the curated library to [`out/`](./out).

## Re-import does not duplicate

The script imports the same staging **twice**. The second pass mints nothing:
every path already maps to a known `_id`, so the concept is reused, not
recreated. The vault holds **3** concepts, not 6.

This is the whole point of the staging + `_id`-stamp pattern: re-vlurping an
unchanged upstream is a no-op, and a *changed* upstream lands as an **ordinary
diff** (a `SetField` on `sha256` + a `SetBody`), audited by `flag/clobber` on
the register — never a duplicated concept. Provenance drift becomes a normal
edit you can review, exactly as if a human had changed the file.

## Determinism

A fixed writer key pair, pinned `at` timestamps, and the content-hash-pinned
fixture make every byte under `out/` identical on every run.
`okf/test/example-vlurp-library.test.js` runs the script **fully offline**
(fixture path) and asserts `out/` regenerates byte-identically and is
OKF-conformant. **Do not hand-edit `out/`.**
