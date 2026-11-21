import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { proto } from '@whiskeysockets/baileys'
import { openAuthStore, listStoredSessions, sessionFile } from '../src/auth-store.js'
import { NoKeyError, WrongKeyError, parseKey } from '../src/crypto-box.js'
import { tempDir, newKey, memoryLogger } from './helpers.js'

const MARKER = 'very-secret-marker-7d1f'

async function fillStore(store) {
  store.state.creds.me = { id: '998901234567:7@s.whatsapp.net', name: MARKER }
  store.state.creds.account = { details: Buffer.from('signed-details'), accountSignatureKey: Buffer.alloc(32, 3) }
  await store.saveCreds()
  await store.state.keys.set({
    'pre-key': { 1: { public: Buffer.from('pub-1'), private: Buffer.from('priv-1') }, 2: { public: Buffer.alloc(32, 7), private: Buffer.alloc(32, 9) } },
    session: { '998907654321.0': new Uint8Array([1, 2, 3, 250]) },
    'app-state-sync-key': { AAAA: { keyData: Buffer.from('k'), timestamp: 1700000000 } },
    'lid-mapping': { '998907654321': '207843005431853' },
  })
  await store.setMeta({ linked_at: 1763550000 })
}

test('encrypted round trip: creds, keys and meta come back; nothing readable on disk; modes 700/600', async () => {
  const dir = path.join(await tempDir(), 'sessions')
  const key = newKey()
  const store = await openAuthStore({ dir, userId: 42, key })
  assert.equal(store.isNew, true)
  assert.equal(store.isLinked(), false)
  // a pairing code request sets creds.me before anything is linked
  store.state.creds.me = { id: '998901234567@s.whatsapp.net', name: '~' }
  assert.equal(store.isLinked(), false)
  await fillStore(store)

  const text = await fs.readFile(sessionFile(dir, 42), 'utf8')
  assert.equal(JSON.parse(text).alg, 'aes-256-gcm')
  assert.ok(!text.includes(MARKER) && !text.includes('998901234567') && !text.includes(Buffer.from('priv-1').toString('base64')))
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700)
  assert.equal((await fs.stat(sessionFile(dir, 42))).mode & 0o777, 0o600)

  const again = await openAuthStore({ dir, userId: 42, key })
  assert.equal(again.isNew, false)
  assert.equal(again.isLinked(), true)
  assert.equal(again.state.creds.me.name, MARKER)
  assert.deepEqual(again.state.creds.noiseKey.private, store.state.creds.noiseKey.private)
  assert.ok(Buffer.isBuffer(again.state.creds.noiseKey.private))
  assert.equal(again.state.creds.registrationId, store.state.creds.registrationId)
  assert.equal(again.meta.linked_at, 1763550000)
  const pre = await again.state.keys.get('pre-key', ['1', '2', '3'])
  assert.deepEqual(Object.keys(pre), ['1', '2'])
  assert.equal(pre['1'].private.toString(), 'priv-1')
  const sess = await again.state.keys.get('session', ['998907654321.0'])
  assert.deepEqual([...sess['998907654321.0']], [1, 2, 3, 250])
  const app = await again.state.keys.get('app-state-sync-key', ['AAAA'])
  assert.ok(app.AAAA instanceof proto.Message.AppStateSyncKeyData)
  assert.equal((await again.state.keys.get('lid-mapping', ['998907654321']))['998907654321'], '207843005431853')
  assert.deepEqual(await listStoredSessions(dir), [42])
})

test('a returned key is a copy: changing it does not change the store', async () => {
  const dir = path.join(await tempDir(), 'sessions')
  const store = await openAuthStore({ dir, userId: 1, key: newKey() })
  await store.state.keys.set({ 'pre-key': { 5: { public: Buffer.from('a'), private: Buffer.from('b') } } })
  const first = await store.state.keys.get('pre-key', ['5'])
  first['5'].private = Buffer.from('changed')
  assert.equal((await store.state.keys.get('pre-key', ['5']))['5'].private.toString(), 'b')
  await store.state.keys.set({ 'pre-key': { 5: null } })
  assert.deepEqual(await store.state.keys.get('pre-key', ['5']), {})
})

test('wrong key, missing key and a file of another user are refused', async () => {
  const dir = path.join(await tempDir(), 'sessions')
  const key = newKey()
  await fillStore(await openAuthStore({ dir, userId: 7, key }))
  await assert.rejects(openAuthStore({ dir, userId: 7, key: newKey() }), WrongKeyError)
  await assert.rejects(openAuthStore({ dir, userId: 7, key: null }), NoKeyError)
  await fs.copyFile(sessionFile(dir, 7), sessionFile(dir, 8))
  await assert.rejects(openAuthStore({ dir, userId: 8, key }), WrongKeyError)
})

test('without a key the file is plain; once a key is set it is sealed', async () => {
  const dir = path.join(await tempDir(), 'sessions')
  await fillStore(await openAuthStore({ dir, userId: 3, key: null }))
  assert.equal(JSON.parse(await fs.readFile(sessionFile(dir, 3), 'utf8')).alg, 'none')
  const key = newKey()
  const sealed = await openAuthStore({ dir, userId: 3, key })
  assert.equal(sealed.state.creds.me.name, MARKER)
  assert.equal(JSON.parse(await fs.readFile(sessionFile(dir, 3), 'utf8')).alg, 'aes-256-gcm')
  assert.equal((await openAuthStore({ dir, userId: 3, key })).state.creds.me.name, MARKER)
})

test('many concurrent writes end with everything on disk; remove() deletes for good', async () => {
  const dir = path.join(await tempDir(), 'sessions')
  const key = newKey()
  const store = await openAuthStore({ dir, userId: 9, key })
  await Promise.all(Array.from({ length: 200 }, (_, i) => store.state.keys.set({ session: { [`s${i}`]: Buffer.from([i % 256]) } })))
  const again = await openAuthStore({ dir, userId: 9, key })
  assert.equal(Object.keys(await again.state.keys.get('session', Array.from({ length: 200 }, (_, i) => `s${i}`))).length, 200)
  await store.remove()
  await store.saveCreds()
  await assert.rejects(fs.stat(sessionFile(dir, 9)), { code: 'ENOENT' })
  assert.deepEqual(await listStoredSessions(dir), [])
})

test('key format and logs: the key is 32 bytes base64, nothing secret is logged', async () => {
  assert.throws(() => parseKey('c2hvcnQ='), /32 bytes/)
  assert.equal(parseKey(newKey().toString('base64')).length, 32)
  assert.equal(parseKey(''), null)
  const { logger, lines } = memoryLogger('trace')
  logger.info({ creds: { noiseKey: Buffer.alloc(32, 1) }, text: 'hello client', jid: '998901234567@s.whatsapp.net', raw: new Uint8Array(16) }, 'event')
  logger.warn('send to +998907654321 failed')
  const all = lines.join('\n')
  assert.ok(!all.includes('hello client') && !all.includes('998901234567') && !all.includes('998907654321'), all)
  assert.match(all, /998\*+21/)
  assert.match(all, /\[16 bytes\]/)
})
