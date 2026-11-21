// Delivery of messages to the CRM API (POST <CRM_API_URL>/whatsapp/incoming) with a persistent
// outbox: SESSIONS_DIR/outbox.json (sealed like the sessions, mode 600).
//   2xx            -> delivered ({status: saved|duplicate|ignored})
//   4xx            -> the API refused it: logged and dropped (sending again would not help)
//   5xx / network  -> kept in the outbox and sent again every POLL_SEC with a growing pause,
//                     in order (the outbox also survives restarts)
// The API never saves the same wa_message_id twice, so a retry after a half-failure is safe.
import { open, seal, NoKeyError, WrongKeyError } from './crypto-box.js'
import { writePrivateFile, readIfExists } from './files.js'
import { shortId } from './log.js'
import fs from 'node:fs/promises'

export class ApiUnavailable extends Error {}
export class ApiRefused extends Error {
  constructor(status, body) { super(`${status} ${String(body).slice(0, 300)}`); this.status = status }
}

export class CrmClient {
  constructor({ baseUrl, token, timeoutMs = 30000, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
    this.timeoutMs = timeoutMs
    this.fetch = fetchImpl
  }

  async postIncoming(payload) {
    if (!this.token) throw new ApiUnavailable('CRM_API_TOKEN is not set')
    let response
    try {
      response = await this.fetch(`${this.baseUrl}/whatsapp/incoming`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WhatsApp-Service-Token': this.token },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new ApiUnavailable(error?.cause?.code || error?.name || error?.message || 'network error')
    }
    const text = await response.text().catch(() => '')
    if (response.status >= 500) throw new ApiUnavailable(`${response.status} ${text.slice(0, 200)}`)
    if (response.status >= 400) throw new ApiRefused(response.status, text)
    try { return text ? JSON.parse(text) : {} } catch { return {} }
  }
}

const LABEL = 'wa-outbox'

export class Outbox {
  /**
   * file: SESSIONS_DIR/outbox.json; key: Buffer|null; client: CrmClient;
   * onResult(payload, result): called for every delivered message (now or from the outbox).
   */
  constructor({ file, key, client, pollSec = 10, maxBackoffSec = 300, maxItems = 5000, logger, onResult, now = Date.now }) {
    Object.assign(this, { file, key, client, pollSec, maxBackoffSec, maxItems, logger, onResult, now })
    this.items = []
    this.nextAt = 0
    this.attempts = 0
    this.flushing = null
    this.timer = null
    this.saving = Promise.resolve()
  }

  get size() { return this.items.length }

  async load() {
    const text = await readIfExists(this.file)
    if (!text) return
    try {
      const data = JSON.parse(open(text, this.key, LABEL))
      this.items = Array.isArray(data.items) ? data.items : []
      this.attempts = 0
      this.nextAt = 0
    } catch (error) {
      const aside = `${this.file}.unreadable-${Date.now()}`
      await fs.rename(this.file, aside).catch(() => {})
      const why = error instanceof NoKeyError || error instanceof WrongKeyError ? error.message : 'damaged file'
      this.logger?.error(`outbox cannot be read (${why}), moved aside to ${aside}`)
    }
  }

  save() {
    const text = seal(JSON.stringify({ v: 1, items: this.items }), this.key, LABEL)
    this.saving = this.saving.then(() => writePrivateFile(this.file, text)).catch((error) => {
      this.logger?.error({ err: error }, 'outbox cannot be written')
    })
    return this.saving
  }

  async enqueue(payload, reason) {
    this.items.push({ payload, queued_at: new Date(this.now()).toISOString(), last_error: String(reason).slice(0, 300) })
    if (this.items.length > this.maxItems) {
      const dropped = this.items.splice(0, this.items.length - this.maxItems)
      this.logger?.error(`outbox is full: ${dropped.length} oldest message(s) dropped`)
    }
    await this.save()
  }

  /** Sends now; on an unavailable API the message waits in the outbox. Returns the API answer or null. */
  async deliver(payload) {
    if (this.items.length > 0 || this.flushing) {
      // keep the order: everything goes through the queue until it is empty
      await this.enqueue(payload, 'queued behind older messages')
      if (this.now() >= this.nextAt) await this.flush()
      return null
    }
    try {
      const result = await this.client.postIncoming(payload)
      await this.onResult?.(payload, result)
      return result
    } catch (error) {
      if (error instanceof ApiRefused) {
        this.logger?.error(`API refused message ${shortId(payload.wa_message_id)}, dropped: ${error.message}`)
        return null
      }
      this.logger?.warn(`API unavailable, message ${shortId(payload.wa_message_id)} queued: ${error.message}`)
      await this.enqueue(payload, error.message)
      this.backoff()
      return null
    }
  }

  backoff() {
    this.attempts += 1
    const pause = Math.min(this.pollSec * 2 ** (this.attempts - 1), this.maxBackoffSec)
    this.nextAt = this.now() + pause * 1000
  }

  /** Resends queued messages in order; stops at the first one the API still cannot take. */
  flush() {
    if (this.flushing) return this.flushing
    this.flushing = (async () => {
      let sent = 0
      try {
        while (this.items.length > 0) {
          const item = this.items[0]
          try {
            const result = await this.client.postIncoming(item.payload)
            await this.onResult?.(item.payload, result)
            sent += 1
          } catch (error) {
            if (!(error instanceof ApiRefused)) {
              item.attempts = (item.attempts || 0) + 1
              item.last_error = error.message.slice(0, 300)
              this.backoff()
              await this.save()
              this.logger?.warn(`outbox: API still unavailable (${error.message}), ${this.items.length} waiting, next try in ${Math.round((this.nextAt - this.now()) / 1000)}s`)
              break
            }
            this.logger?.error(`API refused queued message ${shortId(item.payload?.wa_message_id)}, dropped: ${error.message}`)
          }
          this.items.shift()
          await this.save()
        }
        if (this.items.length === 0) { this.attempts = 0; this.nextAt = 0 }
        if (sent) this.logger?.info(`outbox: ${sent} queued message(s) delivered, ${this.items.length} left`)
        return sent
      } finally {
        this.flushing = null
      }
    })()
    return this.flushing
  }

  /** Every POLL_SEC: a flush when something waits and the pause is over. */
  start() {
    this.stop()
    this.timer = setInterval(() => {
      if (this.items.length > 0 && this.now() >= this.nextAt) this.flush().catch(() => {})
    }, this.pollSec * 1000)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
