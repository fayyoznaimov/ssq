#!/usr/bin/env python3
"""
The journal «кто что изменил» and the common «История событий» (src/audit, components/audit).

    source local/dev/env.sh && python3 local/checks/audit_check.py

* Python stdlib only; talks to the API (CRM_API_URL) and the database (CRM_PSQL), like the other sets.
* Admin password is read from the API env file (CRM_ENV_FILE) and never printed.
* Creates only rows named AUDIT-audit-<run> (users, company, contacts, deals, tasks, product, field, stage,
  trigger, files) and removes them at the end (also after a crash), together with the journal rows about
  them (the journal is immutable: only the session switch parisa.audit_purge of the cleanup lets it delete).
* Prints PASS/FAIL/SKIP per check, exits 1 if anything failed.

What is checked
  context     every request writes with its user (actor id and name), source «web», one save group per
              request, the request id of the X-Request-Id answer; a trigger writes as «триггер» with its id
              and the person who set it off (caused_by), and its history entries carry event.source
  changes     deal: created, budget «10 000 → 12 000» (+2 000), responsible, contacts, products added and
              taken off, stage, a note changed and deleted, a file attached and taken off, to the trash and
              back; task: created, changed, done, deleted; company and contact changed; an employee's rights
              (by entity and action) and password (only «изменён»); a field and a recorder token (settings)
  logins      login, a failed login (the e-mail, never the password), logout, «выйти на всех устройствах»
  secrets     no password, bcrypt hash, recorder token or its hash, login token anywhere in the journal
  immutable   UPDATE and DELETE of audit_log are refused by the database
  api         GET /audit (filters: entity, action, deal, actor, period, kind), /audit/meta, the card
              histories; baseline rows are not shown as news
  visibility  an agent: GET /audit -> 403; a deal they cannot see -> 404; their own deal -> 200; a company
              they may see shows no rows of deals they cannot see; another employee's account -> 403
"""
import base64
import datetime
import hashlib
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
P = "AUDIT-audit-" + RUN  # prefix of everything this run creates
MAIL = "audit-audit-" + RUN  # e-mails of this run

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
        line += "   <- " + str(detail)[:500]
    print(line, flush=True)
    return ok


def skip(name, why):
    print("SKIP  %s   (%s)" % (name, why), flush=True)


def section(title):
    print("\n== " + title, flush=True)


def env(key, default=None):
    try:
        with open(ENV_FILE, encoding="utf-8") as fh:
            for line in fh:
                m = re.match(r"\s*%s\s*=\s*(.*)" % re.escape(key), line)
                if not m:
                    continue
                value = m.group(1).strip()
                if value[:1] in ("'", '"'):
                    return value[1:value.index(value[0], 1)]
                return value.split(" #")[0].strip()
    except OSError:
        pass
    if default is not None:
        return default
    raise SystemExit("%s is not set in %s" % (key, ENV_FILE))


def sql(query):
    proc = subprocess.run(PSQL + ["-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"],
                          input=query, capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise RuntimeError("psql failed: %s\n%s" % (proc.stderr.strip(), query[:600]))
    return [line.split("|") for line in proc.stdout.splitlines() if line != ""]


def sql_error(query):
    """The error text of a statement that must fail ('' when it went through)."""
    proc = subprocess.run(PSQL + ["-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"],
                          input=query, capture_output=True, text=True, encoding="utf-8")
    return proc.stderr.strip() if proc.returncode != 0 else ""


def scalar(query):
    rows = sql(query)
    return rows[0][0] if rows else None


def count(query):
    return int(scalar(query) or 0)


def lit(text):
    return "'" + str(text).replace("'", "''") + "'"


ADMIN = None  # admin token


def request(method, path, body=None, token=None, raw=None, headers=None):
    """(status, parsed json | text | None, response headers). Retries while the API restarts (502)."""
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
    if token and token != "-":
        hdrs["Authorization"] = "Bearer " + token
    deadline = time.time() + 120
    while True:
        req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                status, text, got = response.status, response.read().decode("utf-8", "replace"), dict(response.headers)
        except urllib.error.HTTPError as error:
            status, text, got = error.code, error.read().decode("utf-8", "replace"), dict(error.headers or {})
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
        return status, None, got
    try:
        return status, json.loads(text), got
    except ValueError:
        return status, text, got


def http(method, path, body=None, token=None, raw=None, headers=None):
    status, parsed, _ = request(method, path, body, token, raw, headers)
    return status, parsed


def message_of(response):
    body = response[1]
    if isinstance(body, dict):
        message = body.get("message")
        return " ".join(message) if isinstance(message, list) else str(message)
    return str(body)


def multipart(files):
    boundary = "----auditaudit" + RUN
    body = b""
    for name, filename, content in files:
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
                 "Content-Type: text/plain\r\n\r\n" % (boundary, name, filename)).encode("utf-8")
        body += content + b"\r\n"
    body += ("--%s--\r\n" % boundary).encode("utf-8")
    return body, {"Content-Type": "multipart/form-data; boundary=" + boundary}


def wait_for(fn, timeout=10):
    """fn() until it is truthy (the rows written after the answer: logins, sign-outs)."""
    deadline = time.time() + timeout
    value = fn()
    while not value and time.time() < deadline:
        time.sleep(0.4)
        value = fn()
    return value


def token_sub(token):
    payload = token.split(".")[1]
    return int(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["sub"])


def digits(text):
    """«12 000,50» -> «12000,50»: the thin and the no-break spaces of the numbers out."""
    return re.sub(r"\s", "", str(text or ""))


def history(path, token=None, **query):
    """The items of a history page (GET /audit…), or the HTTP status when it is not 200."""
    q = urllib.parse.urlencode({k: v for k, v in query.items() if v is not None}, doseq=True)
    status, body = http("GET", path + ("?" + q if q else ""), token=token)
    if status != 200 or not isinstance(body, dict):
        return status
    return body.get("data") or []


def changes(items, entity=None, action=None):
    if not isinstance(items, list):
        return []
    return [i for i in items if i.get("kind") == "change" and (entity is None or i.get("entity") == entity)
            and (action is None or i.get("action") == action)]


def field(change, label_part):
    for f in change.get("fields") or []:
        if label_part in (f.get("label") or ""):
            return f
    return None


# --------------------------------------------------------------------------- cleanup

CLEANUP_SQL = r"""
CREATE TEMP TABLE _d AS SELECT id FROM deal WHERE label LIKE 'AUDIT-audit-%';
CREATE TEMP TABLE _u AS SELECT id FROM "user" WHERE username LIKE 'AUDIT-audit-%' OR email LIKE 'audit-audit-%';
CREATE TEMP TABLE _c AS SELECT id FROM company WHERE name LIKE 'AUDIT-audit-%';
CREATE TEMP TABLE _t AS SELECT id FROM task WHERE label LIKE 'AUDIT-audit-%' OR deal_id IN (SELECT id FROM _d);
CREATE TEMP TABLE _s AS SELECT id FROM deal_stage WHERE name LIKE 'AUDIT-audit-%';
CREATE TEMP TABLE _f AS SELECT id FROM file WHERE name LIKE 'AUDIT-audit-%';
DELETE FROM event WHERE deal_id IN (SELECT id FROM _d) OR task_id IN (SELECT id FROM _t)
   OR user_id IN (SELECT id FROM _u) OR target_user_id IN (SELECT id FROM _u)
   OR (deal_id IS NULL AND (after_state::text LIKE '%AUDIT-audit-%' OR before_state::text LIKE '%AUDIT-audit-%'));
DELETE FROM task WHERE id IN (SELECT id FROM _t) OR "createdById" IN (SELECT id FROM _u) OR agent_id IN (SELECT id FROM _u);
DELETE FROM deal_stage_record WHERE deal_id IN (SELECT id FROM _d) OR stage_id IN (SELECT id FROM _s);
DELETE FROM trigger_run WHERE deal_id IN (SELECT id FROM _d) OR trigger_id IN (SELECT id FROM "trigger" WHERE deal_stage_id IN (SELECT id FROM _s));
DELETE FROM "trigger" WHERE deal_stage_id IN (SELECT id FROM _s);
DELETE FROM deal_file WHERE "dealId" IN (SELECT id FROM _d) OR "fileId" IN (SELECT id FROM _f);
DELETE FROM file WHERE id IN (SELECT id FROM _f);
DELETE FROM deal_product WHERE deal_id IN (SELECT id FROM _d) OR product_id IN (SELECT id FROM product WHERE name LIKE 'AUDIT-audit-%');
DELETE FROM deal_filler WHERE deal_id IN (SELECT id FROM _d) OR filler_id IN (SELECT id FROM filler WHERE field LIKE 'AUDIT-audit-%');
DELETE FROM deal_user WHERE "dealId" IN (SELECT id FROM _d) OR "userId" IN (SELECT id FROM _u);
DELETE FROM deal WHERE id IN (SELECT id FROM _d);
DELETE FROM deal_stage WHERE id IN (SELECT id FROM _s);
DELETE FROM product WHERE name LIKE 'AUDIT-audit-%';
DELETE FROM filler WHERE field LIKE 'AUDIT-audit-%';
DELETE FROM recorder_token WHERE user_id IN (SELECT id FROM _u);
DELETE FROM bot_account WHERE user_id IN (SELECT id FROM _u);
DELETE FROM user_filler WHERE user_id IN (SELECT id FROM _u);
UPDATE company SET primary_contact_id = NULL WHERE primary_contact_id IN (SELECT id FROM _u);
DELETE FROM notification WHERE company_id IN (SELECT id FROM _c);
DELETE FROM "user" WHERE id IN (SELECT id FROM _u);
DELETE FROM company WHERE id IN (SELECT id FROM _c);
DELETE FROM "group" WHERE name LIKE 'AUDIT-audit-%';
-- the journal rows about this set's rows: only the switch of the cleanup lets them go (trigger audit_log_guard)
BEGIN;
SELECT set_config('parisa.audit_purge', 'on', true);
DELETE FROM audit_log
 WHERE action <> 'baseline'
   AND (deal_id IN (SELECT id FROM _d) OR company_id IN (SELECT id FROM _c) OR contact_id IN (SELECT id FROM _u)
        OR actor_id IN (SELECT id FROM _u)
        OR (entity IN ('user', 'contact', 'auth', 'bot_account', 'messenger') AND entity_id IN (SELECT id FROM _u))
        OR (entity = 'task' AND entity_id IN (SELECT id FROM _t))
        OR (entity = 'recorder_token' AND (after_state ->> 'user_id' IN (SELECT id::text FROM _u) OR before_state ->> 'user_id' IN (SELECT id::text FROM _u)))
        OR coalesce(summary, '') LIKE '%AUDIT-audit-%'
        OR coalesce(after_state::text, '') LIKE '%AUDIT-audit-%' OR coalesce(before_state::text, '') LIKE '%AUDIT-audit-%'
        OR coalesce(meta::text, '') LIKE '%audit-audit-%');
COMMIT;
"""

LEFTOVERS_SQL = r"""
SELECT 'deal', count(*) FROM deal WHERE label LIKE 'AUDIT-audit-%'
UNION ALL SELECT 'task', count(*) FROM task WHERE label LIKE 'AUDIT-audit-%'
UNION ALL SELECT 'user', count(*) FROM "user" WHERE username LIKE 'AUDIT-audit-%' OR email LIKE 'audit-audit-%'
UNION ALL SELECT 'company', count(*) FROM company WHERE name LIKE 'AUDIT-audit-%'
UNION ALL SELECT 'product', count(*) FROM product WHERE name LIKE 'AUDIT-audit-%'
UNION ALL SELECT 'filler', count(*) FROM filler WHERE field LIKE 'AUDIT-audit-%'
UNION ALL SELECT 'stage', count(*) FROM deal_stage WHERE name LIKE 'AUDIT-audit-%'
UNION ALL SELECT 'file', count(*) FROM file WHERE name LIKE 'AUDIT-audit-%'
UNION ALL SELECT 'group', count(*) FROM "group" WHERE name LIKE 'AUDIT-audit-%'
UNION ALL SELECT 'audit_log', count(*) FROM audit_log WHERE action <> 'baseline'
   AND (coalesce(summary, '') LIKE '%AUDIT-audit-%' OR coalesce(after_state::text, '') LIKE '%AUDIT-audit-%'
        OR coalesce(before_state::text, '') LIKE '%AUDIT-audit-%' OR coalesce(meta::text, '') LIKE '%audit-audit-%')
"""


def cleanup():
    for row in sql("SELECT path FROM file WHERE name LIKE 'AUDIT-audit-%'"):
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
    if not count("SELECT count(*) FROM information_schema.tables WHERE table_name = 'audit_log'"):
        raise SystemExit("no table audit_log: migration 1795810000000-audit-log is not applied")
    start_id = int(scalar("SELECT COALESCE(max(id), 0) FROM audit_log") or 0)
    secrets_seen = []  # every secret this run handles: none may appear in the journal

    def journal_rows(where):
        return count("SELECT count(*) FROM audit_log WHERE id > %d AND %s" % (start_id, where))

    # ----------------------------------------------------------------- logins
    section("Logins (entity auth)")
    admin_password = env("ADMIN_PASSWORD")
    secrets_seen.append(admin_password)
    status, body = http("POST", "/auth/login", {"email": "admin@gmail.com", "password": admin_password}, token="-")
    if status not in (200, 201) or not isinstance(body, dict) or "access_token" not in body:
        raise SystemExit("login failed: HTTP %s" % status)
    ADMIN = body["access_token"]
    secrets_seen.append(ADMIN)
    admin_id = token_sub(ADMIN)
    admin_name = scalar("SELECT username FROM \"user\" WHERE id = %d" % admin_id)
    login_row = wait_for(lambda: journal_rows("entity = 'auth' AND action = 'login' AND entity_id = %d AND actor_id = %d "
                                              "AND meta ? 'ip'" % (admin_id, admin_id)))
    if not check("a login is in the journal: who, the address (entity auth, action login)", login_row,
                 "no row: is the journal switched off (AUDIT_LOG=0)?"):
        raise SystemExit("the journal does not record (AUDIT_LOG=0 or the API runs older code)")

    # ----------------------------------------------------------------- fixtures
    section("Fixtures (through the API, so that they are journaled too)")
    task_type_id = int(scalar("SELECT id FROM task_type ORDER BY id LIMIT 1"))
    collection = int(scalar("SELECT id FROM collection WHERE is_active ORDER BY id DESC LIMIT 1"))
    required_deal = [{"filler_id": int(r[0]), "value": "x"} for r in sql("SELECT id FROM filler WHERE target = 'deal' AND is_required AND field NOT LIKE 'AUDIT-%'")]
    required_co = [{"filler_id": int(r[0]), "value": "x"} for r in sql("SELECT id FROM filler WHERE target = 'company' AND is_required AND field NOT LIKE 'AUDIT-%'")]
    required_user = [{"filler_id": int(r[0]), "value": "x"} for r in sql("SELECT id FROM filler WHERE target = 'user' AND is_required AND field NOT LIKE 'AUDIT-%'")]
    required_prod = [{"filler_id": int(r[0]), "value": "x"} for r in sql("SELECT id FROM filler WHERE target = 'product' AND is_required AND field NOT LIKE 'AUDIT-%'")]

    def perms(deal_view, company_view=3):
        return {
            "deal": {"view": deal_view, "create": 3, "update": deal_view, "delete": 0, "export": 0},
            "contact": {"view": 3, "create": 3, "update": 3, "delete": 0, "export": 0},
            "company": {"view": company_view, "create": 3, "update": 1, "delete": 0, "export": 0},
            "task": {"update": 1, "delete": 1},
            "mail": False,
            "file": True,
        }

    group_id = int(scalar("INSERT INTO \"group\" (name) VALUES (%s) RETURNING id" % lit("%s-g" % P)))
    people = {}
    for key, deal_view in (("a", 1), ("b", 1)):
        password = "Audit-%s-%s-Pw" % (RUN, key)
        secrets_seen.append(password)
        email = "%s-%s@example.test" % (MAIL, key)
        status, created = http("POST", "/users", {"email": email, "password": password, "username": "%s-%s" % (P, key),
                                                  "role": "agent", "group_id": group_id, "permissions": perms(deal_view)})
        if status != 201 or not isinstance(created, dict):
            raise SystemExit("cannot create test user %s: %s %s" % (key, status, message_of((status, created))))
        status, login = http("POST", "/auth/login", {"email": email, "password": password}, token="-")
        if status not in (200, 201):
            raise SystemExit("cannot log in as test user %s: %s" % (key, status))
        secrets_seen.append(login["access_token"])
        people[key] = {"id": created["id"], "token": login["access_token"], "email": email, "password": password,
                       "name": "%s-%s" % (P, key)}
    A, B = people["a"], people["b"]

    status, co = http("POST", "/companies", {"name": "%s-co" % P, "is_old": False, "phone": "+998000000077", "fillers": required_co,
                                             "users": [{"username": "%s-contact1" % P, "role": "ctr_agent", "phone": "+998900000071",
                                                        "email": "%s-c1@example.test" % MAIL, "fillers": list(required_user)}]})
    if status != 201 or not isinstance(co, dict):
        raise SystemExit("cannot create the company: %s %s" % (status, message_of((status, co))))
    company_id = co["id"]
    contact1 = int(scalar("SELECT id FROM \"user\" WHERE username = %s" % lit("%s-contact1" % P)))
    contact2 = int(scalar("INSERT INTO \"user\" (username, role, company_id) VALUES (%s, 'ctr_agent', %d) RETURNING id" % (lit("%s-contact2" % P), company_id)))
    status, prod = http("POST", "/products", {"name": "%s-prod" % P, "fillers": required_prod})
    if status != 201:
        raise SystemExit("cannot create the product: %s %s" % (status, message_of((status, prod))))
    product_id = prod["id"]
    stages = {}
    for key in ("s1", "s2", "trg"):
        status, st = http("POST", "/stages", {"name": "%s-%s" % (P, key), "color": "#D5D8DB", "collection_id": collection})
        if status != 201:
            raise SystemExit("cannot create stage %s: %s %s" % (key, status, message_of((status, st))))
        stages[key] = st["id"]

    def new_deal(suffix, agent, budget=10000, token=None):
        payload = {"label": "%s-%s" % (P, suffix), "budget": budget, "agent_id": agent, "company_id": company_id,
                   "ctr_agent_ids": [contact1], "stage_id": stages["s1"], "fillers": list(required_deal), "products": []}
        return request("POST", "/deals", payload, token=token)

    # ----------------------------------------------------------------- deal: created, changed
    section("Deal: who changed what (AUDIT-1, DEAL-4)")
    status, deal, headers = new_deal("deal", admin_id)
    if status != 201:
        raise SystemExit("cannot create the deal: %s %s" % (status, message_of((status, deal))))
    D = deal["id"]
    request_id = next((v for k, v in headers.items() if k.lower() == "x-request-id"), None)
    check("the answer carries X-Request-Id", bool(request_id), headers)
    items = history("/audit/deal/%d" % D, kind="changes")
    created = changes(items, "deal", "insert")
    check("a new deal: «Создание», by the admin, from the web client", created and created[0]["actor"]["id"] == admin_id
          and created[0]["actor"]["name"] == admin_name and created[0]["source"] == "web" and not created[0]["source_label"], created[:1] or items)
    budget = field(created[0], "Бюджет") if created else None
    check("... its attributes by Russian names, the budget as people read it («10 000»)", budget and digits(budget["after"]).startswith("10000"), created[:1])
    if request_id:
        check("... the row carries the request id of the answer", journal_rows("request_id = %s AND entity = 'deal' AND entity_id = %d" % (lit(request_id), D)) >= 1)

    r = http("PATCH", "/deals/%d" % D, {"budget": 12000})
    items = history("/audit/deal/%d" % D, kind="changes")
    upd = [c for c in changes(items, "deal", "update") if field(c, "Бюджет")]
    f = field(upd[0], "Бюджет") if upd else None
    check("PATCH budget -> «Бюджет: 10 000 → 12 000» with the difference +2 000", r[0] == 200 and f and digits(f["before"]).startswith("10000")
          and digits(f["after"]).startswith("12000") and "2" in digits(f.get("delta")) and str(f.get("delta", "")).startswith("+"), (r[0], upd[:1]))

    r = http("PATCH", "/deals/%d" % D, {"agent_id": B["id"]})
    items = history("/audit/deal/%d" % D, kind="changes")
    upd = [c for c in changes(items, "deal", "update") if field(c, "Ответственный")]
    f = field(upd[0], "Ответственный") if upd else None
    check("PATCH responsible -> «Ответственный: <admin> → <B>» by names, not ids", r[0] == 200 and f and f["before"] == admin_name and f["after"] == B["name"], (r[0], upd[:1]))

    r = http("PATCH", "/deals/%d" % D, {"ctr_agent_ids": [contact1, contact2]})
    items = history("/audit/deal/%d" % D, kind="changes")
    upd = [c for c in changes(items, "deal", "update") if field(c, "Контакты")]
    f = field(upd[0], "Контакты") if upd else None
    check("PATCH contacts -> «Контакты» with the added contact by name", r[0] == 200 and f and ("%s-contact2" % P) in (f["after"] or "")
          and ("%s-contact2" % P) in (f.get("delta") or ""), (r[0], upd[:1]))

    r = http("PATCH", "/deals/%d" % D, {"products": [{"product_id": product_id, "quantity": 2, "price": 500}]})
    items = history("/audit/deal/%d" % D, kind="changes")
    added = changes(items, "deal_product", "insert")
    check("a product added -> «Создание: Сделка №… · товар «…»» with quantity and price", r[0] == 200 and added and ("%s-prod" % P) in added[0]["object"]
          and field(added[0], "Количество") and field(added[0], "Цена"), (r[0], added[:1]))
    r = http("PATCH", "/deals/%d" % D, {"products": []})
    items = history("/audit/deal/%d" % D, kind="changes")
    removed = changes(items, "deal_product", "delete")
    check("the product taken off -> «Удаление» of the product of the deal", r[0] == 200 and removed and ("%s-prod" % P) in removed[0]["object"], (r[0], removed[:1]))

    r = http("PATCH", "/deals/%d/stage" % D, {"stage_id": stages["s2"]})
    items = history("/audit/deal/%d" % D, kind="changes")
    moved = [c for c in changes(items, "deal", "update") if field(c, "Этап")]
    f = field(moved[0], "Этап") if moved else None
    check("a stage move -> «Этап: <s1> → <s2>» by names", r[0] == 200 and f and f["before"] == "%s-s1" % P and f["after"] == "%s-s2" % P, (r[0], moved[:1]))

    # a note: its change and its removal (its creation is the history entry itself)
    r = http("POST", "/deals/%d/comments" % D, {"comment": "%s note one" % P})
    note_id = (r[1] or {}).get("id") if r[0] == 201 and isinstance(r[1], dict) else None
    if note_id:
        r = http("PATCH", "/deals/%d/comments/%d" % (D, note_id), {"comment": "%s note two" % P})
        items = history("/audit/deal/%d" % D, kind="changes")
        edited = changes(items, "comment", "update")
        f = field(edited[0], "Текст") if edited else None
        check("a note changed -> «Примечание: Текст: … one → … two»", r[0] in (200, 204) and f and "one" in (f["before"] or "") and "two" in (f["after"] or ""), (r[0], edited[:1]))
        r = http("DELETE", "/deals/%d/comments/%d" % (D, note_id))
        items = history("/audit/deal/%d" % D, kind="changes")
        gone = changes(items, "comment", "delete")
        check("a note deleted -> «Удаление» with its last text and who deleted it", r[0] in (200, 204) and gone and gone[0]["actor"]["id"] == admin_id
              and any("two" in (x.get("before") or "") for x in gone[0]["fields"]), (r[0], gone[:1]))
    else:
        check("POST /deals/:id/comments -> 201 with the id of the note", False, r)

    # a file: attached and taken off (CALL-12)
    body, hdrs = multipart([("files", "%s-file.txt" % P, b"audit file")])
    r = http("POST", "/deals/%d/files" % D, raw=body, headers=hdrs)
    file_id = int(scalar("SELECT id FROM file WHERE name = %s ORDER BY id DESC LIMIT 1" % lit("%s-file.txt" % P)) or 0)
    items = history("/audit/deal/%d" % D, kind="changes")
    check("a file uploaded into the deal -> a row of the file with its name", r[0] in (200, 201) and file_id and
          any(("%s-file.txt" % P) in c["object"] for c in changes(items, "file", "insert") + changes(items, "file_link", "insert")), (r[0], changes(items, "file")[:1]))
    if file_id:
        r = http("DELETE", "/deals/%d/files/%d" % (D, file_id))
        items = history("/audit/deal/%d" % D, kind="changes")
        unlinked = changes(items, "file_link", "delete")
        check("the file taken off the deal -> «Файл убран из сделки» with its name and who did it", r[0] in (200, 204) and unlinked
              and ("%s-file.txt" % P) in unlinked[0]["object"] and unlinked[0]["actor"]["id"] == admin_id, (r[0], unlinked[:1]))

    # the trash: deleted and restored (AUDIT-2)
    r = http("DELETE", "/deals/%d" % D)
    in_trash = journal_rows("entity = 'deal' AND entity_id = %d AND action = 'soft_delete' AND actor_id = %d" % (D, admin_id))
    check("DELETE /deals/:id -> «Удаление в корзину» by the admin", r[0] in (200, 204) and in_trash == 1, (r, in_trash))
    r = http("POST", "/deals/trash/%d/restore" % D)
    back = journal_rows("entity = 'deal' AND entity_id = %d AND action = 'restore' AND actor_id = %d" % (D, admin_id))
    check("restore from the trash -> «Восстановление» by the admin", r[0] in (200, 201) and back == 1, (r[0], back))

    # ----------------------------------------------------------------- the operation, the merged view
    section("One save = one operation; the business events with the changes")
    http("POST", "/deals/%d/comments" % D, {"comment": "%s note that stays" % P})
    items = history("/audit/deal/%d" % D, kind="all", limit=200)
    kinds = {i.get("kind") for i in items} if isinstance(items, list) else set()
    check("kind=all: the events of the deal and the changes together", {"change", "event"} <= kinds, kinds)
    batches = {}
    for c in changes(items):
        batches.setdefault(c["batch"], set()).add(c["actor"]["name"])
    check("every save group has one author", batches and all(len(names) == 1 for names in batches.values()), batches)
    events_only = history("/audit/deal/%d" % D, kind="events")
    check("kind=events: only business events", isinstance(events_only, list) and events_only and all(i["kind"] == "event" for i in events_only), events_only if not isinstance(events_only, list) else len(events_only))

    # ----------------------------------------------------------------- tasks (TASK-5)
    section("Tasks: created, changed, done, deleted (TASK-5)")
    # with the offset: a time without a zone is read in the API's zone (Asia/Karachi), and the runner's clock may be
    # in another one (UTC) -> «in two hours» lands in the past and POST /tasks refuses it (TASK_IN_PAST)
    now = datetime.datetime.now().astimezone()
    r = http("POST", "/tasks", {"label": "%s-task" % P, "type_id": task_type_id, "assign_to": {"target": "agent", "id": admin_id},
                                "link_to": {"target": "deal", "id": D}, "start_time": (now + datetime.timedelta(hours=2)).isoformat(timespec="seconds"),
                                "end_time": (now + datetime.timedelta(hours=3)).isoformat(timespec="seconds"), "allDay": False})
    task_id = (r[1] or {}).get("id") if r[0] == 201 and isinstance(r[1], dict) else None
    if task_id:
        check("a task -> «Создание» of the task in the deal's history",
              any(c["entity_id"] == str(task_id) for c in changes(history("/audit/deal/%d" % D, kind="changes"), "task", "insert")))
        r = http("PATCH", "/tasks/%d" % task_id, {"label": "%s-task renamed" % P})
        rows = changes(history("/audit/deal/%d" % D, kind="changes"), "task", "update")
        f = field(rows[0], "Задача") if rows else None
        check("a task changed -> «Задача: … → … renamed» (the creation entry is not overwritten)", r[0] == 200 and f and "renamed" in (f["after"] or ""), (r[0], rows[:1]))
        r = http("PATCH", "/tasks/%d/close" % task_id, {"result": "%s done" % P})
        rows = [c for c in changes(history("/audit/deal/%d" % D, kind="changes"), "task", "update") if c["action_text"] == "Задача выполнена"]
        check("a task closed -> «Задача выполнена» with the result", r[0] in (200, 201) and rows and field(rows[0], "Результат"), (r[0], rows[:1]))
        r = http("DELETE", "/tasks/%d" % task_id)
        gone = journal_rows("entity = 'task' AND entity_id = %d AND action = 'delete' AND actor_id = %d" % (task_id, admin_id))
        check("a task deleted -> «Удаление» with its last state (it was a hard delete without a trace)", r[0] in (200, 204) and gone == 1, (r[0], gone))
    else:
        check("POST /tasks -> 201", False, r)

    # ----------------------------------------------------------------- company and contact (AUDIT-3)
    section("Company and contact: one row per change, in their own histories (AUDIT-3)")
    # an ИНН of this run: one company per ИНН (409 when another live company has it, e.g. a QA fixture with 123456789)
    inn = next(x for x in ("990%s%03d" % (RUN, n) for n in range(1000))
               if not count("SELECT count(*) FROM company WHERE regexp_replace(coalesce(inn, ''), '[^0-9]', '', 'g') = %s" % lit(x)))
    r = http("PATCH", "/companies/%d" % company_id, {"name": "%s-co" % P, "inn": inn, "fillers": [], "fillers_create": []})
    rows = [c for c in changes(history("/audit/company/%d" % company_id, kind="changes"), "company", "update") if field(c, "ИНН")]
    check("PATCH company -> «Компания «…»: ИНН: — → <ИНН>» once (not once per deal)", r[0] == 200 and len(rows) == 1
          and field(rows[0], "ИНН")["after"] == inn, (r, rows[:2]))
    r = http("PATCH", "/users/%d" % contact1, {"username": "%s-contact1" % P, "role": "ctr_agent", "phone": "+998900000072",
                                               "email": "%s-c1@example.test" % MAIL, "fillers": [], "fillers_create": list(required_user)})
    rows = [c for c in changes(history("/audit/user/%d" % contact1, kind="changes"), "contact", "update") if field(c, "Телефон")]
    check("PATCH contact -> «Контакт «…»: Телефон: … → …» in the contact's history", r[0] in (200, 201) and rows, (r[0], rows[:1]))

    # ----------------------------------------------------------------- employees: rights, password, logins (AUDIT-4, ACL-10)
    section("Employees: rights, password, logins (AUDIT-4, ACL-10)")
    r = http("PATCH", "/users/%d" % B["id"], {"email": B["email"], "username": B["name"], "role": "agent", "group_id": group_id, "permissions": perms(3)})
    rows = changes(history("/audit/user/%d" % B["id"], kind="changes"), "user", "permissions")
    f = next((x for x in (rows[0]["fields"] if rows else []) if "Сделки" in x["label"] and "просмотр" in x["label"]), None)
    check("rights changed -> «Изменение прав: Права · Сделки — просмотр: свои → все»", r[0] == 200 and f and f["before"] == "свои" and f["after"] == "все", (r[0], rows[:1]))
    new_password = "Audit-%s-New-Pw" % RUN
    secrets_seen.append(new_password)
    r = http("PATCH", "/users/%d" % B["id"], {"email": B["email"], "username": B["name"], "role": "agent", "group_id": group_id,
                                              "permissions": perms(3), "password": new_password})
    rows = [c for c in changes(history("/audit/user/%d" % B["id"], kind="changes"), "user") if field(c, "Пароль")]
    check("a new password -> «Пароль: изменён», no value", r[0] == 200 and rows and field(rows[0], "Пароль")["after"] == "изменён"
          and not field(rows[0], "Пароль")["before"], (r[0], rows[:1]))
    signed_out = wait_for(lambda: journal_rows("entity = 'auth' AND action = 'logout' AND entity_id = %d AND meta ->> 'everywhere' = 'true'" % B["id"]))
    check("... and «Выход на всех устройствах» of that employee", signed_out)

    status, body = http("POST", "/auth/login", {"email": A["email"], "password": "wrong-%s" % RUN}, token="-")
    secrets_seen.append("wrong-%s" % RUN)
    failed = wait_for(lambda: journal_rows("entity = 'auth' AND action = 'login_failed' AND meta ->> 'email' = %s AND actor_id IS NULL" % lit(A["email"])))
    check("a failed login -> «Неудачная попытка входа» with the e-mail and the address, no author", status == 401 and failed, (status, failed))
    r = http("POST", "/audit/logout", {}, token=A["token"])
    out = journal_rows("entity = 'auth' AND action = 'logout' AND entity_id = %d AND actor_id = %d" % (A["id"], A["id"]))
    check("POST /audit/logout -> «Выход из CRM» of the user", r[0] in (200, 204) and out >= 1, (r[0], out))
    items = history("/audit/user/%d" % A["id"])
    check("the employee's card: logins, logout, its creation", isinstance(items, list)
          and {"login", "login_failed", "logout"} <= {c["action"] for c in changes(items, "auth")}, items if not isinstance(items, list) else [c["action"] for c in changes(items)])
    mine = history("/audit/user/%d" % admin_id, **{"as": "actor", "kind": "changes", "limit": 200})
    check("?as=actor: what the employee did (the admin's changes of this run)", isinstance(mine, list) and any(c.get("deal_id") == D for c in changes(mine)), mine if not isinstance(mine, list) else len(mine))

    # ----------------------------------------------------------------- settings (AUDIT-14)
    section("Settings: a field, a recorder token (AUDIT-14, ACL-10)")
    r = http("POST", "/fillers", {"target": "deal", "field": "%s-field" % P, "is_required": False})
    filler_id = (r[1] or {}).get("id") if r[0] == 201 and isinstance(r[1], dict) else None
    if filler_id:
        r2 = http("DELETE", "/fillers/%d" % filler_id)
        rows = history("/audit", entity="filler", q=P, kind="changes")
        check("a field created and deleted -> both in the journal (GET /audit?entity=filler&q=…)", r2[0] in (200, 204) and isinstance(rows, list)
              and {"insert", "delete"} <= {c["action"] for c in changes(rows, "filler")}, rows if not isinstance(rows, list) else [c["action"] for c in rows])
    else:
        check("POST /fillers -> 201", False, r)
    r = http("POST", "/calls/tokens", {"user_id": A["id"]})
    token_value = (r[1] or {}).get("token") if r[0] == 201 and isinstance(r[1], dict) else None
    if token_value:
        secrets_seen.append(token_value)
        secrets_seen.append(hashlib.sha256(token_value.encode("utf-8")).hexdigest())
        secrets_seen.extend(row[0] for row in sql("SELECT token_hash FROM recorder_token WHERE user_id = %d" % A["id"]) if row[0])
        r2 = http("DELETE", "/calls/tokens/%d" % A["id"])
        issued = journal_rows("entity = 'recorder_token' AND action = 'insert' AND actor_id = %d" % admin_id)
        revoked = journal_rows("entity = 'recorder_token' AND action = 'update' AND changes ? 'revoked_at' AND actor_id = %d" % admin_id)
        check("a recorder token issued and revoked -> both in the journal, who did it", r2[0] == 200 and issued >= 1 and revoked >= 1, (issued, revoked))
    else:
        skip("recorder token", "POST /calls/tokens -> %s" % r[0])

    # ----------------------------------------------------------------- automation (AUDIT-11, TRG-5)
    section("Automation: a trigger writes as «триггер», not as the person (AUDIT-11, TRG-5)")
    r = http("POST", "/stages/%d/triggers" % stages["trg"], {
        "type": 0, "deal_filters": [], "apply_when": {"when": "right_away", "after_minutes": 0},
        "create_task_data": {"label": "%s-trg-task" % P, "type_id": task_type_id, "responsible": {"user": "currently_assigned"},
                             "end_time_in_minutes": 60, "all_day": False}})
    trigger_id = int(scalar("SELECT id FROM \"trigger\" WHERE deal_stage_id = %d ORDER BY id DESC LIMIT 1" % stages["trg"]) or 0)
    check("a trigger created -> «Создание: Триггер №…» by the admin", r[0] == 201 and trigger_id and
          journal_rows("entity = 'trigger' AND entity_id = %d AND action = 'insert' AND actor_id = %d" % (trigger_id, admin_id)) == 1, r)
    if trigger_id:
        http("PATCH", "/deals/%d/stage" % D, {"stage_id": stages["trg"]})
        task_row = wait_for(lambda: scalar("SELECT id FROM task WHERE deal_id = %d AND label LIKE %s ORDER BY id DESC LIMIT 1" % (D, lit("%%%s-trg-task%%" % P))), timeout=20)
        rows = [c for c in changes(history("/audit/deal/%d" % D, kind="changes"), "task", "insert") if task_row and c["entity_id"] == str(task_row)]
        ok = rows and rows[0]["source"] == "trigger" and rows[0]["actor"]["automation"] and rows[0]["actor"]["id"] is None \
            and "Триггер" in rows[0]["actor"]["name"] and rows[0]["source_label"] == "триггер" and rows[0]["caused_by"] == admin_name
        check("the trigger's task: source «триггер» №%d, no person as the author, the admin as the one who set it off" % trigger_id, ok, rows[:1] or task_row)
        if task_row:
            ev = sql("SELECT source, source_ref FROM event WHERE task_id = %s AND type = 6 ORDER BY id DESC LIMIT 1" % task_row)
            check("... and its history entry carries event.source = trigger, source_ref = trigger:<id>",
                  ev and ev[0] == ["trigger", "trigger:%d" % trigger_id], ev)

    # ----------------------------------------------------------------- visibility (src/auth/access.ts)
    section("Visibility: the same as the card itself")
    check("an agent: GET /audit (the journal page) -> 403", http("GET", "/audit", token=A["token"])[0] == 403)
    check("an agent: the history of a deal they cannot see -> 404", http("GET", "/audit/deal/%d" % D, token=A["token"])[0] == 404)
    status, own, _ = new_deal("own", A["id"], token=A["token"])
    if status == 201:
        own_items = history("/audit/deal/%d" % own["id"], token=A["token"], kind="changes")
        check("an agent: the history of their own deal -> 200 with its creation", isinstance(own_items, list) and changes(own_items, "deal", "insert"), own_items if not isinstance(own_items, list) else len(own_items))
        co_items = history("/audit/company/%d" % company_id, token=A["token"], kind="all", limit=200)
        check("an agent: the company's history shows no row of the deal they cannot see", isinstance(co_items, list)
              and not [i for i in co_items if (i.get("deal_id") == D) or ((i.get("event") or {}).get("deal") or {}).get("id") == D]
              and any(i.get("deal_id") == own["id"] for i in co_items if i.get("kind") == "change"), co_items if not isinstance(co_items, list) else len(co_items))
    else:
        check("an agent creates their own deal -> 201", False, (status, own))
    check("an agent: another employee's account history -> 403", http("GET", "/audit/user/%d" % B["id"], token=A["token"])[0] == 403)
    check("an agent: their own account history -> 200", isinstance(history("/audit/user/%d" % A["id"], token=A["token"]), list))
    check("an agent: GET /audit/meta -> 200 (the names of the filters)", http("GET", "/audit/meta", token=A["token"])[0] == 200)

    # ----------------------------------------------------------------- the journal page and its filters
    section("GET /audit: filters, meta, baseline")
    rows = history("/audit", entity="deal", action="update", deal_id=D, limit=100)
    check("entity=deal&action=update&deal_id=D -> only updates of that deal", isinstance(rows, list) and len(rows) >= 3
          and all(i["kind"] == "change" and i["entity"] == "deal" and i["action"] == "update" and i["deal_id"] == D for i in rows),
          rows if not isinstance(rows, list) else [(i.get("kind"), i.get("entity"), i.get("action")) for i in rows[:5]])
    today = datetime.date.today().isoformat()
    rows = history("/audit", actor_id=B["id"], kind="changes", **{"from": today, "till": today})
    check("actor_id + period (from/till as days) -> only that employee's rows of today", isinstance(rows, list)
          and all(i["actor"]["id"] == B["id"] for i in rows), rows if not isinstance(rows, list) else rows[:2])
    rows = history("/audit", source="trigger", deal_id=D, kind="changes")
    check("source=trigger -> only the trigger's rows", isinstance(rows, list) and rows and all(i["source"] == "trigger" for i in rows), rows if not isinstance(rows, list) else len(rows))
    status, meta = http("GET", "/audit/meta")
    names = {e["key"]: e["name"] for e in (meta or {}).get("entities", [])} if status == 200 else {}
    check("GET /audit/meta: Russian names of objects, changes and sources", status == 200 and names.get("deal") == "Сделка"
          and any(a["key"] == "permissions" for a in meta.get("actions", [])) and any(s["key"] == "trigger" and s["name"] == "триггер" for s in meta.get("sources", [])), meta)
    baseline = count("SELECT count(*) FROM audit_log WHERE action = 'baseline'")
    if baseline:
        rows = history("/audit", kind="changes", limit=200)
        check("the baseline (the state when the journal came) is kept and not shown as news", isinstance(rows, list) and not [i for i in rows if i["action"] == "baseline"])
    else:
        skip("baseline", "the journal was switched on over an empty database")

    # ----------------------------------------------------------------- immutable, secrets
    section("The journal is immutable and holds no secrets")
    some = scalar("SELECT max(id) FROM audit_log WHERE id > %d" % start_id)
    error = sql_error("UPDATE audit_log SET summary = summary WHERE id = %s;" % some)
    check("UPDATE audit_log -> refused by the database (trigger audit_log_guard)", "нельзя редактировать" in error or "permission denied" in error, error or "went through")
    error = sql_error("DELETE FROM audit_log WHERE id = %s;" % some)
    check("DELETE audit_log (without the switch of the cleanup) -> refused", "очистка по сроку" in error or "permission denied" in error, error or "went through")
    text = "coalesce(changes::text, '') || coalesce(before_state::text, '') || coalesce(after_state::text, '') || coalesce(meta::text, '') || coalesce(summary, '')"
    hashes = journal_rows("(%s) ~ '\\$2[aby]\\$[0-9]{2}\\$'" % text)
    check("no bcrypt hash in the journal", hashes == 0, hashes)
    found = [s[:6] + "…" for s in secrets_seen if s and journal_rows("strpos(%s, %s) > 0" % (text, lit(s)))]
    check("no password, login token, recorder token or its hash in the journal (%d secrets checked)" % len(secrets_seen), not found, found)
    keys = journal_rows("(before_state ?| array['password', 'token_hash', 'tg_api_hash', 'path', 'sign'] OR after_state ?| array['password', 'token_hash', 'tg_api_hash', 'path', 'sign'])")
    check("no secret column kept in the states of the objects", keys == 0, keys)
    masked = journal_rows("changes ? 'password' AND changes -> 'password' <> '[null, \"***\"]'::jsonb AND changes -> 'password' <> '[\"***\", \"***\"]'::jsonb AND changes -> 'password' <> '[\"***\", null]'::jsonb")
    check("a changed password is only «***» in the diff", masked == 0, masked)


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
            check("no AUDIT-audit rows are left in the database (the journal rows about them included)", not left, left)
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
