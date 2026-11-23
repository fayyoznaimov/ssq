// The real Baileys socket (WhatsApp Web protocol over a websocket, no browser).
import makeWASocket, {
  Browsers, proto, fetchLatestWaWebVersion, fetchLatestBaileysVersion, isJidGroup, isJidBroadcast, isJidNewsletter,
} from '@whiskeysockets/baileys'

let cachedVersion = null
const HISTORY_TYPES = new Set([
  proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
  proto.HistorySync.HistorySyncType.PUSH_NAME,
  proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA,
])

/** The WhatsApp Web version to announce: WA_VERSION, else asked from web.whatsapp.com (cached 12 h), else Baileys' own. */
export async function waVersion(config, logger) {
  if (config.waVersion) return config.waVersion.split(/[.,]/).map(Number)
  if (cachedVersion && Date.now() - cachedVersion.at < 12 * 3600 * 1000) return cachedVersion.version
  let found = await fetchLatestWaWebVersion().catch((error) => ({ isLatest: false, error }))
  if (!found?.isLatest) found = await fetchLatestBaileysVersion().catch((error) => ({ isLatest: false, error }))
  if (found?.isLatest && found.version) {
    cachedVersion = { version: found.version, at: Date.now() }
    logger?.info(`WhatsApp Web version ${found.version.join('.')}`)
    return found.version
  }
  logger?.warn('latest WhatsApp Web version unknown, using the one bundled with Baileys')
  return undefined
}

/** socketFactory for SessionManager: ({ auth, logger, config, getMessage }) -> Baileys socket. */
export async function createWaSocket({ auth, logger, config, getMessage }) {
  const version = await waVersion(config, logger)
  return makeWASocket({
    ...(version ? { version } : {}),
    auth,
    logger,
    // a real browser name: WhatsApp refuses pairing codes from unknown companions
    browser: ({ macos: Browsers.macOS, windows: Browsers.windows }[config.waBrowser] || Browsers.ubuntu)('Chrome'),
    // the phone keeps its notifications: this device never shows the account as "online"
    markOnlineOnConnect: false,
    // No history import into the CRM: old messages only ever arrive as 'messaging-history.set',
    // which the service does not record. The small first syncs are still accepted: they carry the
    // contacts' names and the LID <-> phone mappings (Baileys warns that without them sessions break).
    syncFullHistory: false,
    shouldSyncHistoryMessage: ({ syncType }) => HISTORY_TYPES.has(syncType),
    // groups, status, broadcast lists and channels are not decrypted at all
    shouldIgnoreJid: (jid) => Boolean(isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)),
    // messages sent through POST /send are not echoed back as upserts
    emitOwnEvents: false,
    generateHighQualityLinkPreview: false,
    // a client's device that could not decrypt a message asks for it again: the messages sent through
    // POST /send are kept for 7 days (stores.js SentStore); Baileys' own short cache answers first
    getMessage: async (key) => (getMessage ? getMessage(key) : undefined),
  })
}
