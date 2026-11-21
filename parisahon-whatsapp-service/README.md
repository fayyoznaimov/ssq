# parisahon-whatsapp-service

Connects the managers' own WhatsApp accounts to the CRM, like `parisahon-telegram-service` does for
Telegram. Node.js 20 + [Baileys](https://github.com/WhiskeySockets/Baileys) `@whiskeysockets/baileys@7.0.0-rc14`
(the WhatsApp Web multi-device protocol over a websocket, no browser). Each manager links the
service as a "linked device" by scanning a QR code, like WhatsApp Web.

> Unofficial: WhatsApp does not allow third-party clients. The owner chose this knowingly. A number
> can be restricted or banned by WhatsApp, more likely for new numbers, mass sending or many reports.
> Use it for normal one-to-one work with clients, never for mailings.

- One Baileys socket per CRM user (manager); the session (creds + signal keys) is one AES-256-GCM
  encrypted file per user in `SESSIONS_DIR` (`session-<user_id>.json`, directory 700, files 600).
  Stored sessions are reconnected at start.
- Every message of a one-to-one chat — from the client, or written by the manager on the phone — is
  posted to the CRM API `POST ${CRM_API_URL}/whatsapp/incoming`; the API finds the contact and the deal
  and writes the history. Nothing is written to Postgres here.
- If the API is unreachable (5xx, network) the message waits in the outbox (`SESSIONS_DIR/outbox.json`,
  sealed like the sessions) and is resent in order every `POLL_SEC`, with a pause doubling up to
  `MAX_BACKOFF_SEC`; it survives restarts. A 4xx answer is logged and dropped.
- The CRM sends through `POST /send`; those messages are not posted back to the CRM.
- Logs never contain message texts, keys or full phone numbers (runs of 7+ digits are masked).

## HTTP API (for the CRM API only)

Every request except `GET /health` carries `X-WhatsApp-Service-Token: <CRM_API_TOKEN>` (compared in
constant time), otherwise `401`. Errors are `{error: '<short english code>', message: '<Russian text for the manager>'}`.

| Request | Answer |
|---|---|
| `POST /sessions/:user_id/start` | optional JSON `{phone:'+998…'}`. Starts or reuses the socket; waits up to `START_WAIT_SEC` (10 s) for the first QR, the pairing code or the connection: `{status:'starting'}` \| `{status:'qr', qr}` \| `{status:'code', code:'ABCD-1234'}` (with `phone`) \| `{status:'connected', phone:'+998…', name}`. With `phone` the device is linked by a **pairing code** instead of the QR (WhatsApp → Linked devices → Link a device → *Link with phone number instead*, enter the code). A phone given while a QR waits replaces that QR session. Errors: `400 bad phone`; `400 phone rejected` / `429 too many attempts` / `502 pairing failed` when WhatsApp refuses the code request. WhatsApp does not tell whether the number has an account: for a number without WhatsApp the code is simply never used and the session times out. |
| `GET /sessions/:user_id` | `{status:'none'\|'starting'\|'qr'\|'code'\|'connected'\|'logged_out', qr?, code?, phone?, name?, passkey?}` — `qr` is the latest one (it rotates: 60 s, then every 20 s); `code` stays the same until it is used. A QR or code not used in time stops the session (`none`): WhatsApp ends it after ~160 s, `QR_TIMEOUT_SEC` (3 min) is the backstop. `passkey: true` = WhatsApp asked this device for a passkey ("Continue on WhatsApp Web", accounts with a passkey; Baileys cannot answer it): offer linking by phone number. `logged_out` = unlinked on the phone; the stored session is already deleted, a new start shows a new QR. A linked session that lost the connection is `starting` while it reconnects. |
| `DELETE /sessions/:user_id` | logs out (the device disappears from "Linked devices" on the phone) and deletes the stored session: `{status:'none'}` |
| `GET /sessions` | `[{user_id, status, phone}]` |
| `POST /send` | `{user_id, to_phone?, to_wa_id?, text, files:[{path, name, type}]}` — `path` is a file name in `UPLOADS_DIR`. `to_phone` is checked with WhatsApp (`onWhatsApp`); without it `to_wa_id` (the stored `chat.wa_id`, `…@lid` or `…@s.whatsapp.net`) is used as is. Files first (image / video / audio / voice / sticker by `type` or extension, anything else as a document with its name), then the text. `200 {message_ids:[…]}`; `400` `not connected` / `not on whatsapp` / `no recipient` / `bad phone` / `bad wa_id` / `bad file` / `file not found` / `nothing to send`; `502` `send failed` (with `message_ids` of what was sent before the failure) or `whatsapp error`. |
| `POST /resolve` | `{user_id, phone:'+998…'}` → `200 {wa_id:'998…@s.whatsapp.net' \| null, photo:'<32 hex>.jpg' \| null}`: does this number have WhatsApp (asked with `onWhatsApp` through that manager's session) and its profile picture (as `chat.photo`). `400 not connected` without a connected session, `400 bad phone`, `400 bad user_id`, `502 whatsapp error`. |
| `GET /health` | `{ok:true, sessions:n, outbox:n}`, no token |

The QR string is the raw content of the code; the client renders it (any QR library).

## Incoming → CRM

`POST ${CRM_API_URL}/whatsapp/incoming`, header `X-WhatsApp-Service-Token`, JSON:

```json
{ "agent_id": 5, "agent_phone": "+998901234567",
  "chat": { "wa_id": "998907654321@s.whatsapp.net", "phone": "+998907654321", "name": "Ali", "photo": "<32 hex>.jpg" },
  "wa_message_id": "3EB0C4…", "text": "text or caption or ''", "outgoing": false,
  "date": "2026-11-19T15:04:05+05:00",
  "files": [{ "name": "прайс.pdf", "path": "<32 hex>.pdf", "type": "photo|video|voice|audio|document|sticker", "caption": null }] }
```

- `outgoing: true` — written by the manager on the phone (or WhatsApp Web).
- `chat.wa_id` — the chat JID without the device part. WhatsApp increasingly addresses people by
  LID (`…@lid`, a hidden id instead of the number). The phone is then taken from the message
  (`remoteJidAlt` / `senderPn`), the session's LID ↔ phone mapping or the synced contacts; if none
  knows it, `phone` is `null` and the API has to match the chat by `wa_id`.
- `chat.name` — the name saved in the manager's phone book, else the client's own WhatsApp name
  (never the manager's name on outgoing messages); can be `null`.
- `chat.photo` — the client's WhatsApp profile picture, a file in `UPLOADS_DIR`. Sent with the first
  message of a chat after the service starts, then at most once per 24 h; `null` in between, when
  there is no picture, privacy hides it or the download fails (`null` = no news: keep what you have).
  Pictures are remembered per chat in `SESSIONS_DIR/photos.json` (sealed); an unchanged picture is
  not downloaded again (same file name), a changed one gets a new file. Old files are not deleted.
- Contacts and locations come as text (`Контакт: …`, `Геопозиция: … https://maps.google.com/?q=…`).
- Media are saved in `UPLOADS_DIR` under a random 32-hex name; voice messages are converted to mp3
  when `FFMPEG_BIN` is set (else `.ogg`). Files over `MAX_FILE_MB` are not downloaded: a note
  `[видео «…» больше 50 МБ — не сохранён]` goes into the text, as does `[… не удалось скачать из WhatsApp]`.
- The API answers `201 {status:'saved'|'duplicate'|'ignored'}`; on `ignored` the saved files are removed.
- Not recorded: groups, status, broadcast lists, channels, bots, the chat with yourself, reactions,
  edits, deletions and other protocol messages, poll votes, calls, empty messages, messages sent by
  this service, and anything older than the moment the device was linked (no history import; the
  small first sync WhatsApp sends is used only for contact names and LID ↔ phone mappings).
  Messages that arrived while the service was down are delivered by WhatsApp on reconnect and are posted then.

## Running

```bash
npm ci            # node 20; exact versions from package-lock.json
cp .env.example .env && $EDITOR .env
node --env-file=.env src/index.js
npm test          # node:test, no WhatsApp needed (fake socket + fake CRM)
```

On the dev server: unit `crm-dev-whatsapp` (`local/dev/units.sh`), env file written by
`local/dev/whatsapp-env.sh` (`local/dev/whatsapp.env`, sessions in `local/dev/whatsapp-sessions`).

## Files

- `src/index.js` — start: config, outbox, sessions, HTTP.
- `src/session-manager.js` — sockets per user, QR / pairing code / connection life cycle, incoming handling, `send`.
- `src/wa-socket.js` — the Baileys socket options (no online presence, no history, groups ignored).
- `src/auth-store.js` + `src/crypto-box.js` — the encrypted single-file auth state.
- `src/message-map.js` — filters and the payload (pure functions).
- `src/media.js` — media download, size limit, voice → mp3.
- `src/photos.js` — profile pictures (`chat.photo`, `/resolve`).
- `src/outbox.js` — the CRM client and the persistent outbox.
- `src/http-server.js` — the HTTP API. `src/log.js` — the masking logger.

## Known limits

- **Passkey accounts.** For accounts with a passkey WhatsApp may ask the new device for it after the
  QR is scanned ("Continue on WhatsApp Web…", Baileys issue #2672); Baileys cannot answer and the
  phone returns to the scanner. The journal says `WhatsApp asks for a passkey`, the state carries
  `passkey: true`; linking by phone number (pairing code) is the way to try instead — it is not
  guaranteed to avoid the prompt for every account.

- **Bans.** An unofficial client; WhatsApp may log the device out or restrict the number. Status
  `logged_out` then; the manager scans a new QR.
- **Phone must live.** A linked device works without the phone online, but WhatsApp unlinks
  companions after ~14 days without the phone connecting.
- **LID.** For chats WhatsApp gives only by LID and without a known number, `phone` is `null`.
- **No history.** Only messages after linking (and those delivered on reconnect) are recorded.
- **Decryption gaps.** A message WhatsApp cannot decrypt for this device at first is resent by the
  phone later (Baileys asks for it); rarely it never arrives.
- **One instance per session.** Two processes with the same session file push each other out
  (WhatsApp code 440).
- **Not sent:** location, contacts, polls, replies/quotes and reactions from the CRM — text and files only.
