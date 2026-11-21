import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPayload, chatKind, describeMessage, isoWithOffset, phoneFromJid, reasonToSkip, resolveChat,
} from '../src/message-map.js'
import { waMessage } from './helpers.js'

const NOW = Math.floor(Date.now() / 1000)
const ctx = { sinceSec: NOW - 3600, ownIds: new Set(['SENTBYSERVICE1']), selfUsers: new Set(['998901234567', '111222333444555']) }
const map = async (msg, helpers = {}) => {
  const d = describeMessage(msg)
  const chat = await resolveChat(msg, { selfUsers: ctx.selfUsers, ...helpers })
  return buildPayload({ msg, agentId: 5, agentPhone: '+998901234567', chat, text: d.text, files: [] })
}

test('text message -> payload', async () => {
  const msg = waMessage({ message: { conversation: 'Салом, нархи қанча?' }, ts: NOW - 60 })
  assert.equal(reasonToSkip(msg, ctx), null)
  const p = await map(msg)
  assert.deepEqual(p.chat, { wa_id: '998907654321@s.whatsapp.net', phone: '+998907654321', name: 'Client Name', photo: null })
  assert.equal(p.agent_id, 5)
  assert.equal(p.agent_phone, '+998901234567')
  assert.equal(p.wa_message_id, 'ABCDEF1234567890')
  assert.equal(p.text, 'Салом, нархи қанча?')
  assert.equal(p.outgoing, false)
  assert.match(p.date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/)
  assert.equal(Date.parse(p.date), (NOW - 60) * 1000)
  assert.deepEqual(p.files, [])
})

test('extended text, ephemeral wrapper, device part of the jid', async () => {
  const msg = waMessage({ jid: '998907654321:12@s.whatsapp.net', message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'link https://x.uz' } } } } })
  assert.equal(reasonToSkip(msg, ctx), null)
  const p = await map(msg)
  assert.equal(p.text, 'link https://x.uz')
  assert.equal(p.chat.wa_id, '998907654321@s.whatsapp.net')
})

test('captions and media kinds', () => {
  const cases = [
    [{ imageMessage: { caption: 'photo cap', mimetype: 'image/jpeg', fileLength: 1000 } }, 'photo', 'photo cap'],
    [{ videoMessage: { caption: 'video cap', mimetype: 'video/mp4' } }, 'video', 'video cap'],
    [{ ptvMessage: { mimetype: 'video/mp4' } }, 'video', ''],
    [{ audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } }, 'voice', ''],
    [{ audioMessage: { ptt: false, mimetype: 'audio/mpeg' } }, 'audio', ''],
    [{ documentMessage: { fileName: 'price.pdf', mimetype: 'application/pdf' } }, 'document', ''],
    [{ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'kp.xlsx', caption: 'КП', mimetype: 'application/vnd.ms-excel' } } } }, 'document', 'КП'],
    [{ stickerMessage: { mimetype: 'image/webp' } }, 'sticker', ''],
    [{ viewOnceMessageV2: { message: { imageMessage: { caption: 'once', mimetype: 'image/jpeg' } } } }, 'photo', 'once'],
  ]
  for (const [message, kind, text] of cases) {
    const msg = waMessage({ message })
    assert.equal(reasonToSkip(msg, ctx), null, JSON.stringify(message))
    const d = describeMessage(msg)
    assert.equal(d.media?.kind, kind, JSON.stringify(message))
    assert.equal(d.text, text)
  }
  assert.equal(describeMessage(waMessage({ message: { documentMessage: { fileName: 'a.pdf', fileLength: { toNumber: () => 1234 } } } })).media.fileLength, 1234)
})

test('contact card and location become text', () => {
  const contact = describeMessage(waMessage({ message: { contactMessage: { displayName: 'Ali', vcard: 'BEGIN:VCARD\nFN:Ali\nTEL;type=CELL;waid=998901112233:+998 90 111 22 33\nEND:VCARD' } } }))
  assert.equal(contact.text, 'Контакт: Ali +998 90 111 22 33')
  const loc = describeMessage(waMessage({ message: { locationMessage: { degreesLatitude: 41.3, degreesLongitude: 69.24, name: 'Склад' } } }))
  assert.equal(loc.text, 'Геопозиция: Склад https://maps.google.com/?q=41.3,69.24')
})

test('own message from the phone -> outgoing, no pushName as the client name', async () => {
  const msg = waMessage({ fromMe: true, pushName: 'Manager One', message: { conversation: 'Ассалому алайкум' } })
  assert.equal(reasonToSkip(msg, ctx), null)
  const p = await map(msg)
  assert.equal(p.outgoing, true)
  assert.equal(p.chat.name, null)
  assert.equal(p.chat.phone, '+998907654321')
  const named = await map(msg, { contact: (jid) => (jid === '998907654321@s.whatsapp.net' ? { name: 'Ali (кирпич)' } : undefined) })
  assert.equal(named.chat.name, 'Ali (кирпич)')
})

test('LID chat: phone from remoteJidAlt, senderPn, the LID mapping or contacts; else null', async () => {
  const lid = '207843005431853@lid'
  const withAlt = await map(waMessage({ jid: lid, key: { remoteJidAlt: '998935554433@s.whatsapp.net', addressingMode: 'lid' } }))
  assert.deepEqual([withAlt.chat.wa_id, withAlt.chat.phone], [lid, '+998935554433'])

  const withSenderPn = await map(waMessage({ jid: lid, key: { senderPn: '998935554434@s.whatsapp.net' } }))
  assert.equal(withSenderPn.chat.phone, '+998935554434')

  const mapped = await map(waMessage({ jid: lid }), { lidToPn: async (l) => (l === lid ? '998935554435:3@s.whatsapp.net' : null) })
  assert.equal(mapped.chat.phone, '+998935554435')

  const fromContacts = await map(waMessage({ jid: lid }), { contact: (j) => (j === lid ? { id: lid, phoneNumber: '998935554436@s.whatsapp.net', name: 'Saved' } : undefined) })
  assert.deepEqual([fromContacts.chat.phone, fromContacts.chat.name], ['+998935554436', 'Saved'])

  const unknown = await map(waMessage({ jid: lid }), { lidToPn: async () => null })
  assert.deepEqual(unknown.chat, { wa_id: lid, phone: null, name: 'Client Name', photo: null })

  // an own message in a LID chat may carry the manager's own number as the alternative: not the client's
  const own = await map(waMessage({ jid: lid, fromMe: true, key: { remoteJidAlt: '998901234567@s.whatsapp.net' } }))
  assert.equal(own.chat.phone, null)
})

test('filters: groups, status, broadcast, channels, reactions, protocol, edits, old, own, self, empty', () => {
  const skip = (o) => reasonToSkip(waMessage(o), ctx)
  assert.equal(skip({ jid: '120363000000000000@g.us' }), 'group')
  assert.equal(skip({ jid: 'status@broadcast' }), 'status')
  assert.equal(skip({ jid: '1234567890@broadcast' }), 'broadcast list')
  assert.equal(skip({ jid: '120363111111111111@newsletter' }), 'newsletter')
  assert.equal(skip({ message: { reactionMessage: { text: '👍', key: { id: 'X' } } } }), 'reaction')
  assert.equal(skip({ message: { protocolMessage: { type: 0, key: { id: 'X' } } } }), 'protocol message (delete, edit, history sync, settings)')
  assert.equal(skip({ message: { ephemeralMessage: { message: { protocolMessage: { type: 0 } } } } }), 'protocol message (delete, edit, history sync, settings)')
  assert.equal(skip({ message: { editedMessage: { message: { conversation: 'fixed' } } } }), 'edit of an earlier message')
  assert.equal(skip({ message: { protocolMessage: { type: 14, editedMessage: { conversation: 'fixed' } } } }), 'edit of an earlier message')
  assert.equal(skip({ message: { pollUpdateMessage: {} } }), 'poll vote')
  assert.equal(skip({ ts: NOW - 7200 }), 'before the session start')
  assert.equal(skip({ id: 'SENTBYSERVICE1' }), 'sent by this service')
  assert.equal(skip({ jid: '998901234567@s.whatsapp.net' }), 'chat with myself')
  assert.equal(skip({ jid: '111222333444555@lid' }), 'chat with myself')
  assert.equal(skip({ message: null, messageStubType: 2 }), 'service message')
  assert.equal(skip({ message: null }), 'empty')
  assert.equal(skip({ message: { conversation: '   ' } }), 'empty or unsupported (conversation)')
  assert.equal(skip({ message: { senderKeyDistributionMessage: {} } }), 'empty')
  assert.equal(skip({ message: { call: { callKey: Buffer.from('x') } } }), 'empty')
  assert.equal(skip({ jid: '13135550002@bot' }), 'not a private chat (bot)')
})

test('helpers: chat kinds, phones, dates', () => {
  assert.equal(chatKind('207843005431853@lid'), 'user')
  assert.equal(chatKind('998901234567@s.whatsapp.net'), 'user')
  assert.equal(phoneFromJid('998901234567:3@s.whatsapp.net'), '+998901234567')
  assert.equal(phoneFromJid('207843005431853@lid'), null)
  const iso = isoWithOffset(1763550000)
  assert.equal(Date.parse(iso), 1763550000000)
})
