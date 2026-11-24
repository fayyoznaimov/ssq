// The HTTP API and the session life cycle, with a fake WhatsApp socket and a fake CRM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SessionManager, mediaContent } from '../src/session-manager.js'
import { sessionFile, openAuthStore } from '../src/auth-store.js'
import { fakeWhatsApp, tempDir, silent, waitFor, sleep, waMessage, harness, connected, TOKEN } from './helpers.js'

const FFMPEG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../local/dev/bin/ffmpeg')

test('token: everything but /health needs X-WhatsApp-Service-Token', async (t) => {
  const h = await harness(t)
  assert.deepEqual(await h.api('GET', '/health', undefined, null), {
    status: 200,
    body: { ok: true, sessions: 0, connected: 0, states: {}, problems: [], inbox: 0, ffmpeg: null, outbox: 0, outbox_oldest_sec: 0, rejected: 0 },
  })
  for (const [m, u] of [['GET', '/sessions'], ['GET', '/sessions/1'], ['POST', '/sessions/1/start'], ['DELETE', '/sessions/1'], ['POST', '/send'], ['GET', '/nope']]) {
    assert.equal((await h.api(m, u, undefined, null)).status, 401, `${m} ${u} without token`)
    assert.equal((await h.api(m, u, undefined, 'wrong-token')).status, 401, `${m} ${u} wrong token`)
  }
  assert.equal(h.wa.sockets.length, 0)
})

test('404 and 400 paths', async (t) => {
  const h = await harness(t)
  assert.equal((await h.api('GET', '/nothing')).status, 404)
  assert.equal((await h.api('PUT', '/sessions/1')).status, 404)
  assert.equal((await h.api('GET', '/sessions/1/start')).status, 404)
  assert.deepEqual((await h.api('GET', '/sessions/abc')).body.error, 'bad user_id')
  assert.equal((await h.api('POST', '/sessions/0/start')).status, 400)
  assert.equal((await h.api('POST', '/send', '{not json')).status, 400)
  assert.equal((await h.api('POST', '/send', { user_id: 'x' })).body.error, 'bad user_id')
  assert.deepEqual(await h.api('GET', '/sessions/77'), { status: 200, body: { status: 'none' } })
  assert.deepEqual(await h.api('GET', '/sessions'), { status: 200, body: [] })
})

test('start -> QR (rotating) -> connected -> logout', async (t) => {
  const h = await harness(t)
  const pending = h.api('POST', '/sessions/5/start')
  await waitFor(() => h.wa.sockets.length === 1)
  // a second start while the first waits reuses the same socket
  const second = h.api('POST', '/sessions/5/start')
  await sleep(50)
  h.wa.last.emit('connection.update', { qr: 'QR-1' })
  assert.deepEqual((await pending).body, { status: 'qr', qr: 'QR-1' })
  assert.deepEqual((await second).body, { status: 'qr', qr: 'QR-1' })
  assert.equal(h.wa.sockets.length, 1)
  h.wa.last.emit('connection.update', { qr: 'QR-2' })
  assert.deepEqual((await h.api('GET', '/sessions/5')).body, { status: 'qr', qr: 'QR-2' })
  assert.deepEqual((await h.api('GET', '/sessions')).body, [{ user_id: 5, status: 'qr', phone: null }])

  // the phone scans the QR: WhatsApp asks for a restart (515), the new socket opens
  const sock = h.wa.last
  sock.auth.creds.me = { id: '998901234567:7@s.whatsapp.net', name: 'Manager One' }
  sock.auth.creds.account = { details: Buffer.from('signed') }
  sock.emit('creds.update', { me: sock.auth.creds.me })
  sock.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } })
  await waitFor(() => h.wa.sockets.length === 2)
  h.wa.last.emit('connection.update', { connection: 'open' })
  assert.deepEqual((await h.api('GET', '/sessions/5')).body, { status: 'connected', phone: '+998901234567', name: 'Manager One' })
  assert.deepEqual((await h.api('POST', '/sessions/5/start')).body, { status: 'connected', phone: '+998901234567', name: 'Manager One' })
  await h.manager.sessions.get(5).store.persist()
  const stored = await openAuthStore({ dir: h.config.sessionsDir, userId: 5, key: h.key })
  assert.ok(stored.isLinked())
  assert.ok(stored.meta.linked_at > 0)

  assert.deepEqual((await h.api('DELETE', '/sessions/5')).body, { status: 'none' })
  assert.equal(h.wa.last.loggedOut, true)
  assert.equal(fsSync.existsSync(sessionFile(h.config.sessionsDir, 5)), false)
  assert.deepEqual((await h.api('GET', '/sessions/5')).body, { status: 'none' })
  assert.deepEqual((await h.api('DELETE', '/sessions/5')).body, { status: 'none' })
})

test('start answers "starting" when nothing comes within the wait', async (t) => {
  const h = await harness(t, { config: { startWaitMs: 150 } })
  assert.deepEqual((await h.api('POST', '/sessions/6/start')).body, { status: 'starting' })
})

test('a QR not scanned in time stops the session; its creds are deleted', async (t) => {
  const h = await harness(t, { config: { qrTimeoutMs: 200 } })
  const pending = h.api('POST', '/sessions/8/start')
  await waitFor(() => h.wa.sockets.length)
  h.wa.last.emit('connection.update', { qr: 'QR-1' })
  await pending
  await waitFor(() => h.manager.state(8).status === 'none', 2000)
  assert.equal(h.wa.last.ended, true)
  await waitFor(() => !fsSync.existsSync(sessionFile(h.config.sessionsDir, 8)))
})

test('unlinked on the phone (401) -> logged_out, session deleted; reconnect on other errors', async (t) => {
  const h = await harness(t)
  const sock = await connected(h)
  sock.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } })
  assert.equal((await h.api('GET', '/sessions/5')).body.status, 'starting')
  await waitFor(() => h.wa.sockets.length === 2, 4000)
  h.wa.last.emit('connection.update', { connection: 'open' })
  assert.equal((await h.api('GET', '/sessions/5')).body.status, 'connected')
  h.wa.last.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } })
  const out = (await h.api('GET', '/sessions/5')).body
  assert.ok(Date.parse(out.since) > 0)
  assert.deepEqual({ ...out, since: undefined }, { status: 'logged_out', phone: '+998901234567', name: 'Manager One', since: undefined })
  await waitFor(() => !fsSync.existsSync(sessionFile(h.config.sessionsDir, 5)))
  // a new start makes a new QR session
  const pending = h.api('POST', '/sessions/5/start')
  await waitFor(() => h.wa.sockets.length === 3)
  h.wa.last.emit('connection.update', { qr: 'QR-NEW' })
  assert.deepEqual((await pending).body, { status: 'qr', qr: 'QR-NEW' })
})

test('stored sessions are restored at start', async (t) => {
  const h = await harness(t)
  await connected(h, 12)
  const wa2 = fakeWhatsApp()
  const again = new SessionManager({ config: h.config, key: h.key, outbox: h.outbox, logger: silent, socketFactory: wa2.factory })
  t.after(() => again.stopAll())
  await again.restoreAll()
  await waitFor(() => wa2.sockets.length === 1)
  assert.equal(again.state(12).status, 'starting')
  wa2.last.emit('connection.update', { connection: 'open' })
  assert.deepEqual(again.state(12), { status: 'connected', phone: '+998901234567', name: 'Manager One' })
})

test('POST /send: errors', async (t) => {
  const h = await harness(t)
  let r = await h.api('POST', '/send', { user_id: 5, to_phone: '+998907654321', text: 'hi' })
  assert.deepEqual(r, { status: 400, body: { error: 'not connected', message: 'Ваш WhatsApp не подключён к CRM: подключите его в разделе «WhatsApp» и отправьте ещё раз' } })
  await connected(h)
  r = await h.api('POST', '/send', { user_id: 5, text: 'hi' })
  assert.deepEqual([r.status, r.body.error], [400, 'no recipient'])
  h.wa.onWhatsApp = async (nums) => nums.map((n) => ({ jid: `${n}@s.whatsapp.net`, exists: false }))
  r = await h.api('POST', '/send', { user_id: 5, to_phone: '+998 90 765-43-21', text: 'hi' })
  assert.deepEqual(r, { status: 400, body: { error: 'not on whatsapp', message: 'У этого номера нет WhatsApp' } })
  h.wa.onWhatsApp = async () => []
  assert.equal((await h.api('POST', '/send', { user_id: 5, to_phone: '+998907654321', text: 'hi' })).body.error, 'not on whatsapp')
  r = await h.api('POST', '/send', { user_id: 5, to_wa_id: '120363000000000000@g.us', text: 'hi' })
  assert.equal(r.body.error, 'bad wa_id')
  r = await h.api('POST', '/send', { user_id: 5, to_wa_id: '207843005431853@lid', files: [{ path: '../../etc/passwd', name: 'x' }] })
  assert.deepEqual([r.status, r.body.error], [400, 'bad file'])
  r = await h.api('POST', '/send', { user_id: 5, to_wa_id: '207843005431853@lid', files: [{ path: 'missing.pdf', name: 'missing.pdf' }] })
  assert.deepEqual([r.status, r.body.error], [400, 'file not found'])
  r = await h.api('POST', '/send', { user_id: 5, to_wa_id: '207843005431853@lid', text: '  ' })
  assert.deepEqual([r.status, r.body.error], [400, 'nothing to send'])
  h.wa.sendFails = true
  r = await h.api('POST', '/send', { user_id: 5, to_wa_id: '207843005431853@lid', text: 'hi' })
  assert.equal(r.status, 502)
  assert.equal(r.body.error, 'send failed')
  assert.match(r.body.message, /WhatsApp не принял сообщение/)
  assert.equal(h.wa.last.sent.length, 0)
})

test('POST /send: files then text, ids remembered so the echo is not posted to the CRM', async (t) => {
  const h = await harness(t)
  const sock = await connected(h)
  await fs.writeFile(path.join(h.config.uploadsDir, 'aaa.jpg'), 'x')
  await fs.writeFile(path.join(h.config.uploadsDir, 'bbb.pdf'), 'x')
  let asked = null
  h.wa.onWhatsApp = async (nums) => { asked = nums; return [{ jid: '998907654321@s.whatsapp.net', exists: true }] }
  const r = await h.api('POST', '/send', {
    user_id: 5, to_phone: '+998 90 765 43 21', text: 'Ваше КП',
    files: [{ path: 'aaa.jpg', name: 'photo.jpg', type: 'photo' }, { path: 'bbb.pdf', name: 'КП.pdf', type: 'document' }],
  })
  assert.equal(r.status, 200)
  assert.deepEqual(asked, ['998907654321'])
  assert.equal(r.body.message_ids.length, 3)
  assert.deepEqual(sock.sent.map((m) => Object.keys(m.content)[0]), ['image', 'document', 'text'])
  assert.equal(sock.sent[0].jid, '998907654321@s.whatsapp.net')
  assert.equal(sock.sent[0].content.image.url, path.join(h.config.uploadsDir, 'aaa.jpg'))
  assert.equal(sock.sent[1].content.fileName, 'КП.pdf')
  assert.equal(sock.sent[1].content.mimetype, 'application/pdf')
  assert.deepEqual(r.body.message_ids, sock.sent.map((m) => m.opts.messageId))

  // to_wa_id (a LID chat) is used directly, without the onWhatsApp check
  asked = null
  const r2 = await h.api('POST', '/send', { user_id: 5, to_wa_id: '207843005431853@lid', text: 'ok' })
  assert.equal(r2.status, 200)
  assert.equal(asked, null)
  assert.equal(sock.sent[3].jid, '207843005431853@lid')

  // if WhatsApp echoes one of them as an upsert, it is not posted again
  sock.emit('messages.upsert', { type: 'append', messages: [waMessage({ id: r.body.message_ids[2], fromMe: true, message: { conversation: 'Ваше КП' } })] })
  await sleep(100)
  assert.equal(h.crm.requests.length, 0)
})

test('media content by type or extension', () => {
  const kind = (f) => Object.keys(mediaContent({ ...f, abs: '/x/' + f.path }))[0]
  assert.equal(kind({ path: 'a.jpg', name: 'a.jpg', type: 'photo' }), 'image')
  assert.equal(kind({ path: 'a.png', name: 'a.png' }), 'image')
  assert.equal(kind({ path: 'a.webp', name: 'a.webp', type: 'photo' }), 'document')
  assert.equal(kind({ path: 'a.mp4', name: 'v.mp4', type: 'video' }), 'video')
  assert.equal(kind({ path: 'a.mp3', name: 'a.mp3', type: 'audio' }), 'audio')
  assert.equal(mediaContent({ path: 'a.ogg', name: 'v.ogg', type: 'voice', abs: '/x' }).ptt, true)
  assert.equal(mediaContent({ path: 'a.mp3', name: 'v.mp3', type: 'voice', abs: '/x' }).ptt, undefined)
  assert.equal(kind({ path: 'a.webp', name: 's.webp', type: 'sticker' }), 'sticker')
  assert.equal(kind({ path: 'a.xlsx', name: 'p.xlsx', type: 'document' }), 'document')
  assert.equal(kind({ path: 'a.bin', name: 'noext' }), 'document')
})

test('incoming: text and own phone messages reach the CRM, groups and old ones do not', async (t) => {
  const h = await harness(t)
  const sock = await connected(h)
  const now = Math.floor(Date.now() / 1000)
  sock.emit('messages.upsert', {
    type: 'notify',
    messages: [
      waMessage({ id: 'IN1', message: { conversation: 'Салом' } }),
      waMessage({ id: 'GRP', jid: '120363000000000000@g.us', key: { participant: '998907654321@s.whatsapp.net' } }),
      waMessage({ id: 'OLD', ts: now - 86400 * 30 }),
      waMessage({ id: 'REACT', message: { reactionMessage: { text: '👍' } } }),
      waMessage({ id: 'ST', jid: 'status@broadcast' }),
    ],
  })
  sock.emit('messages.upsert', { type: 'append', messages: [waMessage({ id: 'OUT1', fromMe: true, jid: '207843005431853@lid', key: { remoteJidAlt: '998935554433@s.whatsapp.net' }, message: { conversation: 'Ассалому алайкум' } })] })
  await waitFor(() => h.crm.requests.length === 2)
  await sleep(50)
  assert.equal(h.crm.requests.length, 2)
  const [a, b] = h.crm.requests.map((r) => r.body)
  assert.equal(h.crm.requests[0].headers['x-whatsapp-service-token'], TOKEN)
  assert.deepEqual({ ...a, date: undefined }, {
    agent_id: 5, agent_phone: '+998901234567', chat: { wa_id: '998907654321@s.whatsapp.net', phone: '+998907654321', name: 'Client Name', photo: null },
    wa_message_id: 'IN1', text: 'Салом', outgoing: false, date: undefined, files: [],
  })
  assert.deepEqual([b.wa_message_id, b.outgoing, b.chat.wa_id, b.chat.phone, b.chat.name], ['OUT1', true, '207843005431853@lid', '+998935554433', null])
  // the same message again (redelivery) is posted once
  sock.emit('messages.upsert', { type: 'notify', messages: [waMessage({ id: 'IN1', message: { conversation: 'Салом' } })] })
  await sleep(100)
  assert.equal(h.crm.requests.length, 2)
})

test('incoming media: saved under a random name; too large -> a note; download failure -> a note; ignored -> file removed', async (t) => {
  const payloads = { IMG: Buffer.from('jpeg-bytes'), DOC: Buffer.from('%PDF-1.4 test') }
  const h = await harness(t, {
    config: { maxFileMb: 1 },
    download: async (msg) => {
      if (msg.key.id === 'BROKEN') throw Object.assign(new Error('410 gone'), { status: 410 })
      if (msg.key.id === 'HUGE2') return Readable.from([Buffer.alloc(700 * 1024), Buffer.alloc(700 * 1024)])
      return Readable.from([payloads[msg.key.id]])
    },
  })
  const sock = await connected(h)
  sock.emit('messages.upsert', {
    type: 'notify',
    messages: [
      waMessage({ id: 'IMG', message: { imageMessage: { caption: 'вот фото', mimetype: 'image/jpeg', fileLength: 10 } } }),
      waMessage({ id: 'DOC', message: { documentMessage: { fileName: 'прайс.pdf', mimetype: 'application/pdf' } } }),
      waMessage({ id: 'HUGE', message: { videoMessage: { caption: 'big', mimetype: 'video/mp4', fileLength: 5 * 1024 * 1024 } } }),
      waMessage({ id: 'HUGE2', message: { documentMessage: { fileName: 'big.zip', mimetype: 'application/zip' } } }),
      waMessage({ id: 'BROKEN', message: { stickerMessage: { mimetype: 'image/webp' } } }),
    ],
  })
  await waitFor(() => h.crm.requests.length === 5)
  const byId = Object.fromEntries(h.crm.requests.map((r) => [r.body.wa_message_id, r.body]))
  const img = byId.IMG.files[0]
  assert.equal(byId.IMG.text, 'вот фото')
  assert.equal(img.type, 'photo')
  assert.equal(img.caption, null)
  assert.match(img.path, /^[0-9a-f]{32}\.jpg$/)
  assert.match(img.name, /^photo_\d{8}_\d{6}\.jpg$/)
  assert.equal(await fs.readFile(path.join(h.config.uploadsDir, img.path), 'utf8'), 'jpeg-bytes')
  assert.deepEqual([byId.DOC.files[0].name, byId.DOC.files[0].type], ['прайс.pdf', 'document'])
  assert.match(byId.DOC.files[0].path, /^[0-9a-f]{32}\.pdf$/)
  assert.deepEqual(byId.HUGE.files, [])
  assert.match(byId.HUGE.text, /^big\n\[видео «video_\d{8}_\d{6}\.mp4» больше 1 МБ — не сохранён\]$/)
  assert.deepEqual(byId.HUGE2.files, [])
  assert.match(byId.HUGE2.text, /файл «big\.zip» больше 1 МБ/)
  assert.deepEqual(byId.BROKEN.files, [])
  assert.match(byId.BROKEN.text, /не удалось скачать/)
  // only the two good files are left in uploads (the partial download was removed)
  assert.equal((await fs.readdir(h.config.uploadsDir)).length, 2)

  // the API does not want this chat: the saved file is removed again
  h.crm.body = { status: 'ignored' }
  sock.emit('messages.upsert', { type: 'notify', messages: [waMessage({ id: 'IMG', jid: '998900000001@s.whatsapp.net', message: { imageMessage: { mimetype: 'image/jpeg' } } })] })
  await waitFor(() => h.crm.requests.length === 6)
  await sleep(50)
  assert.equal((await fs.readdir(h.config.uploadsDir)).length, 2)
})

test('voice message: ogg converted to mp3 with FFMPEG_BIN', { skip: !fsSync.existsSync(FFMPEG) && 'no local/dev/bin/ffmpeg' }, async (t) => {
  const dir = await tempDir()
  const ogg = path.join(dir, 'voice.ogg')
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', ogg])
  const h = await harness(t, { config: { ffmpegBin: FFMPEG }, download: async () => fsSync.createReadStream(ogg) })
  const sock = await connected(h)
  sock.emit('messages.upsert', { type: 'notify', messages: [waMessage({ id: 'VOICE', message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus', seconds: 1 } } })] })
  await waitFor(() => h.crm.requests.length === 1, 10000)
  const f = h.crm.requests[0].body.files[0]
  assert.equal(f.type, 'voice')
  assert.match(f.path, /^[0-9a-f]{32}\.mp3$/)
  assert.match(f.name, /^voice_\d{8}_\d{6}\.mp3$/)
  const head = (await fs.readFile(path.join(h.config.uploadsDir, f.path))).subarray(0, 3)
  assert.ok(head.toString() === 'ID3' || head[0] === 0xff, 'an mp3 file')
  assert.deepEqual(await fs.readdir(h.config.uploadsDir), [f.path])
})

test('the CRM is down: incoming messages wait in the outbox and go out later', async (t) => {
  const h = await harness(t)
  const sock = await connected(h)
  h.crm.status = 502
  sock.emit('messages.upsert', { type: 'notify', messages: [waMessage({ id: 'W1' }), waMessage({ id: 'W2' })] })
  await waitFor(() => h.outbox.size === 2)
  h.crm.status = 201
  h.outbox.nextAt = 0
  await h.outbox.flush()
  assert.deepEqual(h.crm.requests.slice(-2).map((r) => r.body.wa_message_id), ['W1', 'W2'])
  assert.equal(h.outbox.size, 0)
})
