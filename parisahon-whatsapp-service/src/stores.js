// Small sealed files of the service next to the sessions (AES-256-GCM like them, mode 600):
//   states.json  SessionMarks   who has to be connected but is not: a number unlinked on the phone stays
//                               'logged_out' after a restart (not a silent 'none') until the manager links it
//                               again or the CRM disconnects it (WA-1)
//   inbox.json   InboxJournal   messages WhatsApp handed over and the CRM has not got yet: a message is
//                               written here at once, removed when it reached the outbox or the API, and
//                               handled again after a restart or a crash (WA-9: WhatsApp does not redeliver)
//   sent.json    SentStore      the messages sent through POST /send for 7 days, for Baileys' getMessage:
//                               a client's phone that could not decrypt one asks for it again (WA-15)
// Messages are kept as protobuf bytes (packMessage): nothing of what WhatsApp sent is lost in the file.
import fs from 'node:fs/promises'
import { BufferJSON, proto } from '@whiskeysockets/baileys'
import { open, seal } from './crypto-box.js'
import { readIfExists, writePrivateFile } from './files.js'

class SealedJson {
  constructor({ file, key, label, logger, binary = false }) {
    Object.assign(this, { file, key, label, logger, binary })
    this.saving = Promise.resolve()
  }

  async read(fallback) {
    const text = await readIfExists(this.file)
    if (!text) return fallback
    try {
      return JSON.parse(open(text, this.key, this.label), this.binary ? BufferJSON.reviver : undefined)
    } catch (error) {
      await fs.rename(this.file, `${this.file}.unreadable-${Date.now()}`).catch(() => {})
      this.logger?.warn(`${this.label} cannot be read (${error.message}), starting empty`)
      return fallback
    }
  }

  write(data) {
    let text
    try {
      text = seal(JSON.stringify(data, this.binary ? BufferJSON.replacer : undefined), this.key, this.label)
    } catch (error) {
      this.logger?.warn({ err: error }, `${this.label} cannot be serialized`)
      return this.saving
    }
    this.saving = this.saving.then(() => writePrivateFile(this.file, text)).catch((error) => {
      this.logger?.warn({ err: error }, `${this.label} cannot be written`)
    })
    return this.saving
  }
}

/** user id -> {status: 'logged_out', phone, name, at}: numbers that were unlinked on the phone. */
export class SessionMarks {
  constructor({ file, key, logger }) {
    this.box = new SealedJson({ file, key, label: 'wa-states', logger })
    this.map = new Map()
  }

  get saving() { return this.box.saving }

  async load() {
    const data = await this.box.read({ users: {} })
    for (const [id, mark] of Object.entries(data.users || {})) {
      const userId = Number(id)
      if (Number.isInteger(userId) && userId > 0 && mark?.status) this.map.set(userId, mark)
    }
  }

  get(userId) { return this.map.get(userId) || null }

  entries() { return [...this.map.entries()] }

  set(userId, mark) {
    this.map.set(userId, { ...mark, at: mark.at || new Date().toISOString() })
    return this.save()
  }

  clear(userId) {
    if (!this.map.has(userId)) return Promise.resolve()
    this.map.delete(userId)
    return this.save()
  }

  save() {
    return this.box.write({ v: 1, users: Object.fromEntries(this.map) })
  }
}

const journalKey = (userId, msg) => `${userId}/${msg?.key?.remoteJid}/${msg?.key?.id}`
const JOURNAL_KEEP_MS = 7 * 24 * 3600 * 1000

/**
 * A Baileys message as text that survives the file without losing anything: the protobuf bytes (media
 * keys, Longs and enums exactly as WhatsApp sent them) plus the key as it is (Baileys adds remoteJidAlt,
 * senderPn ... which are not in the protobuf schema).
 */
export function packMessage(msg) {
  const key = { ...(msg?.key || {}) }
  try {
    return { key, pb: Buffer.from(proto.WebMessageInfo.encode(msg).finish()).toString('base64') }
  } catch {
    // not a protobuf-shaped object: kept as JSON (Buffers survive through BufferJSON)
    return { key, json: JSON.stringify(msg, BufferJSON.replacer) }
  }
}

export function unpackMessage(packed) {
  let msg
  if (packed?.pb) {
    msg = proto.WebMessageInfo.decode(Buffer.from(packed.pb, 'base64'))
    const ts = msg.messageTimestamp
    if (ts && typeof ts === 'object' && typeof ts.toNumber === 'function') msg.messageTimestamp = ts.toNumber()
  } else if (packed?.json) {
    msg = JSON.parse(packed.json, BufferJSON.reviver)
  } else {
    return null
  }
  msg.key = { ...(packed.key || {}) }
  return msg
}

/** Messages in the hands of the service: written before they are handled, removed after (WA-9). */
export class InboxJournal {
  constructor({ file, key, logger, maxItems = 2000, now = Date.now }) {
    this.box = new SealedJson({ file, key, label: 'wa-inbox', logger })
    this.items = new Map() // key -> { userId, packed, at, old }
    this.maxItems = maxItems
    this.logger = logger
    this.now = now
  }

  get saving() { return this.box.saving }

  get size() { return this.items.size }

  async load() {
    const data = await this.box.read({ items: [] })
    const limit = this.now() - JOURNAL_KEEP_MS
    let dropped = 0
    for (const item of data.items || []) {
      if (!item?.packed?.key?.id || !Number.isInteger(item.userId)) continue
      // a message of a number that never came back within a week: nothing can be done with it any more
      if (!(item.at > limit)) { dropped += 1; continue }
      this.items.set(`${item.userId}/${item.packed.key.remoteJid}/${item.packed.key.id}`, { ...item, old: true })
    }
    if (dropped) this.logger?.warn(`inbox: ${dropped} message(s) older than a week forgotten`)
    if (this.items.size) this.logger?.warn(`inbox: ${this.items.size} message(s) of the last run were not handed to the CRM, they are handled again`)
  }

  add(userId, msg) {
    this.items.set(journalKey(userId, msg), { userId, packed: packMessage(msg), at: this.now() })
    if (this.items.size > this.maxItems) {
      const oldest = this.items.keys().next().value
      this.items.delete(oldest)
      this.logger?.error('inbox: too many messages waiting, the oldest one is forgotten')
    }
    return this.save()
  }

  done(userId, msg) {
    if (!this.items.delete(journalKey(userId, msg))) return Promise.resolve()
    return this.save()
  }

  /** The messages of the last run for this user (handled again once its socket is open), taken out of the "old" set. */
  takeOld(userId) {
    const out = []
    for (const item of this.items.values()) {
      if (item.userId === userId && item.old) {
        item.old = false
        try {
          const msg = unpackMessage(item.packed)
          if (msg) out.push(msg)
        } catch (error) {
          this.logger?.warn(`inbox: a stored message of user ${userId} cannot be read (${error.message})`)
        }
      }
    }
    return out
  }

  /** The CRM disconnected this number: what it still had cannot be handled any more. */
  forgetUser(userId) {
    let changed = false
    for (const [k, item] of this.items) if (item.userId === userId) { this.items.delete(k); changed = true }
    return changed ? this.save() : Promise.resolve()
  }

  save() {
    return this.box.write({ v: 2, items: [...this.items.values()].map(({ userId, packed, at }) => ({ userId, packed, at })) })
  }
}

/** id -> the message sent through POST /send (protobuf bytes), for getMessage: a resend to a device that asks (WA-15). */
export class SentStore {
  constructor({ file, key, logger, ttlMs = 7 * 24 * 3600 * 1000, maxItems = 3000, now = Date.now }) {
    this.box = new SealedJson({ file, key, label: 'wa-sent', logger })
    Object.assign(this, { ttlMs, maxItems, now, logger })
    this.items = new Map() // id -> { at, pb }
    this.timer = null
  }

  get saving() { return this.box.saving }

  get size() { return this.items.size }

  async load() {
    const data = await this.box.read({ items: {} })
    const limit = this.now() - this.ttlMs
    for (const [id, item] of Object.entries(data.items || {})) {
      if (item?.pb && item.at > limit) this.items.set(id, item)
    }
  }

  remember(id, message) {
    if (!id || !message) return
    let pb
    try {
      pb = Buffer.from(proto.Message.encode(message).finish()).toString('base64')
    } catch (error) {
      this.logger?.warn(`sent message ${String(id).slice(0, 6)} not kept for resends: ${error.message}`)
      return
    }
    this.items.delete(id)
    this.items.set(id, { at: this.now(), pb })
    while (this.items.size > this.maxItems) this.items.delete(this.items.keys().next().value)
    this.scheduleSave()
  }

  /** Baileys' getMessage(key): the proto of a message this service sent, or undefined. */
  get(key) {
    const item = this.items.get(key?.id)
    if (!item || item.at < this.now() - this.ttlMs) return undefined
    try {
      return proto.Message.decode(Buffer.from(item.pb, 'base64'))
    } catch {
      return undefined
    }
  }

  // writes are coalesced: a burst of sends is one write
  scheduleSave() {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.save() }, 1000)
    this.timer.unref?.()
  }

  save() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const limit = this.now() - this.ttlMs
    for (const [id, item] of this.items) if (item.at < limit) this.items.delete(id)
    return this.box.write({ v: 2, items: Object.fromEntries(this.items) })
  }
}
