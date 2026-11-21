#!/usr/bin/env bash
# Writes local/dev/whatsapp.env for the dev copy of parisahon-whatsapp-service (unit crm-dev-whatsapp).
# The shared token is WHATSAPP_SERVICE_TOKEN of local/dev/api.env; when it is not there yet, one is made
# and appended there together with WHATSAPP_SERVICE_URL (restart crm-dev-api to pick them up).
# The session key is kept from the previous whatsapp.env (a new key = every manager scans the QR again).
# Nothing is printed but file names. Not in git.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
API_ENV="${CRM_DEV_ENV:-$HERE/api.env}"
OUT="$HERE/whatsapp.env"
PORT=3140

TOKEN="$(sed -n 's/^WHATSAPP_SERVICE_TOKEN=//p' "$API_ENV" | head -1)"
if [ -z "$TOKEN" ]; then
  TOKEN="$(openssl rand -hex 24)"   # 48 characters
  # a line of its own even if api.env does not end with a newline
  [ -z "$(tail -c 1 "$API_ENV")" ] || echo >> "$API_ENV"
  grep -q '^WHATSAPP_SERVICE_TOKEN=' "$API_ENV" && sed -i '/^WHATSAPP_SERVICE_TOKEN=$/d' "$API_ENV"
  echo "WHATSAPP_SERVICE_TOKEN=$TOKEN" >> "$API_ENV"
  echo "local/dev/api.env: WHATSAPP_SERVICE_TOKEN added (restart crm-dev-api)"
fi
if ! grep -q '^WHATSAPP_SERVICE_URL=' "$API_ENV"; then
  echo "WHATSAPP_SERVICE_URL=http://127.0.0.1:$PORT" >> "$API_ENV"
  echo "local/dev/api.env: WHATSAPP_SERVICE_URL added (restart crm-dev-api)"
fi
API_PORT="$(sed -n 's/^APP_LISTEN_PORT=//p' "$API_ENV" | head -1)"

KEY="$(sed -n 's/^SESSION_ENCRYPTION_KEY=//p' "$OUT" 2>/dev/null | head -1 || true)"
[ -n "$KEY" ] || KEY="$(openssl rand -base64 32)"

mkdir -p "$HERE/whatsapp-sessions" "$ROOT/parisahon-api/public/uploads"
chmod 700 "$HERE/whatsapp-sessions"
umask 077
cat > "$OUT" <<ENV
# Dev copy of parisahon-whatsapp-service. Written by local/dev/whatsapp-env.sh, not in git.
HOST=127.0.0.1
PORT=$PORT
CRM_API_URL=http://127.0.0.1:${API_PORT:-3100}/api/v1
CRM_API_TOKEN=$TOKEN
SESSIONS_DIR=$HERE/whatsapp-sessions
SESSION_ENCRYPTION_KEY=$KEY
# received media go to the API's uploads folder, files for POST /send are read from there
UPLOADS_DIR=$ROOT/parisahon-api/public/uploads
# voice messages are converted with the static ffmpeg (no system ffmpeg here)
FFMPEG_BIN=$HERE/bin/ffmpeg
MAX_FILE_MB=50
POLL_SEC=10
LOG_LEVEL=info
BAILEYS_LOG_LEVEL=warn
TZ=Asia/Karachi
ENV
chmod 600 "$OUT"
echo "local/dev/whatsapp.env written"
