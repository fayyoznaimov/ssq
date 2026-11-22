#!/usr/bin/env python3
"""Nightly integrity check of the CRM's uploaded files (cron, after the backup).

Uploaded files never change after they are written, so every file gets a checksum once
(state/uploads-manifest.json) and is compared with it every night:
  - content differs although the file was not rewritten (same modification time)  -> damaged on disk:
    the good copy is taken back from the nightly snapshots (/root/backups/auto/uploads);
  - the file is gone but the database still refers to it -> deleted by mistake: restored the same way;
  - the file is gone together with its record -> removed in the CRM, forgotten here;
  - the newest snapshot is compared too, and a damaged snapshot copy is replaced from the live file.
Files the database names but that were never on disk are counted once as a baseline and reported
only when new ones appear.

Result: state/integrity.json (the watchdog alerts on it), details in state/integrity.log.
Above FULL_CHECK_BYTES of uploads only one seventh of the files is re-read per night.
"""
import hashlib, json, os, re, shutil, subprocess, sys, time
from datetime import datetime, timezone

# the folders can be pointed elsewhere for a trial run
UPLOADS = os.environ.get("CRM_UPLOADS", "/root/crm/parisahon-api/public/uploads")
SNAPSHOTS = os.environ.get("CRM_UPLOAD_SNAPSHOTS", "/root/backups/auto/uploads")
STATE_DIR = os.environ.get("CRM_OPS_STATE", "/root/crm2/ops/state")
MANIFEST = f"{STATE_DIR}/uploads-manifest.json"
RESULT = f"{STATE_DIR}/integrity.json"
LOG = f"{STATE_DIR}/integrity.log"
QUARANTINE = f"{STATE_DIR}/quarantine"
FULL_CHECK_BYTES = 3 * 1024 ** 3
PATHS_SQL = (
    "SELECT path FROM file WHERE path IS NOT NULL AND path <> '' "
    "UNION SELECT path FROM recording WHERE path IS NOT NULL AND path <> '' "
    "UNION SELECT avatar FROM \"user\" WHERE avatar IS NOT NULL AND avatar <> ''"
)


def log(text):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {text}\n")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def psql(sql=None, dump=False):
    cmd = 'pg_dump -U "$POSTGRES_USER" --data-only "$POSTGRES_DB"' if dump else 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'
    r = subprocess.run(["docker", "exec", "-i", "crm-db", "sh", "-c", cmd], input="" if dump else sql,
                       capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:200])
    return r.stdout


def snapshots():
    if not os.path.isdir(SNAPSHOTS):
        return []
    return sorted((d for d in os.listdir(SNAPSHOTS) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d)), reverse=True)


def good_copy(name, want):
    """The newest snapshot copy of the file with the expected checksum, or None."""
    for day in snapshots():
        path = os.path.join(SNAPSHOTS, day, name)
        if os.path.isfile(path) and (want is None or sha256(path) == want):
            return path
    return None


def put_back(name, source):
    target = os.path.join(UPLOADS, name)
    tmp = target + ".restore-tmp"
    shutil.copy2(source, tmp)
    os.replace(tmp, target)
    os.chmod(target, 0o644)


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    try:
        manifest = json.load(open(MANIFEST, encoding="utf-8"))
    except Exception:
        manifest = {"files": {}, "missing_known": None}
    files = manifest.setdefault("files", {})
    today = datetime.now().strftime("%Y-%m-%d")

    on_disk = {}
    for name in os.listdir(UPLOADS):
        path = os.path.join(UPLOADS, name)
        if name.endswith((".dedupe-tmp", ".restore-tmp")) or not os.path.isfile(path) or os.path.islink(path):
            continue
        st = os.stat(path)
        on_disk[name] = (st.st_size, int(st.st_mtime))
    total = sum(size for size, _ in on_disk.values())

    # what the database refers to: exact columns, plus any mention inside the JSON of the events
    db_ok = True
    try:
        named = {os.path.basename(p) for p in psql(PATHS_SQL).split("\n") if p.strip()}
        mentioned = set(re.findall(r"[A-Za-z0-9_][A-Za-z0-9_.\-]{5,}", psql(dump=True)))
    except Exception as e:
        db_ok, named, mentioned = False, set(), set()
        log(f"database not readable, deletions are not judged tonight: {e}")

    weekday = datetime.now().weekday()
    partial = total > FULL_CHECK_BYTES
    restored, lost, damaged, updated, removed, added = [], [], [], 0, 0, 0

    for name in sorted(set(files) - set(on_disk)):
        entry = files[name]
        if not db_ok:
            continue
        if name in named or name in mentioned:
            source = good_copy(name, entry.get("sha256"))
            if source:
                put_back(name, source)
                restored.append(name)
                log(f"restored {name}: it was gone but the database refers to it (from {source})")
            else:
                lost.append(name)
                log(f"LOST {name}: gone, the database refers to it, no snapshot has it")
        else:
            del files[name]
            removed += 1

    for name, (size, mtime) in sorted(on_disk.items()):
        entry = files.get(name)
        if entry is None:
            files[name] = {"size": size, "mtime": mtime, "sha256": sha256(os.path.join(UPLOADS, name)), "seen": today}
            added += 1
            continue
        if partial and size == entry["size"] and int(hashlib.md5(name.encode()).hexdigest(), 16) % 7 != weekday:
            continue
        actual = sha256(os.path.join(UPLOADS, name))
        if actual == entry["sha256"]:
            entry["mtime"] = mtime
            continue
        if mtime != entry.get("mtime"):
            # written again by the application: a new version, not damage
            entry.update(size=size, mtime=mtime, sha256=actual)
            updated += 1
            continue
        source = good_copy(name, entry["sha256"])
        os.makedirs(QUARANTINE, exist_ok=True)
        shutil.copy2(os.path.join(UPLOADS, name), os.path.join(QUARANTINE, f"{today}_{name}"))
        if source:
            put_back(name, source)
            entry["mtime"] = int(os.stat(os.path.join(UPLOADS, name)).st_mtime)
            restored.append(name)
            log(f"restored {name}: the content changed on disk without being rewritten (from {source})")
        else:
            damaged.append(name)
            log(f"DAMAGED {name}: the content changed on disk, no good snapshot copy")

    # the newest snapshot must hold the same content; a damaged snapshot copy is replaced from the live file
    snapshot_repaired = 0
    days = snapshots()
    if days:
        newest = os.path.join(SNAPSHOTS, days[0])
        for name, entry in files.items():
            if name in lost or name in damaged:
                continue
            copy = os.path.join(newest, name)
            if not os.path.isfile(copy):
                continue
            if partial and int(hashlib.md5(name.encode()).hexdigest(), 16) % 7 != weekday:
                continue
            if sha256(copy) != entry["sha256"] and int(os.stat(copy).st_mtime) == entry.get("mtime"):
                os.remove(copy)  # other days share this inode; the live file is the good one
                shutil.copy2(os.path.join(UPLOADS, name), copy)
                snapshot_repaired += 1
                log(f"snapshot copy of {name} in {days[0]} was damaged, replaced from the live file")

    # records without a file: old ones are a baseline, new ones are a problem
    missing_new = []
    if db_ok:
        missing = sorted(n for n in named if n not in on_disk and n not in restored)
        if manifest.get("missing_known") is None:
            manifest["missing_known"] = missing
            log(f"baseline: {len(missing)} record(s) in the database had no file on the first run")
        known = set(manifest["missing_known"])
        missing_new = [n for n in missing if n not in known and n not in lost]
        for name in missing_new:
            log(f"MISSING {name}: the database has a record, the file is not on disk")

    with open(MANIFEST + ".tmp", "w", encoding="utf-8") as f:
        json.dump(manifest, f)
    os.replace(MANIFEST + ".tmp", MANIFEST)
    result = {
        "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "ok": not (lost or damaged or missing_new) and db_ok,
        "files": len(on_disk), "bytes": total, "checked": "one seventh" if partial else "all",
        "new": added, "removed_with_record": removed, "rewritten": updated,
        "restored": restored, "lost": lost, "damaged": damaged, "missing_new": missing_new,
        "snapshot_repaired": snapshot_repaired, "snapshots": len(days),
        "records_without_file_baseline": len(manifest.get("missing_known") or []),
        "database_read": db_ok,
    }
    with open(RESULT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    log(f"ok={result['ok']} files={len(on_disk)} new={added} removed={removed} restored={len(restored)} "
        f"lost={len(lost)} damaged={len(damaged)} missing_new={len(missing_new)} snapshot_repaired={snapshot_repaired}")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
