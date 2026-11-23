#!/usr/bin/env python3
"""Every GET route of the API answers as the admin without a server error, with real ids from the
database for the route parameters, and in reasonable time. Routes are read from the controllers
(the parser of auth_check.py), so a new route is covered without editing this file.
    local/dev/check.sh smoke
Fails on any 5xx, on a non-JSON answer and on an answer slower than SMOKE_SLOW_MS (default 3000);
answers slower than 1 s are listed. Only reads, creates nothing.
"""
import importlib.util
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BASE = os.environ.get("CRM_API_URL", "http://localhost:8080/api/v1").rstrip("/")
ENV_FILE = os.environ.get("CRM_ENV_FILE") or os.path.join(ROOT, "parisahon-api", ".env")
PSQL = (shlex.split(os.environ["CRM_PSQL"]) if os.environ.get("CRM_PSQL") else
        ["docker", "compose", "-f", os.path.join(ROOT, "docker-compose.local.yml"), "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])
SLOW_MS = int(os.environ.get("SMOKE_SLOW_MS", "3000"))
results = {"PASS": 0, "FAIL": 0}

spec = importlib.util.spec_from_file_location("auth_check", os.path.join(HERE, "auth_check.py"))
auth_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth_check)

# parameters -> a real id (first match wins); the route prefix decides what ":id" is
IDS = {
    ("/companies/:id", "id"): "select c.id from company c join \"user\" u on u.company_id = c.id where c.deleted_at is null group by c.id order by c.id desc limit 1",
    ("/companies/:id", "agent_id"): "select u.id from \"user\" u where u.company_id = {id} and u.role = 'ctr_agent' order by u.id limit 1",
    ("/deals/:id", "id"): "select d.id from deal d join deal_file f on f.\"dealId\" = d.id where d.deleted_at is null order by d.id desc limit 1",
    ("/deals/:id", "file_id"): "select \"fileId\" from deal_file where \"dealId\" = {id} limit 1",
    ("/emails/:id", "id"): "select id from email where deleted_at is null order by id desc limit 1",
    ("/emails/signs/:user_id", "user_id"): "select id from \"user\" where email = 'admin@gmail.com' limit 1",
    ("/emails/templates/:id", "id"): "select id from email_template order by id limit 1",
    ("/emails/transporters/:id", "id"): "select id from email_transporter order by id limit 1",
    ("/groups/:id", "id"): "select id from \"group\" order by id limit 1",
    ("/products/:id", "id"): "select id from product where deleted_at is null order by id desc limit 1",
    ("/stages/collections/:id", "id"): "select id from collection order by id limit 1",
    ("/stages/:id", "id"): "select coalesce((select deal_stage_id from trigger order by id limit 1), (select id from deal_stage order by id limit 1))",
    ("/stages/:id", "trigger_id"): "select id from trigger where deal_stage_id = {id} order by id limit 1",
    ("/task-types/:id", "id"): "select id from task_type order by id limit 1",
    ("/tasks/:id", "id"): "select id from task order by id desc limit 1",
    ("/users/:id", "id"): "select id from \"user\" where role = 'ctr_agent' and deleted_at is null order by id desc limit 1",
    # the calls of a company (its card) and of a staff member (/lists/calls/:id): the busiest ones, for the time limit
    ("/calls/companies/:id", "id"): "select coalesce((select u.company_id from recording r join \"user\" u on u.role = 'ctr_agent' and u.company_id is not null "
                                    "and right(regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g'), 9) = right(regexp_replace(coalesce(r.from_number, ''), '[^0-9]', '', 'g'), 9) "
                                    "join company c on c.id = u.company_id and c.deleted_at is null "
                                    "group by u.company_id order by count(*) desc limit 1), (select id from company where deleted_at is null order by id desc limit 1))",
    ("/calls/staff/:id", "id"): "select user_id from recording group by user_id order by count(*) desc limit 1",
}
# talk to external services or change state although they are GET
SKIP = {"/emails/sync"}


def check(name, ok, detail=""):
    results["PASS" if ok else "FAIL"] += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {str(detail)[:400]}" if detail and not ok else ""), flush=True)


def psql(sql):
    out = subprocess.run(PSQL + ["-At", "-c", sql], capture_output=True, text=True, cwd=ROOT).stdout.strip()
    return out.split("\n")[0] if out else ""


def env_value(key):
    for line in open(ENV_FILE, encoding="utf-8"):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"')


def get(path, token):
    req = urllib.request.Request(BASE + path, headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body, status, ctype = r.read(), r.status, r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        body, status, ctype = e.read(), e.code, e.headers.get("Content-Type", "")
    return status, ctype, body, int((time.time() - started) * 1000)


def fill(path):
    """The route with real ids, or None when the database has no such row."""
    values = {}
    for (prefix, param), sql in IDS.items():
        if path.startswith(prefix.split(":")[0]) and f":{param}" in path and param not in values:
            value = psql(sql.format(**values))
            if not value:
                return None
            values[param] = value
    for param, value in values.items():
        path = path.replace(f":{param}", value)
    return None if ":" in path else path


def main():
    status, body = None, None
    req = urllib.request.Request(BASE + "/auth/login", data=json.dumps({"email": "admin@gmail.com", "password": env_value("ADMIN_PASSWORD")}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        token = json.loads(r.read())["access_token"]
    routes, _ = auth_check.discover_routes()
    slow = []
    for method, path in sorted(r for r in routes if r[0] == "GET"):
        if path in SKIP or path.startswith("/bot/mcp"):
            continue
        real = fill(path)
        if real is None:
            print(f"SKIP  GET {path}: no data for its parameters")
            continue
        status, ctype, raw, ms = get(real, token)
        if ms > 1000:
            slow.append(f"{path} {ms} ms")
        is_json = "json" in ctype or not raw or "/files/" in path or path.endswith("/source") or path == "/"
        check(f"GET {real} -> {status} in {ms} ms", status < 500 and ms <= SLOW_MS and (is_json or status >= 300),
              f"{status} {raw[:200]!r}" if status >= 500 or not is_json else f"slower than {SLOW_MS} ms")
    print("\nslower than 1 s: " + (", ".join(slow) or "none"))
    print(f"\nRESULT: {results['PASS']} passed, {results['FAIL']} failed")
    return 1 if results["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
