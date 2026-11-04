// wanted(vault): the ranked demand index. apply writes
// `wanted/<path>/<from-id>` for every link that does not resolve, and
// `wantedrank/<inv-count>/<path>` so that an ascending scan gives the
// most-wanted path first. See SPEC §4. The index is demand, not loss (I4).
import { keyspace as K } from '@auto-okf/core'

/**
 * The wanted paths, most referenced first, ties in byte order of path:
 *   [{ path, count, referrers: [fromId, ...] }, ...]
 * `reader` is a store Bundle, or any { scan } surface with JSON-decoded
 * values.
 */
export async function wanted(reader) {
  const referrersByPath = new Map()
  for await (const { key } of reader.scan(K.wantedRoot())) {
    const segs = K.parseKey(key) // ['wanted', path, fromId]
    if (segs.length < 3) continue
    const path = segs[1]
    if (!referrersByPath.has(path)) referrersByPath.set(path, [])
    referrersByPath.get(path).push(segs[2])
  }

  // Ascending is most-wanted first.
  const out = []
  const ranked = new Set()
  for await (const { key } of reader.scan(K.wantedRankRoot())) {
    const segs = K.parseKey(key) // ['wantedrank', invCount, path]
    if (segs.length < 3) continue
    const path = segs[2]
    ranked.add(path)
    const referrers = (referrersByPath.get(path) || []).slice().sort(byteCmp)
    out.push({ path, count: referrers.length, referrers })
  }

  // A wanted/ path with no wantedrank/ row cannot occur in a converged view
  // (I8). Append it anyway, in byte order, so that the result is never short.
  const leftover = [...referrersByPath.keys()].filter((p) => !ranked.has(p)).sort(byteCmp)
  for (const path of leftover) {
    const referrers = referrersByPath.get(path).slice().sort(byteCmp)
    out.push({ path, count: referrers.length, referrers })
  }
  return out
}

function byteCmp(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}
