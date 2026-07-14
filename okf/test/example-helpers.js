// Shared harness for the okf/examples/* determinism tests: run a committed
// example script into a fresh scratch dir (never the committed out/) and
// compare the freshly generated tree to the committed one, byte-for-byte
// (I9). Scratch lives under sslop/035/tmp/, unique per run, never cleaned up.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Run a node script with env overrides; resolves { code, stdout, stderr }. */
export function runScript(scriptPath, env = {}, timeout = 300000) {
  return new Promise((resolve) => {
    execFile(
      'node',
      [scriptPath],
      { cwd: REPO, timeout, env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })
    )
  })
}

/** Sorted rel -> sha256 map of every file under dir (byte identity). */
export async function treeHashes(dir) {
  const out = new Map()
  await walk(dir, '', out)
  return new Map([...out.entries()].sort())
}

async function walk(root, rel, out) {
  const abs = rel === '' ? root : join(root, rel)
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  for (const e of entries) {
    const childRel = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) await walk(root, childRel, out)
    else if (e.isFile()) {
      out.set(childRel, createHash('sha256').update(await readFile(join(root, childRel))).digest('hex'))
    }
  }
}
