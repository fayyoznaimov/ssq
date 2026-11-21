// A small logger compatible with Baileys' ILogger (level, child, trace..error) that never prints
// secrets: bytes (keys, media) become "[N bytes]", message bodies are redacted and every run of
// 7+ digits (phone numbers, also inside JIDs) is masked. Lines go to stdout (journald).
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Infinity }
const REDACTED_KEYS = new Set([
  'conversation', 'text', 'caption', 'vcard', 'body', 'contentText', 'selectedDisplayText',
  'message', 'msg', 'messages', 'content', 'plaintext', 'creds', 'keys', 'privKey', 'private',
  'noiseKey', 'signedIdentityKey', 'signedPreKey', 'advSecretKey', 'qr', 'token', 'mediaKey',
])

/** "+998901234567" -> "+998*******67" (any run of 7+ digits inside the string). */
export function maskDigits(value) {
  return String(value).replace(/\d{7,}/g, (m) => m.slice(0, 3) + '*'.repeat(m.length - 5) + m.slice(-2))
}

export const maskPhone = (phone) => (phone ? maskDigits(phone) : String(phone))

/** A message id is not secret, but it is enough to show its start. */
export const shortId = (id) => (id ? String(id).slice(0, 8) + '…' : '-')

function safeJson(obj) {
  const seen = new WeakSet()
  try {
    return JSON.stringify(obj, (key, value) => {
      if (value && typeof value === 'object') {
        if (value.type === 'Buffer' && value.data !== undefined) return `[${(value.data.length ?? 0)} bytes]`
        if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[${value.byteLength} bytes]`
        if (value instanceof Error) {
          return { error: value.message, status: value.output?.statusCode ?? value.status, stack: value.stack?.split('\n').slice(0, 4).join(' | ') }
        }
        if (seen.has(value)) return '[circular]'
        seen.add(value)
      }
      if (key && REDACTED_KEYS.has(key) && value !== null && value !== undefined) {
        return '[redacted]'
      }
      if (typeof value === 'string' && value.length > 300) return value.slice(0, 300) + '…'
      if (typeof value === 'bigint') return value.toString()
      return value
    })
  } catch {
    return '"[unserializable]"'
  }
}

export function createLogger({ level = 'info', bindings = {}, write = (line) => process.stdout.write(line + '\n') } = {}) {
  const state = { level: LEVELS[level] !== undefined ? level : 'info' }
  const make = (own) => {
    const emit = (name) => (obj, msg) => {
      if (LEVELS[name] < LEVELS[state.level]) return
      let text = ''
      let extra = null
      if (typeof obj === 'string') {
        text = obj
        if (msg !== undefined) text += ' ' + String(msg)
      } else {
        text = msg !== undefined ? String(msg) : ''
        if (obj instanceof Error) extra = { err: obj }
        else if (obj !== undefined && obj !== null) extra = obj
      }
      const tag = Object.entries(own).map(([k, v]) => `${k}=${v}`).join(' ')
      const tail = extra && Object.keys(extra).length ? ' ' + safeJson(extra) : ''
      write(maskDigits(`${name.toUpperCase()}${tag ? ' [' + tag + ']' : ''} ${text}${tail}`))
    }
    return {
      get level() { return state.level },
      set level(value) { if (LEVELS[value] !== undefined) state.level = value },
      child: (more) => make({ ...own, ...more }),
      trace: emit('trace'),
      debug: emit('debug'),
      info: emit('info'),
      warn: emit('warn'),
      error: emit('error'),
      fatal: emit('fatal'),
    }
  }
  return make(bindings)
}

/**
 * Baileys acks every notification with creds.me.id; before the first pairing there is no
 * creds.me, so it throws "Cannot read properties of undefined (reading 'id')" and logs an error
 * on every QR scan. The service acks those notifications itself (session-manager), so this
 * wrapper turns that one Baileys error into a debug line.
 */
export function quietPrePairingAckErrors(logger) {
  const isAckCrash = (obj, msg) => typeof msg === 'string' && msg.startsWith('failed to ack') &&
    /reading 'id'/.test(String(obj?.ackErr?.message || ''))
  const wrap = (inner) => ({
    get level() { return inner.level },
    set level(value) { inner.level = value },
    child: (more) => wrap(inner.child(more)),
    trace: (o, m) => inner.trace(o, m),
    debug: (o, m) => inner.debug(o, m),
    info: (o, m) => inner.info(o, m),
    warn: (o, m) => inner.warn(o, m),
    error: (o, m) => (isAckCrash(o, m) ? inner.debug(`${m} before pairing (no account yet), acked by the service`) : inner.error(o, m)),
    fatal: (o, m) => inner.fatal(o, m),
  })
  return wrap(logger)
}
