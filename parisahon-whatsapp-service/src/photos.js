// Clients' WhatsApp profile pictures for the CRM (chat.photo of the incoming payload, POST /resolve).
// A picture is looked up with the manager's session (sock.profilePictureUrl), downloaded into
// UPLOADS_DIR as <32 hex>.jpg and remembered per chat in SESSIONS_DIR/photos.json (sealed like the
// sessions): { wa_id: { checked_at, pic, file } }. `pic` is the picture's URL without the query
// (the query is only a signature that changes): the same `pic` = the same picture, nothing is
// downloaded again. A missing or hidden picture (privacy) is remembered as none; a failure is
// tried again after an hour. Nothing here ever fails a message: every problem gives null.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { open, seal } from './crypto-box.js'
import { readIfExists, writePrivateFile } from './files.js'
import { randomName, writeLimited } from './media.js'

const LABEL = 'wa-photos'
const NO_PICTURE = new Set([401, 403, 404])
const DAY = 24 * 3600 * 1000

export class PhotoCache {
  constructor({ file, key, uploadsDir, maxBytes = 5 * 1024 * 1024, ttlMs = DAY, errorTtlMs = 3600 * 1000,
    queryTimeoutMs = 8000, downloadTimeoutMs = 15000, logger, fetchImpl = globalThis.fetch, now = Date.now }) {
    Object.assign(this, { file, key, uploadsDir, maxBytes, ttlMs, errorTtlMs, queryTimeoutMs, downloadTimeoutMs, logger, fetch: fetchImpl, now })
    this.map = new Map()      // wa_id -> { checked_at, pic, file, failed? }
    this.sent = new Set()     // wa_ids whose photo went with a message since the service started
    this.inflight = new Map() // wa_id -> running lookup
    this.saving = Promise.resolve()
  }

  async load() {
    const text = await readIfExists(this.file)
    if (!text) return
    try {
      const data = JSON.parse(open(text, this.key, LABEL))
      for (const [jid, entry] of Object.entries(data.chats || {})) this.map.set(jid, entry)
    } catch (error) {
      await fsp.rename(this.file, `${this.file}.unreadable-${Date.now()}`).catch(() => {})
      this.logger?.warn(`photos.json cannot be read (${error.message}), starting empty`)
    }
  }

  save() {
    const text = seal(JSON.stringify({ v: 1, chats: Object.fromEntries(this.map) }), this.key, LABEL)
    this.saving = this.saving.then(() => writePrivateFile(this.file, text)).catch((error) => {
      this.logger?.warn({ err: error }, 'photos.json cannot be written')
    })
    return this.saving
  }

  fresh(entry) {
    if (!entry) return false
    return this.now() - entry.checked_at < (entry.failed ? this.errorTtlMs : this.ttlMs)
  }

  fileExists(name) {
    return Boolean(name) && fs.existsSync(path.join(this.uploadsDir, path.basename(name)))
  }

  /**
   * For a message of the chat: the photo file when it is due — the first message of the chat after the
   * service started, then once per 24 h — else null (the CRM keeps what it has).
   */
  async forMessage(sock, jid) {
    try {
      const entry = this.map.get(jid)
      const due = !this.sent.has(jid) || !this.fresh(entry)
      if (!due) return null
      const file = await this.current(sock, jid)
      this.sent.add(jid)
      return file
    } catch (error) {
      this.logger?.debug(`photo lookup failed: ${error.message}`)
      return null
    }
  }

  /** The chat's current photo file: remembered (checked within 24 h) or looked up now; null when there is none. */
  async current(sock, jid) {
    const entry = this.map.get(jid)
    if (this.fresh(entry) && (!entry.file || this.fileExists(entry.file))) return entry.file || null
    if (!this.inflight.has(jid)) {
      const run = this.refresh(sock, jid).finally(() => this.inflight.delete(jid))
      this.inflight.set(jid, run)
    }
    return this.inflight.get(jid)
  }

  async refresh(sock, jid) {
    const previous = this.map.get(jid)
    let url
    try {
      url = await sock.profilePictureUrl(jid, 'image', this.queryTimeoutMs)
    } catch (error) {
      const code = Number(error?.data) || error?.output?.statusCode
      if (NO_PICTURE.has(code) || /not-authorized|item-not-found|forbidden/.test(String(error?.message))) {
        return this.remember(jid, { pic: null, file: null })
      }
      this.logger?.debug(`profile picture query failed (${error?.message})`)
      return this.remember(jid, { pic: previous?.pic ?? null, file: previous?.file ?? null, failed: true })
    }
    if (!url) return this.remember(jid, { pic: null, file: null })
    const pic = String(url).split('?')[0]
    if (previous?.pic === pic && this.fileExists(previous.file)) return this.remember(jid, { pic, file: previous.file })
    // the same person under another id (phone number and LID): the picture is already here
    for (const other of this.map.values()) {
      if (other.pic === pic && this.fileExists(other.file)) return this.remember(jid, { pic, file: other.file })
    }
    const file = await this.download(url)
    if (!file) return this.remember(jid, { pic: previous?.pic ?? null, file: previous?.file ?? null, failed: true })
    return this.remember(jid, { pic, file })
  }

  remember(jid, { pic, file, failed = false }) {
    const entry = { checked_at: this.now(), pic, file }
    if (failed) entry.failed = true
    this.map.set(jid, entry)
    this.save()
    return failed && file && !this.fileExists(file) ? null : file
  }

  async download(url) {
    const name = randomName('jpg')
    const target = path.join(this.uploadsDir, name)
    try {
      const response = await this.fetch(url, { signal: AbortSignal.timeout(this.downloadTimeoutMs) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const type = String(response.headers.get('content-type') || '')
      if (type && !type.startsWith('image/')) throw new Error(`not an image (${type})`)
      const declared = Number(response.headers.get('content-length') || 0)
      if (declared > this.maxBytes) throw new Error('too large')
      await writeLimited(Readable.fromWeb(response.body), target, this.maxBytes)
      return name
    } catch (error) {
      await fsp.rm(target, { force: true })
      this.logger?.debug(`profile picture not downloaded (${error.message})`)
      return null
    }
  }
}
