#!/usr/bin/env bash
# One-time setup of the dev copy on the server. Safe to run again.
#   1. local/dev/api.env from the template: trial db password (~/parisa-crm/db.pass), fresh dev secrets
#   2. dependencies (npm ci / pnpm install) if node_modules are missing
#   3. database parisahon_dev as a copy of the trial db
#   4. systemd --user units crm-dev-* (see units.sh), started and enabled
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"

if [ ! -f "$HERE/api.env" ]; then
  DBPASS="$(tr -d '\n' < "$HOME/parisa-crm/db.pass")"
  python3 - "$HERE/api.env.template" "$HERE/api.env" "$DBPASS" <<'PY'
import secrets, sys
src, dst, dbpass = sys.argv[1:]
s = open(src, encoding='utf-8').read()
s = s.replace('__DBPASS__', dbpass)
s = s.replace('__JWT_SECRET__', secrets.token_hex(32))
s = s.replace('__HASH_SECRET__', secrets.token_hex(16))
s = s.replace('__ADMIN_PASSWORD__', 'dev-' + secrets.token_urlsafe(9))
s = s.replace('__TELEGRAM_SERVICE_TOKEN__', secrets.token_hex(24))
s = s.replace('__MAIL_PASSWORD__', 'mail-' + secrets.token_urlsafe(9))
s = s.replace('# This is the template: local/dev/setup.sh fills the __PLACEHOLDERS__ into local/dev/api.env (not in git).\n', '# Written by local/dev/setup.sh from api.env.template. Not in git.\n')
open(dst, 'w', encoding='utf-8').write(s)
PY
  chmod 600 "$HERE/api.env"
  echo "local/dev/api.env written (dev secrets generated; admin password is inside, not printed)"
else
  echo "local/dev/api.env already exists, kept"
fi

if [ ! -d "$ROOT/parisahon-api/node_modules" ]; then
  (cd "$ROOT/parisahon-api" && npm ci --no-audit --no-fund)
fi
if [ ! -d "$ROOT/parisahon-client/app/node_modules" ]; then
  (cd "$ROOT/parisahon-client/app" && npx -y pnpm@9 install --frozen-lockfile)
fi
mkdir -p "$ROOT/parisahon-api/public/uploads" "$ROOT/parisahon-api/keys"

if [ ! -d "$HERE/mail-venv" ]; then
  python3 -m venv "$HERE/mail-venv"
  "$HERE/mail-venv/bin/pip" install -q pymap aiosmtpd
fi
if [ ! -d "$HERE/tg-venv" ]; then
  python3 -m venv "$HERE/tg-venv"
  "$HERE/tg-venv/bin/pip" install -q -r "$ROOT/parisahon-telegram-service/requirements.txt"
fi
[ -f "$HERE/telegram.env" ] || "$HERE/telegram-env.sh"

node "$HERE/db.js" create
"$HERE/units.sh" install
echo "dev copy is up: API http://127.0.0.1:$(sed -n 's/^APP_LISTEN_PORT=//p' "$HERE/api.env")/api/v1, web http://$(hostname -I | awk '{print $1}'):4150"
