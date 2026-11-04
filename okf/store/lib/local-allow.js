// The swarm keys that this peer alone admits and dials. Not metadata: the
// pinned hash leaves it out, and the invite never carries it.
//
// A late joiner folds no gov/writer record before it connects, so its
// firewall admits only the keys of the invite. When none is online, the
// joiner lists here the key of the indexer that admitted it.
import { randomBytes } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { swarmKeyList } from './metadata.js'

export const LOCAL_ALLOW_FILE = 'okf-swarm-allow.json'

/**
 * Write the local list of `dir` and return it in canonical form. A bad
 * list fails VAULT_BAD_SWARM_ALLOW before anything is written. The write
 * is atomic: a new file in `dir`, synced, then renamed over
 * LOCAL_ALLOW_FILE, so a reader or a crash finds the old list or the new
 * one, never a part.
 */
export async function saveLocalAllow(dir, keys) {
  const allow = swarmKeyList(keys, 'allow')
  const path = join(dir, LOCAL_ALLOW_FILE)
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const fh = await open(tmp, 'wx')
    try {
      await fh.writeFile(JSON.stringify({ allow }, null, 2) + '\n')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
  return allow
}

/**
 * The local list of `dir`, or [] when the file does not exist. A file that
 * is not JSON, or not `{ "allow": [...] }` with distinct swarm keys, fails
 * VAULT_BAD_SWARM_ALLOW, with its path.
 */
export async function loadLocalAllow(dir) {
  const path = join(dir, LOCAL_ALLOW_FILE)
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (err) {
    throw localAllowError(`${path} is not JSON (${err.message})`)
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || Object.keys(doc).some((k) => k !== 'allow')) {
    throw localAllowError(`${path} must be an object whose one key is allow`)
  }
  return swarmKeyList(doc.allow, `${path} allow`)
}

function localAllowError(message) {
  const err = new TypeError(`VAULT_BAD_SWARM_ALLOW: ${message}`)
  err.code = 'VAULT_BAD_SWARM_ALLOW'
  return err
}
