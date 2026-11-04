// The test controller: spawns writer processes, drives them over fork IPC,
// owns the fault proxy, and holds the convergence oracle (quiesce) and
// permutation replay by universe cloning (cloneUniverse).
import { fork } from 'node:child_process'
import { mkdir, appendFile, cp, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Rng, resolveSeed } from './rng.js'
import { FaultHub } from './hub.js'
import { PROFILES, resolveProfile, quiesceTimeout } from './profiles.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WRITER = join(ROOT, 'okf', 'harness', 'lib', 'writer.js')
const CMD_TIMEOUT = 120000

export { PROFILES, resolveProfile, quiesceTimeout }

export class WriterHandle {
  constructor(controller, name, dir) {
    this.controller = controller
    this.name = name
    this.dir = dir
    this.proc = null
    this.info = null
    this._pending = new Map()
    this._nextId = 0
  }

  async spawn() {
    this.proc = fork(WRITER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    this.proc.stdout.pipe(this.controller.logStream, { end: false })
    this.proc.stderr.pipe(this.controller.logStream, { end: false })
    this.proc.on('message', (msg) => {
      if (msg && msg.id !== undefined) {
        const p = this._pending.get(msg.id)
        if (!p) return
        this._pending.delete(msg.id)
        clearTimeout(p.timer)
        msg.ok ? p.resolve(msg.value) : p.reject(new Error(`[${this.name}] ${msg.error}`))
      }
    })
    this.proc.on('exit', (code, signal) => {
      const err = new Error(`[${this.name}] process exited (${code ?? signal})`)
      for (const p of this._pending.values()) {
        clearTimeout(p.timer)
        p.reject(err)
      }
      this._pending.clear()
    })
    await new Promise((resolve) => {
      const onMsg = (msg) => {
        if (msg && msg.ready) {
          this.proc.off('message', onMsg)
          resolve()
        }
      }
      this.proc.on('message', onMsg)
    })
    return this
  }

  cmd(cmd, args = {}, timeout = CMD_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null || this.proc.signalCode) {
        return reject(new Error(`[${this.name}] process is not running`))
      }
      const id = this._nextId++
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`[${this.name}] ${cmd} timed out after ${timeout}ms`))
      }, timeout)
      this._pending.set(id, { resolve, reject, timer })
      this.proc.send({ id, cmd, args })
    })
  }

  async init(metadata) {
    this.info = await this.cmd('init', { dir: this.dir, metadata })
    return this.info
  }

  async join(keyHex, metadata) {
    this.info = await this.cmd('join', { dir: this.dir, key: keyHex, metadata })
    return this.info
  }

  async open() {
    this.info = await this.cmd('open', { dir: this.dir })
    return this.info
  }

  call(method, ...args) {
    return this.cmd('call', { method, args })
  }

  append(type, payload) {
    return this.cmd('append', { type, payload })
  }

  hash() {
    return this.cmd('hash')
  }

  update() {
    return this.cmd('update')
  }

  val(key) {
    return this.cmd('val', { key })
  }

  dump(prefix = '') {
    return this.cmd('dump', { prefix })
  }

  stats() {
    return this.cmd('stats')
  }

  errors() {
    return this.cmd('errors')
  }

  /** SIGKILL, no cleanup. */
  crash() {
    this.proc.kill('SIGKILL')
    return new Promise((r) => this.proc.once('exit', r))
  }

  async restart() {
    await this.spawn()
    return this.open()
  }

  async shutdown() {
    try {
      await this.cmd('close', {}, 30000)
      await this.cmd('exit', {}, 5000)
    } catch {
      this.proc.kill('SIGKILL')
    }
    if (this.proc.exitCode === null && !this.proc.signalCode) {
      await new Promise((r) => this.proc.once('exit', r))
    }
  }
}

export class Controller {
  constructor({ runName, seed, profile } = {}) {
    this.seed = seed ?? resolveSeed()
    this.rng = new Rng(this.seed)
    this.profile = profile || resolveProfile()
    this.runId = `${runName || 'run'}-${process.pid}-${Date.now().toString(36)}`
    this.baseDir = join(ROOT, 'sslop', '036', 'tmp', this.runId)
    this.writers = new Map()
    this.links = new Map() // pairKey -> { linkId, a, b }
    this._linkEpoch = 0
    this.hub = null
    this.logPath = null
    this.logStream = null
  }

  async start() {
    await mkdir(this.baseDir, { recursive: true })
    this.logPath = join(this.baseDir, 'harness.log')
    this.logStream = createWriteStream(this.logPath, { flags: 'a' })
    this.hub = new FaultHub(this.rng, this.profile, (line) => this.log(`[hub] ${line}`))
    await this.hub.listen()
    this.log(
      `run ${this.runId} seed=${this.seed} profile=${this.profile.name} hub=127.0.0.1:${this.hub.port}`
    )
    // The report and the replay instructions quote this line.
    console.log(`[harness] run=${this.runId} seed=${this.seed} profile=${this.profile.name}`)
    return this
  }

  log(line) {
    const msg = `${new Date().toISOString()} ${line}\n`
    if (this.logStream) this.logStream.write(msg)
  }

  async spawn(name) {
    const dir = join(this.baseDir, name)
    await mkdir(dir, { recursive: true })
    const w = new WriterHandle(this, name, dir)
    await w.spawn()
    this.writers.set(name, w)
    this.log(`spawned writer ${name} pid=${w.proc.pid} dir=${dir}`)
    return w
  }

  pairKey(a, b) {
    return [a.name, b.name].sort().join('|')
  }

  async connect(a, b, profile = null) {
    const pk = this.pairKey(a, b)
    if (this.links.has(pk)) return this.links.get(pk)
    const linkId = `${pk}#${this._linkEpoch++}`
    if (profile) this.hub.setLinkProfile(linkId, profile)
    else this.hub.setLinkProfile(linkId, this.profile)
    await Promise.all([
      a.cmd('link', { linkId, port: this.hub.port, side: 0 }),
      b.cmd('link', { linkId, port: this.hub.port, side: 1 })
    ])
    const entry = { linkId, a, b }
    this.links.set(pk, entry)
    this.log(`connected ${pk} as ${linkId}`)
    return entry
  }

  async disconnect(a, b) {
    const pk = this.pairKey(a, b)
    const entry = this.links.get(pk)
    if (!entry) return false
    this.hub.cut(entry.linkId, 'partition')
    await Promise.allSettled([
      a.cmd('unlink', { linkId: entry.linkId }),
      b.cmd('unlink', { linkId: entry.linkId })
    ])
    this.links.delete(pk)
    this.log(`partitioned ${pk}`)
    return true
  }

  /** Forget the links of a writer after a crash killed its sockets. */
  purgeLinks(w) {
    for (const [pk, entry] of [...this.links]) {
      if (entry.a === w || entry.b === w) {
        this.hub.cut(entry.linkId, 'purge')
        this.links.delete(pk)
      }
    }
  }

  async connectAll(writers) {
    for (let i = 0; i < writers.length; i++) {
      for (let j = i + 1; j < writers.length; j++) {
        await this.connect(writers[i], writers[j])
      }
    }
  }

  async partition(groupA, groupB) {
    for (const a of groupA) for (const b of groupB) await this.disconnect(a, b)
  }

  barrier(fns) {
    return Promise.all(fns.map((fn) => fn()))
  }

  /**
   * The convergence oracle. Quiescent means that every writer reports the
   * same hash on two rounds in a row. One round is not enough: a wrong
   * "synced" signal makes the oracle vacuous. Returns the hash, or throws
   * with the hash of each writer on timeout.
   */
  async quiesce(writers, { timeout = quiesceTimeout(this.profile), step = 250 } = {}) {
    const t0 = Date.now()
    let prev = null
    let hashes = []
    while (Date.now() - t0 < timeout) {
      hashes = await Promise.all(writers.map((w) => w.hash()))
      const allEqual = hashes.every((h) => h === hashes[0])
      if (allEqual && prev === hashes[0]) {
        this.log(`quiesced at ${hashes[0]}`)
        return hashes[0]
      }
      prev = allEqual ? hashes[0] : null
      await sleep(step)
    }
    const detail = writers.map((w, i) => `${w.name}=${hashes[i]}`).join(' ')
    throw new Error(
      `quiesce timeout after ${timeout}ms (seed=${this.seed} profile=${this.profile.name}): ${detail}`
    )
  }

  /** Key-by-key diff of two full views, to localize a divergence after quiesce fails. */
  async diffViews(a, b) {
    const [da, db] = await Promise.all([a.dump(''), b.dump('')])
    const keys = new Set([...Object.keys(da), ...Object.keys(db)])
    const diffs = []
    for (const k of [...keys].sort()) {
      const va = JSON.stringify(da[k])
      const vb = JSON.stringify(db[k])
      if (va !== vb) diffs.push({ key: k, [a.name]: da[k] ?? null, [b.name]: db[k] ?? null })
    }
    return diffs
  }

  /**
   * Permutation replay by cloning: close every writer, copy its directory
   * to <run>/clones/<label>/, and reopen the copies in fresh processes.
   * The clones keep the keys and the cores, so their hashes compare with
   * each other and with the originals.
   */
  async cloneUniverse(writers, label) {
    for (const w of writers) await w.cmd('close')
    const clones = []
    for (const w of writers) {
      const dir = join(this.baseDir, 'clones', label, w.name)
      await mkdir(dirname(dir), { recursive: true })
      await cp(w.dir, dir, { recursive: true })
      // hypercore-storage's CORESTORE device file detects a copied directory
      // by inode and xattr ("moved unsafely"). Clone universes never
      // replicate with each other, so the writer fork that the guard
      // prevents cannot happen. Delete the file, and open makes a fresh one.
      await rm(join(dir, 'CORESTORE'), { force: true })
      const c = new WriterHandle(this, `${label}/${w.name}`, dir)
      await c.spawn()
      await c.open()
      this.writers.set(c.name, c)
      clones.push(c)
    }
    this.log(`cloned universe '${label}' from [${writers.map((w) => w.name).join(', ')}]`)
    return clones
  }

  /** Reopen the original writers after cloneUniverse closed their vaults. */
  async reopen(writers) {
    for (const w of writers) await w.cmd('open', { dir: w.dir })
  }

  async note(line) {
    this.log(line)
    await appendFile(join(this.baseDir, 'NOTES.txt'), line + '\n').catch(() => {})
  }

  async stop() {
    for (const w of this.writers.values()) {
      try {
        await w.shutdown()
      } catch {}
    }
    if (this.hub) await this.hub.close()
    if (this.logStream) this.logStream.end()
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll until fn() is truthy. Returns false on timeout and never throws. */
export async function until(fn, ms = 30000, step = 100) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 >= ms) return false
    await sleep(step)
  }
}
