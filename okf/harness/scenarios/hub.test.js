// Validates the fault hub itself (no writer processes): bytes a socket
// sends after its header but before its partner connects reach the partner.
// A replication stream's initiator sends its first Noise handshake message
// at once, so a hub that dropped those bytes left the link paired and dead:
// no handshake, no replication, both ways.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { FaultHub } from '../lib/hub.js'
import { Rng } from '../lib/rng.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const CLEAN = { name: 'clean', latencyMs: 0, jitterMs: 0, stallP: 0, stallMs: 0 }

async function dial(port, link, side) {
  const socket = net.connect(port, '127.0.0.1')
  socket.setNoDelay(true)
  await new Promise((resolve) => socket.once('connect', resolve))
  socket.write(JSON.stringify({ link, side }) + '\n')
  return socket
}

test('fault hub keeps the bytes a socket sends before its partner pairs', async () => {
  const hub = new FaultHub(new Rng(1), CLEAN)
  const port = await hub.listen()
  const sockets = []
  try {
    const a = await dial(port, 'L', 0)
    sockets.push(a)
    await sleep(50) // the header is parsed and a is pending
    a.write('first')
    await sleep(50)
    const b = await dial(port, 'L', 1)
    sockets.push(b)
    let got = ''
    b.on('data', (d) => {
      got += d
    })
    await sleep(50)
    a.write('|second')
    await sleep(100)
    assert.equal(got, 'first|second')
  } finally {
    for (const s of sockets) s.destroy()
    await hub.close()
  }
})
