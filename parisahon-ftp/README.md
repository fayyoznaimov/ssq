# parisahon-ftp

FTP receiver of the managers' call recordings. The recorder on a manager's Android phone (Cube ACR
and the like) keeps every call as a file; an FTP sync app uploads that folder here; this service
posts every audio file to the CRM API (`POST /calls/upload`). It is transport only: the number, the
direction and the time of the call are read from the file name by the API (`parisahon-api/src/calls`).

Python 3 + [pyftpdlib](https://github.com/giampaolo/pyftpdlib) in its own venv; everything else is
the standard library (`urllib`, `sqlite3`). Files: `server.py` (start), `ftpd.py` (login, homes, log
lines), `forwarder.py` (what is sent and when), `crm.py` (the two API calls), `state.py` (sqlite),
`config.py` (environment).

## Login and folders

- User name: anything. **Password: the manager's recorder token** (CRM → settings → calls). The
  service asks the API whose token it is: `GET {CRM_API_URL}/calls/recorder` with `X-Recorder-Token`
  → `{"user_id": 5, "username": "…"}`, `401` = unknown or revoked.
- An accepted token is not asked about again for ~5 minutes (`FTP_AUTH_CACHE_SEC`), a refused one for
  30 seconds. A revoked token therefore still logs in for up to 5 minutes; a session that is already
  open is not cut. While the API is unreachable, a token it accepted earlier (since the service
  started, at most a day ago) is still let in — the files wait on the disk; a token never seen
  before is refused ("try again later").
- A wrong password costs 3 seconds, the third one closes the connection (pyftpdlib). Passwords and
  tokens are never logged, also not when someone types the token into the user name field.
- The session is locked into `FTP_ROOT/<user_id>/` (made at the first login). Inside it everything a
  sync app needs is allowed: list, upload, resume, download, mkdir, rename, delete, set the file time
  (`MFMT`). `SITE CHMOD` is refused. Two managers who type the same user name get different folders.
- Passive mode with the fixed range `FTP_PASSIVE_PORTS` (open it in the firewall together with
  `FTP_PORT`). Behind NAT set `FTP_MASQUERADE_ADDRESS` to the address the phones connect to.
- With `FTP_TLS_CERT` / `FTP_TLS_KEY` explicit FTPS (`AUTH TLS`) is offered; plain FTP stays allowed
  because many phone apps speak nothing else. `setup.sh <venv> <tls dir>` makes a self-signed
  certificate. Without TLS the token travels in clear text: fine in the office network or a VPN,
  not over the open internet.

Phone app settings: server and port from the CRM settings page (`CALLS_FTP_ADDRESS` of the API),
any user name, the token as the password, passive mode, one-way upload of the recorder's folder to `/`.
If the app can upload under a temporary name and rename afterwards, turn that on.

## What is forwarded

Every `FTP_SCAN_SEC` (and right after an upload, a rename or `MFMT`) the homes are walked,
subfolders included. A file is posted when

- its extension is `.amr .mp3 .m4a .wav .ogg .aac .3gp` (any case);
- it is not hidden or temporary: no leading `.`, not inside a `.folder`, no `.part` `.tmp`
  `.filepart` `~` ending; not empty;
- its size **and** mtime have not changed for `FTP_SETTLE_SEC`, and its upload is finished: an upload
  that is running or broke off (lost network, `ABOR`) is marked and waits until the phone uploads the
  file to the end — also across a restart of the service;
- this content (sha256) was not handled for this manager before.

`POST {CRM_API_URL}/calls/upload`, multipart, header `X-Calls-Service-Token: CALLS_SERVICE_TOKEN`:
`user_id` (the folder name), `recorded_at` (the file's mtime, epoch milliseconds — sync apps set it
to the recording's time with `MFMT`), `file` (the audio under its own base name, UTF-8 as is:
Cyrillic, `↗`), `meta` (a `.json` with the same base name next to the audio — `call.json` or
`call.m4a.json` — when there is one). The oldest recording goes first.

| API answer | What happens |
|---|---|
| 2xx | remembered as sent with the API's upload id; `"duplicate": true` is a success too |
| 400, 413, 415 | remembered as rejected with the API's text, never sent again |
| 401, 403 | loud `ERROR` line; that manager's files wait (10 s … 10 min between tries), the others go on. Either `CALLS_SERVICE_TOKEN` is not the API's, or the API does not know that user id as a staff user |
| 5xx, other 4xx | that file is tried again after 30 s, 1 min, 2 min … 1 h |
| no connection, 404, 502–504 | the API is away: everything waits, next try after 10 s … 5 min |

The state is `FTP_STATE_DIR/state.sqlite`, keyed by manager + sha256 of the content: the same
recording under another name, renamed later or uploaded again is not sent twice; unsent files are
picked up after a restart. If the service dies between the API's answer and writing it down, the
file goes out once more and the API answers `duplicate`.

**Files are not deleted or moved after sending**: a sync app compares its folder with the listing
here and would upload a missing file again. Files are removed `FTP_RETAIN_DAYS` after they arrived
(or last changed here; the recording's own date does not count), except audio that is still waiting
to be sent. If the phone uploads a removed file again, it is recognised and not sent again. When
the folder of a manager is removed by hand, the service forgets its records (within 10 minutes).

Known limits: FTP cannot tell a finished upload from one whose app was killed cleanly in the
middle (both end with a closed data connection) — such a half file is forwarded, and the full one
later as a second upload; upload-then-rename in the app avoids it. A `.json` that arrives after its
audio was already sent is not sent. There is no disk quota per manager.

## Log

One line per event, file names as they are (stdout; `journalctl --user -u crm-ftp`, dev:
`local/dev/units.sh logs crm-dev-ftp 200`):

```
ftp.server: login user=5 name="Алишер" ip=172.0.30.77 [tls]
ftp.server: login refused ip=172.0.30.77
ftp.server: received user=5 file="Cube/2026-11-21 14-03-12 (phone) Феруз (+998 90 000-00-00) ↗.wav" size=412044
ftp.server: received user=5 file="x.wav.tmp" size=412044 (not forwarded: temporary name or not audio)
ftp.server: renamed user=5 file="x.wav.tmp" to="x.wav"      deleted … / incomplete … (upload broke off)
ftp.forward: forwarded user=5 file="…" size=412044 upload_id=812 [duplicate (the API already had this content)]
ftp.forward: already sent user=5 file="copy.wav" size=412044 upload_id=812 (same content as "…")
ftp.forward: rejected user=5 file="…" size=3 status=400 reason="…" (will not be sent again)
ftp.forward: retry user=5 file="…" size=… attempt=2 next_try_in=60s reason="HTTP 500: …"
ftp.forward: removed old user=5 file="…" size=… (older than 30 days)
```

Lines of `pyftpdlib:` show the FTP session itself (connect, `MKD` / `RNTO` / `DELE` / `CWD`, each
transfer). `LOG_LEVEL=debug` adds every command of the phone app (the password is masked).

## Settings (environment)

| Key | Default | |
|---|---|---|
| `FTP_HOST` | `0.0.0.0` | address to listen on |
| `FTP_PORT` | `2121` | control port (dev 2131, trial 2121) |
| `FTP_PASSIVE_PORTS` | any free | fixed range for data connections, e.g. `21310-21319` |
| `FTP_MASQUERADE_ADDRESS` | — | address announced for passive connections (NAT) |
| `FTP_ROOT` | required | homes of the managers: `FTP_ROOT/<user_id>/` |
| `FTP_STATE_DIR` | required | `state.sqlite`; must be outside `FTP_ROOT` |
| `CRM_API_URL` | required | e.g. `http://127.0.0.1:3000/api/v1` |
| `CALLS_SERVICE_TOKEN` | required | the same value as `CALLS_SERVICE_TOKEN` of the API |
| `FTP_TLS_CERT`, `FTP_TLS_KEY` | — | both or none; with them `AUTH TLS` is offered |
| `FTP_RETAIN_DAYS` | `30` | `0` = never remove files |
| `FTP_SETTLE_SEC` | `5` | how long size and mtime must hold still |
| `FTP_SCAN_SEC` | `10` | pause between scans |
| `FTP_AUTH_CACHE_SEC` | `300` | how long an accepted token is not asked about again |
| `LOG_LEVEL` | `info` | `debug` shows the FTP dialogue |

The API side: `CALLS_SERVICE_TOKEN` (shared secret) and `CALLS_FTP_ADDRESS` (`host:port` shown to
the managers) in the API's env file.

## Run

```
parisahon-ftp/setup.sh <venv dir> [tls dir]      # venv + requirements.txt (+ self-signed certificate)
<venv dir>/bin/python -u parisahon-ftp/server.py  # settings from the environment
```

- Dev copy: `local/dev/ftp-env.sh` writes `local/dev/ftp.env` (port 2131, passive 21310-21319, files
  and state in `local/dev/ftp/`) and adds the two keys to `local/dev/api.env`; unit `crm-dev-ftp`
  (`local/dev/units.sh`).
- Trial copy: `local/deploy.sh ftp` → `~/parisa-crm/ftp`, unit `crm-ftp`, port 2121, passive
  21210-21219, env `~/parisa-crm/ftp.env`, files `~/parisa-crm/ftp-data`, state and certificate
  `~/parisa-crm/ftp-state`.

## Tests

```
local/dev/ftp/venv/bin/python -m unittest discover -s parisahon-ftp/tests
```

Any venv made by `setup.sh` will do. The tests start a stand-in CRM API (`http.server`,
`tests/helpers.py`) and the real FTP server on free local ports; nothing outside a temp folder is
touched. Against the dev API: `local/dev/check.sh ftp` (`local/checks/ftp_check.py`).
