// Linking by phone number (pairing code), and what happens on the wire before pairing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsSync from 'node:fs'
import { sessionFile, openAuthStore } from '../src/auth-store.js'
import { formatCode, phoneDigits } from '../src/session-manager.js'
import { quietPrePairingAckErrors } from '../src/log.js'
import { harness, memoryLogger, waitFor, sleep } from './helpers.js'

/** POST start with a phone; the fake WhatsApp sends its first QR event (the socket is up). */
async function startWithPhone(h, userId, phone) {
  const before = h.wa.sockets.length
  const pending = h.api('POST', `/sessions/${userId}/start`, { phone })
  await waitFor(() => h.wa.sockets.length > before)
  h.wa.last.emit('connection.update', { qr: 'QR-IGNORED' })
  return pending
}

test('phone -> pairing code; GET shows the code until linked; pair-success + 515 -> connected', async (t) => {
  const { logger, lines } = memoryLogger('info')
  const h = await harness(t, { logger })
  const r = await startWithPhone(h, 5, '+998 90 123-45-67')
  assert.deepEqual(r, { status: 200, body: { status: 'code', code: 'ABCD-1234' } })
  const sock = h.wa.last
  assert.deepEqual(sock.pairingRequests, ['998901234567'])
  // QR events keep coming from WhatsApp: the state stays "code", no QR is shown
  sock.emit('connection.update', { qr: 'QR-2' })
  assert.deepEqual((await h.api('GET', '/sessions/5')).body, { status: 'code', code: 'ABCD-1234' })
  assert.deepEqual((await h.api('GET', '/sessions')).body, [{ user_id: 5, status: 'code', phone: null }])
  // the same start again (with or without the phone) returns the same code, no second request
  assert.deepEqual((await h.api('POST', '/sessions/5/start', { phone: '998901234567' })).body, { status: 'code', code: 'ABCD-1234' })
  assert.deepEqual((await h.api('POST', '/sessions/5/start')).body, { status: 'code', code: 'ABCD-1234' })
  assert.equal(sock.pairingRequests.length, 1)
  // creds.me is set by the code request, but nothing is linked: not restorable
  await h.manager.sessions.get(5).store.persist()
  assert.equal((await openAuthStore({ dir: h.config.sessionsDir, userId: 5, key: h.key })).isLinked(), false)

  // the code is entered on the phone: pair-success, WhatsApp asks for a restart, the new socket opens
  sock.auth.creds.me = { id: '998901234567:9@s.whatsapp.net', lid: '111222333444555:9@lid', name: 'Manager One' }
  sock.auth.creds.account = { details: Buffer.from('signed') }
  sock.emit('creds.update', { me: sock.auth.creds.me, account: sock.auth.creds.account })
  sock.emit('connection.update', { isNewLogin: true, qr: undefined })
  sock.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } })
  await waitFor(() => h.wa.sockets.length === 2)
  h.wa.last.emit('connection.update', { connection: 'open' })
  assert.deepEqual((await h.api('GET', '/sessions/5')).body, { status: 'connected', phone: '+998901234567', name: 'Manager One' })

  const log = lines.join('\n')
  assert.match(log, /user 5: pairing code ready for \+998\*+67/)
  assert.match(log, /user 5: pair-success: the phone linked this device \(\+998\*+67\)/)
  assert.match(log, /user 5: WhatsApp asks for a restart after pairing \(515\), reconnecting/)
  assert.match(log, /user 5: WhatsApp connected \+998\*+67/)
  assert.ok(!log.includes('998901234567') && !log.includes('ABCD'), 'no full phone and no code in the log')
})

test('phone: bad number 400, WhatsApp refusal 400 / 429, request failure 502', async (t) => {
  const h = await harness(t)
  assert.deepEqual(await h.api('POST', '/sessions/5/start', { phone: '12-34' }), { status: 400, body: { error: 'bad phone', message: 'Неверный номер телефона' } })
  assert.equal((await h.api('POST', '/sessions/5/start', { phone: 998901234567 })).body.error, 'bad phone')
  assert.equal(h.wa.sockets.length, 0)

  h.wa.pairingReply = 400
  let r = await startWithPhone(h, 5, '+998000000000')
  assert.deepEqual(r, { status: 400, body: { error: 'phone rejected', message: 'WhatsApp не принял этот номер для привязки' } })
  assert.deepEqual((await h.api('GET', '/sessions/5')).body, { status: 'none' })
  assert.equal(h.wa.last.ended, true)

  h.wa.pairingReply = 429
  r = await startWithPhone(h, 6, '+998000000000')
  assert.deepEqual([r.status, r.body.error], [429, 'too many attempts'])

  h.wa.pairingReply = 'throw'
  r = await startWithPhone(h, 7, '+998000000000')
  assert.deepEqual([r.status, r.body.error], [502, 'pairing failed'])
  assert.match(r.body.message, /WhatsApp не выдал код привязки/)
  await waitFor(() => !fsSync.existsSync(sessionFile(h.config.sessionsDir, 7)))
})

test('a phone given while a QR waits replaces the QR session; the code times out like a QR', async (t) => {
  const h = await harness(t, { config: { qrTimeoutMs: 1500 } })
  const pending = h.api('POST', '/sessions/5/start')
  await waitFor(() => h.wa.sockets.length === 1)
  h.wa.last.emit('connection.update', { qr: 'QR-1' })
  assert.equal((await pending).body.status, 'qr')
  const qrSock = h.wa.last
  const r = await startWithPhone(h, 5, '+998901234567')
  assert.deepEqual(r.body, { status: 'code', code: 'ABCD-1234' })
  assert.equal(qrSock.ended, true)
  assert.equal(h.wa.sockets.length, 2)
  await waitFor(() => h.manager.state(5).status === 'none', 5000)
  assert.equal(h.wa.last.ended, true)
  await waitFor(() => !fsSync.existsSync(sessionFile(h.config.sessionsDir, 5)))
})

test('WhatsApp closes the code session before the code is used -> none', async (t) => {
  const h = await harness(t)
  await startWithPhone(h, 5, '+998901234567')
  h.wa.last.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 }, message: 'QR refs attempts ended' } } })
  await waitFor(() => h.manager.state(5).status === 'none')
})

test('before pairing: notifications are acked by the service, a passkey request is logged and shown', async (t) => {
  const { logger, lines } = memoryLogger('info')
  const h = await harness(t, { logger })
  const pending = h.api('POST', '/sessions/5/start')
  await waitFor(() => h.wa.sockets.length === 1)
  const sock = h.wa.last
  sock.emit('connection.update', { qr: 'QR-1' })
  await pending
  sock.ws.emit('frame', { tag: 'notification', attrs: { id: 'N1', from: 's.whatsapp.net', type: 'account_sync' }, content: [{ tag: 'devices', attrs: {} }] })
  sock.ws.emit('frame', { tag: 'iq', attrs: { id: 'P1', type: 'set', xmlns: 'md' }, content: [{ tag: 'passkey_prologue_request', attrs: {}, content: [] }] })
  await sleep(20)
  assert.deepEqual(sock.nodesSent, [{ tag: 'ack', attrs: { id: 'N1', to: 's.whatsapp.net', class: 'notification', type: 'account_sync' } }])
  const log = lines.join('\n')
  assert.match(log, /pairing notification type=account_sync \[devices\]/)
  assert.match(log, /WhatsApp asks for a passkey \(iq set passkey_prologue_request\): use the phone-number code instead/)
  assert.deepEqual((await h.api('GET', '/sessions/5')).body, { status: 'qr', qr: 'QR-1', passkey: true })
  // once linked nothing is watched or acked by the service any more
  h.wa.link(sock)
  sock.ws.emit('frame', { tag: 'notification', attrs: { id: 'N2', from: 's.whatsapp.net', type: 'devices' }, content: [] })
  await sleep(20)
  assert.equal(sock.nodesSent.length, 1)
  assert.equal(h.manager.state(5).passkey, undefined)
})

test("Baileys' pre-pairing ack crash is a debug line, other errors stay errors", () => {
  const { logger, lines } = memoryLogger('info')
  const quiet = quietPrePairingAckErrors(logger).child({ user: 5 })
  quiet.error({ ackErr: new TypeError("Cannot read properties of undefined (reading 'id')") }, 'failed to ack notification')
  assert.equal(lines.length, 0)
  quiet.error({ ackErr: new Error('socket closed') }, 'failed to ack notification')
  quiet.error({ err: new Error('boom') }, 'something else')
  assert.equal(lines.filter((l) => l.startsWith('ERROR')).length, 2)
})

test('helpers: phone digits and code format', () => {
  assert.equal(phoneDigits('+998 (90) 123-45-67'), '998901234567')
  assert.equal(phoneDigits('123'), null)
  assert.equal(formatCode('ABCD1234'), 'ABCD-1234')
})
