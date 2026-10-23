// Which autobee wrote a generation's store (the autobee@1 to autobee@2 flag
// day). autobee@2 cannot open a store autobee@1 wrote: it boots onto the v1
// system head named by the local core's `autobee/head` user data, throws
// "Out of bounds" decoding the first v1 writer record, and closes. So okf
// must tell the two apart BEFORE it constructs an Autobee.
//
// The rule, checked against stores written by autobee@1.0.10 (the old okf
// release) and by autobee@2.12.1:
//
// - Both versions name the local writer core in the bootstrap core's
//   `autobee/local` user data, and keep the boot record (a compact
//   `{ key: fixed32, length: uint }` naming the system core) in the local
//   core's `autobee/head` user data. A store with no `autobee/head` has
//   applied nothing: there is nothing to migrate.
// - okf marks the local core `okf/substrate = autobee@2` on every autobee@2
//   open. A marked store is autobee@2.
// - An unmarked store with a head is decided by the system core it names:
//   autobee@2 creates its system core at manifest version 3 (lib/constants.js
//   DEFAULT_MANIFEST_VERSION, through corestore >= 7.12, which honours a
//   per-core manifestVersion); autobee@1 created it under
//   store.namespace('system') at corestore's default, version 1. Below 3 is
//   autobee@1. This keeps a v2 store that lost its marker from being refused.
//
// Every read here is user data or a manifest of a core that already exists.
import b4a from 'b4a'

export const SUBSTRATE = 'autobee@2'
export const SUBSTRATE_MARKER = 'okf/substrate'
const FIRST_AUTOBEE2_MANIFEST = 3

/**
 * `{ substrate: 'none' | 'autobee@1' | 'autobee@2', marked }` for the store a
 * generation session holds under the vault (bootstrap) key.
 */
export async function detectSubstrate(session, bootKey) {
  const bootstrap = session.get({ key: bootKey, active: false })
  try {
    await bootstrap.ready()
    const localKey = await bootstrap.getUserData('autobee/local')
    if (!localKey) return { substrate: 'none', marked: false }
    const local = session.get({ key: localKey, active: false })
    try {
      await local.ready()
      const mark = await local.getUserData(SUBSTRATE_MARKER)
      if (mark && b4a.toString(mark) === SUBSTRATE) return { substrate: SUBSTRATE, marked: true }
      const head = await local.getUserData('autobee/head')
      if (!head || head.byteLength < 32) return { substrate: 'none', marked: false }
      const system = session.get({ key: head.subarray(0, 32), active: false })
      try {
        await system.ready()
        const version = system.manifest ? system.manifest.version : 0
        return {
          substrate: version >= FIRST_AUTOBEE2_MANIFEST ? SUBSTRATE : 'autobee@1',
          marked: false
        }
      } finally {
        await system.close()
      }
    } finally {
      await local.close()
    }
  } finally {
    await bootstrap.close()
  }
}

/** Mark an autobee@2 store's local core (see the rule above). */
export function markSubstrate(local) {
  return local.setUserData(SUBSTRATE_MARKER, b4a.from(SUBSTRATE))
}
