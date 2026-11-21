// parisahon-whatsapp-service: the managers' own WhatsApp accounts (Baileys) <-> the CRM API.
import path from 'node:path'
import fs from 'node:fs/promises'
import { loadConfig } from './config.js'
import { createLogger } from './log.js'
import { parseKey } from './crypto-box.js'
import { ensurePrivateDir } from './files.js'
import { CrmClient, Outbox } from './outbox.js'
import { SessionManager } from './session-manager.js'
import { createHttpServer } from './http-server.js'
import { createWaSocket } from './wa-socket.js'
import { PhotoCache } from './photos.js'

const config = loadConfig()
const logger = createLogger({ level: config.logLevel, bindings: {} })
const baileysLogger = createLogger({ level: config.baileysLogLevel, bindings: { mod: 'baileys' } })

let key
try {
  key = parseKey(config.sessionKey)
} catch (error) {
  logger.fatal(error.message)
  process.exit(2)
}
if (!key) logger.warn('SESSION_ENCRYPTION_KEY is not set: WhatsApp sessions are stored as plain text')
if (!config.crmApiToken) logger.warn('CRM_API_TOKEN is not set: every request except /health is refused and nothing reaches the CRM')

await ensurePrivateDir(config.sessionsDir)
await fs.mkdir(config.uploadsDir, { recursive: true })
if (config.ffmpegBin) {
  // Baileys runs "ffmpeg" for video thumbnails: the static one is found through PATH
  process.env.PATH = `${path.dirname(config.ffmpegBin)}${path.delimiter}${process.env.PATH || ''}`
}

const client = new CrmClient({ baseUrl: config.crmApiUrl, token: config.crmApiToken, timeoutMs: config.crmApiTimeoutMs })
const outbox = new Outbox({
  file: path.join(config.sessionsDir, 'outbox.json'), key, client, pollSec: config.pollSec, maxBackoffSec: config.maxBackoffSec,
  logger: logger.child({ mod: 'outbox' }),
})
await outbox.load()

const photos = new PhotoCache({
  file: path.join(config.sessionsDir, 'photos.json'), key, uploadsDir: config.uploadsDir,
  maxBytes: Math.min(config.maxFileMb, 5) * 1024 * 1024, logger: logger.child({ mod: 'photos' }),
})
await photos.load()

const manager = new SessionManager({ config, key, outbox, logger, baileysLogger, socketFactory: createWaSocket, photos })
outbox.onResult = (payload, result) => manager.onDelivered(payload, result)
outbox.start()

const server = createHttpServer({ manager, outbox, token: config.crmApiToken, logger })
server.listen(config.port, config.host, () => {
  logger.info(`listening on ${config.host}:${config.port}; CRM API ${config.crmApiUrl}; outbox ${outbox.size} waiting`)
})

manager.restoreAll().catch((error) => logger.error({ err: error }, 'restoring sessions failed'))
if (outbox.size) outbox.flush().catch(() => {})

let stopping = false
const stop = async (signal) => {
  if (stopping) return
  stopping = true
  logger.info(`${signal}: stopping`)
  outbox.stop()
  server.close()
  await manager.stopAll().catch(() => {})
  await outbox.saving
  await photos.saving
  process.exit(0)
}
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
process.on('unhandledRejection', (error) => logger.error({ err: error }, 'unhandled rejection'))
