# Server automation of the CRM (prod: /root/crm2/ops, schedule: /etc/cron.d/crm-ops)

| File | When | What it does |
|---|---|---|
| `watchdog.py` | every 5 min | checks containers, database, site, API (`/api/v1/health`), WhatsApp and Telegram sessions, disk, memory, last backup, certificate, API errors; starts a stopped container, restarts the API after 3 failed checks; tells admins through the CRM bot; state in `state/status.json` |
| `backup.sh` | 02:15 Tashkent | database dump + test restore into a scratch database, settings and messenger sessions, files (hard-linked snapshots); 14 days + monthly for 6 months; result in `state/backup.json` |
| `weekly.sh` | Sunday night | identical uploaded files become one copy (`dedupe-uploads.py`), unused docker layers removed, CRM container logs above 100 MB cut |
| `nginx_perf.py` | once | gzip and browser caching for the site (already applied, marker `crm-perf-2026-11-22`) |

Restore the database from a backup:

    docker exec -i crm-db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < /root/backups/auto/daily/<date>/db.dump

Backups stay on the same server. For a copy elsewhere put an executable `/root/crm2/ops/offsite.sh`
(gets the day folder and the files folder as arguments); `backup.sh` runs it and records the result.
