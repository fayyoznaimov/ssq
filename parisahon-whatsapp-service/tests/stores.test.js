import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { InboxJournal, SentStore, SessionMarks, packMessage, unpackMessage } from '../src/stores.js'
import { harness, connected, newKey, silent, sleep, tempDir, waMessage, waitFor } from './helpers.js'

test('POST /send: the same request_id is sent once; the repeat gets the first answer', async (t) => {
  const h = await harness(t)
  const sock = await connected(h)
  const body = { user_id: 5, to_phone: '+998907654321', text: 'Счёт', request_id: 'req-1' }
  const [a, b] = await Promise.all([h.api('POST', '/send', body), h.api('POST', '/send', body)])
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.equal(sock.sent.length, 1)
  assert.deepEqual(a.body.message_ids, b.body.message_ids)
  const c = await h.api('POST', '/send', body)
  assert.equal(c.body.repeated, true)
  assert.equal(sock.sent.length, 1)
  // another id is another message
  await h.api('POST', '/send', { ...body, request_id: 'req-2' })
  assert.equal(sock.sent.length, 2)
  // a bad id is refused
  assert.equal((await h.api('POST', '/send', { ...body, request_id: 'a b' })).status, 400)
})

test('POST /send that failed before anything went out may be sent again with the same request_id', async (t) => {
  const h = await harness(t)
  const sock = await connected(h)
  h.wa.sendFails = true
  const body = { user_id: 5, to_phone: '+998907654321', text: 'Счёт', request_id: 'req-9' }
  const first = await h.api('POST', '/send', body)
  assert.equal(first.status, 502)
  h.wa.sendFails = false
  const second = await h.api('POST', '/send', body)
  assert.equal(second.status, 200)
  assert.equal(sock.sent.length, 1)
})

test('a send the CRM stopped waiting for is recorded in the CRM by the service, with its deal', async (t) => {
  const h = await harness(t)
  const sock = await connected(h)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const original = sock.sendMessage
  sock.sendMessage = async (...args) => { await gate; return original(...args) }
  const { entry } = h.manager.startSend({ userId: 5, toPhone: '+998907654321', text: 'Позже', files: [], requestId: 'late-1', dealId: 77 })
  h.manager.abandonSend(entry)
  release()
  await entry.promise
  await waitFor(() => h.crm.requests.length === 1)
  const posted = h.crm.requests[0].body
  assert.equal(posted.outgoing, true)
  assert.equal(posted.deal_id, 77)
  assert.equal(posted.text, 'Позже')
  assert.equal(posted.wa_message_id, entry.result.message_ids[0])
  assert.equal(posted.chat.wa_id, '998907654321@s.whatsapp.net')
})

test('GET /health: every number with its state; an unlinked number is a problem', async (t) => {
  const h = await harness(t)
  await connected(h, 5)
  let health = (await h.api('GET', '/health', undefined, null)).body
  assert.equal(health.sessions, 1)
  assert.equal(health.connected, 1)
  assert.deepEqual(health.problems, [])
  h.wa.last.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } })
  health = (await h.api('GET', '/health', undefined, null)).body
  assert.equal(health.connected, 0)
  assert.equal(health.states['5'], 'logged_out')
  assert.equal(health.problems[0].status, 'logged_out')
})

test('SessionMarks: a number unlinked on the phone is still logged_out after a restart, until linked again', async () => {
  const dir = await tempDir()
  const key = newKey()
  const file = path.join(dir, 'states.json')
  const marks = new SessionMarks({ file, key, logger: silent })
  await marks.set(5, { status: 'logged_out', phone: '+998901234567', name: 'M' })
  const again = new SessionMarks({ file, key, logger: silent })
  await again.load()
  assert.equal(again.get(5).status, 'logged_out')
  assert.ok(Date.parse(again.get(5).at) > 0)
  await again.clear(5)
  const third = new SessionMarks({ file, key, logger: silent })
  await third.load()
  assert.equal(third.get(5), null)
})

test('InboxJournal: a message in hand survives a restart byte for byte and is handled again once', async () => {
  const dir = await tempDir()
  const key = newKey()
  const file = path.join(dir, 'inbox.json')
  const msg = waMessage({ id: 'J1', message: { imageMessage: { mediaKey: Buffer.from([1, 2, 3]), caption: 'фото', mimetype: 'image/jpeg' } } })
  const journal = new InboxJournal({ file, key, logger: silent })
  await journal.add(5, msg)
  await journal.add(6, waMessage({ id: 'J2' }))
  await journal.done(6, waMessage({ id: 'J2' }))

  const after = new InboxJournal({ file, key, logger: silent })
  await after.load()
  assert.equal(after.size, 1)
  const old = after.takeOld(5)
  assert.equal(old.length, 1)
  assert.equal(old[0].key.id, 'J1')
  assert.equal(old[0].message.imageMessage.caption, 'фото')
  assert.deepEqual([...old[0].message.imageMessage.mediaKey], [1, 2, 3])
  assert.equal(typeof old[0].messageTimestamp, 'number')
  assert.equal(after.takeOld(5).length, 0) // once
  await after.forgetUser(5)
  assert.equal(after.size, 0)

  const round = unpackMessage(packMessage(msg))
  assert.equal(round.key.remoteJid, msg.key.remoteJid)
})

test('SentStore: a message sent from the CRM can be given to WhatsApp again (getMessage) for a week', async () => {
  const dir = await tempDir()
  let clock = 1_000_000
  const store = new SentStore({ file: path.join(dir, 'sent.json'), key: newKey(), logger: silent, now: () => clock })
  store.remember('ID1', { conversation: 'Ваш счёт' })
  assert.equal(store.get({ id: 'ID1' }).conversation, 'Ваш счёт')
  assert.equal(store.get({ id: 'nope' }), undefined)
  clock += 8 * 24 * 3600 * 1000
  assert.equal(store.get({ id: 'ID1' }), undefined)
  await sleep(0)
})
