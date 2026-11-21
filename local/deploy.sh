#!/usr/bin/env bash
# Deploys the repository to the trial copy on this server (~/parisa-crm, units crm-api / crm-web).
#   local/deploy.sh          api + web
#   local/deploy.sh api      only parisahon-api  -> ~/parisa-crm/api
#   local/deploy.sh web      only parisahon-client/app -> ~/parisa-crm/web
#   local/deploy.sh telegram parisahon-telegram-service -> ~/parisa-crm/telegram (unit crm-telegram,
#                            127.0.0.1:3030; first run writes ~/parisa-crm/telegram.env with a new
#                            session key and points the API at it). Not part of "all".
#   local/deploy.sh whatsapp parisahon-whatsapp-service -> ~/parisa-crm/whatsapp (unit crm-whatsapp, 127.0.0.1:3040;
#                            first run writes ~/parisa-crm/whatsapp.env with a new token and session key and
#                            adds WHATSAPP_SERVICE_URL / WHATSAPP_SERVICE_TOKEN to api.env). Not part of "all".
#   local/deploy.sh stt      parisahon-stt -> ~/parisa-crm/stt (unit crm-stt, 127.0.0.1:8096: speech-to-text of
#                            the bot's voice messages; model copied from local/dev/stt or downloaded once,
#                            sets CRM_BOT_STT_URL in api.env). Not part of "all".
#   local/deploy.sh ftp      parisahon-ftp -> ~/parisa-crm/ftp (unit crm-ftp, port 2121, passive 21210-21219: the
#                            FTP receiver the managers' phones sync their call recordings to; venv in ftp-venv,
#                            files in ftp-data, state and the self-signed certificate in ftp-state; first run
#                            writes ~/parisa-crm/ftp.env and adds CALLS_SERVICE_TOKEN / CALLS_FTP_ADDRESS to
#                            api.env). Not part of "all".
# Steps: copy the sources (never .env, keys/, public/uploads/, node_modules, builds), install the
# dependencies only when the lock file changed, build, run the migrations (api), restart the
# units and check that both answer. Logs: ~/parisa-crm/build-api.log, ~/parisa-crm/build-web.log.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TARGET="${CRM_TRIAL_DIR:-$HOME/parisa-crm}"
API_URL="${CRM_TRIAL_API_URL:-http://127.0.0.1:3000/api/v1/}"
WEB_URL="${CRM_TRIAL_WEB_URL:-http://127.0.0.1:4300/}"
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
WHAT="${1:-all}"
case "$WHAT" in api|web|all|telegram|stt|whatsapp|ftp) ;; *) echo "usage: deploy.sh [api|web|all|telegram|stt|whatsapp|ftp]"; exit 2 ;; esac
[ -d "$TARGET/api" ] && [ -d "$TARGET/web" ] || { echo "no trial copy in $TARGET"; exit 1; }
[ -f "$TARGET/api.env" ] || { echo "no $TARGET/api.env"; exit 1; }

say() { echo "[deploy $(date +%H:%M:%S)] $*"; }
lock_hash() { [ -f "$1" ] && tr -d '\r' < "$1" | sha256sum | cut -d' ' -f1 || echo none; }

# copies the sources; prints "changed" when the lock file is not the same as before
sync_sources() {
  local src="$1" dst="$2" lock="$3"; shift 3
  local before after
  before="$(lock_hash "$dst/$lock")"
  rsync -a --delete "$@" --exclude '.git' --exclude 'node_modules' --exclude '.env' --exclude '.env.*' \
    --exclude 'keys/' --exclude 'public/uploads/' --exclude 'logs/' --exclude '*.log' "$src/" "$dst/"
  after="$(lock_hash "$dst/$lock")"
  [ "$before" != "$after" ] && echo changed || true
}

deploy_api() {
  say "api: copying sources"
  local changed
  changed="$(sync_sources "$ROOT/parisahon-api" "$TARGET/api" package-lock.json --exclude 'dist/' --exclude 'test/')"
  mkdir -p "$TARGET/api/public/uploads" "$TARGET/api/keys"
  cd "$TARGET/api"
  if [ -n "$changed" ] || [ ! -d node_modules ]; then
    say "api: package-lock.json changed, npm ci"
    npm ci --no-audit --no-fund > "$TARGET/npm-api.log" 2>&1 || { tail -20 "$TARGET/npm-api.log"; exit 1; }
  fi
  say "api: nest build"
  npx nest build > "$TARGET/build-api.log" 2>&1 || { tail -30 "$TARGET/build-api.log"; exit 1; }
  say "api: migrations"
  (
    set -a; . "$TARGET/api.env"; set +a
    npx typeorm -d dist/datasource.js migration:run 2>&1 | grep -v "^$" | sed -E 's/(PASSWORD|SECRET|TOKEN)=.*/\1=<hidden>/I' | tail -15
  )
  say "api: restart crm-api"
  systemctl --user restart crm-api
}

deploy_web() {
  say "web: copying sources"
  local changed
  # .npmrc / .nvmrc exist only in the trial copy: kept there, copied if the repo gets them
  changed="$(sync_sources "$ROOT/parisahon-client/app" "$TARGET/web" pnpm-lock.yaml --exclude '.nuxt/' --exclude '.output/' --filter 'P .npmrc' --filter 'P .nvmrc')"
  cd "$TARGET/web"
  if [ -n "$changed" ] || [ ! -d node_modules ]; then
    say "web: pnpm-lock.yaml changed, pnpm install"
    npx -y pnpm@9 install --frozen-lockfile > "$TARGET/pnpm-web.log" 2>&1 || { tail -20 "$TARGET/pnpm-web.log"; exit 1; }
  fi
  say "web: nuxt build (a few minutes)"
  NODE_OPTIONS=--max-old-space-size=4096 npx -y pnpm@9 exec nuxt build > "$TARGET/build-web.log" 2>&1 || { tail -30 "$TARGET/build-web.log"; exit 1; }
  say "web: restart crm-web"
  systemctl --user restart crm-web
}

deploy_telegram() {
  local dir="$TARGET/telegram" envf="$TARGET/telegram.env" unit="$HOME/.config/systemd/user/crm-telegram.service"
  say "telegram: copying sources"
  mkdir -p "$dir"
  local changed
  changed="$(sync_sources "$ROOT/parisahon-telegram-service" "$dir" requirements.txt --exclude '__pycache__/' \
    --exclude 'ffmpeg*' --exclude '*.db' --exclude 'tests/' --exclude 'Dockerfile' --exclude '*compose*.yml')"
  if [ -n "$changed" ] || [ ! -x "$TARGET/tg-venv/bin/python" ]; then
    say "telegram: requirements.txt changed, pip install"
    [ -x "$TARGET/tg-venv/bin/python" ] || python3 -m venv "$TARGET/tg-venv"
    "$TARGET/tg-venv/bin/pip" install -q -r "$dir/requirements.txt" > "$TARGET/pip-telegram.log" 2>&1 || { tail -20 "$TARGET/pip-telegram.log"; exit 1; }
  fi
  if [ ! -f "$envf" ]; then
    say "telegram: writing $envf (new session key)"
    local token key
    token="$(sed -n 's/^TELEGRAM_SERVICE_TOKEN=//p' "$TARGET/api.env" | head -1 | tr -d '"')"
    [ -n "$token" ] || { echo "TELEGRAM_SERVICE_TOKEN is empty in $TARGET/api.env"; exit 1; }
    key="$("$TARGET/tg-venv/bin/python" -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
    ( umask 077; cat > "$envf" <<ENV
# Trial copy of parisahon-telegram-service (local/deploy.sh telegram). Secrets: do not print.
PORT=3030
HOST=127.0.0.1
CRM_API_URL=http://127.0.0.1:3000/api/v1
CRM_API_TOKEN=$token
SERVICE_DB=$TARGET/telegram_service.db
# keep this key: without it the stored sessions cannot be read
SESSION_ENCRYPTION_KEY=$key
LOGS_DIR=$TARGET/telegram-logs
RECORDINGS_TARGET=$TARGET/api/public/uploads
RECORDINGS_SOURCE=
USE_CUSTOM_FFMPEG_INSTALLATION=true
FFMPEG_INSTALLATION_DIR=$TARGET/bin
ENV
    )
  fi
  mkdir -p "$TARGET/telegram-logs"
  if [ ! -f "$unit" ]; then
    cat > "$unit" <<UNIT
[Unit]
Description=Parisa CRM Telegram service (trial copy)
After=crm-api.service
[Service]
Type=simple
WorkingDirectory=$dir
EnvironmentFile=$envf
ExecStart=$TARGET/tg-venv/bin/python app.py
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable crm-telegram >/dev/null 2>&1 || true
  fi
  # the API talks to the service at TELEGRAM_SERVICE_HOST:TELEGRAM_SERVICE_PORT
  if ! grep -q '^TELEGRAM_SERVICE_HOST=http://127.0.0.1$' "$TARGET/api.env" || ! grep -q '^TELEGRAM_SERVICE_PORT=3030$' "$TARGET/api.env"; then
    say "telegram: api.env -> TELEGRAM_SERVICE_HOST=http://127.0.0.1, TELEGRAM_SERVICE_PORT=3030; restart crm-api"
    sed -i -E 's|^TELEGRAM_SERVICE_HOST=.*|TELEGRAM_SERVICE_HOST=http://127.0.0.1|; s|^TELEGRAM_SERVICE_PORT=.*|TELEGRAM_SERVICE_PORT=3030|' "$TARGET/api.env"
    systemctl --user restart crm-api
  fi
  say "telegram: restart crm-telegram"
  systemctl --user restart crm-telegram
}

deploy_whatsapp() {
  local dir="$TARGET/whatsapp" envf="$TARGET/whatsapp.env" unit="$HOME/.config/systemd/user/crm-whatsapp.service"
  say "whatsapp: copying sources"
  mkdir -p "$dir"
  local changed
  changed="$(sync_sources "$ROOT/parisahon-whatsapp-service" "$dir" package-lock.json --exclude 'tests/' --exclude 'sessions/')"
  if [ -n "$changed" ] || [ ! -d "$dir/node_modules" ]; then
    say "whatsapp: package-lock.json changed, npm ci"
    (cd "$dir" && npm ci --omit=dev --no-audit --no-fund > "$TARGET/npm-whatsapp.log" 2>&1) || { tail -20 "$TARGET/npm-whatsapp.log"; exit 1; }
  fi
  if [ ! -f "$envf" ]; then
    say "whatsapp: writing $envf (new token and session key)"
    local token key
    token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(36))')"
    key="$(python3 -c 'import os, base64; print(base64.b64encode(os.urandom(32)).decode())')"
    ( umask 077; cat > "$envf" <<ENV
# Trial copy of parisahon-whatsapp-service (local/deploy.sh whatsapp). Secrets: do not print.
HOST=127.0.0.1
PORT=3040
CRM_API_URL=http://127.0.0.1:3000/api/v1
CRM_API_TOKEN=$token
# keep this key: without it the stored sessions cannot be read (managers scan the QR again)
SESSION_ENCRYPTION_KEY=$key
SESSIONS_DIR=$TARGET/whatsapp-sessions
UPLOADS_DIR=$TARGET/api/public/uploads
FFMPEG_BIN=$TARGET/bin/ffmpeg
TZ=Asia/Karachi
ENV
    )
    sed -i -E '/^WHATSAPP_SERVICE_(URL|TOKEN)=/d' "$TARGET/api.env"
    printf '\n# WhatsApp of the managers (local/deploy.sh whatsapp)\nWHATSAPP_SERVICE_URL=http://127.0.0.1:3040\nWHATSAPP_SERVICE_TOKEN=%s\n' "$token" >> "$TARGET/api.env"
    say "whatsapp: api.env -> WHATSAPP_SERVICE_URL / TOKEN; restart crm-api"
    systemctl --user restart crm-api
  fi
  mkdir -p "$TARGET/whatsapp-sessions" && chmod 700 "$TARGET/whatsapp-sessions"
  if [ ! -f "$unit" ]; then
    cat > "$unit" <<UNIT
[Unit]
Description=Parisa CRM WhatsApp service (trial copy)
After=crm-api.service
[Service]
Type=simple
WorkingDirectory=$dir
EnvironmentFile=$envf
ExecStart=$HOME/.nvm/versions/node/v20.20.2/bin/node $dir/src/index.js
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable crm-whatsapp >/dev/null 2>&1 || true
  fi
  say "whatsapp: restart crm-whatsapp"
  systemctl --user restart crm-whatsapp
}

deploy_stt() {
  local dir="$TARGET/stt" unit="$HOME/.config/systemd/user/crm-stt.service"
  say "stt: copying sources"
  mkdir -p "$dir/app"
  local changed
  changed="$(sync_sources "$ROOT/parisahon-stt" "$dir/app" requirements.txt --exclude '__pycache__/')"
  if [ ! -d "$dir/models" ] && [ -d "$ROOT/local/dev/stt/models" ]; then
    say "stt: copying the model from the dev copy"
    cp -r "$ROOT/local/dev/stt/models" "$dir/models"
  fi
  if [ -n "$changed" ] || [ ! -x "$dir/venv/bin/python" ] || [ ! -d "$dir/models" ]; then
    say "stt: venv and model (setup.sh)"
    bash "$dir/app/setup.sh" "$dir/venv" "$dir/models" small > "$TARGET/setup-stt.log" 2>&1 || { tail -20 "$TARGET/setup-stt.log"; exit 1; }
  fi
  if [ ! -f "$unit" ]; then
    cat > "$unit" <<UNIT
[Unit]
Description=Parisa CRM speech-to-text for the bot's voice messages (trial copy)
[Service]
Type=simple
WorkingDirectory=$dir/app
Environment=STT_HOST=127.0.0.1
Environment=STT_PORT=8096
Environment=STT_MODEL=small
Environment=STT_MODELS_DIR=$dir/models
Environment=STT_THREADS=4
Environment=STT_LANGUAGES=ru,uz
Environment=HF_HUB_DISABLE_TELEMETRY=1
ExecStart=$dir/venv/bin/python -u $dir/app/server.py
Nice=5
MemoryMax=2G
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable crm-stt >/dev/null 2>&1 || true
  fi
  say "stt: restart crm-stt"
  systemctl --user restart crm-stt
  if ! grep -q '^CRM_BOT_STT_URL=http://127.0.0.1:8096$' "$TARGET/api.env"; then
    say "stt: api.env -> CRM_BOT_STT_URL=http://127.0.0.1:8096; restart crm-api"
    if grep -q '^CRM_BOT_STT_URL=' "$TARGET/api.env"; then
      sed -i -E 's|^CRM_BOT_STT_URL=.*|CRM_BOT_STT_URL=http://127.0.0.1:8096|' "$TARGET/api.env"
    else
      printf '\n# speech-to-text of the bot voice messages (local/deploy.sh stt)\nCRM_BOT_STT_URL=http://127.0.0.1:8096\n' >> "$TARGET/api.env"
    fi
    systemctl --user restart crm-api
  fi
}

deploy_ftp() {
  local dir="$TARGET/ftp" envf="$TARGET/ftp.env" unit="$HOME/.config/systemd/user/crm-ftp.service"
  local venv="$TARGET/ftp-venv" data="$TARGET/ftp-data" state="$TARGET/ftp-state"
  say "ftp: copying sources"
  mkdir -p "$dir"
  local changed
  changed="$(sync_sources "$ROOT/parisahon-ftp" "$dir" requirements.txt --exclude '__pycache__/' --exclude 'tests/')"
  mkdir -p "$data" "$state" && chmod 700 "$data" "$state"
  if [ -n "$changed" ] || [ ! -x "$venv/bin/python" ]; then
    say "ftp: requirements.txt changed, venv and certificate (setup.sh)"
    bash "$dir/setup.sh" "$venv" "$state/tls" > "$TARGET/setup-ftp.log" 2>&1 || { tail -20 "$TARGET/setup-ftp.log"; exit 1; }
  fi
  local token api_token
  api_token="$(sed -n 's/^CALLS_SERVICE_TOKEN=//p' "$TARGET/api.env" | head -1 | tr -d '"')"
  if [ ! -f "$envf" ]; then
    say "ftp: writing $envf"
    # the token the API already has, else a new one for both
    token="$api_token"
    [ -n "$token" ] || token="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
    local cert="" key=""
    if [ -s "$state/tls/cert.pem" ] && [ -s "$state/tls/key.pem" ]; then cert="$state/tls/cert.pem"; key="$state/tls/key.pem"; fi
    ( umask 077; cat > "$envf" <<ENV
# Trial copy of parisahon-ftp (local/deploy.sh ftp). Secrets: do not print.
FTP_HOST=0.0.0.0
FTP_PORT=2121
FTP_PASSIVE_PORTS=21210-21219
# the address phones are told to open data connections to, when it is not this machine's own (NAT, port forwarding)
FTP_MASQUERADE_ADDRESS=
# one folder per manager (FTP_ROOT/<user id>); what was sent is remembered in FTP_STATE_DIR
FTP_ROOT=$data
FTP_STATE_DIR=$state
CRM_API_URL=http://127.0.0.1:3000/api/v1
CALLS_SERVICE_TOKEN=$token
# FTPS (AUTH TLS) is offered with these, plain FTP stays allowed; empty = plain FTP only
FTP_TLS_CERT=$cert
FTP_TLS_KEY=$key
FTP_RETAIN_DAYS=30
FTP_SETTLE_SEC=2
FTP_SCAN_SEC=2
LOG_LEVEL=info
TZ=Asia/Karachi
ENV
    )
  fi
  # the API checks the receiver's uploads with the same token and shows the address to the managers
  token="$(sed -n 's/^CALLS_SERVICE_TOKEN=//p' "$envf" | head -1)"
  [ -n "$token" ] || { echo "CALLS_SERVICE_TOKEN is empty in $envf"; exit 1; }
  local api_changed=0 ip
  if [ -z "$api_token" ]; then
    sed -i '/^CALLS_SERVICE_TOKEN=/d' "$TARGET/api.env"
    printf '\n# FTP receiver of call recordings (local/deploy.sh ftp)\nCALLS_SERVICE_TOKEN=%s\n' "$token" >> "$TARGET/api.env"
    api_changed=1
  elif [ "$api_token" != "$token" ]; then
    say "ftp: WARNING: CALLS_SERVICE_TOKEN of api.env and ftp.env are not the same, the API will refuse the uploads"
  fi
  if ! grep -q '^CALLS_FTP_ADDRESS=' "$TARGET/api.env"; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [ -z "$(tail -c 1 "$TARGET/api.env")" ] || echo >> "$TARGET/api.env"
    printf 'CALLS_FTP_ADDRESS=%s:%s\n' "${ip:-172.0.30.4}" "$(sed -n 's/^FTP_PORT=//p' "$envf" | head -1)" >> "$TARGET/api.env"
    api_changed=1
  fi
  if [ $api_changed -eq 1 ]; then
    say "ftp: api.env -> CALLS_SERVICE_TOKEN / CALLS_FTP_ADDRESS; restart crm-api"
    systemctl --user restart crm-api
  fi
  if [ ! -f "$unit" ]; then
    cat > "$unit" <<UNIT
[Unit]
Description=Parisa CRM FTP receiver of call recordings (trial copy)
After=crm-api.service
[Service]
Type=simple
WorkingDirectory=$dir
EnvironmentFile=$envf
ExecStart=$venv/bin/python -u $dir/server.py
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable crm-ftp >/dev/null 2>&1 || true
  fi
  say "ftp: restart crm-ftp"
  systemctl --user restart crm-ftp
}

# the FTP receiver greets on its port
wait_ftp() {
  local port="$1" name="$2" i
  for i in $(seq 1 20); do
    if python3 -c 'import ftplib, sys
f = ftplib.FTP(); f.connect("127.0.0.1", int(sys.argv[1]), timeout=3)
sys.exit(0 if f.getwelcome().startswith("220") else 1)' "$port" 2>/dev/null; then
      say "$name answers on port $port"
      return 0
    fi
    sleep 2
  done
  say "$name does NOT answer on port $port"
  journalctl --user -u "$name" -n 30 --no-pager | cut -c1-200
  return 1
}

wait_http() {
  local url="$1" name="$2" code=000 i
  for i in $(seq 1 40); do
    code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$url" || true)"
    [ "$code" = 200 ] && { say "$name answers 200 at $url"; return 0; }
    sleep 3
  done
  say "$name does NOT answer at $url (last code $code)"
  journalctl --user -u "$name" -n 30 --no-pager | cut -c1-200
  return 1
}

if [ "$WHAT" = whatsapp ]; then
  deploy_whatsapp
  ok=0
  wait_http "http://127.0.0.1:3040/health" crm-whatsapp || ok=1
  wait_http "$API_URL" crm-api || ok=1
  [ $ok -eq 0 ] && say "done" || { say "FAILED"; exit 1; }
  exit 0
fi
if [ "$WHAT" = ftp ]; then
  deploy_ftp
  ok=0
  wait_ftp "$(sed -n 's/^FTP_PORT=//p' "$TARGET/ftp.env" | head -1)" crm-ftp || ok=1
  wait_http "$API_URL" crm-api || ok=1
  [ $ok -eq 0 ] && say "done" || { say "FAILED"; exit 1; }
  exit 0
fi
if [ "$WHAT" = stt ]; then
  deploy_stt
  ok=0
  wait_http "http://127.0.0.1:8096/health" crm-stt || ok=1
  wait_http "$API_URL" crm-api || ok=1
  [ $ok -eq 0 ] && say "done" || { say "FAILED"; exit 1; }
  exit 0
fi
if [ "$WHAT" = telegram ]; then
  deploy_telegram
  ok=0
  wait_http "$API_URL" crm-api || ok=1
  wait_http "http://127.0.0.1:3030/health" crm-telegram || ok=1
  [ $ok -eq 0 ] && say "done" || { say "FAILED"; exit 1; }
  exit 0
fi
[ "$WHAT" = web ] || deploy_api
[ "$WHAT" = api ] || deploy_web
ok=0
[ "$WHAT" = web ] || wait_http "$API_URL" crm-api || ok=1
[ "$WHAT" = api ] || wait_http "$WEB_URL" crm-web || ok=1
[ $ok -eq 0 ] && say "done" || { say "FAILED"; exit 1; }
