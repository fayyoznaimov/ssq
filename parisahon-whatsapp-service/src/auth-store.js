// Baileys auth state (creds + signal keys) of one CRM user in ONE encrypted file:
//   SESSIONS_DIR/session-<user_id>.json   (mode 600, directory 700)
// Like Baileys' useMultiFileAuthState, but a single AES-256-GCM sealed JSON per user
// (crypto-box.js). The file is a full login to the manager's WhatsApp: whoever has it and the key
// reads and writes as that person.
//
// Keys are kept in memory as their JSON text (exactly what a file per key would hold, so Baileys
// always gets fresh objects) and every change is written at once; writes are serialized and
// coalesced: changes made while a write runs go out together in the next one.
import fs from 'node:fs/promises'
import path from 'node:path'
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys'
import { open, seal, isSealed } from './crypto-box.js'
import { writePrivateFile, readIfExists, ensurePrivateDir } from './files.js'

export const sessionFile = (dir, userId) => path.join(dir, `session-${userId}.json`)
const label = (userId) => `wa-session:${userId}`

/** User ids of the stored sessions. */
export async function listStoredSessions(dir) {
  let names = []
  try { names = await fs.readdir(dir) } catch { return [] }
  return names
    .map((n) => /^session-(\d+)\.json$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
}

/**
 * Opens (or creates in memory) the auth state of a user.
 * Throws NoKeyError / WrongKeyError / SyntaxError when the stored file cannot be read: the caller
 * decides (restore: skip it; a new connection: put it aside and start over).
 */
export async function openAuthStore({ dir, userId, key, logger }) {
  await ensurePrivateDir(dir)
  const file = sessionFile(dir, userId)
  const text = await readIfExists(file)
  let creds
  let meta = {}
  const keys = {} // type -> id -> JSON text
  let isNew = true
  let needsRewrite = false
  if (text) {
    const inner = open(text, key, label(userId))
    const data = JSON.parse(inner, BufferJSON.reviver)
    creds = data.creds
    meta = data.meta || {}
    for (const [type, values] of Object.entries(data.keys || {})) {
      keys[type] = {}
      for (const [id, value] of Object.entries(values)) keys[type][id] = JSON.stringify(value, BufferJSON.replacer)
    }
    isNew = false
    // a plain file (written without a key) is sealed as soon as a key is configured
    needsRewrite = Boolean(key) && !isSealed(text)
  } else {
    creds = initAuthCreds()
  }

  let removed = false
  let tail = Promise.resolve()
  let queued = null

  const serialize = () => {
    const types = Object.entries(keys).map(([type, values]) => {
      const inner = Object.entries(values).map(([id, json]) => `${JSON.stringify(id)}:${json}`).join(',')
      return `${JSON.stringify(type)}:{${inner}}`
    })
    return `{"v":1,"user_id":${Number(userId)},"meta":${JSON.stringify(meta)},` +
      `"creds":${JSON.stringify(creds, BufferJSON.replacer)},"keys":{${types.join(',')}}}`
  }

  const writeNow = async () => {
    if (removed) return
    await writePrivateFile(file, seal(serialize(), key, label(userId)))
  }

  /** Resolves when a write that includes every change made so far is on disk. */
  const persist = () => {
    if (removed) return Promise.resolve()
    if (queued) return queued
    const run = tail.then(() => { queued = null; return writeNow() })
    queued = run
    tail = run.catch((error) => logger?.error({ err: error }, `cannot write the WhatsApp session of user ${userId}`))
    return run
  }

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const out = {}
        const values = keys[type] || {}
        for (const id of ids) {
          const json = values[id]
          if (json === undefined) continue
          let value = JSON.parse(json, BufferJSON.reviver)
          if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
          out[id] = value
        }
        return out
      },
      set: async (data) => {
        for (const type of Object.keys(data)) {
          keys[type] ||= {}
          for (const [id, value] of Object.entries(data[type] || {})) {
            if (value === null || value === undefined) delete keys[type][id]
            else keys[type][id] = JSON.stringify(value, BufferJSON.replacer)
          }
        }
        await persist()
      },
      clear: async () => {
        for (const type of Object.keys(keys)) delete keys[type]
        await persist()
      },
    },
  }

  if (needsRewrite) await persist()

  return {
    file,
    isNew,
    state,
    meta,
    /** true once the phone has linked this device (QR scanned or code entered). creds.me alone is
     *  not enough: Baileys sets it as soon as a pairing code is requested. */
    isLinked: () => Boolean(state.creds?.account && state.creds?.me?.id),
    saveCreds: persist,
    setMeta: async (more) => { Object.assign(meta, more); await persist() },
    persist,
    /** Waits for pending writes, then deletes the file; nothing is written afterwards. */
    remove: async () => {
      await tail
      removed = true
      await fs.rm(file, { force: true })
    },
    /** Waits for pending writes (shutdown). */
    flush: () => tail,
  }
}

/** Moves an unreadable session file aside (kept for a key mix-up), so a new one can be made. */
export async function setAsideUnreadable(dir, userId) {
  const file = sessionFile(dir, userId)
  const aside = `${file}.unreadable-${Date.now()}`
  await fs.rename(file, aside).catch(() => {})
  return aside
}
