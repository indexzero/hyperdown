// The local swarm allowlist of one peer (G3-P9 F03): swarm keys that this
// peer admits and dials, and no other peer. It is the persisted form of
// Bundle.swarm({ allow }). `auto-okf join --swarm-allow` writes it next to
// okf-vault.json, and `auto-okf watch --swarm` reads it and passes it to
// swarm(). It is not metadata: no other peer reads it, the pinned hash
// leaves it out, and the invite never carries it.
//
// Why it exists: a late joiner folds no gov/writer record before it
// connects, so its firewall admits only the keys of the invite. When no
// peer of the invite is online, the indexer that admitted the joiner hands
// it its swarm key with the invite, and the joiner lists that key here.
import { randomBytes } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { swarmKeyList } from './metadata.js'

export const LOCAL_ALLOW_FILE = 'okf-swarm-allow.json'

/**
 * Write the local list of `dir`, and return it in canonical form
 * (lowercase hex, sorted). The list replaces the one that the file held.
 * A value that is not an array, a bad key or a key listed twice fails
 * VAULT_BAD_SWARM_ALLOW before anything is written.
 *
 * The write is atomic (D-060 F20): the list goes to a new file in `dir`,
 * which is flushed to disk and then renamed over LOCAL_ALLOW_FILE. A
 * rename in one directory replaces the name in one step (POSIX rename(2)),
 * so a reader or a crash finds the old list or the new one, whole, and
 * never a part. A failure removes the new file and leaves the old one.
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
 * The local list of `dir`: [] when the file does not exist. A file that
 * is not JSON (D-060 F20), or not `{ "allow": [...] }` with valid,
 * distinct keys, is refused by name, with its path: VAULT_BAD_SWARM_ALLOW.
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
