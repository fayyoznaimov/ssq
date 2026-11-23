// Settings from the environment (see .env.example). Paths are resolved against the working directory.
import path from 'node:path'

const positive = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function loadConfig(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    port: positive(env.PORT, 3140),
    crmApiUrl: (env.CRM_API_URL || 'http://127.0.0.1:3000/api/v1').replace(/\/+$/, ''),
    crmApiToken: env.CRM_API_TOKEN || '',
    crmApiTimeoutMs: positive(env.CRM_API_TIMEOUT_SEC, 30) * 1000,
    sessionsDir: path.resolve(env.SESSIONS_DIR || 'sessions'),
    uploadsDir: path.resolve(env.UPLOADS_DIR || 'uploads'),
    sessionKey: (env.SESSION_ENCRYPTION_KEY || '').trim(),
    ffmpegBin: env.FFMPEG_BIN ? path.resolve(env.FFMPEG_BIN) : '',
    maxFileMb: positive(env.MAX_FILE_MB, 50),
    pollSec: positive(env.POLL_SEC, 10),
    maxBackoffSec: positive(env.MAX_BACKOFF_SEC, 300),
    startWaitMs: positive(env.START_WAIT_SEC, 10) * 1000,
    // POST /send answers 504 {pending} after this; the CRM API waits 120 s, so keep it below that
    sendWaitMs: positive(env.SEND_WAIT_SEC, 90) * 1000,
    // on SIGTERM the messages in hand are handled for at most this long (docker stop waits 10 s by default)
    drainMs: positive(env.DRAIN_SEC, 8) * 1000,
    qrTimeoutMs: positive(env.QR_TIMEOUT_SEC, 180) * 1000,
    logLevel: env.LOG_LEVEL || 'info',
    baileysLogLevel: env.BAILEYS_LOG_LEVEL || 'warn',
    // "2,3000,1055357543": a fixed WhatsApp Web version; empty = ask web.whatsapp.com at start
    waVersion: env.WA_VERSION || '',
    // the "browser" shown in Linked devices and sent with pairing codes: ubuntu | macos | windows (always Chrome)
    waBrowser: (env.WA_BROWSER || 'ubuntu').toLowerCase(),
  }
}
