#!/usr/bin/env python3
"""The modules the other sets do not cover: groups, task types, staff accounts, the files list,
the search over deals / companies / contacts (linkables), the action log, settings and the desktop.
CRUD as the admin, refusals for an agent and a manager where the API says so.
    local/dev/check.sh platform
Everything it creates is named AUDIT-plt-<run> and removed at the end; settings are restored.
"""
import json
import os
import secrets
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASE = os.environ.get("CRM_API_URL", "http://localhost:8080/api/v1").rstrip("/")
ENV_FILE = os.environ.get("CRM_ENV_FILE") or os.path.join(ROOT, "parisahon-api", ".env")
PSQL = (shlex.split(os.environ["CRM_PSQL"]) if os.environ.get("CRM_PSQL") else
        ["docker", "compose", "-f", os.path.join(ROOT, "docker-compose.local.yml"), "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])
RUN = secrets.token_hex(3)
TAG = f"AUDIT-plt-{RUN}"
results = {"PASS": 0, "FAIL": 0}


def check(name, ok, detail=""):
    results["PASS" if ok else "FAIL"] += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {str(detail)[:400]}" if detail and not ok else ""), flush=True)


def env_value(key):
    for line in open(ENV_FILE, encoding="utf-8"):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"')


def psql(sql):
    done = subprocess.run(PSQL + ["-At", "-c", sql], capture_output=True, text=True, cwd=ROOT)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip())
    return done.stdout.strip()


def http(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "Accept": "application/json"})
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for attempt in range(30):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                text = r.read()
                return r.status, json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            text = e.read()
            try:
                return e.code, json.loads(text)
            except Exception:
                return e.code, text.decode(errors="replace")
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            time.sleep(3)
    raise SystemExit(f"API is not reachable at {BASE}")


def items(body):
    return body.get("data", body) if isinstance(body, dict) else body


def main():
    admin = http("POST", "/auth/login", {"email": "admin@gmail.com", "password": env_value("ADMIN_PASSWORD")})[1]["access_token"]
    groups = sorted(g["id"] for g in http("GET", "/groups", token=admin)[1])
    perms = {"deal": {"view": 1, "create": 3, "update": 1, "delete": 0, "export": 0},
             "contact": {"view": 3, "create": 3, "update": 3, "delete": 0, "export": 0},
             "company": {"view": 3, "create": 3, "update": 3, "delete": 0, "export": 0},
             "task": {"update": 1, "delete": 0}, "mail": True, "file": True}
    users, settings_before = {}, None
    try:
        print("== staff accounts (POST/PATCH/DELETE /users)")
        for role in ("agent", "manager"):
            person = {"email": f"audit-plt-{RUN}-{role}@example.test", "password": secrets.token_urlsafe(12),
                      "username": f"{TAG}-{role}", "role": role, "group_id": groups[0], "permissions": perms}
            status, body = http("POST", "/users", person, admin)
            check(f"admin creates a {role} -> 201", status == 201, (status, body))
            person["id"] = body["id"]
            person["token"] = http("POST", "/auth/login", {"email": person["email"], "password": person["password"]})[1]["access_token"]
            users[role] = person
        A, M = users["agent"], users["manager"]
        status, _ = http("POST", "/users", {"email": f"audit-plt-{RUN}-x@example.test", "password": "x" * 12, "username": f"{TAG}-x",
                                            "role": "agent", "group_id": groups[0], "permissions": perms}, M["token"])
        check("a manager cannot create staff accounts -> 403", status == 403, status)
        status, body = http("GET", f"/users/{A['id']}", token=admin)
        check("GET /users/:id -> the account without its password", status == 200 and body.get("username") == f"{TAG}-agent" and "password" not in body, body)
        status, body = http("GET", "/users?role=agent&limit=500", token=admin)
        check("GET /users?role=agent lists the new agent", status == 200 and any(u.get("id") == A["id"] for u in items(body)), status)

        print("== groups")
        status, _ = http("POST", "/groups", {"name": f"{TAG}-g"}, A["token"])
        check("an agent cannot create a group -> 403", status == 403, status)
        status, body = http("POST", "/groups", {"name": f"{TAG}-g"}, admin)
        check("admin creates a group -> 201", status == 201, (status, body))
        gid = body["id"] if status == 201 else 0
        # one time zone: created_at is filled by the database, and must come back as the real moment
        import datetime as _dt
        created = body.get("created_at") if isinstance(body, dict) else None
        if not created:
            created = next((g.get("created_at") for g in http("GET", "/groups", token=admin)[1] if g["id"] == gid), None)
        try:
            moment = _dt.datetime.fromisoformat(str(created).replace("Z", "+00:00"))
            drift = abs((moment - _dt.datetime.now(_dt.timezone.utc)).total_seconds())
        except Exception:
            drift = None
        check("a new row's created_at (filled by the database) is the real moment, not 5 hours off", drift is not None and drift < 120, (created, drift))
        status, _ = http("PATCH", f"/groups/{gid}", {"name": f"{TAG}-g2"}, admin)
        check("admin renames the group", status == 200 and psql(f"select name from \"group\" where id = {gid}") == f"{TAG}-g2", status)
        status, body = http("GET", "/groups", token=A["token"])
        check("an agent can read the groups", status == 200 and any(g["id"] == gid for g in body), status)
        status, _ = http("DELETE", f"/groups/{gid}", token=admin)
        check("admin deletes the group", status == 200 and psql(f"select count(*) from \"group\" where id = {gid}") == "0", status)

        print("== task types")
        status, _ = http("POST", "/task-types", {"name": f"{TAG}-t"}, A["token"])
        check("an agent cannot create a task type -> 403", status == 403, status)
        status, body = http("POST", "/task-types", {"name": f"{TAG}-t"}, admin)
        check("admin creates a task type -> 201", status == 201, (status, body))
        tid = body["id"] if status == 201 else 0
        status, body = http("GET", f"/task-types/{tid}", token=A["token"])
        check("anyone reads it", status == 200 and body.get("name") == f"{TAG}-t", body)
        status, _ = http("PATCH", f"/task-types/{tid}", {"name": f"{TAG}-t2"}, admin)
        check("admin renames it", status == 200, status)
        status, _ = http("DELETE", f"/task-types/{tid}", token=admin)
        check("admin deletes it", status == 200, status)

        print("== search (GET /linkables)")
        cid = int(psql(f"insert into company (name, is_old) values ('{TAG} Поиск', false) returning id"))
        status, body = http("GET", f"/linkables?name={urllib.request.quote(TAG + ' Пои')}", token=admin)
        found = [x for x in items(body) or [] if str(x.get("id")) == str(cid)] if status == 200 else []
        check("a company is found by a part of its name (Cyrillic)", status == 200 and found, (status, body if status != 200 else len(items(body))))
        status, _ = http("GET", "/linkables", token=admin)
        check("search without a name -> 400", status == 400, status)
        psql(f"delete from company where id = {cid}")

        print("== files, log, desktop")
        status, body = http("GET", "/files?limit=5", token=admin)
        check("GET /files -> 200 with a list", status == 200 and isinstance(items(body), list), status)
        status, _ = http("GET", "/logs?limit=5", token=M["token"])
        check("the action log is open to a manager", status == 200, status)
        status, _ = http("GET", "/logs?limit=5", token=A["token"])
        check("... and closed to an agent -> 403", status == 403, status)
        status, body = http("GET", "/desktop?my_stats=true&from_date=2026-01-01&till_date=2026-12-31", token=A["token"])
        check("the desktop answers an agent with their own counters", status == 200 and isinstance(body, dict) and body, (status, str(body)[:200]))
        status, _ = http("GET", "/desktop?from_date=2026-01-01&till_date=2026-12-31", token=A["token"])
        check("... and refuses an agent the company-wide ones -> 403", status == 403, status)

        print("== settings")
        status, settings_before = http("GET", "/settings", token=admin)
        check("GET /settings -> 200", status == 200, status)
        stage = int(psql("select s.id from deal_stage s join collection c on c.id = s.collection_id where c.is_active order by s.\"order\" limit 1"))
        status, _ = http("PATCH", "/settings", {"default_stage_id": stage}, A["token"])
        check("an agent cannot change settings -> 403", status == 403, status)
        status, _ = http("PATCH", "/settings", {"default_stage_id": stage}, admin)
        check("admin sets the default stage", status == 200 and psql("select default_stage_id from setting order by id desc limit 1") == str(stage), status)

        print("== deleted account")
        status, _ = http("DELETE", f"/users/{A['id']}", token=admin)
        status2, _ = http("POST", "/auth/login", {"email": A["email"], "password": A["password"]})
        check("a deleted agent cannot log in", status == 200 and status2 == 401, (status, status2))
    finally:
        print("== cleanup")
        if isinstance(settings_before, dict):
            before_stage = (settings_before.get("default_stage") or {}).get("id")
            psql(f"update setting set default_stage_id = {before_stage if before_stage else 'null'} where id = (select id from setting order by id desc limit 1)")
        psql(";".join([
            "begin",
            f"delete from event where user_id in (select id from \"user\" where username like '{TAG}%') or target_user_id in (select id from \"user\" where username like '{TAG}%')",
            f"delete from \"user\" where username like '{TAG}%'",
            f"delete from \"group\" where name like '{TAG}%'",
            f"delete from task_type where name like '{TAG}%'",
            f"delete from company where name like '{TAG}%'",
            "commit",
        ]))
        left = psql(f"select (select count(*) from \"user\" where username like '{TAG}%') + (select count(*) from \"group\" where name like '{TAG}%') + (select count(*) from task_type where name like '{TAG}%')")
        check("test rows removed, settings restored", left == "0", left)
    print(f"\nRESULT: {results['PASS']} passed, {results['FAIL']} failed")
    return 1 if results["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
