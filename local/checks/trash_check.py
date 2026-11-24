#!/usr/bin/env python3
"""
Trash of deals and sequential deal numbers.

    source local/dev/env.sh && python3 local/checks/trash_check.py

* Python stdlib only; talks to the API (CRM_API_URL) and the database (CRM_PSQL), like the other sets.
* Admin password is read from the API env file (CRM_ENV_FILE) and never printed.
* Creates only rows named AUDIT-trash-<run> (deals, tasks, users, groups, company, product, field, files)
  and removes them at the end (also after a crash); a run starts with the same cleanup.
* Never deletes for good anything but its own rows: "empty the trash" is called only when the trash
  holds nothing but AUDIT rows (otherwise only the 403s of non-admins are checked).
* Prints PASS/FAIL/SKIP per check, exits 1 if anything failed.

What is checked
  numbering   new deal = max(display_id of all deals, trash included) + 1; a number in the trash is
              not reused; a manual number is accepted when free (and the next one follows it);
              10 parallel POST /deals get 10 unique consecutive numbers; a deal without a name is "#<n>"
  trash       DELETE /deals/:id -> gone from GET /deals (list, kanban), search by number, /deals/stats,
              /analytics/users, task lists, desktop counters; listed in GET /deals/trash with who/when;
              restore -> back in its stage with history, tasks, files, products, fields; a deal without
              a stage comes back in the default stage
  purge       admin only; removes the deal, events, tasks, stage records, products, fields, contacts,
              its own file (row and disk); a file shared with another deal (in the trash too) is kept
  rights      agent with delete=0 / delete=1 (own) / delete=2 (group) / delete=3; a manager sees and restores
              every deal whatever the matrix says (src/auth/access.ts: admin and manager — everything) / admin
"""
import base64
import concurrent.futures
import datetime
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
ENV_FILE = os.environ.get("CRM_ENV_FILE") or os.path.join(ROOT, "parisahon-api", ".env")
COMPOSE_FILE = os.path.join(ROOT, "docker-compose.local.yml")
UPLOADS_DIR = os.path.join(ROOT, "parisahon-api", "public", "uploads")
BASE = os.environ.get("CRM_API_URL", "http://localhost:8080/api/v1").rstrip("/")
PSQL = (shlex.split(os.environ["CRM_PSQL"]) if os.environ.get("CRM_PSQL") else
        ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])

RUN = str(int(time.time()))[-6:]
P = "AUDIT-trash-" + RUN  # prefix of everything this run creates
FAR_PAST, FAR_FUTURE = "2020-01-01", "2035-12-31"

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# --------------------------------------------------------------------------- helpers

results = []


def check(name, ok, detail=""):
    ok = bool(ok)
    results.append((name, ok))
    line = ("PASS  " if ok else "FAIL  ") + name
    if detail and not ok:
        line += "   <- " + str(detail)[:400]
    print(line, flush=True)
    return ok


def skip(name, why):
    print("SKIP  %s   (%s)" % (name, why), flush=True)


def section(title):
    print("\n== " + title, flush=True)


def env(key):
    with open(ENV_FILE, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"\s*%s\s*=\s*(.*)" % re.escape(key), line)
            if not m:
                continue
            value = m.group(1).strip()
            if value[:1] in ("'", '"'):
                return value[1:value.index(value[0], 1)]
            return value.split(" #")[0].strip()
    raise SystemExit("%s is not set in %s" % (key, ENV_FILE))


def sql(query):
    proc = subprocess.run(PSQL + ["-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"],
                          input=query, capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise RuntimeError("psql failed: %s\n%s" % (proc.stderr.strip(), query))
    return [line.split("|") for line in proc.stdout.splitlines() if line != ""]


def scalar(query):
    rows = sql(query)
    return rows[0][0] if rows else None


def count(query):
    return int(scalar(query) or 0)


ADMIN = None  # admin token


def http(method, path, body=None, token=None, raw=None, headers=None):
    """(status, parsed json | text | None). Retries while the API restarts (nest --watch: 502)."""
    url = BASE + urllib.parse.quote(path, safe="/?=&[]%:,+-_.~")
    hdrs = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    if raw is not None:
        data = raw
    if headers:
        hdrs.update(headers)
    token = token or ADMIN
    if token:
        hdrs["Authorization"] = "Bearer " + token
    deadline = time.time() + 120
    while True:
        request = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                status, text = response.status, response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            status, text = error.code, error.read().decode("utf-8", "replace")
        except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
            if time.time() > deadline:
                raise SystemExit("API is not reachable: %s" % error)
            time.sleep(3)
            continue
        if status in (502, 503, 504) and time.time() < deadline:
            time.sleep(3)
            continue
        break
    if not text:
        return status, None
    try:
        return status, json.loads(text)
    except ValueError:
        return status, text


def message_of(response):
    body = response[1]
    if isinstance(body, dict):
        message = body.get("message")
        return " ".join(message) if isinstance(message, list) else str(message)
    return str(body)


def multipart(files):
    boundary = "----audittrash" + RUN
    body = b""
    for name, filename, content in files:
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
                 "Content-Type: text/plain\r\n\r\n" % (boundary, name, filename)).encode("utf-8")
        body += content + b"\r\n"
    body += ("--%s--\r\n" % boundary).encode("utf-8")
    return body, {"Content-Type": "multipart/form-data; boundary=" + boundary}


def wait_for(fn, expected, timeout=8):
    deadline = time.time() + timeout
    value = fn()
    while value != expected and time.time() < deadline:
        time.sleep(0.4)
        value = fn()
    return value


def token_sub(token):
    payload = token.split(".")[1]
    return int(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["sub"])


# --------------------------------------------------------------------------- cleanup

CLEANUP_SQL = r"""
CREATE TEMP TABLE _d AS SELECT id FROM deal WHERE label LIKE 'AUDIT-trash-%';
CREATE TEMP TABLE _u AS SELECT id FROM "user" WHERE username LIKE 'AUDIT-trash-%';
CREATE TEMP TABLE _t AS SELECT id FROM task WHERE label LIKE 'AUDIT-trash-%' OR deal_id IN (SELECT id FROM _d);
CREATE TEMP TABLE _f AS SELECT id FROM file WHERE name LIKE 'AUDIT-trash-%';
DELETE FROM event WHERE deal_id IN (SELECT id FROM _d) OR task_id IN (SELECT id FROM _t)
   OR (deal_id IS NULL AND (after_state::text LIKE '%AUDIT-trash-%' OR before_state::text LIKE '%AUDIT-trash-%'));
DELETE FROM task WHERE id IN (SELECT id FROM _t);
DELETE FROM deal_stage_record WHERE deal_id IN (SELECT id FROM _d);
DELETE FROM deal_file WHERE "dealId" IN (SELECT id FROM _d) OR "fileId" IN (SELECT id FROM _f);
DELETE FROM file WHERE id IN (SELECT id FROM _f);
DELETE FROM deal WHERE id IN (SELECT id FROM _d);
DELETE FROM deal_user WHERE "userId" IN (SELECT id FROM _u);
DELETE FROM "user" WHERE id IN (SELECT id FROM _u);
DELETE FROM "group" WHERE name LIKE 'AUDIT-trash-%';
DELETE FROM deal_product WHERE product_id IN (SELECT id FROM product WHERE name LIKE 'AUDIT-trash-%');
DELETE FROM product WHERE name LIKE 'AUDIT-trash-%';
DELETE FROM filler WHERE field LIKE 'AUDIT-trash-%';
DELETE FROM notification WHERE company_id IN (SELECT id FROM company WHERE name LIKE 'AUDIT-trash-%');
DELETE FROM company WHERE name LIKE 'AUDIT-trash-%';
"""

LEFTOVERS_SQL = r"""
SELECT 'deal', count(*) FROM deal WHERE label LIKE 'AUDIT-trash-%'
UNION ALL SELECT 'task', count(*) FROM task WHERE label LIKE 'AUDIT-trash-%'
UNION ALL SELECT 'user', count(*) FROM "user" WHERE username LIKE 'AUDIT-trash-%'
UNION ALL SELECT 'group', count(*) FROM "group" WHERE name LIKE 'AUDIT-trash-%'
UNION ALL SELECT 'company', count(*) FROM company WHERE name LIKE 'AUDIT-trash-%'
UNION ALL SELECT 'product', count(*) FROM product WHERE name LIKE 'AUDIT-trash-%'
UNION ALL SELECT 'filler', count(*) FROM filler WHERE field LIKE 'AUDIT-trash-%'
UNION ALL SELECT 'file', count(*) FROM file WHERE name LIKE 'AUDIT-trash-%'
"""


def cleanup():
    for row in sql("SELECT path FROM file WHERE name LIKE 'AUDIT-trash-%'"):
        target = os.path.join(UPLOADS_DIR, os.path.basename(row[0]))
        if os.path.basename(row[0]) and os.path.isfile(target):
            try:
                os.remove(target)
            except OSError:
                pass
    sql(CLEANUP_SQL)


def leftovers():
    return {name: int(n) for name, n in sql(LEFTOVERS_SQL) if int(n) > 0}


# --------------------------------------------------------------------------- the run

def main():
    global ADMIN
    cleanup()

    status, body = http("POST", "/auth/login", {"email": "admin@gmail.com", "password": env("ADMIN_PASSWORD")})
    if status not in (200, 201) or not isinstance(body, dict) or "access_token" not in body:
        raise SystemExit("login failed: HTTP %s" % status)
    ADMIN = body["access_token"]
    admin_id = token_sub(ADMIN)

    # ----------------------------------------------------------------- fixtures
    company_id = int(scalar("INSERT INTO company (name, email, phone, is_old) VALUES ('%s-co', 'audit-trash-%s@example.com', '+998000000001', false) RETURNING id" % (P, RUN)))
    contact_id = int(scalar("INSERT INTO \"user\" (username, email, role, company_id) VALUES ('%s-contact', 'audit-trash-contact-%s@example.com', 'ctr_agent', %d) RETURNING id" % (P, RUN, company_id)))
    product_id = int(scalar("INSERT INTO product (name) VALUES ('%s-prod') RETURNING id" % P))
    filler_id = int(scalar("INSERT INTO filler (target, field) VALUES ('deal', '%s-field') RETURNING id" % P))
    group_a = int(scalar("INSERT INTO \"group\" (name) VALUES ('%s-g1') RETURNING id" % P))
    group_b = int(scalar("INSERT INTO \"group\" (name) VALUES ('%s-g2') RETURNING id" % P))
    task_type_id = int(scalar("SELECT id FROM task_type ORDER BY id LIMIT 1"))

    status, stages = http("GET", "/stages")
    if status != 200:
        raise SystemExit("GET /stages -> %s" % status)
    by_name = {s["name"]: s["id"] for s in stages}
    stage_prepay = by_name[env("DEAL_STAGE_PREPAYMENT")]
    stage_created = by_name[env("DEAL_STAGE_CREATED")]
    default_stage = int(scalar(
        "SELECT COALESCE((SELECT default_stage_id FROM setting ORDER BY id DESC LIMIT 1), "
        "(SELECT s.id FROM deal_stage s JOIN collection c ON c.id = s.collection_id WHERE c.is_active AND s.name = '%s' LIMIT 1))"
        % env("DEAL_STAGE_UNKNOWN").replace("'", "''")))

    def perms(delete):
        return {
            "deal": {"view": 3, "create": 3, "update": 3, "delete": delete, "export": 0},
            "contact": {"view": 3, "create": 3, "update": 3, "delete": 0, "export": 0},
            "company": {"view": 3, "create": 3, "update": 3, "delete": 0, "export": 0},
            "task": {"update": 3, "delete": 3},
            "mail": False,
            "file": True,
        }

    people = {}
    for key, role, group, delete in (("own", "agent", group_a, 1), ("none", "agent", group_a, 0),
                                     ("group", "agent", group_a, 2), ("other", "agent", group_b, 3),
                                     ("manager", "manager", group_b, 0)):
        password = "Audit-%s-%s" % (RUN, key)
        email = "audit-trash-%s-%s@example.test" % (RUN, key)
        status, body = http("POST", "/users", {"email": email, "password": password, "username": "%s-%s" % (P, key),
                                               "role": role, "group_id": group, "permissions": perms(delete)})
        if status != 201 or not isinstance(body, dict):
            raise SystemExit("cannot create test user %s: %s %s" % (key, status, message_of((status, body))))
        status, login = http("POST", "/auth/login", {"email": email, "password": password}, token="-")
        if status not in (200, 201):
            raise SystemExit("cannot log in as test user %s: %s" % (key, status))
        people[key] = {"id": body["id"], "token": login["access_token"]}
    own, none, grp, other, mgr = people["own"], people["none"], people["group"], people["other"], people["manager"]

    def create_deal(suffix, agent=None, token=None, **extra):
        payload = {"label": "%s-%s" % (P, suffix), "budget": 100, "agent_id": agent or admin_id,
                   "company_id": company_id, "ctr_agent_ids": [contact_id], "stage_id": stage_created,
                   "fillers": [], "products": []}
        payload.update(extra)
        payload = {k: v for k, v in payload.items() if v is not None}
        return http("POST", "/deals", payload, token=token)

    def deal_or_die(response, what):
        if response[0] != 201:
            raise SystemExit("cannot create %s: %s %s" % (what, response[0], message_of(response)))
        return response[1]

    def max_number():
        return int(scalar("SELECT COALESCE(MAX(display_id), 0) FROM deal"))

    def trash_ids(token=None, query=""):
        status, body = http("GET", "/deals/trash?limit=1000" + query, token=token)
        if status != 200:
            return "HTTP %s" % status
        return sorted(d["id"] for d in body["data"])

    def deal_ids(query):
        status, body = http("GET", "/deals?" + query)
        if status != 200:
            return "HTTP %s" % status
        return sorted(d["id"] for d in body["data"])

    def row(deal_id):
        rows = sql("SELECT stage_id, deleted_at IS NOT NULL, deleted_by FROM deal WHERE id = %d" % deal_id)
        if not rows:
            return None
        r = rows[0]
        return {"stage": int(r[0]) if r[0] else None, "deleted": r[1] == "t", "deleted_by": int(r[2]) if r[2] else None}

    # ================================================================= numbering
    section("Sequential deal numbers")
    m = max_number()
    d1 = deal_or_die(create_deal("n1"), "deal n1")
    check("new deal gets max(display_id) + 1 (%d)" % (m + 1), d1["display_id"] == m + 1, d1["display_id"])
    r = http("DELETE", "/deals/%d" % d1["id"])
    check("DELETE /deals/:id (admin) -> 200", r[0] in (200, 204), r)
    d2 = deal_or_die(create_deal("n2"), "deal n2")
    check("a number in the trash is not reused: next deal gets %d" % (m + 2), d2["display_id"] == m + 2, d2["display_id"])
    r = create_deal("dup", display_id=d1["display_id"])
    check("manual display_id of a deal in the trash -> 400", r[0] == 400, r)
    r = create_deal("zero", display_id=0)
    check("manual display_id 0 -> 400", r[0] == 400, r)
    d3 = deal_or_die(create_deal("manual", display_id=m + 10), "manual deal")
    check("a free manual display_id is accepted", d3["display_id"] == m + 10, d3["display_id"])
    d4 = deal_or_die(create_deal("after-manual"), "deal after the manual one")
    check("the next automatic number follows the manual one (%d)" % (m + 11), d4["display_id"] == m + 11, d4["display_id"])
    r = http("POST", "/deals", {"label": "", "budget": 0, "agent_id": admin_id, "ctr_agent_ids": [], "fillers": [], "products": [], "stage_id": stage_created})
    if r[0] == 201:
        sql("UPDATE deal SET label = '%s-noname' WHERE id = %d" % (P, r[1]["id"]))
    check("a deal without a name is called #<number>", r[0] == 201 and r[1]["label"] == "#%s" % r[1].get("display_id") and r[1]["display_id"] == m + 12, r)

    m = max_number()
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        responses = list(pool.map(lambda i: create_deal("par-%02d" % i), range(10)))
    numbers = sorted(resp[1]["display_id"] for resp in responses if resp[0] == 201)
    check("10 parallel POST /deals -> all 201", len(numbers) == 10, [resp[0] for resp in responses])
    check("... with unique consecutive numbers %d..%d" % (m + 1, m + 10), numbers == list(range(m + 1, m + 11)), numbers)

    # ================================================================= trash: move, hide, list
    section("Move to the trash")
    T = deal_or_die(create_deal("main", agent=own["id"], stage_id=stage_prepay,
                                products=[{"product_id": product_id, "quantity": 2, "price": 50}],
                                fillers=[{"filler_id": filler_id, "value": "trash field"}]), "main deal")
    TID, TNUM = T["id"], T["display_id"]
    past = datetime.datetime.now() - datetime.timedelta(days=2)
    r = http("POST", "/tasks", {"label": P + "-task", "type_id": task_type_id,
                                "assign_to": {"target": "agent", "id": own["id"]}, "link_to": {"target": "deal", "id": TID},
                                "start_time": past.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                                "end_time": (past + datetime.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z"), "allDay": False,
                                "allow_past": True})  # overdue on purpose (TASK_IN_PAST)
    check("fixture: an overdue task of the deal", r[0] == 201, r)
    body, hdrs = multipart([("files", P + "-own.txt", b"only this deal")])
    r = http("POST", "/deals/%d/files" % TID, raw=body, headers=hdrs)
    check("fixture: a file of the deal", r[0] == 201, r)
    r = http("POST", "/deals/%d/comments" % TID, {"comment": P + " comment"})
    wait_for(lambda: count("SELECT count(*) FROM event WHERE deal_id = %d AND type = 6" % TID), 1)

    lbl = "label=%s&limit=1000" % urllib.parse.quote(P)
    history_sql = ("SELECT (SELECT count(*) FROM deal_stage_record WHERE deal_id = {0}), (SELECT count(*) FROM event WHERE deal_id = {0}), "
                   "(SELECT count(*) FROM task WHERE deal_id = {0}), (SELECT count(*) FROM deal_file WHERE \"dealId\" = {0}), "
                   "(SELECT count(*) FROM deal_product WHERE deal_id = {0}), (SELECT count(*) FROM deal_filler WHERE deal_id = {0}), "
                   "(SELECT count(*) FROM deal_user WHERE \"dealId\" = {0})").format(TID)
    before = sql(history_sql)[0]
    check("the deal has history (stage records, events, task, file, product, field, contact)", all(int(x) > 0 for x in before), before)

    def overdue_stat():
        status, body = http("GET", "/deals/stats?" + lbl)
        return str(body[0].get("deals_with_overdue_tasks")) if status == 200 and body else "HTTP %s" % status

    def analytics_deals(user_id):
        status, body = http("GET", "/analytics/users?from_date=%s&till_date=%s" % (FAR_PAST, FAR_FUTURE))
        rows = body if isinstance(body, list) else (body or {}).get("data", []) if isinstance(body, dict) else []
        return next((r["deal_count"] for r in rows if r.get("id") == user_id), "HTTP %s / no row" % status)

    def desktop_overdue(token):
        status, body = http("GET", "/desktop?from_date=%s&till_date=%s&my_stats=true" % (FAR_PAST, FAR_FUTURE), token=token)
        return int(body["task_stats"]["tasks_overdue"]) if status == 200 else "HTTP %s" % status

    def tasks_of(deal_id):
        status, body = http("GET", "/tasks?deal_id=%d" % deal_id)
        return body["count"] if status == 200 else "HTTP %s" % status

    check("before: the deal is in GET /deals", TID in deal_ids(lbl), deal_ids(lbl))
    check("before: /deals/stats counts its overdue task", overdue_stat() == "1", overdue_stat())
    check("before: /analytics/users counts the deal for its responsible", analytics_deals(own["id"]) == 1, analytics_deals(own["id"]))
    check("before: its task is listed", tasks_of(TID) == 1, tasks_of(TID))
    desk_before = desktop_overdue(own["token"])
    check("before: the desktop of the responsible counts the overdue task", isinstance(desk_before, int) and desk_before >= 1, desk_before)

    r = http("DELETE", "/deals/%d" % TID)
    check("DELETE /deals/:id -> 200", r[0] in (200, 204), r)
    rw = row(TID)
    check("the row stays with deleted_at and deleted_by = who deleted", rw and rw["deleted"] and rw["deleted_by"] == admin_id, rw)
    check("GET /deals/:id -> 404", http("GET", "/deals/%d" % TID)[0] == 404)
    check("gone from GET /deals (list and kanban)", TID not in deal_ids(lbl), deal_ids(lbl))
    check("gone from the search by number", deal_ids("display_id=%d" % TNUM) == [], deal_ids("display_id=%d" % TNUM))
    check("gone from /deals/stats", overdue_stat() == "0", overdue_stat())
    check("gone from /analytics/users", analytics_deals(own["id"]) == 0, analytics_deals(own["id"]))
    check("its tasks are not listed", tasks_of(TID) == 0, tasks_of(TID))
    check("desktop counters skip the task of a deal in the trash", desktop_overdue(own["token"]) == desk_before - 1, (desk_before, desktop_overdue(own["token"])))
    check("nothing linked to the deal is removed", sql(history_sql)[0] == before, (before, sql(history_sql)[0]))

    status, body = http("GET", "/deals/trash?limit=1000&search=" + urllib.parse.quote(P))
    item = next((d for d in body.get("data", []) if d["id"] == TID), None) if status == 200 else None
    check("GET /deals/trash lists it", item is not None, (status, message_of((status, body))))
    check("... with when and who deleted, its stage and responsible",
          item and item.get("deleted_at") and (item.get("deleted_by") or {}).get("id") == admin_id
          and (item.get("stage") or {}).get("id") == stage_prepay and (item.get("agent") or {}).get("id") == own["id"], item)
    check("... no secrets of the user who deleted", item and not {"password", "tg_api_hash"} & set((item.get("deleted_by") or {}).keys()), item and item.get("deleted_by"))
    check("trash search by number finds it", TID in trash_ids(query="&search=%d" % TNUM), trash_ids(query="&search=%d" % TNUM))
    check("active deals are not in the trash", d2["id"] not in trash_ids(query="&search=" + urllib.parse.quote(P)))
    r = http("GET", "/deals/trash?sort[budget]=1")
    check("GET /deals/trash?sort[...] works (200)", r[0] == 200, r)

    # ================================================================= restore
    section("Restore")
    r = http("POST", "/deals/trash/%d/restore" % TID)
    check("POST /deals/trash/:id/restore -> 201, back in its stage", r[0] in (200, 201) and (r[1].get("stage") or {}).get("id") == stage_prepay, r)
    rw = row(TID)
    check("deleted_at and deleted_by are cleared", rw and not rw["deleted"] and rw["deleted_by"] is None, rw)
    status, body = http("GET", "/deals/%d" % TID)
    check("GET /deals/:id -> 200 again, same stage", status == 200 and body["stage"]["id"] == stage_prepay, status)
    check("back in GET /deals", TID in deal_ids(lbl))
    check("back in /deals/stats and /analytics/users", overdue_stat() == "1" and analytics_deals(own["id"]) == 1, (overdue_stat(), analytics_deals(own["id"])))
    check("its task is listed again, desktop counts it again", tasks_of(TID) == 1 and desktop_overdue(own["token"]) == desk_before, (tasks_of(TID), desktop_overdue(own["token"])))
    check("history, tasks, files, products, fields, contacts are all there", sql(history_sql)[0] == before, (before, sql(history_sql)[0]))
    check("restore again -> 404 (not in the trash)", http("POST", "/deals/trash/%d/restore" % TID)[0] == 404)
    check("restore a missing deal -> 404", http("POST", "/deals/trash/99999999/restore")[0] == 404)

    NS = deal_or_die(create_deal("nostage"), "deal without stage")
    http("DELETE", "/deals/%d" % NS["id"])
    records = count("SELECT count(*) FROM deal_stage_record WHERE deal_id = %d" % NS["id"])
    sql("UPDATE deal SET stage_id = NULL WHERE id = %d" % NS["id"])
    r = http("POST", "/deals/trash/%d/restore" % NS["id"])
    check("a deal without a stage is restored into the default stage",
          r[0] in (200, 201) and row(NS["id"])["stage"] == default_stage
          and count("SELECT count(*) FROM deal_stage_record WHERE deal_id = %d" % NS["id"]) == records + 1, (r, row(NS["id"])))

    # ================================================================= rights
    section("Rights")
    mine = deal_or_die(create_deal("own-deal", agent=own["id"]), "deal of the agent")
    theirs = deal_or_die(create_deal("other-deal", agent=other["id"]), "deal of another group")
    admins = deal_or_die(create_deal("admin-deal"), "deal of the admin")

    r = http("DELETE", "/deals/%d" % mine["id"], token=none["token"])
    check("agent with delete=0: DELETE /deals/:id -> 403, deal kept", r[0] == 403 and not row(mine["id"])["deleted"], r)
    check("agent with delete=0: GET /deals/trash -> 403", http("GET", "/deals/trash", token=none["token"])[0] == 403)
    r = http("DELETE", "/deals/%d" % admins["id"], token=own["token"])
    check("agent with delete=1: a deal of somebody else -> 403", r[0] == 403 and not row(admins["id"])["deleted"], r)
    r = http("DELETE", "/deals/%d" % mine["id"], token=own["token"])
    check("agent with delete=1: own deal -> 200, deleted_by = the agent", r[0] in (200, 204) and row(mine["id"])["deleted_by"] == own["id"], r)
    http("DELETE", "/deals/%d" % theirs["id"])
    http("DELETE", "/deals/%d" % admins["id"])
    seen = trash_ids(own["token"], "&search=" + urllib.parse.quote(P))
    check("agent with delete=1 sees only own deals in the trash", isinstance(seen, list) and mine["id"] in seen and theirs["id"] not in seen and admins["id"] not in seen, seen)
    check("agent with delete=0: restore -> 403", http("POST", "/deals/trash/%d/restore" % mine["id"], token=none["token"])[0] == 403)
    check("agent with delete=1: restore a deal of somebody else -> 403", http("POST", "/deals/trash/%d/restore" % admins["id"], token=own["token"])[0] == 403)
    seen = trash_ids(grp["token"], "&search=" + urllib.parse.quote(P))
    check("agent with delete=2 sees deals of the group, not of other groups", isinstance(seen, list) and mine["id"] in seen and theirs["id"] not in seen and admins["id"] not in seen, seen)
    seen = trash_ids(other["token"], "&search=" + urllib.parse.quote(P))
    check("agent with delete=3 sees every deal in the trash", isinstance(seen, list) and {mine["id"], theirs["id"], admins["id"]} <= set(seen), seen)
    seen = trash_ids(mgr["token"], "&search=" + urllib.parse.quote(P))
    check("manager (delete=0 in the matrix) sees every deal in the trash: admin and manager see everything (Access)",
          isinstance(seen, list) and {mine["id"], theirs["id"], admins["id"]} <= set(seen), seen)
    for who, person in (("agent delete=1", own), ("agent delete=2", grp), ("agent delete=3", other), ("manager", mgr)):
        r = http("DELETE", "/deals/trash/%d" % mine["id"], token=person["token"])
        r2 = http("DELETE", "/deals/trash", token=person["token"])
        check("%s: delete for good / empty the trash -> 403" % who, r[0] == 403 and r2[0] == 403 and row(mine["id"]) is not None, (r[0], r2[0]))
    r = http("POST", "/deals/trash/%d/restore" % mine["id"], token=grp["token"])
    check("agent with delete=2: restore a deal of the group -> 201", r[0] in (200, 201) and not row(mine["id"])["deleted"], r)
    r = http("POST", "/deals/trash/%d/restore" % theirs["id"], token=grp["token"])
    check("agent with delete=2: restore a deal of another group -> 403", r[0] == 403 and row(theirs["id"])["deleted"], r)
    r = http("POST", "/deals/trash/%d/restore" % theirs["id"], token=other["token"])
    check("agent with delete=3: restore any deal -> 201", r[0] in (200, 201) and not row(theirs["id"])["deleted"], r)
    r = http("POST", "/deals/trash/%d/restore" % admins["id"], token=mgr["token"])
    check("manager (delete=0 in the matrix): restore a deal of somebody else -> 201", r[0] in (200, 201) and not row(admins["id"])["deleted"], r)
    sql("UPDATE \"user\" SET permissions = NULL WHERE id = %d" % none["id"])
    seen = trash_ids(none["token"])
    check("agent without stored permissions: own deals (the bot's default) -> trash 200", isinstance(seen, list), seen)

    # ================================================================= delete for good
    section("Delete for good (admin)")
    shared_owner = deal_or_die(create_deal("shared-owner"), "deal sharing a file")
    body, hdrs = multipart([("files", P + "-shared.txt", b"shared with another deal")])
    r = http("POST", "/deals/%d/files" % TID, raw=body, headers=hdrs)
    check("fixture: a second file of the deal", r[0] == 201, r)
    own_file = sql("SELECT id, path FROM file WHERE name = '%s-own.txt'" % P)
    shared_file = sql("SELECT id, path FROM file WHERE name = '%s-shared.txt'" % P)
    if not own_file or not shared_file:
        raise SystemExit("uploaded files not found")
    own_file_id, own_path = int(own_file[0][0]), os.path.join(UPLOADS_DIR, os.path.basename(own_file[0][1]))
    shared_id, shared_path = int(shared_file[0][0]), os.path.join(UPLOADS_DIR, os.path.basename(shared_file[0][1]))
    sql("INSERT INTO deal_file (\"dealId\", \"fileId\") VALUES (%d, %d)" % (shared_owner["id"], shared_id))
    http("DELETE", "/deals/%d" % shared_owner["id"])  # the other user of the file is in the trash too
    check("fixture: both files are on disk", os.path.isfile(own_path) and os.path.isfile(shared_path), (own_path, shared_path))
    task_ids = [r[0] for r in sql("SELECT id FROM task WHERE deal_id = %d" % TID)]

    r = http("DELETE", "/deals/trash/%d" % TID)
    check("DELETE /deals/trash/<active deal> -> 404, nothing removed", r[0] == 404 and row(TID) is not None, r)
    http("DELETE", "/deals/%d" % TID)
    r = http("DELETE", "/deals/trash/%d" % TID)
    check("DELETE /deals/trash/:id (admin) -> 200", r[0] in (200, 204), r)
    gone_sql = ("SELECT (SELECT count(*) FROM deal WHERE id = {0}), (SELECT count(*) FROM event WHERE deal_id = {0}), "
                "(SELECT count(*) FROM task WHERE deal_id = {0}), (SELECT count(*) FROM deal_stage_record WHERE deal_id = {0}), "
                "(SELECT count(*) FROM deal_file WHERE \"dealId\" = {0}), (SELECT count(*) FROM deal_product WHERE deal_id = {0}), "
                "(SELECT count(*) FROM deal_filler WHERE deal_id = {0}), (SELECT count(*) FROM deal_user WHERE \"dealId\" = {0}), "
                "(SELECT count(*) FROM trigger_run WHERE deal_id = {0})").format(TID)
    check("the deal and its events, tasks, stage records, file links, products, fields, contacts, trigger runs are gone",
          sql(gone_sql)[0] == ["0"] * 9, sql(gone_sql)[0])
    if task_ids:
        check("events of its tasks are gone", count("SELECT count(*) FROM event WHERE task_id IN (%s)" % ",".join(task_ids)) == 0)
    check("its own file: row and disk file removed", count("SELECT count(*) FROM file WHERE id = %d" % own_file_id) == 0 and not os.path.isfile(own_path),
          (count("SELECT count(*) FROM file WHERE id = %d" % own_file_id), os.path.isfile(own_path)))
    check("a file shared with a deal in the trash is kept (row, link, disk)",
          count("SELECT count(*) FROM deal_file WHERE \"fileId\" = %d AND \"dealId\" = %d" % (shared_id, shared_owner["id"])) == 1
          and os.path.isfile(shared_path), os.path.isfile(shared_path))
    check("not in the trash any more; second delete -> 404", TID not in trash_ids() and http("DELETE", "/deals/trash/%d" % TID)[0] == 404)
    check("trigger_run cascades with the deal (FK ON DELETE CASCADE)",
          count("SELECT count(*) FROM pg_constraint WHERE conrelid = 'trigger_run'::regclass AND confrelid = 'deal'::regclass AND confdeltype = 'c'") == 1)
    m = max_number()
    check("numbers continue after a deletion for good (max + 1)", deal_or_die(create_deal("after-purge"), "deal after purge")["display_id"] == m + 1)

    # empty the trash: only when nothing but this run's rows is there
    foreign = count("SELECT count(*) FROM deal WHERE deleted_at IS NOT NULL AND label NOT LIKE 'AUDIT-%'")
    foreign_audit = count("SELECT count(*) FROM deal WHERE deleted_at IS NOT NULL AND label LIKE 'AUDIT-%%' AND label NOT LIKE '%s-%%'" % P)
    if foreign or foreign_audit:
        skip("DELETE /deals/trash (empty the trash) by the admin", "%d other deal(s) in the trash are not this run's" % (foreign + foreign_audit))
    else:
        mine_in_trash = count("SELECT count(*) FROM deal WHERE deleted_at IS NOT NULL AND label LIKE '%s-%%'" % P)
        r = http("DELETE", "/deals/trash")
        check("DELETE /deals/trash (admin) empties the trash", r[0] == 200 and r[1].get("deleted") == mine_in_trash
              and count("SELECT count(*) FROM deal WHERE deleted_at IS NOT NULL") == 0, (r, mine_in_trash))
        check("... and the shared file goes once its last deal is gone", count("SELECT count(*) FROM file WHERE id = %d" % shared_id) == 0 and not os.path.isfile(shared_path))


def run():
    failed_hard = None
    try:
        main()
    except SystemExit as error:
        failed_hard = str(error)
    except Exception as error:  # a crash is a failed run, but cleanup still happens
        failed_hard = "%s: %s" % (type(error).__name__, error)
    finally:
        section("Cleanup")
        try:
            cleanup()
            left = leftovers()
            check("no AUDIT-trash rows are left in the database", not left, left)
        except Exception as error:
            check("cleanup", False, error)
    if failed_hard:
        check("run completed", False, failed_hard)
    failed = [name for name, ok in results if not ok]
    print("\n%d checks: %d passed, %d failed" % (len(results), len(results) - len(failed), len(failed)))
    for name in failed:
        print("  FAILED: " + name)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    run()
