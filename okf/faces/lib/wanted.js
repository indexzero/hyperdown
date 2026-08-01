// wanted(vault): the ranked demand index (okf SPEC §4, §9;
// Special:WantedPages). A `wanted/<path>/<from-id>` row is written by apply
// for every unresolved link referrer, and `wantedrank/<inv-count>/<path>`
// is the derived rank index whose ASCENDING scan yields most-wanted first
// (inv-count = MAX - count, §4). This is a pure read: wanted/ demand is
// NOT loss (I4) — it is "what does the graph want written?", ranked by
// referrer count.
import { keyspace as K } from '@auto-okf/core'

/**
 * Return the ranked list of wanted (unwritten) concept paths:
 *   [{ path, count, referrers: [fromId, ...] }, ...]
 * ordered most-referenced first (ties broken by path byte order, which the
 * wantedrank/ key order provides deterministically). `reader` is a store
 * Bundle (or any { scan } surface); values are JSON-decoded.
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

  // wantedrank/ ascending == most-wanted first (§4).
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

  // Defensive: any wanted/ path missing from wantedrank/ (should not happen
  // in a converged view — I8) is appended in deterministic byte order so the
  // result is never silently short.
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
