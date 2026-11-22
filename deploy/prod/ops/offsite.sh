#!/usr/bin/env bash
# Copy of the nightly backup outside this server (called by backup.sh: <day folder> <files snapshot>).
#
# Storage: any rclone remote named crm-offsite (Google Drive, Backblaze B2, S3 ...). Everything is
# encrypted on this server before it leaves (rclone "crypt" remote crm-offsite-crypt on top of it):
# the storage sees neither names nor contents. The key is in /root/.config/rclone/rclone.conf and in
# /root/crm2/ops/OFFSITE-RECOVERY-KEY.txt — WITHOUT that key the copies cannot be read, so the owner
# keeps a copy of it away from this server.
#
#   daily/<date>/      database dump and settings of that night (kept a year)
#   uploads/           the CRM files as of the last night
#   uploads-removed/   files that were deleted or replaced, by the date it happened (kept 90 days)
#
# Exit: 0 copied and verified, 3 the storage is not connected yet, anything else = failed.
# Restore:  rclone copy crm-offsite-crypt:daily/<date> /root/restore   (see README.md)
set -uo pipefail
REMOTE=${CRM_OFFSITE_REMOTE:-crm-offsite}
CRYPT="$REMOTE-crypt"
DAY_DIR=$1
FILES_DIR=$2
DAY=$(basename "$DAY_DIR")
RC="rclone --retries 3 --low-level-retries 5 --timeout 60s --contimeout 20s --transfers 4 --stats 0 -q"

command -v rclone >/dev/null || { echo "rclone is not installed"; exit 3; }
rclone listremotes | grep -qx "$REMOTE:" || { echo "storage $REMOTE is not connected"; exit 3; }
rclone listremotes | grep -qx "$CRYPT:" || { echo "encryption remote $CRYPT is missing"; exit 4; }

$RC copy "$DAY_DIR" "$CRYPT:daily/$DAY" || { echo "copy of the database failed"; exit 5; }
$RC sync "$FILES_DIR" "$CRYPT:uploads" --backup-dir "$CRYPT:uploads-removed/$DAY" || { echo "copy of the files failed"; exit 6; }

# what arrived must be what was sent (compares checksums through the encryption)
rclone cryptcheck "$DAY_DIR" "$CRYPT:daily/$DAY" --one-way -q || { echo "verification of the database copy failed"; exit 7; }
rclone cryptcheck "$FILES_DIR" "$CRYPT:uploads" --one-way -q || { echo "verification of the files failed"; exit 8; }

# retention in the storage, by the date in the folder name (a moved file keeps its own old date,
# so "older than N days" by file time would erase it at once)
prune_dated() {  # <folder> <days>
  local cutoff; cutoff=$(date -d "$2 days ago" +%F)
  for d in $(rclone lsf "$CRYPT:$1" --dirs-only 2>/dev/null | tr -d /); do
    if [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && [[ "$d" < "$cutoff" ]]; then $RC purge "$CRYPT:$1/$d" || true; fi
  done
}
prune_dated daily 366
prune_dated uploads-removed 90

echo "offsite ok: $(rclone size "$CRYPT:" --json 2>/dev/null)"
