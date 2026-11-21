// HTTP API of the service, called only by the CRM API (see README.md).
// Every request except GET /health carries X-WhatsApp-Service-Token: <CRM_API_TOKEN>.
import http from 'node:http'
import crypto from 'node:crypto'
import { ServiceError } from './session-manager.js'

const MAX_BODY = 1024 * 1024

/** Constant-time comparison (digests have the same length whatever the input). */
export function tokenMatches(given, expected) {
  if (!expected || typeof given !== 'string' || !given) return false
  const a = crypto.createHash('sha256').update(given).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

const send = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' })
  res.end(text)
}
const fail = (res, status, error, message) => send(res, status, { error, message })

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try { resolve(JSON.parse(text)) } catch { reject(Object.assign(new Error('bad json'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

const parseUserId = (value) => {
  if (!/^\d{1,12}$/.test(value)) return null
  const n = Number(value)
  return n > 0 ? n : null
}

/** createApp({ manager, outbox, token, logger }) -> http.Server (not listening yet). */
export function createHttpServer({ manager, outbox, token, logger }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local')
    const parts = url.pathname.split('/').filter(Boolean)
    const method = req.method
    try {
      if (method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, sessions: manager.count, outbox: outbox?.size ?? 0 })
      }
      if (!tokenMatches(req.headers['x-whatsapp-service-token'], token)) {
        return fail(res, 401, 'unauthorized', 'Нет доступа к WhatsApp-сервису')
      }
      if (parts[0] === 'sessions') {
        if (parts.length === 1 && method === 'GET') return send(res, 200, manager.list())
        if (parts.length >= 2 && parts.length <= 3) {
          const userId = parseUserId(parts[1])
          if (!userId) return fail(res, 400, 'bad user_id', 'Неверный пользователь')
          if (parts.length === 3 && parts[2] === 'start' && method === 'POST') {
            const body = await readJson(req)
            if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'bad json', 'Неверный запрос')
            if (body.phone !== undefined && body.phone !== null && typeof body.phone !== 'string') return fail(res, 400, 'bad phone', 'Неверный номер телефона')
            return send(res, 200, await manager.start(userId, { phone: body.phone }))
          }
          if (parts.length === 2 && method === 'GET') return send(res, 200, manager.state(userId))
          if (parts.length === 2 && method === 'DELETE') return send(res, 200, await manager.logout(userId))
        }
      }
      if (parts.length === 1 && parts[0] === 'resolve' && method === 'POST') {
        const body = await readJson(req)
        const userId = parseUserId(String(body?.user_id ?? ''))
        if (!userId) return fail(res, 400, 'bad user_id', 'Неверный пользователь')
        if (typeof body.phone !== 'string') return fail(res, 400, 'bad phone', 'Неверный номер телефона')
        return send(res, 200, await manager.resolve({ userId, phone: body.phone }))
      }
      if (parts.length === 1 && parts[0] === 'send' && method === 'POST') {
        const body = await readJson(req)
        const userId = parseUserId(String(body.user_id ?? ''))
        if (!userId) return fail(res, 400, 'bad user_id', 'Неверный пользователь')
        if (body.files !== undefined && !Array.isArray(body.files)) return fail(res, 400, 'bad files', 'Неверный список файлов')
        if (body.text !== undefined && body.text !== null && typeof body.text !== 'string') return fail(res, 400, 'bad text', 'Неверный текст')
        const result = await manager.send({
          userId, toPhone: body.to_phone, toWaId: body.to_wa_id, text: body.text || '', files: body.files || [],
        })
        return send(res, 200, result)
      }
      return fail(res, 404, 'not found', 'Нет такого адреса')
    } catch (error) {
      if (error instanceof ServiceError) return send(res, error.status, { error: error.error, message: error.message, ...error.extra })
      if (error?.status === 400) return fail(res, 400, 'bad json', 'Неверный запрос')
      if (error?.status === 413) return fail(res, 413, 'too large', 'Слишком большой запрос')
      logger?.error({ err: error }, `${method} ${url.pathname} failed`)
      return fail(res, 500, 'internal', 'Ошибка WhatsApp-сервиса')
    }
  })
}
