#!/usr/bin/env bash
# Nightly backup of the CRM (cron: /etc/cron.d/crm-ops). Keeps 14 days, the 1st of each month for 6 months.
#   daily/<date>/db.dump        the database (pg_dump custom format), restored into a scratch database as a test
#   daily/<date>/config.tar.gz  settings, keys, WhatsApp and Telegram sessions
#   uploads/<date>/             files of the CRM; unchanged files are hard links to the previous day
#                               (30 days + monthly for a year; integrity.py checks them every night)
# Result: /root/crm2/ops/state/backup.json (the watchdog alerts when it is old or failed).
# offsite.sh then copies the night's backup, encrypted, to the storage connected as the rclone remote crm-offsite.
set -uo pipefail
ROOT=/root/backups/auto
STATE=/root/crm2/ops/state
UP=/root/crm/parisahon-api/public/uploads
DAY=$(date +%F)
D=$ROOT/daily/$DAY
mkdir -p "$D" "$ROOT/uploads" "$STATE"
chmod 700 /root/backups "$ROOT"
umask 077
log() { echo "$(date '+%F %T') $*" >> "$STATE/backup.log"; }
fail() {
  log "FAILED: $*"
  printf '{"ok":false,"at":"%s","error":"%s"}\n' "$(date -u +%FT%TZ)" "$*" > "$STATE/backup.json"
  exit 1
}

# 1. database
docker exec crm-db sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > "$D/db.dump.tmp" 2>>"$STATE/backup.log" || fail "pg_dump"
BYTES=$(stat -c %s "$D/db.dump.tmp")
[ "$BYTES" -gt 50000 ] || fail "dump too small: $BYTES bytes"
mv "$D/db.dump.tmp" "$D/db.dump"

# 2. the dump must restore: load it into a scratch database and compare row counts with the live one
Q="SELECT (SELECT count(*) FROM deal)||'/'||(SELECT count(*) FROM event)||'/'||(SELECT count(*) FROM \"user\")"
docker exec crm-db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists crm_restore_check && createdb -U "$POSTGRES_USER" crm_restore_check' || fail "scratch database"
docker exec -i crm-db sh -c 'pg_restore -U "$POSTGRES_USER" -d crm_restore_check --no-owner' < "$D/db.dump" 2>>"$STATE/backup.log" || fail "pg_restore"
GOT=$(echo "$Q" | docker exec -i crm-db sh -c 'psql -U "$POSTGRES_USER" -d crm_restore_check -At')
docker exec crm-db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists crm_restore_check'
# live counts may only grow between the dump and now
IFS=/ read -r gd ge gu <<< "$GOT"
LIVE=$(echo "$Q" | docker exec -i crm-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At')
IFS=/ read -r ld le lu <<< "$LIVE"
[ -n "$gd" ] && [ "$ge" -gt 0 ] && [ "$gu" -gt 1 ] && [ "$gu" -le "$lu" ] && [ "$ge" -le "$le" ] && [ $((le - ge)) -lt 200 ] || fail "restore check: restored $GOT, live $LIVE"

# 3. settings and sessions
tar czf "$D/config.tar.gz" --exclude=root/crm2/ops/state -C / \
  root/crm2/compose.yml root/crm2/api.Dockerfile root/crm2/parisahon-api/.env root/crm2/telegram.env \
  root/crm2/whatsapp.env root/crm2/ftp.env root/crm2/wa-sessions root/crm2/tg-data root/crm2/ops \
  root/crm/parisahon-api/keys root/crm/parisahon-api/compose.yml root/crm/parisahon-api/docker/nginx/nginx.conf \
  2>>"$STATE/backup.log" || fail "config archive"

# 4. files
PREV=$(find "$ROOT/uploads" -mindepth 1 -maxdepth 1 -type d ! -name "$DAY" | sort | tail -1)
rsync -aH --delete ${PREV:+--link-dest="$PREV"} "$UP/" "$ROOT/uploads/$DAY/" 2>>"$STATE/backup.log" || fail "uploads copy"
FILES=$(find "$ROOT/uploads/$DAY" -type f | wc -l)

# 5. retention
find "$ROOT/daily" -mindepth 1 -maxdepth 1 -type d -mtime +14 ! -name '*-01' -exec rm -rf {} +
find "$ROOT/daily" -mindepth 1 -maxdepth 1 -type d -mtime +185 -exec rm -rf {} +
# file snapshots cost almost nothing (hard links): 30 days, and the 1st of each month for a year.
# By folder name: rsync gives the folders the date of the uploads folder, not of the copy.
cutoff=$(date -d '30 days ago' +%F); year_ago=$(date -d '366 days ago' +%F)
for dir in "$ROOT"/uploads/*/; do
  name=$(basename "$dir")
  [[ "$name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
  if [[ "$name" < "$year_ago" ]] || { [[ "$name" < "$cutoff" ]] && [[ "$name" != *-01 ]]; }; then rm -rf "$dir"; fi
done

# copy outside this server (offsite.sh): 0 = copied and verified, 3 = no storage connected yet
OFFSITE=none
if [ -x /root/crm2/ops/offsite.sh ]; then
  /root/crm2/ops/offsite.sh "$D" "$ROOT/uploads/$DAY" >>"$STATE/backup.log" 2>&1 </dev/null
  case $? in 0) OFFSITE=ok ;; 3) OFFSITE="not connected" ;; *) OFFSITE=failed ;; esac
fi
printf '{"ok":true,"at":"%s","db_bytes":%s,"restored_rows":"%s","upload_files":%s,"offsite":"%s","size":"%s"}\n' \
  "$(date -u +%FT%TZ)" "$BYTES" "$GOT" "$FILES" "$OFFSITE" "$(du -sh "$ROOT" | cut -f1)" > "$STATE/backup.json"
log "ok: db $BYTES bytes, restored deals/events/users $GOT, $FILES files, offsite $OFFSITE"
