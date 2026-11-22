#!/usr/bin/env bash
# Weekly housekeeping of the CRM server (cron: /etc/cron.d/crm-ops).
echo "== $(date '+%F %T')"
# identical uploaded files -> one copy on disk
/usr/bin/python3 /root/crm2/ops/dedupe-uploads.py /root/crm/parisahon-api/public/uploads
# docker layers nothing uses any more
docker image prune -f | tail -1
docker builder prune -f | tail -1
# logs of the CRM containers above 100 MB are cut (docker keeps them without a limit)
for c in crm-nginx crm2-app crm2-telegram crm2-whatsapp crm2-ftp crm2-stt; do
  f=$(docker inspect -f '{{.LogPath}}' "$c" 2>/dev/null)
  if [ -f "$f" ] && [ "$(stat -c %s "$f")" -gt 104857600 ]; then
    truncate -s 0 "$f" && echo "log of $c cut"
  fi
done
