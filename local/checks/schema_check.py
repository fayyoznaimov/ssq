#!/usr/bin/env python3
"""The database matches the code: every migration is applied, and the entities describe the same
tables, columns, types, foreign keys and indexes as the database (TypeORM `schema:log`). Names of
constraints and indexes may differ (older migrations named them by hand); anything structural fails.
    local/dev/check.sh schema
Runs `typeorm` in the API's environment: CRM_APP_EXEC / CRM_APP_DIR (dev copy) or the docker container.
"""
import os
import re
import shlex
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
COMPOSE_FILE = os.path.join(ROOT, "docker-compose.local.yml")
APP_EXEC = (shlex.split(os.environ["CRM_APP_EXEC"]) if os.environ.get("CRM_APP_EXEC") else
            ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-app"])
APP_DIR = os.environ.get("CRM_APP_DIR", "/app")
results = {"PASS": 0, "FAIL": 0}


def check(name, ok, detail=""):
    results["PASS" if ok else "FAIL"] += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {str(detail)[:1500]}" if detail and not ok else ""), flush=True)


def typeorm(*args):
    cmd = f"cd {shlex.quote(APP_DIR)} && npx typeorm -d dist/datasource.js {' '.join(args)}"
    done = subprocess.run(APP_EXEC + ["sh", "-c", cmd], capture_output=True, text=True, timeout=300)
    return done.returncode, "\n".join(l for l in (done.stdout + done.stderr).splitlines() if not l.startswith("query:"))


def main():
    code, out = typeorm("migration:show")
    applied = re.findall(r"^\s*\[X\]", out, re.M)
    pending = re.findall(r"^\s*\[ \]\s*(.*)$", out, re.M)
    check(f"migrations: {len(applied)} applied, none pending", code == 0 and applied and not pending, pending or out[-500:])

    # the database works in the API's time zone (migration 1794960000000-time-zone, datasource.ts)
    env_file = os.environ.get("CRM_ENV_FILE") or os.path.join(ROOT, "parisahon-api", ".env")
    tz = "Asia/Karachi"
    try:
        for line in open(env_file, encoding="utf-8"):
            if line.startswith("TZ="):
                tz = line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    psql = (shlex.split(os.environ["CRM_PSQL"]) if os.environ.get("CRM_PSQL") else
            ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])
    db_tz = subprocess.run(psql + ["-At", "-c", "show timezone"], capture_output=True, text=True, cwd=ROOT).stdout.strip()
    check(f"the database time zone is the API's ({tz})", db_tz == tz, db_tz)

    code, out = typeorm("schema:log")
    if "Your schema is up to date" in out:
        check("entities and database schema are the same", True)
    else:
        statements = [s.strip() for s in re.findall(r"^(?:ALTER|CREATE|DROP|COMMENT)[^;]*;", out, re.M)]
        structural, fk_drop, fk_add, idx_drop, idx_add = [], {}, {}, 0, []
        for s in statements:
            m = re.match(r'ALTER TABLE "(\w+)" DROP CONSTRAINT "FK_\w+";', s)
            if m:
                fk_drop[m.group(1)] = fk_drop.get(m.group(1), 0) + 1
                continue
            m = re.match(r'ALTER TABLE "(\w+)" ADD CONSTRAINT "FK_\w+" FOREIGN KEY', s)
            if m:
                fk_add[m.group(1)] = fk_add.get(m.group(1), 0) + 1
                continue
            if re.match(r'DROP INDEX "public"\."\w+";', s):
                idx_drop += 1
                continue
            m = re.match(r'CREATE (?:UNIQUE )?INDEX "\w+" ON "(\w+)" \(([^)]*)\)', s)
            if m:
                idx_add.append(s)
                continue
            structural.append(s)
        check("no structural difference between the entities and the database (tables, columns, types)", not structural, "\n".join(structural[:15]))
        check("foreign keys: the same on both sides (only their names differ)", fk_drop == fk_add, {"db_only": fk_drop, "code_only": fk_add})
        check("indexes: the same on both sides (only their names differ)", idx_drop == len(idx_add), {"dropped": idx_drop, "created": idx_add[:5]})
    print(f"\nRESULT: {results['PASS']} passed, {results['FAIL']} failed")
    return 1 if results["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
