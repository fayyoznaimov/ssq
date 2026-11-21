// Clients' profile pictures (chat.photo) and POST /resolve.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { harness, connected, waitFor, sleep, waMessage } from './helpers.js'

const CLIENT = '998907654321@s.whatsapp.net'
const CDN = 'https://pps.whatsapp.net/v/t61/abc_n.jpg'
const DAY = 24 * 3600 * 1000

async function setup(t) {
  const clock = { now: Date.now() }
  const h = await harness(t, { clock: () => clock.now })
  const sock = await connected(h)
  h.wa.pictures[CLIENT] = `${CDN}?oh=sig1&oe=111`
  h.wa.images[CDN] = Buffer.from('JPEG-1')
  let n = 0
  const send = async (more = {}) => {
    const id = `M${++n}`
    sock.emit('messages.upsert', { type: 'notify', messages: [waMessage({ id, ...more })] })
    await waitFor(() => h.crm.requests.some((r) => r.body.wa_message_id === id))
    return h.crm.requests.find((r) => r.body.wa_message_id === id).body
  }
  return { h, sock, clock, send }
}

test('chat.photo: with the first message, then not again for 24 h; unchanged picture is not downloaded again', async (t) => {
  const { h, clock, send } = await setup(t)
  const first = await send()
  assert.match(first.chat.photo, /^[0-9a-f]{32}\.jpg$/)
  assert.equal(await fs.readFile(path.join(h.config.uploadsDir, first.chat.photo), 'utf8'), 'JPEG-1')
  assert.deepEqual(h.wa.photoQueries, [[CLIENT, 'image']])
  assert.equal((await send()).chat.photo, null)
  assert.equal(h.wa.photoQueries.length, 1)

  // a day later: asked again; the same picture (only the URL signature changed) -> the same file
  clock.now += DAY + 1000
  h.wa.pictures[CLIENT] = `${CDN}?oh=sig2&oe=222`
  const later = await send()
  assert.equal(later.chat.photo, first.chat.photo)
  assert.equal(h.wa.photoQueries.length, 2)
  assert.equal(h.wa.downloads.length, 1)

  // another day, a new picture -> a new file
  clock.now += DAY + 1000
  h.wa.pictures[CLIENT] = 'https://pps.whatsapp.net/v/t61/new_n.jpg?oh=x'
  h.wa.images['https://pps.whatsapp.net/v/t61/new_n.jpg'] = Buffer.from('JPEG-2')
  const changed = await send()
  assert.notEqual(changed.chat.photo, first.chat.photo)
  assert.equal(await fs.readFile(path.join(h.config.uploadsDir, changed.chat.photo), 'utf8'), 'JPEG-2')
})

test('chat.photo after a restart: sent with the first message again, from the stored map (no query, no download)', async (t) => {
  const { h, send } = await setup(t)
  const first = await send()
  await h.photos.saving
  const raw = await fs.readFile(path.join(h.config.sessionsDir, 'photos.json'), 'utf8')
  assert.equal(JSON.parse(raw).alg, 'aes-256-gcm')
  assert.ok(!raw.includes('998907654321'))
  const again = h.makePhotos()
  await again.load()
  h.manager.photos = again
  const queries = h.wa.photoQueries.length
  assert.equal((await send()).chat.photo, first.chat.photo)
  assert.equal(h.wa.photoQueries.length, queries)
  assert.equal(h.wa.downloads.length, 1)
  assert.equal((await send()).chat.photo, null)
})

test('no picture, hidden by privacy, query or download failure: photo null, the message still goes', async (t) => {
  const { h, clock, send } = await setup(t)
  const other = (n) => `99890000000${n}@s.whatsapp.net`
  h.wa.pictures[other(1)] = 404
  h.wa.pictures[other(2)] = 401
  h.wa.pictures[other(3)] = 500
  h.wa.pictures[other(4)] = 'https://pps.whatsapp.net/v/t61/broken_n.jpg?x'
  h.wa.images['https://pps.whatsapp.net/v/t61/broken_n.jpg'] = 'throw'
  h.wa.pictures[other(5)] = 'https://pps.whatsapp.net/v/t61/huge_n.jpg?x'
  h.wa.images['https://pps.whatsapp.net/v/t61/huge_n.jpg'] = Buffer.alloc(200 * 1024)
  for (const n of [1, 2, 3, 4, 5]) {
    const p = await send({ jid: other(n), message: { conversation: `hi ${n}` } })
    assert.equal(p.chat.photo, null, `chat ${n}`)
    assert.equal(p.text, `hi ${n}`)
  }
  // failed or too large downloads leave nothing in uploads
  assert.deepEqual(await fs.readdir(h.config.uploadsDir), [])
  // a failure is tried again after an hour, "none" only after a day
  const before = h.wa.photoQueries.length
  clock.now += 3600 * 1000 + 1000
  h.wa.pictures[other(3)] = `${CDN}?late`
  h.manager.photos.sent.clear() // as after a restart: the first message of each chat is due again
  assert.match((await send({ jid: other(3) })).chat.photo, /\.jpg$/)
  assert.equal((await send({ jid: other(1) })).chat.photo, null)
  assert.equal(h.wa.photoQueries.length, before + 1)
})

test('the same picture under the phone number and the LID is downloaded once', async (t) => {
  const { h, send } = await setup(t)
  const lid = '207843005431853@lid'
  h.wa.pictures[lid] = `${CDN}?other-signature`
  const a = await send()
  const b = await send({ jid: lid })
  assert.equal(a.chat.photo, b.chat.photo)
  assert.equal(h.wa.downloads.length, 1)
})

test('POST /resolve: wa_id and photo of a number, through the manager session', async (t) => {
  const h = await harness(t)
  assert.equal((await h.api('POST', '/resolve', { user_id: 5, phone: '+998907654321' }, null)).status, 401)
  assert.deepEqual(await h.api('POST', '/resolve', { user_id: 5, phone: '+998907654321' }),
    { status: 400, body: { error: 'not connected', message: 'Ваш WhatsApp не подключён (Профиль → WhatsApp)' } })
  assert.deepEqual((await h.api('POST', '/resolve', { user_id: 5, phone: '12' })).body.error, 'bad phone')
  assert.deepEqual((await h.api('POST', '/resolve', { user_id: 5 })).body.error, 'bad phone')
  assert.deepEqual((await h.api('POST', '/resolve', { phone: '+998907654321' })).body.error, 'bad user_id')
  await connected(h)
  h.wa.pictures[CLIENT] = `${CDN}?s=1`
  h.wa.images[CDN] = Buffer.from('JPEG-R')
  const r = await h.api('POST', '/resolve', { user_id: 5, phone: '+998 90 765 43 21' })
  assert.equal(r.status, 200)
  assert.equal(r.body.wa_id, CLIENT)
  assert.match(r.body.photo, /^[0-9a-f]{32}\.jpg$/)
  // asked again: the remembered picture, no new query
  const q = h.wa.photoQueries.length
  assert.deepEqual((await h.api('POST', '/resolve', { user_id: 5, phone: '998907654321' })).body, r.body)
  assert.equal(h.wa.photoQueries.length, q)
  // a number with WhatsApp but no picture, and a number without WhatsApp
  assert.deepEqual((await h.api('POST', '/resolve', { user_id: 5, phone: '+998900000009' })).body, { wa_id: '998900000009@s.whatsapp.net', photo: null })
  h.wa.onWhatsApp = async () => []
  assert.deepEqual((await h.api('POST', '/resolve', { user_id: 5, phone: '+998900000008' })).body, { wa_id: null, photo: null })
  h.wa.onWhatsApp = async () => { throw new Error('timed out') }
  const failed = await h.api('POST', '/resolve', { user_id: 5, phone: '+998900000008' })
  assert.deepEqual([failed.status, failed.body.error], [502, 'whatsapp error'])
  await sleep(10)
})
