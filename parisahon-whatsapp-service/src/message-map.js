// Which WhatsApp messages belong to the CRM, and how one becomes the payload of
// POST /whatsapp/incoming. Pure functions (no socket), covered by tests/message-map.test.js.
import {
  getContentType, normalizeMessageContent, jidDecode, jidNormalizedUser,
  isJidGroup, isJidStatusBroadcast, isJidBroadcast, isJidNewsletter, isLidUser, isPnUser,
  isHostedPnUser, isHostedLidUser, isJidBot, isJidMetaAI,
} from '@whiskeysockets/baileys'

/** Content types that are not a message of the conversation. */
const SKIPPED_TYPES = {
  protocolMessage: 'protocol message (delete, edit, history sync, settings)',
  reactionMessage: 'reaction',
  encReactionMessage: 'reaction',
  pollUpdateMessage: 'poll vote',
  encEventResponseMessage: 'event response',
  keepInChatMessage: 'keep in chat',
  pinInChatMessage: 'pin',
  senderKeyDistributionMessage: 'key distribution',
  messageContextInfo: 'no content',
  call: 'call',
  bcallMessage: 'call',
  callLogMesssage: 'call log',
  stickerSyncRmrMessage: 'sticker sync',
  placeholderMessage: 'placeholder',
}

/** Kind of the chat by its JID. Only 'user' chats are recorded. */
export function chatKind(jid) {
  if (!jid) return 'none'
  if (isJidGroup(jid)) return 'group'
  if (isJidStatusBroadcast(jid)) return 'status'
  if (isJidBroadcast(jid)) return 'broadcast'
  if (isJidNewsletter(jid)) return 'newsletter'
  if (isJidBot(jid) || isJidMetaAI(jid)) return 'bot'
  if (isPnUser(jid) || isLidUser(jid) || isHostedPnUser(jid) || isHostedLidUser(jid)) return 'user'
  return 'other'
}

/** '+998901234567' for a phone-number JID ('998901234567:3@s.whatsapp.net'), else null. */
export function phoneFromJid(jid) {
  if (!jid || !(isPnUser(jid) || isHostedPnUser(jid))) return null
  const user = jidDecode(jid)?.user
  return user && /^\d{5,16}$/.test(user) ? '+' + user : null
}

export const userOf = (jid) => (jid ? jidDecode(jid)?.user || null : null)

/** Seconds since the epoch from messageTimestamp (number, Long or string). */
export function timestampSec(value) {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber()
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const pad = (n) => String(n).padStart(2, '0')

/** ISO 8601 with the offset of this process' time zone: 2026-11-19T15:04:05+05:00 */
export function isoWithOffset(seconds) {
  const d = new Date(seconds * 1000)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

const toNumber = (value) => (value === null || value === undefined ? null : timestampSec(value))

function vcardPhones(vcard) {
  if (!vcard) return []
  const phones = []
  for (const m of String(vcard).matchAll(/^(?:item\d+\.)?TEL[^:\n]*:([^\n\r]+)/gim)) {
    const value = m[1].trim()
    if (value) phones.push(value)
  }
  return phones
}

function contactText(contact) {
  const phones = vcardPhones(contact?.vcard)
  return `Контакт: ${contact?.displayName || 'без имени'}${phones.length ? ' ' + phones.join(', ') : ''}`
}

function locationText(loc, live) {
  const lat = Number(loc?.degreesLatitude)
  const lng = Number(loc?.degreesLongitude)
  const where = [loc?.name, loc?.address].filter(Boolean).join(', ')
  return `${live ? 'Трансляция геопозиции' : 'Геопозиция'}${where ? ': ' + where : ''}` +
    (Number.isFinite(lat) && Number.isFinite(lng) ? ` https://maps.google.com/?q=${lat},${lng}` : '')
}

/**
 * What the message carries: { type, text, media } where media is
 * { kind: photo|video|voice|audio|document|sticker, contentType, mimetype, fileName, fileLength, ptt }.
 * `type` is the Baileys content type ('conversation', 'imageMessage', ...).
 */
export function describeMessage(msg) {
  const content = normalizeMessageContent(msg?.message)
  const type = getContentType(content)
  const out = { type, text: '', media: null }
  if (!content || !type) return out
  const c = content[type]
  const media = (kind, extra = {}) => ({
    kind,
    contentType: type,
    mimetype: c?.mimetype || null,
    fileName: c?.fileName || null,
    fileLength: toNumber(c?.fileLength),
    ptt: Boolean(c?.ptt),
    ...extra,
  })
  switch (type) {
    case 'conversation': out.text = content.conversation || ''; break
    case 'extendedTextMessage': out.text = c?.text || ''; break
    case 'imageMessage': out.text = c?.caption || ''; out.media = media('photo'); break
    case 'videoMessage': out.text = c?.caption || ''; out.media = media('video'); break
    case 'ptvMessage': out.media = media('video'); break
    case 'audioMessage': out.media = media(c?.ptt ? 'voice' : 'audio'); break
    case 'documentMessage': out.text = c?.caption || ''; out.media = media('document'); break
    case 'stickerMessage': out.media = media('sticker'); break
    case 'contactMessage': out.text = contactText(c); break
    case 'contactsArrayMessage': out.text = (c?.contacts || []).map(contactText).join('\n'); break
    case 'locationMessage': out.text = locationText(c, false); break
    case 'liveLocationMessage': out.text = locationText(c, true); break
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
    case 'pollCreationMessageV5':
      out.text = `Опрос: ${c?.name || ''}${c?.options?.length ? ' (' + c.options.map((o) => o.optionName).join(' / ') + ')' : ''}`
      break
    case 'eventMessage': out.text = `Событие: ${c?.name || ''}${c?.description ? '\n' + c.description : ''}`; break
    case 'buttonsResponseMessage': out.text = c?.selectedDisplayText || ''; break
    case 'templateButtonReplyMessage': out.text = c?.selectedDisplayText || ''; break
    case 'listResponseMessage': out.text = c?.title || ''; break
    case 'interactiveResponseMessage': out.text = c?.body?.text || ''; break
    default: out.text = typeof c?.text === 'string' ? c.text : typeof c?.caption === 'string' ? c.caption : ''
  }
  return out
}

/** An edit of an earlier message (Baileys' normalizeMessageContent would unwrap it into a new-looking one). */
function isEdit(message) {
  let m = message
  for (let i = 0; i < 5 && m; i++) {
    if (m.editedMessage || m.protocolMessage?.editedMessage) return true
    m = (m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension ||
      m.documentWithCaptionMessage)?.message
  }
  return false
}

/**
 * null when the message must go to the CRM, otherwise a short reason for the log.
 * ctx: { sinceSec, ownIds: Set (ids this service sent), selfUsers: Set (own PN and LID user parts) }
 */
export function reasonToSkip(msg, ctx = {}) {
  const key = msg?.key
  const jid = key?.remoteJid
  if (!key || !jid || !key.id) return 'no chat'
  const kind = chatKind(jid)
  if (kind === 'group') return 'group'
  if (kind === 'status') return 'status'
  if (kind === 'broadcast') return 'broadcast list'
  if (kind === 'newsletter') return 'newsletter'
  if (kind !== 'user') return `not a private chat (${kind})`
  if (ctx.selfUsers?.has(userOf(jid))) return 'chat with myself'
  if (ctx.ownIds?.has(key.id)) return 'sent by this service'
  if (!msg.message) return msg.messageStubType ? 'service message' : 'empty'
  if (isEdit(msg.message)) return 'edit of an earlier message'
  const content = normalizeMessageContent(msg.message)
  const type = getContentType(content)
  if (!type) return 'empty'
  if (SKIPPED_TYPES[type]) return SKIPPED_TYPES[type]
  const sec = timestampSec(msg.messageTimestamp)
  if (ctx.sinceSec && sec && sec < ctx.sinceSec) return 'before the session start'
  const d = describeMessage(msg)
  if (!d.media && !d.text.trim()) return `empty or unsupported (${type})`
  return null
}

/**
 * The other side of the chat: { wa_id, phone, name }.
 * helpers: { lidToPn(lidJid) -> Promise<pnJid|null>, contact(jid) -> {name, notify, verifiedName, phoneNumber, lid}|undefined,
 *            selfUsers: Set }
 */
export async function resolveChat(msg, helpers = {}) {
  const key = msg.key
  const waId = jidNormalizedUser(key.remoteJid)
  let phone = phoneFromJid(waId)
  const notSelf = (jid) => jid && !helpers.selfUsers?.has(userOf(jid))
  if (!phone) {
    // LID-addressed chat: the phone number may come with the message, from the session's
    // LID <-> PN mapping or from the contacts WhatsApp synced for this account
    const candidates = [key.remoteJidAlt, key.senderPn, key.participantPn]
    for (const alt of candidates) {
      if (alt && notSelf(alt) && phoneFromJid(alt)) { phone = phoneFromJid(alt); break }
    }
    if (!phone && helpers.lidToPn && isLidUser(waId)) {
      try {
        const pn = await helpers.lidToPn(waId)
        if (pn && notSelf(pn)) phone = phoneFromJid(pn)
      } catch { /* no mapping */ }
    }
    if (!phone && helpers.contact) {
      const c = helpers.contact(waId)
      if (c?.phoneNumber && notSelf(c.phoneNumber)) phone = phoneFromJid(c.phoneNumber)
      if (!phone && c?.id && c.id !== waId && notSelf(c.id)) phone = phoneFromJid(c.id)
    }
  }
  const contact = helpers.contact?.(waId) || (phone && helpers.contact?.(phone.slice(1) + '@s.whatsapp.net')) || null
  // pushName of an outgoing message is the manager's own name, not the client's
  const pushName = key.fromMe ? null : (msg.pushName || null)
  const name = contact?.name || pushName || contact?.notify || contact?.verifiedName || null
  return { wa_id: waId, phone: phone || null, name: name ? String(name).trim() || null : null }
}

/** The body of POST /whatsapp/incoming. */
export function buildPayload({ msg, agentId, agentPhone, chat, text, files }) {
  return {
    agent_id: Number(agentId),
    agent_phone: agentPhone || null,
    chat: { wa_id: chat.wa_id, phone: chat.phone ?? null, name: chat.name ?? null, photo: chat.photo ?? null },
    wa_message_id: msg.key.id,
    text: text || '',
    outgoing: Boolean(msg.key.fromMe),
    date: isoWithOffset(timestampSec(msg.messageTimestamp) || Math.floor(Date.now() / 1000)),
    files: files || [],
  }
}
