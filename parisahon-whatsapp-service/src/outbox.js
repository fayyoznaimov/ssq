// Delivery of messages to the CRM API (POST <CRM_API_URL>/whatsapp/incoming) with a persistent
// outbox: SESSIONS_DIR/outbox.json (sealed like the sessions, mode 600).
//   2xx                     -> delivered ({status: saved|duplicate|ignored})
//   network, 502/503/504,   -> the API (or the way to it) is not ready, or refuses the service itself
//   401/403/408/425/429        (a changed token): kept in the outbox and sent again every POLL_SEC with a
//                              growing pause, in order, however long it takes (the outbox survives restarts)
//   other 5xx (500 ...)     -> the API is up but fails on this message: tried again with its own growing
//                              pause, without holding up the messages behind it; after MAX_FAILED_ATTEMPTS
//                              it is kept aside in `rejected`
//   other 4xx (400, 404,    -> the API refused this message (sending again would not help): kept aside in
//   409, 410, 413, 422 ...)    `rejected` (the last REJECTED_KEEP), never silently dropped; /health counts them
// The API never saves the same wa_message_id twice, so a retry after a half-failure is safe.
import { open, seal, NoKeyError, WrongKeyError } from './crypto-box.js'
import { writePrivateFile, readIfExists } from './files.js'
import { shortId } from './log.js'
import fs from 'node:fs/promises'

const UNAVAILABLE = new Set([401, 403, 408, 425, 429, 502, 503, 504])
export const MAX_FAILED_ATTEMPTS = 8
const REJECTED_KEEP = 500

export class ApiUnavailable extends Error {}
export class ApiFailed extends Error {
  constructor(status, body) { super(`${status} ${String(body).slice(0, 300)}`); this.status = status }
}
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
    if (UNAVAILABLE.has(response.status)) throw new ApiUnavailable(`${response.status} ${text.slice(0, 200)}`)
    if (response.status >= 500) throw new ApiFailed(response.status, text)
    if (response.status >= 400) throw new ApiRefused(response.status, text)
    try { return text ? JSON.parse(text) : {} } catch { return {} }
  }
}

const LABEL = 'wa-outbox'

export class Outbox {
  /**
   * file: SESSIONS_DIR/outbox.json; key: Buffer|null; client: CrmClient;
   * onResult(payload, result): called for every delivered message (now or from the outbox);
   * onDiscard(payload): a rejected message fell out of the kept list (its files may go).
   */
  constructor({ file, key, client, pollSec = 10, maxBackoffSec = 300, maxItems = 5000, logger, onResult, onDiscard, now = Date.now }) {
    Object.assign(this, { file, key, client, pollSec, maxBackoffSec, maxItems, logger, onResult, onDiscard, now })
    this.items = []
    this.rejected = []
    this.nextAt = 0
    this.attempts = 0
    this.flushing = null
    this.timer = null
    this.saving = Promise.resolve()
  }

  get size() { return this.items.length }

  get rejectedCount() { return this.rejected.length }

  /** Seconds the oldest waiting message has waited (0 when none). */
  get oldestSec() {
    if (!this.items.length) return 0
    const t = Date.parse(this.items[0].queued_at)
    return Number.isFinite(t) ? Math.max(0, Math.round((this.now() - t) / 1000)) : 0
  }

  async load() {
    const text = await readIfExists(this.file)
    if (!text) return
    try {
      const data = JSON.parse(open(text, this.key, LABEL))
      this.items = Array.isArray(data.items) ? data.items : []
      this.rejected = Array.isArray(data.rejected) ? data.rejected : []
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
    const text = seal(JSON.stringify({ v: 2, items: this.items, rejected: this.rejected }), this.key, LABEL)
    this.saving = this.saving.then(() => writePrivateFile(this.file, text)).catch((error) => {
      this.logger?.error({ err: error }, 'outbox cannot be written')
    })
    return this.saving
  }

  async enqueue(payload, reason, extra = {}) {
    this.items.push({ payload, queued_at: new Date(this.now()).toISOString(), last_error: String(reason).slice(0, 300), ...extra })
    if (this.items.length > this.maxItems) {
      const dropped = this.items.splice(0, this.items.length - this.maxItems)
      this.logger?.error(`outbox is full: ${dropped.length} oldest message(s) dropped`)
    }
    await this.save()
  }

  /** Kept aside with the reason: /health counts them, the server watchdog alarms. */
  async reject(payload, error, queuedAt) {
    this.logger?.error(`API refused message ${shortId(payload?.wa_message_id)} of user ${payload?.agent_id}, kept aside: ${error.message}`)
    this.rejected.push({
      payload, status: error.status ?? null, error: String(error.message).slice(0, 300),
      queued_at: queuedAt || new Date(this.now()).toISOString(), rejected_at: new Date(this.now()).toISOString(),
    })
    if (this.rejected.length > REJECTED_KEEP) {
      for (const old of this.rejected.splice(0, this.rejected.length - REJECTED_KEEP)) await this.onDiscard?.(old.payload)
    }
    await this.save()
  }

  retryPause(failures) {
    return Math.min(this.pollSec * 2 ** Math.max(0, failures - 1), this.maxBackoffSec) * 1000
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
        await this.reject(payload, error)
        return null
      }
      if (error instanceof ApiFailed) {
        this.logger?.warn(`API failed on message ${shortId(payload.wa_message_id)}, queued for a retry: ${error.message}`)
        await this.enqueue(payload, error.message, { failures: 1, next_at: this.now() + this.retryPause(1) })
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

  /**
   * Resends queued messages in order; stops at the first one the API still cannot take (unavailable).
   * A message the API keeps failing on (500) waits for its own next try and does not block the others.
   */
  flush() {
    if (this.flushing) return this.flushing
    this.flushing = (async () => {
      let sent = 0
      try {
        for (const item of [...this.items]) {
          if (item.next_at && item.next_at > this.now()) continue
          let done = false
          try {
            const result = await this.client.postIncoming(item.payload)
            await this.onResult?.(item.payload, result)
            sent += 1
            done = true
          } catch (error) {
            if (error instanceof ApiRefused) {
              await this.reject(item.payload, error, item.queued_at)
              done = true
            } else if (error instanceof ApiFailed) {
              item.failures = (item.failures || 0) + 1
              item.attempts = (item.attempts || 0) + 1
              item.last_error = error.message.slice(0, 300)
              if (item.failures >= MAX_FAILED_ATTEMPTS) {
                await this.reject(item.payload, Object.assign(new Error(`${item.failures} attempts: ${error.message}`), { status: error.status }), item.queued_at)
                done = true
              } else {
                item.next_at = this.now() + this.retryPause(item.failures)
                await this.save()
              }
            } else {
              item.attempts = (item.attempts || 0) + 1
              item.last_error = error.message.slice(0, 300)
              this.backoff()
              await this.save()
              this.logger?.warn(`outbox: API still unavailable (${error.message}), ${this.items.length} waiting, next try in ${Math.round((this.nextAt - this.now()) / 1000)}s`)
              break
            }
          }
          if (done) {
            const at = this.items.indexOf(item)
            if (at >= 0) this.items.splice(at, 1)
            await this.save()
          }
        }
        if (this.items.every((i) => i.next_at && i.next_at > this.now())) { this.attempts = 0; this.nextAt = 0 }
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
