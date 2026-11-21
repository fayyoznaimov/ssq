// AES-256-GCM sealing of the files this service keeps on disk (WhatsApp sessions, the outbox).
// Sealed:  {"v":1,"alg":"aes-256-gcm","iv":b64,"tag":b64,"data":b64}
// Plain:   {"v":1,"alg":"none","data":"<the JSON text>"}   (no SESSION_ENCRYPTION_KEY: dev only)
// `label` is bound as additional authenticated data, so a file of one user cannot be passed off
// as another user's file.
import crypto from 'node:crypto'

export class NoKeyError extends Error {
  constructor() { super('the file is encrypted and SESSION_ENCRYPTION_KEY is not set'); this.code = 'NO_KEY' }
}
export class WrongKeyError extends Error {
  constructor() { super('the file cannot be decrypted with this SESSION_ENCRYPTION_KEY'); this.code = 'WRONG_KEY' }
}

/** 32 bytes in base64 (openssl rand -base64 32) -> Buffer; '' -> null. Throws on a malformed key. */
export function parseKey(value) {
  if (!value) return null
  const key = Buffer.from(String(value).trim(), 'base64')
  if (key.length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must be 32 bytes in base64 (openssl rand -base64 32)')
  return key
}

export function seal(text, key, label = '') {
  if (!key) return JSON.stringify({ v: 1, alg: 'none', data: text })
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  if (label) cipher.setAAD(Buffer.from(label))
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return JSON.stringify({
    v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  })
}

/** The JSON text inside a sealed file. Throws NoKeyError / WrongKeyError / SyntaxError. */
export function open(fileText, key, label = '') {
  const box = JSON.parse(fileText)
  if (!box || box.v !== 1) throw new SyntaxError('unknown file format')
  if (box.alg === 'none') return box.data
  if (box.alg !== 'aes-256-gcm') throw new SyntaxError('unknown cipher ' + box.alg)
  if (!key) throw new NoKeyError()
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'))
    if (label) decipher.setAAD(Buffer.from(label))
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new WrongKeyError()
  }
}

export const isSealed = (fileText) => {
  try { return JSON.parse(fileText)?.alg === 'aes-256-gcm' } catch { return false }
}
