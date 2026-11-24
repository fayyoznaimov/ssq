#!/usr/bin/env bash
# Writes local/dev/ftp.env for the dev copy of parisahon-ftp (unit crm-dev-ftp): the FTP receiver the
# managers' phones upload their call recordings to (port 2131, passive 21310-21319).
# The shared token is CALLS_SERVICE_TOKEN of local/dev/api.env; when it is not there yet, one is made
# and appended there together with CALLS_FTP_ADDRESS, the address the CRM shows to the managers
# (restart crm-dev-api to pick them up: local/dev/units.sh restart crm-dev-api).
# The venv and the self-signed certificate: parisahon-ftp/setup.sh local/dev/ftp/venv local/dev/ftp/tls
# Nothing is printed but file names. Not in git.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_ENV="${CRM_DEV_ENV:-$HERE/api.env}"
OUT="$HERE/ftp.env"
DATA="$HERE/ftp"
PORT=2131
PASSIVE=21310-21319

TOKEN="$(sed -n 's/^CALLS_SERVICE_TOKEN=//p' "$API_ENV" | head -1)"
if [ -z "$TOKEN" ]; then
  TOKEN="$(openssl rand -hex 24)"   # 48 characters
  # a line of its own even if api.env does not end with a newline
  [ -z "$(tail -c 1 "$API_ENV")" ] || echo >> "$API_ENV"
  sed -i '/^CALLS_SERVICE_TOKEN=$/d' "$API_ENV"
  echo "CALLS_SERVICE_TOKEN=$TOKEN" >> "$API_ENV"
  echo "local/dev/api.env: CALLS_SERVICE_TOKEN added (restart crm-dev-api)"
fi
if ! grep -q '^CALLS_FTP_ADDRESS=' "$API_ENV"; then
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -z "$(tail -c 1 "$API_ENV")" ] || echo >> "$API_ENV"
  echo "CALLS_FTP_ADDRESS=${IP:-172.0.30.4}:$PORT" >> "$API_ENV"
  echo "local/dev/api.env: CALLS_FTP_ADDRESS added (restart crm-dev-api)"
fi
API_PORT="$(sed -n 's/^APP_LISTEN_PORT=//p' "$API_ENV" | head -1)"

# FTPS (AUTH TLS) is offered when setup.sh made a certificate; plain FTP works either way
CERT="" KEY=""
if [ -s "$DATA/tls/cert.pem" ] && [ -s "$DATA/tls/key.pem" ]; then CERT="$DATA/tls/cert.pem"; KEY="$DATA/tls/key.pem"; fi

mkdir -p "$DATA/data" "$DATA/state"
chmod 700 "$DATA/data" "$DATA/state"
umask 077
cat > "$OUT" <<ENV
# Dev copy of parisahon-ftp. Written by local/dev/ftp-env.sh, not in git.
FTP_HOST=0.0.0.0
FTP_PORT=$PORT
FTP_PASSIVE_PORTS=$PASSIVE
# the address phones are told to open data connections to, when it is not this machine's own (NAT)
FTP_MASQUERADE_ADDRESS=
# one folder per manager (FTP_ROOT/<user id>); what was sent is remembered in FTP_STATE_DIR
FTP_ROOT=$DATA/data
FTP_STATE_DIR=$DATA/state
CRM_API_URL=http://127.0.0.1:${API_PORT:-3100}/api/v1
CALLS_SERVICE_TOKEN=$TOKEN
FTP_TLS_CERT=$CERT
FTP_TLS_KEY=$KEY
FTP_RETAIN_DAYS=30
FTP_SETTLE_SEC=2
FTP_SCAN_SEC=2
LOG_LEVEL=info
TZ=Asia/Tashkent
ENV
chmod 600 "$OUT"
echo "local/dev/ftp.env written"
