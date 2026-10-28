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
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { swarmKeyList } from './metadata.js'

export const LOCAL_ALLOW_FILE = 'okf-swarm-allow.json'

/**
 * Write the local list of `dir`, and return it in canonical form
 * (lowercase hex, sorted). The list replaces the one that the file held.
 * A value that is not an array, a bad key or a key listed twice fails
 * VAULT_BAD_SWARM_ALLOW before anything is written.
 */
export async function saveLocalAllow(dir, keys) {
  const allow = swarmKeyList(keys, 'allow')
  await writeFile(join(dir, LOCAL_ALLOW_FILE), JSON.stringify({ allow }, null, 2) + '\n')
  return allow
}

/**
 * The local list of `dir`: [] when the file does not exist. A file that
 * is not `{ "allow": [...] }` with valid, distinct keys is refused by name.
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
  const doc = JSON.parse(raw)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || Object.keys(doc).some((k) => k !== 'allow')) {
    throw new TypeError(`${path} must be an object whose one key is allow`)
  }
  return swarmKeyList(doc.allow, `${path} allow`)
}
