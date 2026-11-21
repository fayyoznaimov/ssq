// Test doubles: a fake Baileys socket, a fake CRM API, temporary folders. No real WhatsApp.
import { EventEmitter } from 'node:events'
import http from 'node:http'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/log.js'
import { CrmClient, Outbox } from '../src/outbox.js'
import { SessionManager } from '../src/session-manager.js'
import { createHttpServer } from '../src/http-server.js'
import { PhotoCache } from '../src/photos.js'
import assert from 'node:assert/strict'

export const TOKEN = 'test-token-123'

export const silent = createLogger({ level: 'silent' })
/** A logger that keeps its lines (to check what is printed). */
export function memoryLogger(level = 'debug') {
  const lines = []
  const logger = createLogger({ level, write: (line) => lines.push(line) })
  return { logger, lines }
}

const made = []
process.on('exit', () => { for (const dir of made) fsSync.rmSync(dir, { recursive: true, force: true }) })

/** A temporary folder, removed when the test process exits. */
export async function tempDir(prefix = 'wa-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  made.push(dir)
  return dir
}

export const newKey = () => crypto.randomBytes(32)

export function testConfig(dir, more = {}) {
  return {
    ...loadConfig({
      SESSIONS_DIR: path.join(dir, 'sessions'),
      UPLOADS_DIR: path.join(dir, 'uploads'),
      CRM_API_TOKEN: 'test-token-123',
    }),
    startWaitMs: 2000,
    qrTimeoutMs: 60000,
    ...more,
  }
}

/** A socket factory whose sockets the test drives: emit('connection.update', ...), etc. */
export function fakeWhatsApp() {
  const wa = {
    sockets: [],
    onWhatsApp: async (nums) => nums.map((n) => ({ jid: `${n}@s.whatsapp.net`, exists: true })),
    sendFails: false,
    lidMap: {},
    pairingReply: 'result', // 'result' | <error code> | 'throw' | null (no answer)
    pictures: {},  // jid -> picture URL, or an error code (401 privacy, 404 none, 500 failure)
    images: {},    // URL without the query -> bytes served by wa.fetch
    photoQueries: [],
    downloads: [],
    get last() { return this.sockets[this.sockets.length - 1] },
  }
  wa.factory = async ({ auth }) => {
    const emitter = new EventEmitter()
    const sock = {
      auth,
      ev: { on: (n, f) => emitter.on(n, f), off: (n, f) => emitter.off(n, f), emit: (n, d) => emitter.emit(n, d) },
      emit: (n, d) => emitter.emit(n, d),
      ended: false,
      loggedOut: false,
      sent: [],
      get user() { return auth.creds.me },
      end() { sock.ended = true },
      async logout() { sock.loggedOut = true; emitter.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } }) },
      async onWhatsApp(...nums) { return wa.onWhatsApp(nums) },
      async sendMessage(jid, content, opts) {
        if (wa.sendFails) throw new Error('stream closed')
        sock.sent.push({ jid, content, opts })
        return { key: { id: opts?.messageId, remoteJid: jid, fromMe: true } }
      },
      signalRepository: { lidMapping: { getPNForLID: async (lid) => wa.lidMap[lid] ?? null } },
      updateMediaMessage: async (m) => m,
      async profilePictureUrl(jid, type) {
        wa.photoQueries.push([jid, type])
        const pic = wa.pictures[jid]
        if (pic === undefined || typeof pic === 'number') {
          const code = pic ?? 404
          throw Object.assign(new Error(code === 401 ? 'not-authorized' : code === 404 ? 'item-not-found' : 'internal-server-error'), { data: code })
        }
        return pic
      },
      // raw frames (Baileys' sock.ws emits 'frame' for every node received)
      ws: new EventEmitter(),
      nodesSent: [],
      async sendNode(node) { sock.nodesSent.push(node) },
      pairingRequests: [],
      /** Like Baileys: sets creds.me to the phone at once, then WhatsApp answers the iq (wa.pairingReply). */
      async requestPairingCode(phone) {
        sock.pairingRequests.push(phone)
        auth.creds.me = { id: `${phone}@s.whatsapp.net`, name: '~' }
        emitter.emit('creds.update', auth.creds)
        const reply = wa.pairingReply
        if (reply === 'throw') throw new Error('Connection Closed')
        setTimeout(() => {
          if (reply === 'result') sock.ws.emit('frame', { tag: 'iq', attrs: { type: 'result', id: '1' }, content: [{ tag: 'link_code_companion_reg', attrs: {}, content: [] }] })
          else if (typeof reply === 'number') sock.ws.emit('frame', { tag: 'iq', attrs: { type: 'error', id: '1' }, content: [{ tag: 'error', attrs: { code: String(reply), text: 'refused' } }] })
        }, 10)
        return 'ABCD1234'
      },
    }
    wa.sockets.push(sock)
    return sock
  }
  /** Stands in for fetch() of the picture URLs (WhatsApp's CDN). */
  wa.fetch = async (url) => {
    wa.downloads.push(url)
    const bytes = wa.images[String(url).split('?')[0]]
    if (bytes === undefined) return new Response('no', { status: 404 })
    if (bytes === 'throw') throw new TypeError('fetch failed')
    return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } })
  }
  /** The phone linked the device (QR scanned or code entered): pair-success, then the connection opens. */
  wa.link = (sock, phone = '998901234567', name = 'Manager One') => {
    sock.auth.creds.me = { id: `${phone}:7@s.whatsapp.net`, lid: '111222333444555:7@lid', name }
    sock.auth.creds.account = { details: Buffer.from('signed'), accountSignatureKey: Buffer.alloc(32, 1) }
    sock.emit('creds.update', { me: sock.auth.creds.me })
    sock.emit('connection.update', { connection: 'open' })
  }
  return wa
}

/** A fake CRM API: records POST /whatsapp/incoming, answers with `crm.status` (201 by default). */
export async function fakeCrm() {
  const crm = { requests: [], status: 201, body: { status: 'saved' } }
  crm.server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      crm.requests.push({ method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null })
      const status = typeof crm.status === 'function' ? crm.status(crm.requests.length) : crm.status
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(status < 300 ? crm.body : { message: 'no' }))
    })
  })
  await new Promise((resolve) => crm.server.listen(0, '127.0.0.1', resolve))
  crm.url = `http://127.0.0.1:${crm.server.address().port}/api/v1`
  crm.close = () => new Promise((resolve) => crm.server.close(resolve))
  return crm
}

export const waitFor = async (check, ms = 3000, step = 20) => {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, step))
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A WhatsApp message as Baileys gives it in messages.upsert. */
export function waMessage({ id = 'ABCDEF1234567890', jid = '998907654321@s.whatsapp.net', fromMe = false, message, ts, pushName = 'Client Name', key = {}, ...rest } = {}) {
  return {
    key: { remoteJid: jid, fromMe, id, ...key },
    message: message === undefined ? { conversation: 'hello' } : message,
    messageTimestamp: ts ?? Math.floor(Date.now() / 1000),
    pushName,
    ...rest,
  }
}

/** The whole service on a free port: fake WhatsApp, fake CRM, real HTTP API, outbox and session manager. */
export async function harness(t, { config: more = {}, download, logger = silent, clock } = {}) {
  const dir = await tempDir()
  const config = testConfig(dir, more)
  await fs.mkdir(config.uploadsDir, { recursive: true })
  const crm = await fakeCrm()
  const key = newKey()
  const outbox = new Outbox({ file: path.join(config.sessionsDir, 'outbox.json'), key, logger: silent, client: new CrmClient({ baseUrl: crm.url, token: TOKEN }) })
  const wa = fakeWhatsApp()
  const makePhotos = () => new PhotoCache({
    file: path.join(config.sessionsDir, 'photos.json'), key, uploadsDir: config.uploadsDir, maxBytes: 64 * 1024,
    fetchImpl: wa.fetch, now: clock || Date.now, logger: silent,
  })
  const photos = makePhotos()
  const manager = new SessionManager({ config, key, outbox, logger, baileysLogger: logger, socketFactory: wa.factory, download, photos })
  outbox.onResult = (p, r) => manager.onDelivered(p, r)
  const server = createHttpServer({ manager, outbox, token: TOKEN, logger: silent })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const api = async (method, url, body, token = TOKEN) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-WhatsApp-Service-Token': token } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
  t.after(async () => { await manager.stopAll(); server.close(); await crm.close() })
  return { dir, config, crm, key, outbox, wa, manager, api, photos, makePhotos }
}

/** start -> QR -> scanned: a connected session for user 5. */
export async function connected(h, userId = 5) {
  const pending = h.api('POST', `/sessions/${userId}/start`)
  await waitFor(() => h.wa.sockets.length)
  h.wa.last.emit('connection.update', { qr: 'QR-1' })
  assert.equal((await pending).body.status, 'qr')
  h.wa.link(h.wa.last)
  await waitFor(() => h.manager.state(userId).status === 'connected')
  await h.manager.sessions.get(userId).store.persist() // the linked creds are on disk
  return h.wa.last
}
