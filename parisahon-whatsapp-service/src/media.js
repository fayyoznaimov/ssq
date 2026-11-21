// Media of incoming messages: downloaded into UPLOADS_DIR (the API's uploads folder) under a random
// 32-hex name; voice messages (ogg/opus) are converted to mp3 when FFMPEG_BIN is set.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'audio/amr': 'amr', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm',
  'application/pdf': 'pdf', 'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/vnd.rar': 'rar', 'application/x-rar-compressed': 'rar',
  'application/x-7z-compressed': '7z', 'text/plain': 'txt', 'text/csv': 'csv', 'application/json': 'json', 'application/xml': 'xml',
  'text/xml': 'xml', 'application/vnd.android.package-archive': 'apk', 'application/rtf': 'rtf',
}
const DEFAULT_EXT = { photo: 'jpg', video: 'mp4', voice: 'ogg', audio: 'mp3', sticker: 'webp', document: 'bin' }

export const EXT_MIME = Object.fromEntries(Object.entries(MIME_EXT).reverse().map(([m, e]) => [e, m]))
EXT_MIME.jpg = 'image/jpeg'
EXT_MIME.jpeg = 'image/jpeg'
EXT_MIME.ogg = 'audio/ogg; codecs=opus'
EXT_MIME.mp3 = 'audio/mpeg'
EXT_MIME.webm = 'video/webm'

const safeExt = (ext) => (ext && /^[a-z0-9]{1,8}$/.test(ext) ? ext : null)

export function extensionFor(media) {
  const fromName = safeExt(path.extname(media.fileName || '').slice(1).toLowerCase())
  if (media.kind === 'document' && fromName) return fromName
  const mime = String(media.mimetype || '').split(';')[0].trim().toLowerCase()
  return MIME_EXT[mime] || fromName || DEFAULT_EXT[media.kind] || 'bin'
}

/** A file name safe to show: no directories, no control characters, at most 180 characters. */
export function cleanFileName(name) {
  const base = path.basename(String(name || '')).replace(/[\u0000-\u001f\u007f/\\]/g, '').trim()
  return base.length > 180 ? base.slice(0, 180) : base
}

const stamp = (sec) => {
  const d = new Date(sec * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export const randomName = (ext) => `${crypto.randomBytes(16).toString('hex')}.${ext}`

const KIND_RU = { photo: 'фото', video: 'видео', voice: 'голосовое', audio: 'аудио', document: 'файл', sticker: 'стикер' }

export class TooLarge extends Error {}

function limitBytes(max) {
  let total = 0
  return new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length
      if (total > max) cb(new TooLarge(`more than ${max} bytes`))
      else cb(null, chunk)
    },
  })
}

/**
 * Writes a stream to `target` (mode 644), at most maxBytes. On any failure the file is removed —
 * after the write stream is closed, so a late open cannot leave an empty file behind.
 */
export async function writeLimited(source, target, maxBytes) {
  const out = fs.createWriteStream(target, { mode: 0o644 })
  try {
    await pipeline(source, limitBytes(maxBytes), out)
  } catch (error) {
    if (!out.closed) await new Promise((resolve) => { out.once('close', resolve); out.destroy() })
    await fsp.rm(target, { force: true })
    throw error
  }
}

export function convertToMp3(ffmpegBin, input, output, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-codec:a', 'libmp3lame', '-q:a', '4', output],
      { timeout: timeoutMs }, (error) => (error ? reject(error) : resolve()))
  })
}

/**
 * Saves the media of a message. Returns { file } ({name, path, type, caption}) or { note } — a line
 * for the message text when the file is too large or could not be downloaded.
 * download(msg) -> Promise<Readable> (Baileys' downloadMediaMessage in production, a stub in tests).
 */
export async function saveMedia({ msg, media, uploadsDir, maxFileMb, ffmpegBin, download, logger, timestampSec }) {
  const maxBytes = maxFileMb * 1024 * 1024
  const ext = extensionFor(media)
  const original = cleanFileName(media.fileName)
  const shownName = original || `${media.kind}_${stamp(timestampSec || Date.now() / 1000)}.${ext}`
  const tooLarge = () => ({ note: `[${KIND_RU[media.kind] || 'файл'} «${shownName}» больше ${maxFileMb} МБ — не сохранён]` })
  if (media.fileLength && media.fileLength > maxBytes) return tooLarge()

  const stored = randomName(ext)
  const target = path.join(uploadsDir, stored)
  try {
    await writeLimited(await download(msg), target, maxBytes)
  } catch (error) {
    if (error instanceof TooLarge) return tooLarge()
    logger?.warn({ err: error }, `media of message ${String(msg.key?.id).slice(0, 8)}… not downloaded`)
    return { note: `[${KIND_RU[media.kind] || 'файл'} не удалось скачать из WhatsApp]` }
  }

  if (media.kind === 'voice' && ffmpegBin && ext !== 'mp3') {
    const mp3 = stored.replace(/\.[a-z0-9]+$/, '.mp3')
    try {
      await convertToMp3(ffmpegBin, target, path.join(uploadsDir, mp3))
      await fsp.rm(target, { force: true })
      const name = original ? original.replace(/\.[^.]+$/, '') + '.mp3' : shownName.replace(/\.[a-z0-9]+$/, '.mp3')
      return { file: { name, path: mp3, type: 'voice', caption: null } }
    } catch (error) {
      await fsp.rm(path.join(uploadsDir, mp3), { force: true })
      logger?.warn({ err: error }, 'voice message kept as ogg: ffmpeg failed')
    }
  }
  return { file: { name: shownName, path: stored, type: media.kind, caption: null } }
}

/** Removes saved files (the API answered "ignored": the chat is not for the CRM). */
export async function removeFiles(uploadsDir, files) {
  for (const f of files || []) {
    if (!f?.path) continue
    await fsp.rm(path.join(uploadsDir, path.basename(f.path)), { force: true }).catch(() => {})
  }
}
