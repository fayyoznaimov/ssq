# parisahon-telegram-service

Connects the managers' own Telegram accounts (Pyrogram) to the CRM.

- One Pyrogram client per connected manager (`sessions` in `SERVICE_DB`, sqlite).
- Every message of a private chat with a person (incoming, or sent from the phone) is posted
  to the CRM API: `POST /telegram/incoming` with the shared `CRM_API_TOKEN`. The API finds or
  creates the contact and the deal and writes the history; nothing is written to Postgres here.
  Bots, Telegram's service accounts (login codes), groups and "Saved Messages" are skipped
  (`helpers/chat_filter.py`).
- If the API is unreachable (or refuses the service itself: 401/403 after a token change) the message
  waits in the `outbox` table and is resent in order; a message the API fails on (500) is retried with its
  own pause without holding up the others and set aside after `API_MAX_FAILED_ATTEMPTS`; one the API refuses
  (400, 404, 410 for a manager who is no longer staff) goes to the `rejected` table at once — never dropped.
- The HTTP API (`app.py`) wants `X-Telegram-Service-Token` = `SERVICE_HTTP_TOKEN` (default `CRM_API_TOKEN`,
  the same shared secret; the API sends `TELEGRAM_SERVICE_HTTP_TOKEN` or `TELEGRAM_SERVICE_TOKEN`) on every
  route except `GET /health`.
- Each account's state (`connected`, `error`, `revoked` = ended in Telegram itself) is in `/get-sessions` and
  `/health`; every `HEALTH_SEC` each client is asked who it is. A new connection replaces the running client
  at once; `POST /logout` signs the account out of Telegram and forgets it (the CRM's «Отключить»).
- Edits of a message go to the CRM too (`edited: true`, the recorded text is replaced).
- `chat.photo` of the payload: the client's Telegram profile photo, saved into the uploads folder as
  `<hex>.jpg`, with the first message of a chat after the listener starts, then at most once a day per
  chat and only when it changed; `null` when there is no photo or privacy hides it, left out otherwise
  (`helpers/profile_photo.py`).
- `POST /resolve-phone {user_id, phone, first_name?, last_name?}` → `{tg_id|null, username, first_name,
  last_name, photo|null}`: is there a Telegram account behind the number, looked up with that manager's
  account through `contacts.importContacts` (the number stays in their Telegram contacts, so they can write
  to it). 400 no session / bad phone, 429 Telegram's flood limit (`retry_after`), 503 no answer in
  `RESOLVE_TIMEOUT_SEC` (20). `helpers/phone_lookup.py`.
- A file above `TG_MAX_AUTO_DOWNLOAD_MB` (25; 0 = no limit) is not saved: the payload carries
  `{remote: true, size, mime}` instead of a path, and the CRM shows a link. `GET /download?user_id&chat_id&message_id`
  streams such a file from Telegram through that manager's account when somebody clicks the link; nothing
  is kept on the server (`helpers/media_download.py`). It works while the message exists in Telegram and
  the manager's account is connected.
- A message sent from the CRM (`POST /new-message`) is answered only after Telegram accepted it;
  the API records it. Two-step verification is supported when connecting (`needs_password`).
- Call recordings from the recorder's folders (`RECORDINGS_SOURCE/<CRM user id>/*.amr + .json`) are
  sent to `POST /calls/upload` of the API with the service token; nothing is written to Postgres.

Tests (no Telegram needed): `python -m unittest discover -s tests -t .`

## Explanations
We use third party app to record calls which will save records for each user in 
separate sub-folders with names corresponding to user id  

---

### Example recordings folder:
- recordings
  - 1 # Recordings for user with id 1 
    - recording.json # .json file will include metadata
    - recording.amr # .amr file is recording itself
  - 2 # Recordings for user with id 2
    - recording.json
    - recording.amr

---

### FFMPEG
We use ffmpeg to convert different files types to necessary types

---

## Project setup instructions
Do not use relative path when creating soft links
```commandline
ln -s <parisahon-api-dir>/public/uploads <this-project-dir> 
```

```commandline
docker compose up -d --build
```

```commandline
docker exec -it telegram-app bash
```
This step if optional:
If you want manual installation of ffmpeg
```
tar -xf ffmpeg/{your_cpu_architecture_version}.tar.xz
```
And set USE_CUSTOM_FFMPEG_INSTALLATION in .env file to true

```commandline
mkdir recordings
```

```commandline
exit
```

```commandline
docker restart telegram-app
```