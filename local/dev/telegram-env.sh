#!/usr/bin/env bash
# Writes local/dev/telegram.env for the dev copy of parisahon-telegram-service (unit crm-dev-telegram):
# the API address and the shared token are taken from local/dev/api.env. Not in git.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
API_ENV="${CRM_DEV_ENV:-$HERE/api.env}"
TOKEN="$(sed -n 's/^TELEGRAM_SERVICE_TOKEN=//p' "$API_ENV" | head -1)"
API_PORT="$(sed -n 's/^APP_LISTEN_PORT=//p' "$API_ENV" | head -1)"
# the key of the stored Telegram sessions: kept from the previous telegram.env, made once
KEY="$(sed -n 's/^SESSION_ENCRYPTION_KEY=//p' "$HERE/telegram.env" 2>/dev/null | head -1)"
[ -n "$KEY" ] || KEY="$("$HERE/tg-venv/bin/python" -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
mkdir -p "$HERE/telegram-logs" "$ROOT/parisahon-api/public/uploads"
cat > "$HERE/telegram.env" <<ENV
# Dev copy of parisahon-telegram-service. Written by local/dev/telegram-env.sh, not in git.
PORT=3130
HOST=127.0.0.1
CRM_API_URL=http://127.0.0.1:${API_PORT:-3100}/api/v1
CRM_API_TOKEN=$TOKEN
SERVICE_DB=$HERE/telegram_service.db
SESSION_ENCRYPTION_KEY=$KEY
LOGS_DIR=$HERE/telegram-logs
# downloaded media go to the API's uploads folder, as in production
RECORDINGS_TARGET=$ROOT/parisahon-api/public/uploads
# call recordings are off on the dev copy (no recorder, no direct database access)
RECORDINGS_SOURCE=
POSTGRES_HOST=
SEND_TIMEOUT_SEC=20
# voice messages from chats are converted with the static ffmpeg (no system ffmpeg here)
USE_CUSTOM_FFMPEG_INSTALLATION=true
FFMPEG_INSTALLATION_DIR=$HERE/bin
ENV
chmod 600 "$HERE/telegram.env"
echo "local/dev/telegram.env written"
