#!/usr/bin/env bash
# systemd --user units of the dev copy (next to crm-api / crm-web / crm-postgres of the trial copy):
#   crm-dev-api            nest start --watch in parisahon-api, port from local/dev/api.env (3100)
#   crm-dev-web            nuxt dev in parisahon-client/app on port 4150, talking to crm-dev-api
#   crm-dev-fake-telegram  local/fake-telegram/server.mjs on 127.0.0.1:8098
#   crm-dev-mock-claude    local/mock-claude/server.py on 127.0.0.1:8099
#   crm-dev-telegram       parisahon-telegram-service (Flask, no Telegram sessions) on 127.0.0.1:3130, venv local/dev/tg-venv
#   crm-dev-whatsapp       parisahon-whatsapp-service (Node + Baileys) on 127.0.0.1:3140, env local/dev/whatsapp.env
#                          (local/dev/whatsapp-env.sh), sessions in local/dev/whatsapp-sessions
#   crm-dev-mail           local/dev/mail/server.py: IMAPS 8993 + SMTPS 8465 (pymap + aiosmtpd), venv local/dev/mail-venv
#   crm-dev-stt            parisahon-stt/server.py: speech-to-text of the bot's voice messages on 127.0.0.1:8097
#                          (faster-whisper "small"), venv and model in local/dev/stt: parisahon-stt/setup.sh local/dev/stt/venv local/dev/stt/models
#   crm-dev-ftp            parisahon-ftp/server.py: FTP receiver of the managers' call recordings on 0.0.0.0:2131
#                          (passive 21310-21319), env local/dev/ftp.env (local/dev/ftp-env.sh), venv, files and state
#                          in local/dev/ftp: parisahon-ftp/setup.sh local/dev/ftp/venv local/dev/ftp/tls
#   local/dev/units.sh install | start [unit…] | stop [unit…] | restart [unit…] | status | logs [unit] | remove
#   (start / stop / restart without a unit name act on all of them)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
NODE_BIN="$HOME/.nvm/versions/node/v20.20.2/bin"
UNIT_DIR="$HOME/.config/systemd/user"
UNITS=(crm-dev-fake-telegram crm-dev-mock-claude crm-dev-mail crm-dev-telegram crm-dev-whatsapp crm-dev-stt crm-dev-ftp crm-dev-api crm-dev-web)
WEB_PORT=4150
WEB_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
API_PORT="$(sed -n 's/^APP_LISTEN_PORT=//p' "$HERE/api.env" 2>/dev/null | head -1)"
API_PORT="${API_PORT:-3100}"

write_units() {
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/crm-dev-fake-telegram.service" <<UNIT
[Unit]
Description=Parisa CRM dev: stand-in Telegram Bot API (local/fake-telegram)
[Service]
Type=simple
Environment=PORT=8098
Environment=FAKE_TG_TOKEN=local-test-token
ExecStart=$NODE_BIN/node $ROOT/local/fake-telegram/server.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=default.target
UNIT
  cat > "$UNIT_DIR/crm-dev-mock-claude.service" <<UNIT
[Unit]
Description=Parisa CRM dev: stand-in Anthropic API (local/mock-claude)
[Service]
Type=simple
Environment=PORT=8099
ExecStart=/usr/bin/python3 -u $ROOT/local/mock-claude/server.py
Restart=always
RestartSec=3
[Install]
WantedBy=default.target
UNIT
  MAIL_USER="$(sed -n 's/^EMAIL_DEFAULT_USER=//p' "$HERE/api.env" | head -1)"
  MAIL_PASSWORD="$(sed -n 's/^EMAIL_DEFAULT_PASSWORD=//p' "$HERE/api.env" | head -1)"
  cat > "$UNIT_DIR/crm-dev-mail.service" <<UNIT
[Unit]
Description=Parisa CRM dev: mail server stand-in (pymap IMAP + aiosmtpd SMTP)
After=network-online.target
[Service]
Type=simple
WorkingDirectory=$HERE/mail
Environment=MAIL_USER=$MAIL_USER
Environment=MAIL_PASSWORD=$MAIL_PASSWORD
Environment=IMAP_PORT=8993
Environment=IMAP_PLAIN_PORT=8143
Environment=SMTP_PORT=8465
Environment=MAIL_DIR=$HERE/mail
ExecStart=$HERE/mail-venv/bin/python $HERE/mail/server.py
Restart=always
RestartSec=3
[Install]
WantedBy=default.target
UNIT
  cat > "$UNIT_DIR/crm-dev-telegram.service" <<UNIT
[Unit]
Description=Parisa CRM dev: Telegram service (parisahon-telegram-service, Flask + Pyrogram)
After=network-online.target
[Service]
Type=simple
WorkingDirectory=$ROOT/parisahon-telegram-service
EnvironmentFile=$HERE/telegram.env
ExecStart=$HERE/tg-venv/bin/python app.py
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UNIT
  cat > "$UNIT_DIR/crm-dev-whatsapp.service" <<UNIT
[Unit]
Description=Parisa CRM dev: WhatsApp service (parisahon-whatsapp-service, Node + Baileys)
After=network-online.target
[Service]
Type=simple
WorkingDirectory=$ROOT/parisahon-whatsapp-service
EnvironmentFile=$HERE/whatsapp.env
ExecStart=$NODE_BIN/node src/index.js
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UNIT
  # STT_TEST_HOOKS=1: local/checks/bot_check.py simulates an outage through POST /_test/outage (never in production)
  cat > "$UNIT_DIR/crm-dev-stt.service" <<UNIT
[Unit]
Description=Parisa CRM dev: speech-to-text for the bot's voice messages (parisahon-stt, faster-whisper)
[Service]
Type=simple
WorkingDirectory=$ROOT/parisahon-stt
Environment=STT_HOST=127.0.0.1
Environment=STT_PORT=8097
Environment=STT_MODEL=small
Environment=STT_MODELS_DIR=$HERE/stt/models
Environment=STT_THREADS=4
Environment=STT_LANGUAGES=ru,uz
Environment=STT_TEST_HOOKS=1
Environment=HF_HUB_DISABLE_TELEMETRY=1
ExecStart=$HERE/stt/venv/bin/python -u $ROOT/parisahon-stt/server.py
Nice=5
MemoryMax=2G
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UNIT
  cat > "$UNIT_DIR/crm-dev-ftp.service" <<UNIT
[Unit]
Description=Parisa CRM dev: FTP receiver of call recordings (parisahon-ftp, pyftpdlib)
After=network-online.target
[Service]
Type=simple
WorkingDirectory=$ROOT/parisahon-ftp
EnvironmentFile=$HERE/ftp.env
ExecStart=$HERE/ftp/venv/bin/python -u $ROOT/parisahon-ftp/server.py
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UNIT
  cat > "$UNIT_DIR/crm-dev-api.service" <<UNIT
[Unit]
Description=Parisa CRM dev: API (nest start --watch in $ROOT/parisahon-api)
After=network-online.target crm-postgres.service crm-dev-fake-telegram.service crm-dev-mail.service
Requires=crm-postgres.service
Wants=crm-dev-fake-telegram.service crm-dev-mail.service
[Service]
Type=simple
WorkingDirectory=$ROOT/parisahon-api
EnvironmentFile=$HERE/api.env
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_BIN/npx nest start --watch
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UNIT
  cat > "$UNIT_DIR/crm-dev-web.service" <<UNIT
[Unit]
Description=Parisa CRM dev: web (nuxt dev in $ROOT/parisahon-client/app)
After=network-online.target crm-dev-api.service
[Service]
Type=simple
WorkingDirectory=$ROOT/parisahon-client/app
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
Environment=NODE_OPTIONS=--max-old-space-size=3072
Environment=NUXT_PUBLIC_API_URL=http://$WEB_IP:$API_PORT/api/v1
Environment=NUXT_PUBLIC_SOCKET_URL=ws://$WEB_IP:$API_PORT
ExecStart=$NODE_BIN/npx pnpm@9 exec nuxt dev --host 0.0.0.0 --port $WEB_PORT
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UNIT
}

case "${1:-status}" in
  install)
    write_units
    systemctl --user daemon-reload
    systemctl --user enable --now "${UNITS[@]}"
    systemctl --user --no-pager list-units 'crm-dev-*' --all ;;
  start|stop|restart)
    # with unit names only those (dev units only), otherwise all
    if [ $# -gt 1 ]; then
      for u in "${@:2}"; do case "$u" in crm-dev-*) ;; *) echo "not a dev unit: $u"; exit 2 ;; esac; done
      systemctl --user "$1" "${@:2}"
    else
      systemctl --user "$1" "${UNITS[@]}"
    fi
    systemctl --user --no-pager list-units 'crm-dev-*' --all ;;
  status) systemctl --user --no-pager list-units 'crm-dev-*' --all ;;
  logs) journalctl --user -u "${2:-crm-dev-api}" -n "${3:-100}" --no-pager ;;
  remove)
    systemctl --user disable --now "${UNITS[@]}" || true
    for u in "${UNITS[@]}"; do rm -f "${UNIT_DIR:?}/${u:?}.service"; done
    systemctl --user daemon-reload ;;
  *) echo "usage: units.sh install | start [unit…] | stop [unit…] | restart [unit…] | status | logs [unit] [lines] | remove"; exit 2 ;;
esac
