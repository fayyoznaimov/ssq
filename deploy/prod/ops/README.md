# Server automation of the CRM (prod: /root/crm2/ops, schedule: /etc/cron.d/crm-ops)

| File | When | What it does |
|---|---|---|
| `watchdog.py` | every 5 min | checks containers, database, site, API (`/api/v1/health`), WhatsApp and Telegram sessions, disk, memory, last backup, certificate, API errors; starts a stopped container, restarts the API after 3 failed checks; tells admins through the CRM bot; state in `state/status.json` |
| `backup.sh` | 02:15 Tashkent | database dump + test restore into a scratch database, settings and messenger sessions, files (hard-linked snapshots); database 14 days + monthly for 6 months, files 30 days + monthly for a year; result in `state/backup.json` |
| `integrity.py` | 02:35 Tashkent | every uploaded file against its checksum (`state/uploads-manifest.json`) and the database: a file damaged on disk or deleted while the database still refers to it is restored from the snapshots; a damaged snapshot copy is replaced; result in `state/integrity.json`, details in `integrity.log`, damaged originals in `state/quarantine/` |
| `weekly.sh` | Sunday night | identical uploaded files become one copy (`dedupe-uploads.py`), unused docker layers removed, CRM container logs above 100 MB cut |
| `nginx_perf.py` | once | gzip and browser caching for the site (already applied, marker `crm-perf-2026-11-22`) |

Restore the database from a backup:

    docker exec -i crm-db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < /root/backups/auto/daily/<date>/db.dump

Backups stay on the same server. For a copy elsewhere put an executable `/root/crm2/ops/offsite.sh`
(gets the day folder and the files folder as arguments); `backup.sh` runs it and records the result.
