// Shared harness for the okf/examples/* tests: run an example script into a
// fresh scratch directory, then compare its tree with the committed out/
// byte for byte (I9). Scratch stays on disk after a run.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Run a node script with extra env. Resolves { code, stdout, stderr }. */
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

/** A sorted map of relative path to sha256 for every file under dir. A missing dir gives an empty map. */
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
