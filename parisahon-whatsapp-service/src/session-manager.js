// One Baileys socket per CRM user (manager). States:
//   none        no session
//   starting    socket opening (a new QR or code coming, or a linked session reconnecting)
//   qr          waiting for the QR to be scanned (qr = the latest QR string, it rotates)
//   code        waiting for the pairing code to be entered on the phone (linking by phone number)
//   connected   linked and online (phone, name)
//   logged_out  the device was unlinked on the phone (the stored session is deleted)
// A QR or code not used within QR_TIMEOUT_SEC (WhatsApp itself ends it after ~160 s) stops the
// session (status none).
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DisconnectReason, buildAckStanza, downloadMediaMessage, generateMessageIDV2, jidNormalizedUser } from '@whiskeysockets/baileys'
import { openAuthStore, listStoredSessions, setAsideUnreadable, sessionFile } from './auth-store.js'
import { buildPayload, chatKind, describeMessage, phoneFromJid, reasonToSkip, resolveChat, timestampSec, userOf } from './message-map.js'
import { saveMedia, removeFiles, EXT_MIME } from './media.js'
import { maskPhone, shortId, quietPrePairingAckErrors } from './log.js'

/** An error answered to the CRM API as {error, message, ...extra} with an HTTP status. */
export class ServiceError extends Error {
  constructor(status, error, message, extra = {}) {
    super(message)
    Object.assign(this, { status, error, extra })
  }
}
export const SendError = ServiceError

const RECONNECT_SEC = [2, 5, 10, 30, 60, 120, 300]
const TERMINAL = new Set([DisconnectReason.loggedOut, DisconnectReason.forbidden, DisconnectReason.multideviceMismatch])
const PAIRING_REPLY_MS = 8000

class BoundedSet {
  constructor(max) { this.max = max; this.map = new Map() }
  add(v) { this.map.delete(v); this.map.set(v, true); if (this.map.size > this.max) this.map.delete(this.map.keys().next().value) }
  has(v) { return this.map.has(v) }
}

class Session {
  constructor(userId, pairPhone = null) {
    this.userId = userId
    this.status = 'starting'
    this.qr = null
    this.pairPhone = pairPhone // digits: link by a pairing code instead of the QR
    this.code = null
    this.codeRequested = false
    this.pairError = null
    this.passkey = false
    this.phone = null
    this.name = null
    this.sock = null
    this.store = null
    this.gen = 0
    this.closing = false
    this.qrTimer = null
    this.reconnectTimer = null
    this.reconnects = 0
    this.sinceSec = 0
    this.ownIds = new BoundedSet(2000)
    this.seen = new BoundedSet(5000)
    this.contacts = new Map()
    this.queue = Promise.resolve()
    this.events = new EventEmitter()
  }

  setStatus(status) {
    this.status = status
    this.events.emit('change', status)
  }

  selfUsers() {
    const me = this.store?.state?.creds?.me
    return new Set([userOf(me?.id), userOf(me?.lid)].filter(Boolean))
  }

  linked() { return Boolean(this.store?.isLinked()) }
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms).unref?.())])

/** '+998 90 123-45-67' -> '998901234567'; null when it is not a phone number. */
export function phoneDigits(value) {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 15 ? digits : null
}

/** 'ABCD1234' -> 'ABCD-1234' (as WhatsApp shows it). */
export const formatCode = (code) => (String(code).length === 8 ? `${String(code).slice(0, 4)}-${String(code).slice(4)}` : String(code))

const childTags = (node) => (Array.isArray(node?.content) ? node.content.map((c) => c?.tag).filter(Boolean) : [])
function mentionsPasskey(node, depth = 0) {
  if (!node || depth > 3) return false
  if (/passkey/i.test(String(node.tag || '')) || /passkey/i.test(String(node.attrs?.type || ''))) return true
  return Array.isArray(node.content) && node.content.some((c) => mentionsPasskey(c, depth + 1))
}

export class SessionManager {
  /**
   * config: loadConfig(); key: Buffer|null; outbox: Outbox; logger / baileysLogger: log.js loggers;
   * socketFactory({auth, logger, config}) -> socket (wa-socket.js in production, a fake in tests);
   * download(msg, sock) -> Readable (media; Baileys in production).
   */
  constructor({ config, key, outbox, logger, baileysLogger, socketFactory, download, photos }) {
    Object.assign(this, { config, key, outbox, logger, baileysLogger: quietPrePairingAckErrors(baileysLogger || logger), socketFactory, photos })
    this.download = download || ((msg, sock) => downloadMediaMessage(msg, 'stream', {}, {
      logger: this.baileysLogger, reuploadRequest: sock.updateMediaMessage,
    }))
    this.sessions = new Map()
    this.removals = new Map() // user id -> deletion of a previous session file still running
    this.stopping = false
  }

  get count() { return this.sessions.size }

  state(userId) {
    const s = this.sessions.get(userId)
    if (!s) return { status: 'none' }
    const out = { status: s.status }
    if (s.status === 'qr' && s.qr) out.qr = s.qr
    if (s.status === 'code' && s.code) out.code = s.code
    if (s.phone) out.phone = s.phone
    if (s.name) out.name = s.name
    if (s.passkey && s.status !== 'connected') out.passkey = true
    return out
  }

  list() {
    return [...this.sessions.values()].map((s) => ({ user_id: s.userId, status: s.status, phone: s.phone || null }))
  }

  /** At service start: every stored, linked session is connected again. */
  async restoreAll() {
    const ids = await listStoredSessions(this.config.sessionsDir)
    for (const userId of ids) {
      if (this.sessions.has(userId)) continue
      const s = new Session(userId)
      try {
        s.store = await openAuthStore({ dir: this.config.sessionsDir, userId, key: this.key, logger: this.logger })
      } catch (error) {
        this.logger.error(`user ${userId}: stored WhatsApp session cannot be read (${error.message}); skipped, the manager connects again`)
        continue
      }
      if (this.sessions.has(userId)) continue // started through the API meanwhile
      if (!s.linked()) {
        // a QR or code that was never used: nothing to restore
        await s.store.remove()
        continue
      }
      this.sessions.set(userId, s)
      s.phone = phoneFromJid(s.store.state.creds.me.id)
      s.name = s.store.state.creds.me.name || null
      s.sinceSec = s.store.meta.linked_at || Math.floor(Date.now() / 1000)
      this.logger.info(`user ${userId}: restoring WhatsApp session ${maskPhone(s.phone)}`)
      this.openSocket(s).catch((error) => this.socketFailed(s, error))
    }
  }

  /**
   * POST /sessions/:id/start [{phone}]: reuses a running session, else opens a new one and waits for
   * the QR (no phone) or the pairing code for that phone number, or the connection.
   * A phone given for a session still waiting on a QR (or a code for another number) replaces it.
   */
  async start(userId, { phone } = {}) {
    let digits = null
    if (phone !== undefined && phone !== null && String(phone).trim() !== '') {
      digits = phoneDigits(phone)
      if (!digits) throw new ServiceError(400, 'bad phone', 'Неверный номер телефона')
    }
    let s = this.sessions.get(userId)
    if (s && ['starting', 'qr', 'code', 'connected'].includes(s.status)) {
      const replace = digits && s.store && !s.linked() && s.pairPhone !== digits
      if (!replace) {
        if (s.status === 'starting') await this.waitForState(s, this.config.startWaitMs)
        return this.state(userId)
      }
      this.logger.info(`user ${userId}: ${s.status === 'qr' ? 'QR' : 'unfinished'} session replaced by linking with a phone number`)
      this.forget(s)
      await this.removeStore(s)
    } else if (s) {
      this.forget(s)
    }
    s = new Session(userId, digits)
    this.sessions.set(userId, s) // before any await: a second call reuses it
    try {
      await this.removals.get(userId) // a previous session file must be gone before this one is written
      try {
        s.store = await openAuthStore({ dir: this.config.sessionsDir, userId, key: this.key, logger: this.logger })
      } catch (error) {
        const aside = await setAsideUnreadable(this.config.sessionsDir, userId)
        this.logger.error(`user ${userId}: stored session unreadable (${error.message}), moved to ${path.basename(aside)}; linking again`)
        s.store = await openAuthStore({ dir: this.config.sessionsDir, userId, key: this.key, logger: this.logger })
      }
      if (s.linked()) {
        s.pairPhone = null
        s.phone = phoneFromJid(s.store.state.creds.me.id)
        s.sinceSec = s.store.meta.linked_at || Math.floor(Date.now() / 1000)
      } else if (s.store.state.creds.me) {
        // left over from an unfinished pairing code: start clean
        await s.store.remove()
        s.store = await openAuthStore({ dir: this.config.sessionsDir, userId, key: this.key, logger: this.logger })
      }
      if (this.sessions.get(userId) !== s) return this.state(userId)
      await this.openSocket(s)
    } catch (error) {
      this.socketFailed(s, error)
    }
    await this.waitForState(s, this.config.startWaitMs)
    if (s.pairError) throw s.pairError
    return this.state(userId)
  }

  waitForState(s, ms) {
    if (s.status !== 'starting') return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); s.events.off('change', onChange); resolve() }
      const onChange = (status) => { if (status !== 'starting') done() }
      const timer = setTimeout(done, ms)
      s.events.on('change', onChange)
    })
  }

  /** Deletes the session file; a new session of the same user waits for it (start). */
  removeStore(s) {
    if (!s.store) return Promise.resolve()
    const p = s.store.remove().catch(() => {})
    this.removals.set(s.userId, p)
    p.then(() => { if (this.removals.get(s.userId) === p) this.removals.delete(s.userId) })
    return p
  }

  async openSocket(s) {
    const gen = ++s.gen
    s.closing = false
    const sock = await this.socketFactory({
      auth: s.store.state,
      logger: this.baileysLogger.child({ user: s.userId }),
      config: this.config,
    })
    if (gen !== s.gen || this.sessions.get(s.userId) !== s) {
      try { sock.end(undefined) } catch { /* already closed */ }
      return
    }
    s.sock = sock
    sock.ws?.on?.('frame', (node) => { if (gen === s.gen) this.watchPairingFrame(s, sock, node) })
    sock.ev.on('creds.update', (update) => {
      if (gen === s.gen && update?.me?.name && update.me.name !== '~') s.name = update.me.name
      s.store.saveCreds().catch(() => {})
    })
    sock.ev.on('connection.update', (update) => this.onConnection(s, gen, update))
    sock.ev.on('messages.upsert', ({ messages }) => {
      if (gen !== s.gen) return
      for (const msg of messages || []) {
        s.queue = s.queue.then(() => this.handleMessage(s, msg)).catch((error) => {
          this.logger.error({ err: error }, `user ${s.userId}: message ${shortId(msg?.key?.id)} not processed`)
        })
      }
    })
    const remember = (list) => {
      for (const c of list || []) {
        if (!c?.id) continue
        const id = jidNormalizedUser(c.id)
        const merged = { ...(s.contacts.get(id) || {}), ...c, id }
        s.contacts.set(id, merged)
        if (c.lid) s.contacts.set(jidNormalizedUser(c.lid), { ...merged, phoneNumber: merged.phoneNumber || (phoneFromJid(id) ? id : undefined) })
        if (c.phoneNumber && phoneFromJid(c.phoneNumber)) s.contacts.set(jidNormalizedUser(c.phoneNumber), merged)
      }
    }
    sock.ev.on('contacts.upsert', remember)
    sock.ev.on('contacts.update', remember)
    // the first sync after linking: only the contacts are used (names, LID <-> phone), never the messages
    sock.ev.on('messaging-history.set', ({ contacts }) => remember(contacts))
  }

  /**
   * Raw frames while the device is not linked yet:
   *  - a notification before creds.me exists is acked here (Baileys' own ack needs creds.me.id and throws);
   *  - a passkey request (WhatsApp's "Continue on WhatsApp Web" for accounts with a passkey) is logged:
   *    Baileys cannot answer it, the phone-number code is the way out;
   *  - other notifications are logged by type (no contents) to see what WhatsApp sends during pairing.
   */
  watchPairingFrame(s, sock, node) {
    if (!node || node instanceof Uint8Array || !node.tag || s.linked()) return
    if (mentionsPasskey(node)) {
      if (!s.passkey) {
        this.logger.info(`user ${s.userId}: WhatsApp asks for a passkey (${node.tag} ${node.attrs?.type || ''} ${childTags(node).join(',')}): use the phone-number code instead`)
      }
      s.passkey = true
      s.events.emit('change', s.status)
    }
    if (node.tag === 'notification') {
      this.logger.info(`user ${s.userId}: pairing notification type=${node.attrs?.type || '-'} [${childTags(node).join(',')}]`)
      if (!s.store?.state?.creds?.me?.id && typeof sock.sendNode === 'function') {
        Promise.resolve().then(() => sock.sendNode(buildAckStanza(node))).catch(() => {})
      }
    }
  }

  /**
   * Linking by phone number: asks WhatsApp for a pairing code once the socket is up (the first
   * QR event means the server is ready) and waits briefly for WhatsApp's answer to the request.
   * WhatsApp does not say whether the number has an account: the code is simply never used then.
   */
  async requestCode(s, gen, sock) {
    s.codeRequested = true
    let finish
    const reply = new Promise((resolve) => { finish = resolve })
    const onFrame = (node) => {
      if (node?.tag !== 'iq') return
      const first = Array.isArray(node.content) ? node.content[0] : null
      if (node.attrs?.type === 'result' && first?.tag === 'link_code_companion_reg') finish({ ok: true })
      else if (node.attrs?.type === 'error') {
        const err = Array.isArray(node.content) ? node.content.find((c) => c?.tag === 'error') : null
        finish({ ok: false, code: Number(err?.attrs?.code) || 0, text: err?.attrs?.text || '' })
      }
    }
    const timer = setTimeout(() => finish({ ok: true, unconfirmed: true }), PAIRING_REPLY_MS)
    sock.ws?.on?.('frame', onFrame)
    try {
      const raw = await sock.requestPairingCode(s.pairPhone)
      const answer = await reply
      if (gen !== s.gen || this.sessions.get(s.userId) !== s) return
      if (!answer.ok) {
        this.logger.warn(`user ${s.userId}: WhatsApp refused a pairing code for ${maskPhone(`+${s.pairPhone}`)} (${answer.code} ${answer.text})`)
        s.pairError = answer.code === 429
          ? new ServiceError(429, 'too many attempts', 'WhatsApp: слишком много попыток привязки, попробуйте позже')
          : answer.code >= 400 && answer.code < 500
            ? new ServiceError(400, 'phone rejected', 'WhatsApp не принял этот номер для привязки')
            : new ServiceError(502, 'pairing failed', `WhatsApp не выдал код привязки (${answer.code || 'ошибка'})`)
        await this.abandon(s, 'pairing code refused')
        return
      }
      s.code = formatCode(raw)
      this.logger.info(`user ${s.userId}: pairing code ready for ${maskPhone(`+${s.pairPhone}`)}, waiting for it to be entered on the phone`)
      s.setStatus('code')
    } catch (error) {
      if (gen !== s.gen || this.sessions.get(s.userId) !== s) return
      this.logger.warn({ err: error }, `user ${s.userId}: pairing code request failed`)
      s.pairError = new ServiceError(502, 'pairing failed', `WhatsApp не выдал код привязки: ${error.message}`)
      await this.abandon(s, 'pairing code request failed')
    } finally {
      clearTimeout(timer)
      sock.ws?.off?.('frame', onFrame)
    }
  }

  socketFailed(s, error) {
    this.logger.error({ err: error }, `user ${s.userId}: WhatsApp socket could not be opened`)
    if (s.linked()) this.scheduleReconnect(s, null)
    else this.abandon(s, 'socket failed').catch(() => {})
  }

  onConnection(s, gen, update) {
    if (gen !== s.gen || this.sessions.get(s.userId) !== s) return
    const { connection, lastDisconnect, qr, isNewLogin } = update
    if (qr) {
      s.qr = qr
      if (!s.qrTimer) {
        if (!s.pairPhone) this.logger.info(`user ${s.userId}: QR ready, waiting for the phone to scan it`)
        s.qrTimer = setTimeout(() => {
          if (s.linked()) return
          this.logger.info(`user ${s.userId}: ${s.pairPhone ? 'code' : 'QR'} not used in ${this.config.qrTimeoutMs / 1000}s, session stopped`)
          this.abandon(s, 'qr timeout').catch(() => {})
        }, this.config.qrTimeoutMs)
        s.qrTimer.unref?.()
      }
      if (s.pairPhone) {
        // linking by phone number: the QR is not shown, the code is asked for once
        if (!s.codeRequested && s.sock) this.requestCode(s, gen, s.sock).catch(() => {})
      } else {
        s.setStatus('qr')
      }
    }
    if (isNewLogin) {
      this.logger.info(`user ${s.userId}: pair-success: the phone linked this device (${maskPhone(phoneFromJid(s.store.state.creds.me?.id))})`)
    }
    if (connection === 'open') {
      clearTimeout(s.qrTimer)
      s.qrTimer = null
      s.qr = null
      s.code = null
      s.pairPhone = null
      s.passkey = false
      s.reconnects = 0
      const me = s.store.state.creds.me || s.sock?.user || {}
      s.phone = phoneFromJid(me.id) || s.phone
      const name = me.name && me.name !== '~' ? me.name : me.notify || me.verifiedName || s.sock?.user?.name
      s.name = name && name !== '~' ? name : s.name
      if (!s.store.meta.linked_at) {
        s.store.setMeta({ linked_at: Math.floor(Date.now() / 1000) }).catch(() => {})
      }
      s.sinceSec = s.store.meta.linked_at
      this.logger.info(`user ${s.userId}: WhatsApp connected ${maskPhone(s.phone)}`)
      s.setStatus('connected')
    }
    if (connection === 'close') {
      if (s.closing || this.stopping) return
      const code = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode
      const linked = s.linked()
      s.sock = null
      if (TERMINAL.has(code) && linked) {
        this.logger.warn(`user ${s.userId}: WhatsApp logged out (${code}): the device was unlinked on the phone`)
        clearTimeout(s.reconnectTimer)
        this.removeStore(s)
        s.qr = null
        s.setStatus('logged_out')
        return
      }
      if (code === DisconnectReason.restartRequired) {
        // right after pairing (QR or code) WhatsApp asks for a new connection
        this.logger.info(`user ${s.userId}: WhatsApp asks for a restart after pairing (515), reconnecting`)
        clearTimeout(s.qrTimer)
        s.qrTimer = null
        s.qr = null
        s.code = null
        s.setStatus('starting')
        this.openSocket(s).catch((error) => this.socketFailed(s, error))
        return
      }
      if (!linked) {
        this.logger.info(`user ${s.userId}: ${s.pairPhone ? 'code' : 'QR'} session closed (${code ?? 'no code'}: ${lastDisconnect?.error?.message || ''})`)
        this.abandon(s, `closed before the ${s.pairPhone ? 'code was entered' : 'QR was scanned'}`).catch(() => {})
        return
      }
      this.scheduleReconnect(s, code)
    }
  }

  scheduleReconnect(s, code) {
    if (s.closing || this.stopping) return
    clearTimeout(s.reconnectTimer)
    const base = RECONNECT_SEC[Math.min(s.reconnects, RECONNECT_SEC.length - 1)]
    // 440: the same session was opened elsewhere; do not fight over it every few seconds
    const pause = code === DisconnectReason.connectionReplaced ? Math.max(base, 60) : base
    s.reconnects += 1
    this.logger.warn(`user ${s.userId}: WhatsApp connection closed (${code ?? 'error'}), reconnect in ${pause}s`)
    s.setStatus('starting')
    s.reconnectTimer = setTimeout(() => {
      if (this.sessions.get(s.userId) !== s || s.closing) return
      this.openSocket(s).catch((error) => this.socketFailed(s, error))
    }, pause * 1000)
    s.reconnectTimer.unref?.()
  }

  /** A session that never got linked: closed, its creds deleted, status none. */
  async abandon(s, reason) {
    if (this.sessions.get(s.userId) !== s) return
    this.forget(s)
    this.logger.info(`user ${s.userId}: session stopped (${reason})`)
    await this.removeStore(s)
  }

  /** Drops the session from memory and closes its socket (nothing is deleted on the phone). */
  forget(s) {
    s.closing = true
    s.gen += 1
    clearTimeout(s.qrTimer)
    clearTimeout(s.reconnectTimer)
    try { s.sock?.end(undefined) } catch { /* closed */ }
    s.sock = null
    if (this.sessions.get(s.userId) === s) this.sessions.delete(s.userId)
    s.setStatus('none')
  }

  /** DELETE /sessions/:id: unlinks the device on the phone (when online) and deletes the stored session. */
  async logout(userId) {
    const s = this.sessions.get(userId)
    if (s) {
      if (s.status === 'starting' && s.linked()) await this.waitForState(s, this.config.startWaitMs)
      if (s.status === 'connected' && s.sock) {
        s.closing = true
        try {
          await withTimeout(s.sock.logout(), 10000)
          this.logger.info(`user ${userId}: WhatsApp device unlinked`)
        } catch (error) {
          this.logger.warn({ err: error }, `user ${userId}: logout request failed, the session is deleted anyway`)
        }
      }
      this.forget(s)
      await this.removeStore(s)
    }
    await this.removals.get(userId)
    await fs.rm(sessionFile(this.config.sessionsDir, userId), { force: true })
    if (s) this.logger.info(`user ${userId}: WhatsApp session deleted`)
    return { status: 'none' }
  }

  async stopAll() {
    this.stopping = true
    for (const s of this.sessions.values()) {
      s.closing = true
      clearTimeout(s.qrTimer)
      clearTimeout(s.reconnectTimer)
      try { s.sock?.end(undefined) } catch { /* closed */ }
      await s.store?.flush()
    }
  }

  // ---------------------------------------------------------------- incoming

  async handleMessage(s, msg) {
    const reason = reasonToSkip(msg, { sinceSec: s.sinceSec, ownIds: s.ownIds, selfUsers: s.selfUsers() })
    if (reason) {
      if (chatKind(msg?.key?.remoteJid) === 'user') this.logger.debug(`user ${s.userId}: message ${shortId(msg?.key?.id)} skipped: ${reason}`)
      return null
    }
    const dedupKey = `${msg.key.remoteJid}/${msg.key.id}`
    if (s.seen.has(dedupKey)) return null
    s.seen.add(dedupKey)

    const sock = s.sock
    const chat = await resolveChat(msg, {
      selfUsers: s.selfUsers(),
      lidToPn: (lid) => sock?.signalRepository?.lidMapping?.getPNForLID?.(lid),
      contact: (jid) => s.contacts.get(jid),
    })
    // the client's profile picture: with the first message of the chat after the start, then once a day
    chat.photo = this.photos && sock ? await this.photos.forMessage(sock, chat.wa_id) : null
    const d = describeMessage(msg)
    let text = d.text || ''
    const files = []
    if (d.media) {
      const saved = await saveMedia({
        msg, media: d.media, uploadsDir: this.config.uploadsDir, maxFileMb: this.config.maxFileMb, ffmpegBin: this.config.ffmpegBin,
        download: (m) => this.download(m, sock), logger: this.logger, timestampSec: timestampSec(msg.messageTimestamp),
      })
      if (saved.file) files.push(saved.file)
      if (saved.note) text = text ? `${text}\n${saved.note}` : saved.note
    }
    const payload = buildPayload({ msg, agentId: s.userId, agentPhone: s.phone, chat, text, files })
    const result = await this.outbox.deliver(payload)
    this.logger.info(`user ${s.userId}: ${payload.outgoing ? 'outgoing' : 'incoming'} message ${shortId(payload.wa_message_id)} ` +
      `chat ${maskPhone(chat.phone || chat.wa_id)}${files.length ? ` +${files.length} file` : ''}: ${result ? result.status || 'ok' : 'queued/dropped'}`)
    return payload
  }

  /** Outbox callback: the API does not want this chat -> its files are not kept. */
  async onDelivered(payload, result) {
    if (result?.status === 'ignored' && payload?.files?.length) await removeFiles(this.config.uploadsDir, payload.files)
  }

  // ---------------------------------------------------------------- resolve

  /** POST /resolve: does this number have WhatsApp (asked through the manager's session), and its picture. */
  async resolve({ userId, phone }) {
    const digits = phoneDigits(phone)
    if (!digits) throw new ServiceError(400, 'bad phone', 'Неверный номер телефона')
    const s = this.sessions.get(userId)
    if (!s || s.status !== 'connected' || !s.sock) {
      throw new ServiceError(400, 'not connected', 'Ваш WhatsApp не подключён (Профиль → WhatsApp)')
    }
    const sock = s.sock
    let found
    try {
      ;[found] = (await sock.onWhatsApp(digits)) || []
    } catch (error) {
      throw new ServiceError(502, 'whatsapp error', `WhatsApp не ответил: ${error.message}`)
    }
    if (!found?.exists || !found.jid) return { wa_id: null, photo: null }
    const waId = jidNormalizedUser(found.jid)
    const photo = this.photos ? await this.photos.current(sock, waId).catch(() => null) : null
    return { wa_id: waId, photo: photo || null }
  }

  // ---------------------------------------------------------------- outgoing

  /** POST /send. Returns { message_ids } or throws SendError. */
  async send({ userId, toPhone, toWaId, text, files }) {
    const s = this.sessions.get(userId)
    if (!s || s.status !== 'connected' || !s.sock) {
      throw new ServiceError(400, 'not connected', 'Ваш WhatsApp не подключён (Профиль → WhatsApp)')
    }
    const sock = s.sock
    const list = Array.isArray(files) ? files : []
    const prepared = []
    for (const f of list) {
      const name = String(f?.path || '')
      if (!name || path.basename(name) !== name || name.startsWith('.')) {
        throw new ServiceError(400, 'bad file', `Неверный файл: ${f?.name || name}`)
      }
      const abs = path.join(this.config.uploadsDir, name)
      try {
        const st = await fs.stat(abs)
        if (!st.isFile()) throw new Error('not a file')
      } catch {
        throw new ServiceError(400, 'file not found', `Файл не найден: ${f?.name || name}`)
      }
      prepared.push({ ...f, abs })
    }
    const body = typeof text === 'string' ? text : ''
    if (!body.trim() && prepared.length === 0) throw new ServiceError(400, 'nothing to send', 'Нечего отправлять')

    let jid
    const digits = String(toPhone || '').replace(/\D/g, '')
    if (digits) {
      if (digits.length < 7 || digits.length > 15) throw new ServiceError(400, 'bad phone', 'Неверный номер телефона')
      let found
      try {
        ;[found] = (await sock.onWhatsApp(digits)) || []
      } catch (error) {
        throw new ServiceError(502, 'whatsapp error', `WhatsApp не ответил: ${error.message}`)
      }
      if (!found?.exists) throw new ServiceError(400, 'not on whatsapp', 'У этого номера нет WhatsApp')
      jid = found.jid
    } else if (toWaId) {
      if (chatKind(String(toWaId)) !== 'user') throw new ServiceError(400, 'bad wa_id', 'Неверный адрес чата WhatsApp')
      jid = jidNormalizedUser(String(toWaId))
    } else {
      throw new ServiceError(400, 'no recipient', 'Не указан получатель')
    }

    const ids = []
    const sendOne = async (content) => {
      const messageId = generateMessageIDV2(sock.user?.id)
      s.ownIds.add(messageId)
      const sent = await sock.sendMessage(jid, content, { messageId })
      const id = sent?.key?.id || messageId
      s.ownIds.add(id)
      ids.push(id)
    }
    try {
      for (const f of prepared) await sendOne(mediaContent(f))
      if (body.trim()) await sendOne({ text: body })
    } catch (error) {
      this.logger.error({ err: error }, `user ${userId}: send to ${maskPhone(digits || toWaId)} failed after ${ids.length} message(s)`)
      throw new ServiceError(502, 'send failed', `WhatsApp не принял сообщение: ${error.message}`, { message_ids: ids })
    }
    this.logger.info(`user ${userId}: sent ${ids.length} message(s) to ${maskPhone(digits || toWaId)}`)
    return { message_ids: ids }
  }
}

const IMAGE = new Set(['jpg', 'jpeg', 'png'])
const VIDEO = new Set(['mp4', '3gp', 'mov', 'm4v'])
const AUDIO = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus', 'amr', 'wav'])

/** Baileys content for a file of POST /send: image / video / audio / voice / sticker by type or extension, else a document. */
export function mediaContent(f) {
  const ext = path.extname(f.name || f.path || '').slice(1).toLowerCase() || path.extname(f.path || '').slice(1).toLowerCase()
  const type = String(f.type || '').toLowerCase()
  const url = { url: f.abs }
  const mimetype = EXT_MIME[ext]
  if (IMAGE.has(ext) && (type === '' || type === 'photo' || type === 'image')) return { image: url, mimetype }
  if (VIDEO.has(ext) && (type === '' || type === 'video' || type === 'video_note')) return { video: url, mimetype: mimetype || 'video/mp4' }
  if (type === 'voice' && (ext === 'ogg' || ext === 'opus')) return { audio: url, mimetype: 'audio/ogg; codecs=opus', ptt: true }
  if (AUDIO.has(ext) && (type === '' || type === 'audio' || type === 'voice')) return { audio: url, mimetype: mimetype || 'audio/mpeg' }
  if (type === 'sticker' && ext === 'webp') return { sticker: url }
  const fileName = (f.name && path.basename(String(f.name))) || path.basename(f.path)
  return { document: url, mimetype: mimetype || 'application/octet-stream', fileName }
}
