#!/usr/bin/env python3
"""
Regression checks for companies, contacts, products, custom fields and the desktop.

    py local/checks/modules_check.py

* Python stdlib only.
* Talks to the LOCAL stack only: API http://localhost:8080/api/v1, database through
  `docker compose -f docker-compose.local.yml exec crm-db psql` (fixtures, assertions on rows, cleanup).
  With the CRM_* variables from local/dev/env.sh it talks to the dev copy on the server instead
  (CRM_API_URL, CRM_PSQL, CRM_ENV_FILE).
* Admin password is read from parisahon-api/.env and never printed.
* Everything it creates is prefixed with AUDIT- and is removed at the end, also when the run
  is interrupted. A run starts with the same cleanup.
* Prints PASS/FAIL per check, exits 1 if anything failed.
"""
import base64
import datetime
import json
import os
import re
import secrets
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
CLIENT = os.path.join(ROOT, "parisahon-client", "app")
BASE = os.environ.get("CRM_API_URL", "http://localhost:8080/api/v1").rstrip("/")
# psql of the local database: CRM_PSQL (dev copy: local/dev/psql.js) or the docker container
PSQL = (shlex.split(os.environ["CRM_PSQL"]) if os.environ.get("CRM_PSQL") else
        ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])

RUN = str(int(time.time()))[-6:]
P = "AUDIT-mod-" + RUN  # prefix of everything this run creates

EVENT_NEW_COMMENT = 5

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


def section(title):
    print("\n== " + title, flush=True)


def env(key):
    with open(ENV_FILE, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"\s*%s\s*=\s*(.*)" % re.escape(key), line)
            if m:
                return m.group(1).strip().strip('"').strip("'")
    raise SystemExit("%s is not set in %s" % (key, ENV_FILE))


def sql(query):
    """Runs SQL in the local database, returns rows as lists of strings."""
    proc = subprocess.run(
        PSQL + ["-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"],
        input=query, capture_output=True, text=True, encoding="utf-8",
    )
    if proc.returncode != 0:
        raise RuntimeError("psql failed: %s\n%s" % (proc.stderr.strip(), query))
    return [line.split("|") for line in proc.stdout.splitlines() if line != ""]


def scalar(query):
    rows = sql(query)
    return rows[0][0] if rows else None


def count(query):
    return int(scalar(query) or 0)


TOKEN = None


def http(method, path, body=None, token=None, auth=True):
    """Returns (status, parsed json | text | None). Retries while the API restarts (nest --watch)."""
    url = BASE + urllib.parse.quote(path, safe="/?=&[]%:,+-_.~")
    hdrs = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    bearer = token or (TOKEN if auth else None)
    if bearer:
        hdrs["Authorization"] = "Bearer " + bearer

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


def login(email, password):
    status, body = http("POST", "/auth/login", {"email": email, "password": password}, auth=False)
    if status not in (200, 201) or not isinstance(body, dict) or "access_token" not in body:
        raise SystemExit("login failed for %s: HTTP %s" % (email, status))
    return body["access_token"]


def user_id_of(token):
    payload = token.split(".")[1]
    return int(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["sub"])


def client_file(relative):
    with open(os.path.join(CLIENT, relative), encoding="utf-8") as fh:
        return fh.read()


def ts(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S")


# --------------------------------------------------------------------------- cleanup

CLEANUP_SQL = r"""
CREATE TEMP TABLE _d AS SELECT id FROM deal WHERE label LIKE 'AUDIT-%';
CREATE TEMP TABLE _t AS SELECT id FROM task WHERE label LIKE 'AUDIT-%' OR deal_id IN (SELECT id FROM _d);
CREATE TEMP TABLE _c AS SELECT id FROM company WHERE name LIKE 'AUDIT-%';
CREATE TEMP TABLE _u AS SELECT id FROM "user" WHERE username LIKE 'AUDIT-%';
CREATE TEMP TABLE _p AS SELECT id FROM product WHERE name LIKE 'AUDIT-%';

DELETE FROM notification WHERE company_id IN (SELECT id FROM _c);
DELETE FROM event WHERE deal_id IN (SELECT id FROM _d) OR task_id IN (SELECT id FROM _t)
   OR user_id IN (SELECT id FROM _u) OR target_user_id IN (SELECT id FROM _u)
   OR (deal_id IS NULL AND (after_state::text LIKE '%AUDIT-%' OR before_state::text LIKE '%AUDIT-%'));
DELETE FROM bot_reminder WHERE task_id IN (SELECT id FROM _t);
DELETE FROM task WHERE id IN (SELECT id FROM _t);
DELETE FROM task_type WHERE name LIKE 'AUDIT-%';
DELETE FROM deal_stage_record WHERE deal_id IN (SELECT id FROM _d);
DELETE FROM deal_file WHERE "dealId" IN (SELECT id FROM _d);
DELETE FROM file WHERE name LIKE 'AUDIT-%';
DELETE FROM recording WHERE path LIKE 'AUDIT-%';
DELETE FROM deal_user WHERE "dealId" IN (SELECT id FROM _d) OR "userId" IN (SELECT id FROM _u);
DELETE FROM deal_product WHERE deal_id IN (SELECT id FROM _d) OR product_id IN (SELECT id FROM _p);
DELETE FROM deal WHERE id IN (SELECT id FROM _d);
DELETE FROM user_filler WHERE user_id IN (SELECT id FROM _u);
DELETE FROM company_filler WHERE company_id IN (SELECT id FROM _c);
DELETE FROM product_filler WHERE product_id IN (SELECT id FROM _p);
DELETE FROM filler WHERE field LIKE 'AUDIT-%';
DELETE FROM bot_account WHERE user_id IN (SELECT id FROM _u);
DELETE FROM bot_link_code WHERE user_id IN (SELECT id FROM _u);
DELETE FROM "user" WHERE id IN (SELECT id FROM _u);
DELETE FROM product WHERE id IN (SELECT id FROM _p);
DELETE FROM company WHERE id IN (SELECT id FROM _c);
"""

LEFTOVERS_SQL = r"""
SELECT 'deal', count(*) FROM deal WHERE label LIKE 'AUDIT-%'
UNION ALL SELECT 'task', count(*) FROM task WHERE label LIKE 'AUDIT-%'
UNION ALL SELECT 'company', count(*) FROM company WHERE name LIKE 'AUDIT-%'
UNION ALL SELECT 'user', count(*) FROM "user" WHERE username LIKE 'AUDIT-%'
UNION ALL SELECT 'product', count(*) FROM product WHERE name LIKE 'AUDIT-%'
UNION ALL SELECT 'filler', count(*) FROM filler WHERE field LIKE 'AUDIT-%'
UNION ALL SELECT 'file', count(*) FROM file WHERE name LIKE 'AUDIT-%'
UNION ALL SELECT 'event', count(*) FROM event WHERE after_state::text LIKE '%AUDIT-%' OR before_state::text LIKE '%AUDIT-%'
"""


def cleanup():
    sql(CLEANUP_SQL)


def leftovers():
    return {name: int(n) for name, n in sql(LEFTOVERS_SQL) if int(n) > 0}


# --------------------------------------------------------------------------- the run

def main():
    global TOKEN

    cleanup()
    TOKEN = login("admin@gmail.com", env("ADMIN_PASSWORD"))
    admin_id = user_id_of(TOKEN)
    now = datetime.datetime.now()

    # ----------------------------------------------------------------- fixtures
    stage_id = int(scalar("SELECT s.id FROM deal_stage s JOIN collection c ON c.id = s.collection_id WHERE c.is_active = true ORDER BY s.\"order\", s.id LIMIT 1"))
    task_type_id = int(scalar("SELECT id FROM task_type ORDER BY id LIMIT 1"))
    group_id = int(scalar('SELECT id FROM "group" ORDER BY id LIMIT 1'))

    company_id = int(scalar("INSERT INTO company (name, email, phone, is_old, created_by) VALUES ('%s-co', 'audit-mod-%s@example.test', '+998000000001', false, %d) RETURNING id" % (P, RUN, admin_id)))
    company_empty = int(scalar("INSERT INTO company (name, is_old, created_by) VALUES ('%s-co-empty', false, %d) RETURNING id" % (P, admin_id)))
    company_deleted = int(scalar("INSERT INTO company (name, is_old, created_by, deleted_at) VALUES ('%s-co-del', false, %d, now()) RETURNING id" % (P, admin_id)))

    contact_id = int(scalar("INSERT INTO \"user\" (username, email, phone, role, company_id) VALUES ('%s-contact Иванов', 'audit-mod-contact-%s@example.test', '+998900000001', 'ctr_agent', %d) RETURNING id" % (P, RUN, company_id)))
    contact_deleted = int(scalar("INSERT INTO \"user\" (username, email, role, company_id, deleted_at) VALUES ('%s-contact-del', 'audit-mod-del-%s@example.test', 'ctr_agent', %d, now()) RETURNING id" % (P, RUN, company_id)))
    contact_orphan = int(scalar("INSERT INTO \"user\" (username, email, role, company_id) VALUES ('%s-contact-orphan', 'audit-mod-orphan-%s@example.test', 'ctr_agent', %d) RETURNING id" % (P, RUN, company_deleted)))

    f_user = int(scalar("INSERT INTO filler (target, field) VALUES ('user', '%s-должность') RETURNING id" % P))
    uf_id = int(scalar("INSERT INTO user_filler (user_id, filler_id, value) VALUES (%d, %d, 'Директор') RETURNING id" % (contact_id, f_user)))

    def new_deal(label, agent_id="NULL", company="%d" % company_id, created=None):
        created_sql = "'%s'" % ts(created) if created else "now()"
        return int(scalar(
            "INSERT INTO deal (label, display_id, budget, stage_id, agent_id, created_by, company_id, created_at) "
            "VALUES ('%s', %d, 100, %d, %s, %d, %s, %s) RETURNING id"
            % (label, 900000000 + secrets.randbelow(90000000), stage_id, agent_id, admin_id, company, created_sql)))

    deal1 = new_deal("%s-deal-1" % P)
    deal2 = new_deal("%s-deal-2" % P)
    sql('INSERT INTO deal_user ("dealId", "userId") VALUES (%d, %d)' % (deal1, contact_id))
    for deal in (deal1, deal2):
        sql("INSERT INTO event (type, deal_id, user_id, after_state) VALUES (%d, %d, %d, '{\"data\": {\"comment\": \"%s-comment-%d\"}}')"
            % (EVENT_NEW_COMMENT, deal, admin_id, P, deal))
    file_id = int(scalar("INSERT INTO file (name, path, size, \"from\", uploaded_by) VALUES ('%s-file.txt', 'uploads/%s-file.txt', 3, 'uploads', %d) RETURNING id" % (P, P, admin_id)))
    sql('INSERT INTO deal_file ("fileId", "dealId") VALUES (%d, %d)' % (file_id, deal1))

    product_id = int(scalar("INSERT INTO product (name, created_by) VALUES ('%s-prod Пижама', %d) RETURNING id" % (P, admin_id)))
    sql("INSERT INTO deal_product (deal_id, product_id, quantity, price) VALUES (%d, %d, 2, 300)" % (deal1, product_id))

    # an agent (sales manager) of their own, for the personal desktop numbers
    permissions = {
        "deal": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
        "contact": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
        "company": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
        "task": {"update": 3, "delete": 3},
        "mail": True,
        "file": True,
    }
    agent = {"email": "audit-mod-agent-%s@example.test" % RUN, "password": secrets.token_urlsafe(12)}
    status, body = http("POST", "/users", {
        "email": agent["email"], "password": agent["password"], "username": "%s-agent" % P,
        "role": "agent", "group_id": group_id, "permissions": permissions,
    })
    if status != 201 or not isinstance(body, dict):
        raise SystemExit("cannot create the test agent: %s %s" % (status, body))
    agent["id"] = body["id"]
    agent["token"] = login(agent["email"], agent["password"])

    # ================================================================= companies
    section("Company feed (GET /companies/:id/events)")
    status, body = http("GET", "/companies/%d/events?limit=25&sort[id]=-1" % company_id)
    check("feed of a company with two deals -> 200", status == 200, "%s %s" % (status, message_of((status, body))))
    comments = sorted(e.get("after_state", {}).get("data", {}).get("comment") for e in (body or {}).get("data", [])) if status == 200 else []
    check("the feed holds the events of BOTH deals (was: field changes of the first deal only)",
          comments == sorted(["%s-comment-%d" % (P, deal1), "%s-comment-%d" % (P, deal2)]), comments)
    check("count = 2", status == 200 and body.get("count") == 2, (body or {}).get("count"))

    status, body = http("GET", "/companies/%d/events" % company_empty)
    check("company without deals -> 200 and an empty feed (was 404)", status == 200 and body.get("count") == 0 and body.get("data") == [],
          "%s %s" % (status, message_of((status, body))))
    status, body = http("GET", "/companies/999999999/events")
    check("unknown company -> 404", status == 404, status)
    status, body = http("GET", "/companies/%d/events?limit=25" % company_id)
    deals_of = sorted((e.get("deal") or {}).get("id") for e in (body or {}).get("data", [])) if status == 200 else []
    check("the feed says which deal an event is of (two deals in one feed)", deals_of == sorted([deal1, deal2]), deals_of)
    # a task of the company itself (no deal) is in its feed: it was shown once and gone after a reload
    status, body = http("POST", "/tasks", {
        "label": "%s-company-task" % P, "type_id": task_type_id,
        "assign_to": {"target": "agent", "id": admin_id}, "link_to": {"target": "company", "id": company_id},
        "start_time": now.strftime("%Y-%m-%dT%H:%M:%S"), "end_time": (now + datetime.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S"),
        "allDay": False,
    })
    check("a task linked to the company -> 201", status == 201, "%s %s" % (status, message_of((status, body))))
    company_task = body.get("id") if status == 201 and isinstance(body, dict) else None

    def company_feed_has_task():
        st, bd = http("GET", "/companies/%d/events?limit=25" % company_id)
        return st == 200 and any(e.get("type") == 6 and (e.get("after_state") or {}).get("data", {}).get("id") == company_task
                                 for e in (bd or {}).get("data", []))
    deadline = time.time() + 8
    seen = company_feed_has_task()
    while not seen and time.time() < deadline:
        time.sleep(0.5)
        seen = company_feed_has_task()
    check("... and its «Задача поставлена» is in the company feed", company_task and seen, company_task)

    section("Contact feed (GET /users/:id/events, /users/:id/deals)")
    status, body = http("GET", "/users/%d/events?limit=25" % contact_id, token=agent["token"])
    comments = [((e.get("after_state") or {}).get("data") or {}).get("comment") for e in (body or {}).get("data", [])] if status == 200 else []
    check("an agent reads the feed of a contact -> 200 with the events of its deal (was 403 for every contact)",
          status == 200 and "%s-comment-%d" % (P, deal1) in comments, (status, comments))
    status, body = http("GET", "/users/%d/deals" % contact_id, token=agent["token"])
    check("... and the deals of the contact -> 200", status == 200 and any(d.get("id") == deal1 for d in (body or [])), status)
    status, _ = http("GET", "/users/%d/events" % admin_id, token=agent["token"])
    check("... but not the history of another employee -> 403", status == 403, status)
    status, _ = http("GET", "/users/%d/events" % agent["id"], token=agent["token"])
    check("... their own history -> 200", status == 200, status)

    section("Feeds within the rights: «свои сделки» and the mail switch (ACL-4, MAIL-9)")
    # deal2 becomes the agent's; a letter in deal1 (not the agent's) and one in deal2
    sql("UPDATE deal SET agent_id = %d WHERE id = %d" % (agent["id"], deal2))
    mail_events = [int(scalar(
        "INSERT INTO event (type, deal_id, user_id, outgoing, after_state) VALUES (9, %d, %d, false, "
        "jsonb_build_object('data', jsonb_build_object('id', NULL, 'subject', '%s-mail-%d', 'body', '<p>secret</p>', 'outgoing', false, 'to', '[]'::jsonb, 'files', '[]'::jsonb))) RETURNING id"
        % (deal, contact_id, P, deal))) for deal in (deal1, deal2)]
    own_deals = dict(permissions, deal=dict(permissions["deal"], view=1), mail=False)
    sql("UPDATE \"user\" SET permissions = '%s'::jsonb WHERE id = %d" % (json.dumps(own_deals), agent["id"]))

    def feed_of(path):
        st, bd = http("GET", path, token=agent["token"])
        return st, {e.get("id"): e for e in (bd or {}).get("data", [])} if st == 200 else {}

    for name, path in (("company", "/companies/%d/events?limit=50" % company_id), ("contact", "/users/%d/events?limit=50" % contact_id)):
        st, rows = feed_of(path)
        texts = [((e.get("after_state") or {}).get("data") or {}).get("comment") for e in rows.values()]
        check("%s feed of an agent with «own deals»: nothing of a colleague's deal (comment, letter)" % name,
              st == 200 and "%s-comment-%d" % (P, deal1) not in texts and mail_events[0] not in rows, (st, texts, list(rows)[:10]))
        if name == "company":
            mine = rows.get(mail_events[1]) or {}
            check("... their own deal is there; a letter without the mail right: hidden, no subject or text",
                  "%s-comment-%d" % (P, deal2) in texts and (mine.get("after_state") or {}).get("hidden") is True
                  and not ((mine.get("after_state") or {}).get("data") or {}).get("subject")
                  and "secret" not in json.dumps(mine), mine)
    sql("UPDATE \"user\" SET permissions = '%s'::jsonb WHERE id = %d" % (json.dumps(permissions), agent["id"]))
    st, rows = feed_of("/companies/%d/events?limit=50" % company_id)
    check("... with every deal and the mail right: both letters, with their subjects",
          st == 200 and all(((rows.get(i) or {}).get("after_state") or {}).get("data", {}).get("subject") for i in mail_events), (st, list(rows)[:10]))
    sql("DELETE FROM event WHERE id IN (%s)" % ",".join(str(i) for i in mail_events))
    sql("UPDATE deal SET agent_id = NULL WHERE id = %d" % deal2)

    section("Source of a contact (GET /companies/:id/agent/:contact/source)")
    status, body = http("GET", "/companies/%d/agent/%d/source" % (company_id, contact_id))
    check("contact of the company -> 200 (was 500)", status == 200, "%s %s" % (status, message_of((status, body))))
    files = (body or {}).get("files", []) if status == 200 else []
    check("the files of the contact's deals are listed with their path",
          any(f.get("path") == "uploads/%s-file.txt" % P and f.get("deal") == deal1 for f in files), files)
    check("recordings key is present", status == 200 and isinstance(body.get("recordings"), list), body)
    status, body = http("GET", "/companies/%d/agent/%d/source" % (company_empty, contact_id))
    check("contact of another company -> 400", status == 400, "%s %s" % (status, message_of((status, body))))
    status, body = http("GET", "/companies/%d/agent/%d/source" % (company_id, admin_id))
    check("a staff user instead of a contact -> 404", status == 404, status)
    status, body = http("GET", "/companies/%d/agent/999999999/source" % company_id)
    check("unknown contact -> 404 (was 500)", status == 404, status)

    section("Create company (POST /companies): errors are reported as they are")

    # the CRM data already has required custom fields ("Страна", "Код Клиента" for companies,
    # "Должность" for contacts): the payloads of the web form fill them
    prod_required_co = [{"filler_id": int(r[0]), "value": "x"} for r in sql("SELECT id FROM filler WHERE target = 'company' AND is_required AND field NOT LIKE 'AUDIT-%'")]
    prod_required_user = [{"filler_id": int(r[0]), "value": "x"} for r in sql("SELECT id FROM filler WHERE target = 'user' AND is_required AND field NOT LIKE 'AUDIT-%'")]

    def company_payload(name, **extra):
        payload = {"name": name, "is_old": False, "phone": "+998000000002", "fillers": list(prod_required_co)}
        if "fillers" in extra:
            extra["fillers"] = list(prod_required_co) + extra["fillers"]
        for user in extra.get("users", []):
            user["fillers"] = list(prod_required_user) + user.get("fillers", [])
        payload.update(extra)
        return payload

    status, body = http("POST", "/companies", company_payload("%s-co" % P))
    check("duplicate name -> 400 'already exists'", status == 400 and "already exists" in message_of((status, body)),
          "%s %s" % (status, message_of((status, body))))
    status, body = http("POST", "/companies", company_payload("%s-co-x" % P, users=[
        {"username": "%s-x" % P, "email": "audit-mod-contact-%s@example.test" % RUN, "phone": "+998900000009", "role": "ctr_agent", "fillers": []}]))
    check("contact with an e-mail that is taken -> 400 about the contact, not 'company already exists'",
          status == 400 and "ctr_agent" in message_of((status, body)) and "Company with name" not in message_of((status, body)),
          "%s %s" % (status, message_of((status, body))))
    check("no company was created by the failed request", count("SELECT count(*) FROM company WHERE name = '%s-co-x'" % P) == 0)

    section("Required custom fields are checked on the server")
    f_req_co = int(scalar("INSERT INTO filler (target, field, is_required) VALUES ('company', '%s-req-co', true) RETURNING id" % P))
    status, body = http("POST", "/companies", company_payload("%s-co-new" % P))
    check("company without the required field -> 400 naming the field",
          status == 400 and "%s-req-co" % P in message_of((status, body)), "%s %s" % (status, message_of((status, body))))
    status, body = http("POST", "/companies", company_payload("%s-co-new" % P, fillers=[{"filler_id": f_req_co, "value": "  "}]))
    check("blank value does not count", status == 400, status)
    status, body = http("POST", "/companies", company_payload("%s-co-new" % P, fillers=[{"filler_id": f_req_co, "value": "ok"}]))
    check("company with the required field -> 201", status == 201 and isinstance(body, dict) and body.get("id"),
          "%s %s" % (status, message_of((status, body))))
    new_company = body.get("id") if status == 201 else None

    f_req_user = int(scalar("INSERT INTO filler (target, field, is_required) VALUES ('user', '%s-req-user', true) RETURNING id" % P))
    status, body = http("POST", "/companies", company_payload("%s-co-new2" % P, fillers=[{"filler_id": f_req_co, "value": "ok"}], users=[
        {"username": "%s-y" % P, "email": "audit-mod-y-%s@example.test" % RUN, "phone": "+998900000008", "role": "ctr_agent", "fillers": []}]))
    check("company whose contact misses a required contact field -> 400",
          status == 400 and "%s-req-user" % P in message_of((status, body)), "%s %s" % (status, message_of((status, body))))
    status, body = http("POST", "/companies", company_payload("%s-co-new2" % P, fillers=[{"filler_id": f_req_co, "value": "ok"}], users=[
        {"username": "%s-y" % P, "email": "audit-mod-y-%s@example.test" % RUN, "phone": "+998900000008", "role": "ctr_agent",
         "fillers": [{"filler_id": f_req_user, "value": "Менеджер"}]}]))
    check("… and 201 when the contact field is filled", status == 201, "%s %s" % (status, message_of((status, body))))
    check("the contact's own field value is saved",
          scalar("SELECT value FROM user_filler uf JOIN \"user\" u ON u.id = uf.user_id WHERE u.username = '%s-y' AND uf.filler_id = %d" % (P, f_req_user)) == "Менеджер")

    f_req_prod = int(scalar("INSERT INTO filler (target, field, is_required) VALUES ('product', '%s-req-prod', true) RETURNING id" % P))
    status, body = http("POST", "/products", {"name": "%s-prod-new" % P, "fillers": []})
    check("product without the required field -> 400", status == 400 and "%s-req-prod" % P in message_of((status, body)),
          "%s %s" % (status, message_of((status, body))))
    status, body = http("POST", "/products", {"name": "%s-prod-new" % P, "fillers": [{"filler_id": f_req_prod, "value": "XL"}]})
    check("product with the required field -> 201", status == 201, "%s %s" % (status, message_of((status, body))))

    f_req_deal = int(scalar("INSERT INTO filler (target, field, is_required) VALUES ('deal', '%s-req-deal', true) RETURNING id" % P))
    deal_payload = {"label": "%s-deal-new" % P, "budget": 10, "agent_id": admin_id, "company_id": company_id,
                    "ctr_agent_ids": [contact_id], "stage_id": stage_id, "fillers": [], "products": []}
    status, body = http("POST", "/deals", deal_payload)
    check("deal without the required field -> 400", status == 400 and "%s-req-deal" % P in message_of((status, body)),
          "%s %s" % (status, message_of((status, body))))
    deal_payload["fillers"] = [{"filler_id": f_req_deal, "value": "A"}]
    status, body = http("POST", "/deals", deal_payload)
    check("deal with the required field -> 201", status == 201, "%s %s" % (status, message_of((status, body))))
    new_deal_id = body.get("id") if status == 201 and isinstance(body, dict) else None
    if new_deal_id:
        df_id = scalar("SELECT id FROM deal_filler WHERE deal_id = %d AND filler_id = %d" % (new_deal_id, f_req_deal))
        status, body = http("PATCH", "/deals/%d" % new_deal_id, {"fillers": [{"deal_filler_id": int(df_id), "value": ""}], "fillers_create": []})
        check("blanking a required deal field on edit -> 400", status == 400, "%s %s" % (status, message_of((status, body))))
        check("the value is untouched", scalar("SELECT value FROM deal_filler WHERE id = %s" % df_id) == "A")

    # the required fields are gone for the rest of the run
    sql("DELETE FROM filler WHERE id IN (%d, %d, %d, %d)" % (f_req_co, f_req_user, f_req_prod, f_req_deal))

    # ================================================================= contacts
    # a local number nobody has (Telegram / WhatsApp / calls compare the last 9 digits): a contact's phone
    # must be free since the duplicate-phone rule (UserService.assertPhoneIsFree), the QA data has +99890111000x
    def free_local9():
        while True:
            candidate = "77" + "".join(str(secrets.randbelow(10)) for _ in range(7))
            if not count("SELECT count(*) FROM \"user\" WHERE right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 9) = '%s'" % candidate):
                return candidate

    section("Primary contact of a company: its phone and email stand in for the company's")
    prim_phone1 = "+998" + free_local9()
    prim_phone2 = prim_phone1
    while prim_phone2 == prim_phone1:
        prim_phone2 = "+998" + free_local9()
    status, body = http("POST", "/companies", company_payload("%s-co-prim" % P, phone=None, users=[
        {"username": "%s-prim-1" % P, "email": "audit-mod-prim1-%s@example.test" % RUN, "phone": prim_phone1, "role": "ctr_agent", "fillers": []},
        {"username": "%s-prim-2" % P, "email": "audit-mod-prim2-%s@example.test" % RUN, "phone": prim_phone2, "role": "ctr_agent", "fillers": []}]))
    check("company created without a phone of its own, with two contacts -> 201", status == 201, "%s %s" % (status, message_of((status, body))))
    co_prim = body["id"] if status == 201 else 0
    row = sql("SELECT phone, email, primary_contact_id = (SELECT id FROM \"user\" WHERE username = '%s-prim-1') FROM company WHERE id = %d" % (P, co_prim))
    check("the first contact is the primary one and lent the company its phone and email",
          row and row[0] == [prim_phone1, "audit-mod-prim1-%s@example.test" % RUN, "t"], row)
    status, body = http("GET", "/companies/%d" % co_prim)
    prim2 = int(scalar("SELECT id FROM \"user\" WHERE username = '%s-prim-2'" % P))
    check("GET /companies/:id shows primary_contact_id", status == 200 and body.get("primary_contact_id") == int(scalar("SELECT id FROM \"user\" WHERE username = '%s-prim-1'" % P)), body.get("primary_contact_id") if status == 200 else status)
    status, body = http("PATCH", "/companies/%d" % co_prim, {"name": "%s-co-prim" % P, "is_old": False, "fillers": [], "fillers_create": [], "users": [], "primary_contact_id": prim2})
    check("PATCH with primary_contact_id of the second contact -> 200", status == 200, "%s %s" % (status, message_of((status, body))))
    # the phone copied at creation is the company's own now; when the company has none, the primary contact's is shown
    sql("UPDATE company SET phone = NULL, email = NULL WHERE id = %d" % co_prim)
    status, body = http("GET", "/companies/%d" % co_prim)
    check("with an empty phone of its own the company shows the new primary contact's phone and says so",
          status == 200 and body.get("primary_contact_id") == prim2 and body.get("phone") == prim_phone2 and body.get("phone_from_contact") == "%s-prim-2" % P, (status, body.get("phone"), body.get("phone_from_contact")))
    status, body = http("PATCH", "/companies/%d" % co_prim, {"name": "%s-co-prim" % P, "is_old": False, "fillers": [], "fillers_create": [], "users": [], "primary_contact_id": contact_id})
    check("a contact of another company cannot be the primary one -> 400", status == 400, status)
    status, body = http("GET", "/companies?limit=100&name=%s-co-prim" % P)
    listed = next((c for c in (body.get("data") or []) if c.get("id") == co_prim), None) if status == 200 else None
    check("the companies list shows the contact's phone too", listed and listed.get("phone") == prim_phone2, listed and listed.get("phone"))

    section("Contacts list (GET /contacts)")
    status, body = http("GET", "/contacts?name=%s&limit=50" % P)
    check("GET /contacts?name=… -> 200", status == 200, "%s %s" % (status, message_of((status, body))))
    rows = {(r["type"], r["id"]): r for r in (body or {}).get("data", [])} if status == 200 else {}
    check("live contact is listed with its company", ("ctr_agent", contact_id) in rows and (rows[("ctr_agent", contact_id)].get("company") or {}).get("id") == company_id, list(rows))
    check("DELETED contact is not listed (was listed)", ("ctr_agent", contact_deleted) not in rows, list(rows))
    check("DELETED company is not listed", ("company", company_deleted) not in rows, list(rows))
    check("contact of a deleted company is listed without a company",
          ("ctr_agent", contact_orphan) in rows and rows[("ctr_agent", contact_orphan)].get("company") is None,
          rows.get(("ctr_agent", contact_orphan)))
    check("live company is listed", ("company", company_id) in rows, list(rows))
    check("count matches the rows", status == 200 and body.get("count") == len(body.get("data", [])), (body or {}).get("count"))

    status, body = http("GET", "/contacts?name=%s&employees=true&limit=50" % P)
    data = (body or {}).get("data", []) if status == 200 else []
    check("employees=true: only contacts that belong to a live company",
          status == 200 and data and all(r["type"] == "ctr_agent" and r.get("company") for r in data) and body.get("count") == len(data),
          "%s %s" % (status, [(r["type"], r.get("company")) for r in data]))
    status, body = http("GET", "/contacts?name=%s&employees=false&limit=50" % P)
    data = (body or {}).get("data", []) if status == 200 else []
    check("employees=false: companies and contacts without a company",
          status == 200 and data and all(r.get("company") is None for r in data) and any(r["id"] == contact_orphan for r in data),
          "%s %s" % (status, [(r["type"], r["id"]) for r in data]))

    status, body = http("GET", "/contacts?name=Иванов&limit=50")
    found = status == 200 and any(r["type"] == "ctr_agent" and r["id"] == contact_id for r in body.get("data", []))
    check("search in Cyrillic finds the contact (GET /contacts?name=Иванов)", found, "%s %s" % (status, message_of((status, body))))
    search_vue = client_file(os.path.join("components", "common", "Search.vue"))
    check("client: Search.vue no longer encodes the text itself (useService encodes once)", "encodeURIComponent" not in search_vue)

    section("Edit contact (PATCH /users/:id): custom field values are saved")
    patch = {"email": "audit-mod-contact-%s@example.test" % RUN, "username": "%s-contact Иванов" % P, "role": "ctr_agent",
             "company_id": company_id, "phone": "+998900000001",
             "fillers": [{"user_filler_id": uf_id, "value": "Главный директор"}], "fillers_create": []}
    status, body = http("PATCH", "/users/%d" % contact_id, patch)
    check("PATCH with a changed value and no new fields -> 200", status in (200, 201), "%s %s" % (status, message_of((status, body))))
    check("the new value is in the database (was lost unless a field was added at the same time)",
          scalar("SELECT value FROM user_filler WHERE id = %d" % uf_id) == "Главный директор")
    status, body = http("GET", "/contacts?name=%s&limit=50" % P)
    check("GET /contacts still 200 after the edit", status == 200, status)

    # ================================================================= companies, contacts, staff (AUDIT people)
    section("Companies, contacts and staff: the card, the lists and the rights (CO-1..CO-14, ACL-2..ACL-18)")
    local9 = free_local9()
    local_text = "%s %s %s %s" % (local9[:2], local9[2:5], local9[5:7], local9[7:])

    # CO-1: a contact as Telegram makes it (no company, no e-mail) is saved from its card
    channel_contact = int(scalar("INSERT INTO \"user\" (username, role) VALUES ('%s-tg-contact', 'ctr_agent') RETURNING id" % P))
    status, body = http("PATCH", "/users/%d" % channel_contact, {
        "username": "%s-tg-contact" % P, "role": "ctr_agent", "email": "", "phone": local_text,
        "fillers": [], "fillers_create": list(prod_required_user)})
    check("CO-1: a contact without company and e-mail is saved from its card (\"\" e-mail, local phone) -> 200",
          status in (200, 201), "%s %s" % (status, message_of((status, body))))
    row = sql("SELECT phone, email IS NULL, company_id IS NULL FROM \"user\" WHERE id = %d" % channel_contact)
    check("CO-6: the local phone is stored as +998..., the e-mail stays empty, no company",
          row and row[0] == ["+998" + local9, "t", "t"], row)

    # CO-6: the same number typed another way is the same client
    status, body = http("POST", "/companies", company_payload("%s-co-dup-phone" % P, users=[
        {"username": "%s-dup-phone" % P, "phone": "+998 %s" % local_text, "role": "ctr_agent", "fillers": []}]))
    check("CO-6: a company whose new contact has a taken phone (another format) -> 400, nothing created",
          status == 400 and count("SELECT count(*) FROM company WHERE name = '%s-co-dup-phone'" % P) == 0,
          "%s %s" % (status, message_of((status, body))))

    # CO-14: attaching a contact to a company: its deals without a company follow, the move is logged
    channel_deal = new_deal("%s-deal-channel" % P, company="NULL")
    sql('INSERT INTO deal_user ("dealId", "userId") VALUES (%d, %d)' % (channel_deal, channel_contact))
    status, body = http("PATCH", "/users/%d" % channel_contact, {
        "username": "%s-tg-contact" % P, "role": "ctr_agent", "company_id": company_empty, "fillers": [], "fillers_create": []})
    check("CO-14: the contact is attached to a company -> 200", status in (200, 201), "%s %s" % (status, message_of((status, body))))
    check("... its deal without a company now belongs to that company",
          count("SELECT count(*) FROM deal WHERE id = %d AND company_id = %d" % (channel_deal, company_empty)) == 1)
    for _ in range(10):  # the history is written by an event listener
        if count("SELECT count(*) FROM event WHERE deal_id = %d AND after_state::text LIKE '%%%s-co-empty%%'" % (channel_deal, P)):
            break
        time.sleep(0.5)
    check("... and the move is in the deal's history",
          count("SELECT count(*) FROM event WHERE deal_id = %d AND after_state::text LIKE '%%%s-co-empty%%'" % (channel_deal, P)) >= 1)

    # CO-2 / ACL-9: custom field values are matched by the field and only the record's own values change
    f_co = int(scalar("INSERT INTO filler (target, field) VALUES ('company', '%s-код') RETURNING id" % P))
    own_value = int(scalar("INSERT INTO company_filler (company_id, filler_id, value) VALUES (%d, %d, 'K-1') RETURNING id" % (company_id, f_co)))
    other_value = int(scalar("INSERT INTO company_filler (company_id, filler_id, value) VALUES (%d, %d, 'K-2') RETURNING id" % (company_empty, f_co)))
    status, body = http("GET", "/companies/%d" % company_id)
    card_fillers = (body or {}).get("fillers", []) if status == 200 else []
    card_users = (body or {}).get("users", []) if status == 200 else []
    check("CO-2: the card gives each value with its field (filler_id), for the company and its contacts",
          any(f.get("id") == own_value and f.get("filler_id") == f_co for f in card_fillers)
          and any(f.get("id") == uf_id and f.get("filler_id") == f_user for u in card_users for f in u.get("fillers", [])),
          (card_fillers, card_users))
    status, body = http("PATCH", "/companies/%d" % company_id, {"fillers": [{"id": other_value, "value": "hacked"}]})
    check("ACL-9: a value id of ANOTHER company -> 400, that value is untouched",
          status == 400 and scalar("SELECT value FROM company_filler WHERE id = %d" % other_value) == "K-2",
          "%s %s" % (status, message_of((status, body))))
    status, body = http("PATCH", "/companies/%d" % company_id, {"fillers": [{"filler_id": f_co, "value": "K-1 new"}]})
    check("CO-2: a field set by its definition changes the company's own value only",
          status == 200 and scalar("SELECT value FROM company_filler WHERE id = %d" % own_value) == "K-1 new"
          and scalar("SELECT value FROM company_filler WHERE id = %d" % other_value) == "K-2",
          "%s %s" % (status, message_of((status, body))))
    other_uf = int(scalar("INSERT INTO user_filler (user_id, filler_id, value) VALUES (%d, %d, 'Бухгалтер') RETURNING id" % (channel_contact, f_user)))
    status, body = http("PATCH", "/users/%d" % contact_id, {
        "username": "%s-contact Иванов" % P, "role": "ctr_agent", "fillers": [{"user_filler_id": other_uf, "value": "hacked"}]})
    check("ACL-9: a contact value id of ANOTHER contact -> 400, untouched",
          status == 400 and scalar("SELECT value FROM user_filler WHERE id = %d" % other_uf) == "Бухгалтер",
          "%s %s" % (status, message_of((status, body))))

    # CO-3: contacts are added and detached in the company card; a contact without e-mail does not block it
    status, body = http("PATCH", "/companies/%d" % company_empty, {"users": [
        {"id": channel_contact, "username": "%s-tg-contact" % P, "email": None, "phone": "+998" + local9, "fillers": []},
        {"username": "%s-card-new" % P, "email": "", "phone": "", "fillers": list(prod_required_user)}]})
    new_card_contact = int(scalar("SELECT COALESCE(max(id), 0) FROM \"user\" WHERE username = '%s-card-new' AND company_id = %d" % (P, company_empty)))
    check("CO-3: PATCH company with a contact without e-mail and a NEW contact -> 200, the contact is created",
          status == 200 and new_card_contact > 0, "%s %s" % (status, message_of((status, body))))
    status, body = http("PATCH", "/companies/%d" % company_empty, {"users": [
        {"id": contact_id, "username": "%s-contact Иванов" % P, "fillers": []}]})
    check("ACL-12: a contact of ANOTHER company cannot be rewritten through this card -> 400",
          status == 400 and count("SELECT count(*) FROM \"user\" WHERE id = %d AND company_id = %d" % (contact_id, company_id)) == 1,
          "%s %s" % (status, message_of((status, body))))
    status, body = http("PATCH", "/companies/%d" % company_empty, {"removed_user_ids": [new_card_contact]})
    check("CO-3: removed_user_ids detaches the contact (it stays in the CRM without a company)",
          status == 200 and count("SELECT count(*) FROM \"user\" WHERE id = %d AND company_id IS NULL AND deleted_at IS NULL" % new_card_contact) == 1,
          "%s %s" % (status, message_of((status, body))))

    # CO-9 / CO-4: one search box and the «Без сделок» filter
    status, body = http("GET", "/companies?limit=100&q=%s" % urllib.parse.quote("%s-contact Иванов" % P))
    check("CO-9: the companies list finds a company by its contact's name (q)",
          status == 200 and any(c.get("id") == company_id for c in body.get("data", [])), "%s %s" % (status, message_of((status, body))))
    status, body = http("GET", "/companies?limit=100&q=%s&no_deals=true" % P)
    ids = [c.get("id") for c in (body or {}).get("data", [])] if status == 200 else []
    check("CO-9: no_deals=true lists companies without deals only (was 400)",
          status == 200 and company_id not in ids, "%s %s" % (status, message_of((status, body))))
    status, body = http("GET", "/contacts?q=%s&role=ctr_agent&limit=50" % local9)
    check("CO-4: the contacts list finds a contact by the phone digits (q) without choosing a field",
          status == 200 and any(r["id"] == channel_contact for r in body.get("data", [])), "%s %s" % (status, message_of((status, body))))
    status, body = http("GET", "/contacts?name=%s&role=ctr_agent&limit=50" % P)
    data = (body or {}).get("data", []) if status == 200 else []
    check("CO-4: role=ctr_agent lists contacts with and without a company, no companies",
          status == 200 and data and all(r["type"] == "ctr_agent" for r in data) and any(r["id"] == new_card_contact for r in data),
          "%s %s" % (status, [(r["type"], r["id"]) for r in data]))

    # CO-11 / CALL-3: the «Звонки» and «Файлы» tabs of the company
    rec_path = "%s-call.mp3" % P
    sql("INSERT INTO recording (duration, user_id, outgoing, path, from_number) VALUES (42, %d, false, '%s', '+998900000001')" % (admin_id, rec_path))
    status, body = http("GET", "/companies/%d/sources?limit=50" % company_id)
    check("CO-11: GET /companies/:id/sources -> 200 with the files of the company's deals",
          status == 200 and any(f.get("path") == "uploads/%s-file.txt" % P for f in body.get("files", [])), "%s %s" % (status, message_of((status, body))))
    check("CALL-3: ... and the call made from the contact's phone (the tab was always empty)",
          status == 200 and any(r.get("path") == rec_path for r in body.get("recordings", [])), (body or {}).get("recordings") if status == 200 else status)
    sql("DELETE FROM recording WHERE path = '%s'" % rec_path)

    # CO-8: a deleted company can be found and restored; its name can be used again
    trash_co = int(scalar("INSERT INTO company (name, is_old, created_by) VALUES ('%s-co-trash', false, %d) RETURNING id" % (P, admin_id)))
    http("DELETE", "/companies/%d" % trash_co)
    status, body = http("GET", "/companies/trash?q=%s-co-trash&limit=50" % P)
    check("CO-8: the deleted company is in GET /companies/trash",
          status == 200 and any(c.get("id") == trash_co for c in body.get("data", [])), "%s %s" % (status, message_of((status, body))))
    status, body = http("PATCH", "/companies/%d/restore" % trash_co, {})
    check("CO-8: PATCH /companies/:id/restore brings it back",
          status == 200 and count("SELECT count(*) FROM company WHERE id = %d AND deleted_at IS NULL" % trash_co) == 1,
          "%s %s" % (status, message_of((status, body))))
    sql("UPDATE company SET deleted_at = now() WHERE id = %d" % trash_co)
    status, body = http("POST", "/companies", company_payload("%s-co-trash" % P))
    check("CO-8: the name of a deleted company can be given to a new one (was 'already exists')",
          status == 201, "%s %s" % (status, message_of((status, body))))
    status, body = http("GET", "/fillers/%d/usage" % f_co)
    check("CO-8: GET /fillers/:id/usage counts the values a deleted field would take with it",
          status == 200 and isinstance(body, dict) and body.get("values") == 2, "%s %s" % (status, body))

    # CO-13: a rename to a taken name is a 400, not a 500
    status, body = http("PATCH", "/companies/%d" % company_empty, {"name": "%s-co" % P})
    check("CO-13: renaming to the name of another company -> 400 (was 500)", status == 400, "%s %s" % (status, message_of((status, body))))

    # ACL-6 / TASK-17: the staff list of the pickers
    status, body = http("GET", "/users/staff", token=agent["token"])
    staff = (body or {}).get("data", []) if status == 200 else []
    check("ACL-6: GET /users/staff -> staff accounts only, the new agent included, no contacts",
          status == 200 and any(u.get("id") == agent["id"] for u in staff) and all(u.get("role") != "ctr_agent" for u in staff),
          "%s %s" % (status, message_of((status, body))))

    # CO-10 / ACL-7 / ACL-12: the lists and the creation of contacts follow the rights
    limited = dict(permissions, company=dict(permissions["company"], view=1),
                   contact=dict(permissions["contact"], view=1, create=0))
    sql("UPDATE \"user\" SET permissions = '%s'::jsonb WHERE id = %d" % (json.dumps(limited), agent["id"]))
    status, body = http("GET", "/companies?limit=100&q=%s" % P, token=agent["token"])
    check("CO-10: «own» company view: GET /companies does not list a colleague's company",
          status == 200 and all(c.get("id") != company_id for c in body.get("data", [])), "%s %s" % (status, message_of((status, body))))
    status, body = http("GET", "/contacts?name=%s&limit=50" % P, token=agent["token"])
    check("ACL-7: «own» contact view: GET /contacts does not list a colleague's contact",
          status == 200 and all(not (r["type"] == "ctr_agent" and r["id"] == contact_id) for r in body.get("data", [])),
          "%s %s" % (status, message_of((status, body))))
    status, body = http("POST", "/users", {"username": "%s-no-right" % P, "role": "ctr_agent"}, token=agent["token"])
    check("ACL-12: no «Создание контактов»: POST /users (a contact) -> 403", status == 403, "%s %s" % (status, message_of((status, body))))
    status, body = http("POST", "/companies", company_payload("%s-co-no-right" % P, users=[
        {"username": "%s-no-right" % P, "role": "ctr_agent", "fillers": []}]), token=agent["token"])
    check("ACL-12: ... nor through a new company with contacts -> 403", status == 403, "%s %s" % (status, message_of((status, body))))
    sql("UPDATE \"user\" SET permissions = '%s'::jsonb WHERE id = %d" % (json.dumps(permissions), agent["id"]))

    # ACL-18: one's own name and phone
    status, body = http("PATCH", "/users/me", {"username": "%s-agent" % P, "phone": local_text}, token=agent["token"])
    check("ACL-18: PATCH /users/me changes one's own phone (stored as +998...)",
          status == 200 and scalar("SELECT phone FROM \"user\" WHERE id = %d" % agent["id"]) == "+998" + local9,
          "%s %s" % (status, message_of((status, body))))
    status, body = http("PATCH", "/users/me", {"username": "%s-agent" % P, "phone": ""}, token=agent["token"])
    check("ACL-18: ... and \"\" clears it", status == 200 and scalar("SELECT phone FROM \"user\" WHERE id = %d" % agent["id"]) in (None, ""), status)

    # CO-12: a product has an article, a unit and a price with kopecks
    prod_required_product = [{"filler_id": int(r[0]), "value": "x"} for r in sql("SELECT id FROM filler WHERE target = 'product' AND is_required AND field NOT LIKE 'AUDIT-%'")]
    status, body = http("POST", "/products", {"name": "%s-prod-price" % P, "sku": "AUD-1", "unit": "м", "price": "12,50", "fillers": prod_required_product})
    check("CO-12: a product with an article, a unit and the price 12,50 -> 201",
          status == 201 and scalar("SELECT price::text || '/' || sku || '/' || unit FROM product WHERE name = '%s-prod-price'" % P) == "12.50/AUD-1/м",
          "%s %s" % (status, message_of((status, body))))

    # ================================================================= products
    section("Products")
    status, body = http("GET", "/products?name=Пижам&limit=50")
    check("GET /products?name=<part of the name> finds the product (was: whole name only)",
          status == 200 and any(p["id"] == product_id for p in body.get("data", [])), "%s %s" % (status, message_of((status, body))))
    products_vue = client_file(os.path.join("pages", "lists", "products", "index.vue"))
    check("client: the products search sends the typed text, not the ref object",
          "productService.find({name})" not in products_vue and "query.name = text" in products_vue)

    for key in ("deal_count", "total_price_sold", "average_price_per_product", "average_quantity_per_deal"):
        status, body = http("GET", "/products/statistics?sort[%s]=-1&limit=50" % key)
        check("GET /products/statistics?sort[%s]=-1 -> 200 (was 500)" % key, status == 200, "%s %s" % (status, message_of((status, body))))
    status, body = http("GET", "/products/statistics?sort[deal_count]=-1&limit=200")
    row = next((r for r in (body or {}).get("data", []) if r["id"] == product_id), None) if status == 200 else None
    check("the statistics row of the product: 1 deal, quantity 2, sum 300",
          row and row["deal_count"] == 1 and row.get("average_quantity_per_deal") == 2 and row["total_price_sold"] == 300, row)
    status, body = http("GET", "/products/statistics?sort[name]=-1")
    check("sorting by a column that is not allowed -> 400", status == 400, status)
    analytics_vue = client_file(os.path.join("pages", "analytics", "products", "index.vue"))
    check("client: products analytics shows no random demo numbers", "Math.random" not in analytics_vue and "mockData" not in analytics_vue)

    # ================================================================= tasks
    section("Tasks (GET/POST/PATCH /tasks, task types, linkables)")
    hour = datetime.timedelta(hours=1)

    def iso(dt):
        return dt.strftime("%Y-%m-%dT%H:%M:%S")

    def new_task(label, link, assignee=None, token=None, **extra):
        body = {"label": label, "assign_to": {"target": "agent", "id": assignee or admin_id}, "link_to": link,
                "start_time": iso(now + 24 * hour), "end_time": iso(now + 25 * hour), "allDay": False}
        body.update(extra)
        st, bd = http("POST", "/tasks", body, token=token)
        return st, (bd.get("id") if st == 201 and isinstance(bd, dict) else None), bd

    # TASK-1: a task without a type gets the default one
    status, t_notype, body = new_task("%s-task-notype" % P, {"target": "deal", "id": deal1})
    check("POST /tasks without type_id -> 201, the task gets a type (a typeless task broke the board and the deal history)",
          t_notype and scalar("SELECT type_id IS NOT NULL FROM task WHERE id = %d" % t_notype) == "t",
          "%s %s" % (status, message_of((status, body))))
    # ... and the client never reads the type of a task without a guard (a null type blanked the deal history)
    unguarded = [name for name in (os.path.join("components", "task", "TaskColumn.vue"),
                                   os.path.join("components", "common", "EventsList.vue"),
                                   os.path.join("components", "common", "DealActionsNav.vue"),
                                   os.path.join("pages", "tasks", "calendar.vue"),
                                   os.path.join("pages", "tasks", "index.vue"))
                 # a line that tests type?. first is guarded (if (task.type?.id) payload.type_id = task.type.id)
                 if any(re.search(r"(task|data|item)\.type\.(name|id)\b", line) and "type?." not in line
                        for line in client_file(name).splitlines())]
    check("client: the task board, calendar and deal history read task.type?.name (a typeless task is shown as 'Задача')",
          not unguarded, unguarded)

    # TASK-2: an automatic task names the deal and its company; a move keeps both
    t_auto = int(scalar(
        "INSERT INTO task (label, start_time, end_time, type_id, agent_id, \"createdById\", deal_id, company_id) "
        "VALUES ('%s-task-auto', '%s', '%s', %d, %d, %d, %d, %d) RETURNING id"
        % (P, ts(now + 24 * hour), ts(now + 25 * hour), task_type_id, admin_id, admin_id, deal1, company_id)))
    sql("INSERT INTO bot_reminder (task_id) VALUES (%d)" % t_auto)
    status, body = http("PATCH", "/tasks/%d" % t_auto, {"label": "%s-task-auto renamed" % P})
    check("PATCH with the label only -> 200, the bot's 'reminded' mark stays (same time, same person)",
          status == 200 and count("SELECT count(*) FROM bot_reminder WHERE task_id = %d" % t_auto) == 1,
          "%s %s" % (status, message_of((status, body))))
    status, body = http("PATCH", "/tasks/%d" % t_auto, {"start_time": iso(now + 48 * hour), "end_time": iso(now + 49 * hour), "allDay": False})
    row = sql("SELECT deal_id, company_id, type_id, label FROM task WHERE id = %d" % t_auto)
    check("a drag (times only) -> 200 and the task keeps its deal, company, type and text",
          status == 200 and row and row[0][:3] == [str(deal1), str(company_id), str(task_type_id)] and row[0][3].endswith("renamed"),
          (status, message_of((status, body)), row))
    check("... moved: the bot reminds again (the 'reminded' mark is removed)",
          count("SELECT count(*) FROM bot_reminder WHERE task_id = %d" % t_auto) == 0)
    # an older client sends everything, the company first
    status, body = http("PATCH", "/tasks/%d" % t_auto, {
        "label": "%s-task-auto" % P, "type_id": task_type_id, "assign_to": {"target": "agent", "id": admin_id},
        "link_to": {"target": "company", "id": company_id},
        "start_time": iso(now + 48 * hour), "end_time": iso(now + 49 * hour), "allDay": False})
    check("an old client's full PATCH with the deal's company -> the deal stays linked (it used to be dropped)",
          status == 200 and scalar("SELECT deal_id FROM task WHERE id = %d" % t_auto) == str(deal1), (status, message_of((status, body))))
    status, body = http("PATCH", "/tasks/%d" % t_auto, {"link_to": {"target": "deal", "id": deal2}})
    check("a new link really moves the task (deal 2)",
          status == 200 and scalar("SELECT deal_id FROM task WHERE id = %d" % t_auto) == str(deal2), (status, message_of((status, body))))

    # TASK-11: a day without a time is an all-day task of that local day, not a task at 05:00
    today = now.strftime("%Y-%m-%d")
    status, t_day, body = new_task("%s-task-day" % P, {"target": "deal", "id": deal1}, start_time=today, end_time=today, type_id=task_type_id)
    row = sql("SELECT \"allDay\", to_char(start_time, 'YYYY-MM-DD HH24:MI'), to_char(end_time, 'YYYY-MM-DD HH24:MI') FROM task WHERE id = %d" % (t_day or 0))
    check("POST /tasks with a plain date -> an all-day task 00:00-23:59 of that day (was 05:00 = UTC midnight)",
          row == [["t", today + " 00:00", today + " 23:59"]], (status, message_of((status, body)), row))
    client_scheduler = client_file(os.path.join("components", "common", "EventSchedulerSingle.vue"))
    check("client: the task form posts 'allDay' (the forms read allDay; 'all_day' was never saved)",
          'name="allDay"' in client_scheduler and 'name="all_day"' not in client_scheduler)

    # TASK-9: "Мои", every status, the client's tasks
    status, t_agent, body = new_task("%s-task-of-agent" % P, {"target": "deal", "id": deal1}, assignee=agent["id"], type_id=task_type_id)
    status, body = http("GET", "/tasks?mine=true&limit=1000", token=agent["token"])
    mine = [t["id"] for t in (body or {}).get("data", [])] if status == 200 else None
    check("GET /tasks?mine=true -> the caller's tasks only", mine is not None and t_agent in mine and t_notype not in mine, mine)
    status, body = http("PATCH", "/tasks/%d/close" % t_agent, {"result": "done"}, token=agent["token"])
    check("the agent closes their task -> 200", status == 200, "%s %s" % (status, message_of((status, body))))
    status, body = http("GET", "/tasks?deal_id=%d&limit=1000" % deal1)
    open_ids = [t["id"] for t in (body or {}).get("data", [])] if status == 200 else []
    status, body = http("GET", "/tasks?deal_id=%d&type=all&limit=1000" % deal1)
    all_ids = [t["id"] for t in (body or {}).get("data", [])] if status == 200 else []
    check("without a status: open tasks; type=all: closed ones too ('Все статусы' showed only open ones)",
          t_agent not in open_ids and t_agent in all_ids and t_notype in open_ids, (open_ids, all_ids))
    status, body = http("GET", "/tasks?company_id=%d&type=all&limit=1000" % company_id)
    of_company = [t["id"] for t in (body or {}).get("data", [])] if status == 200 else []
    check("GET /tasks?company_id -> tasks of the company and of its deals", status == 200 and t_notype in of_company and t_agent in of_company,
          (status, of_company))
    # the closed task of the agent would change the agent's desktop numbers below
    if t_agent:
        sql("DELETE FROM event WHERE task_id = %d; DELETE FROM task WHERE id = %d" % (t_agent, t_agent))
    status, body = http("GET", "/tasks?sort[end_time]=1&limit=5")
    check("the list sorts by the deadline (sort[end_time]) -> 200", status == 200, "%s %s" % (status, message_of((status, body))))

    # TASK-3: an agent with "own" rights does not read or link other people's deals through tasks
    own = {"view": 1, "create": 3, "update": 1, "delete": 1, "export": 0}
    agent2 = {"email": "audit-mod-agent2-%s@example.test" % RUN, "password": secrets.token_urlsafe(12)}
    status, body = http("POST", "/users", {
        "email": agent2["email"], "password": agent2["password"], "username": "%s-agent2" % P, "role": "agent", "group_id": group_id,
        "permissions": {"deal": own, "contact": own, "company": own, "task": {"update": 1, "delete": 1}, "mail": False, "file": False},
    })
    if status != 201 or not isinstance(body, dict):
        raise SystemExit("cannot create the second test agent: %s %s" % (status, body))
    agent2["id"] = body["id"]
    agent2["token"] = login(agent2["email"], agent2["password"])
    status, _ = http("GET", "/tasks/%d" % t_notype, token=agent2["token"])
    check("own rights: GET /tasks/:id of a task on someone else's deal -> 404", status == 404, status)
    status, body = http("GET", "/tasks?deal_id=%d&limit=1000" % deal1, token=agent2["token"])
    check("own rights: GET /tasks does not list the tasks of someone else's deal (label, budget, requisites)",
          status == 200 and body.get("count") == 0, (status, (body or {}).get("count")))
    status, _, body = new_task("%s-task-foreign" % P, {"target": "deal", "id": deal1}, assignee=agent2["id"], token=agent2["token"], type_id=task_type_id)
    check("own rights: POST /tasks on someone else's deal -> 404 (it went into that deal's history)", status == 404, status)
    deal_own2 = new_deal("%s-deal-agent2" % P, agent_id=str(agent2["id"]))
    status, t_own2, body = new_task("%s-task-own2" % P, {"target": "deal", "id": deal_own2}, assignee=agent2["id"], token=agent2["token"], type_id=task_type_id)
    status_get, _ = http("GET", "/tasks/%d" % (t_own2 or 0), token=agent2["token"])
    check("own rights: a task on the agent's own deal -> 201 and readable", t_own2 and status_get == 200, (status, message_of((status, body)), status_get))

    # TASK-10: linkables find Cyrillic names, not deleted records, within the rights
    status, body = http("GET", "/linkables?name=Иванов")
    found = [(l.get("type"), l.get("id")) for l in (body or [])] if status == 200 and isinstance(body, list) else []
    check("GET /linkables?name=<Cyrillic> finds the contact", ("user", contact_id) in found, (status, found))
    status, body = http("GET", "/linkables?name=%s-contact" % P)
    found = [l.get("id") for l in (body or [])] if status == 200 and isinstance(body, list) else []
    check("... deleted contacts are not offered", contact_id in found and contact_deleted not in found, found)
    status, body = http("GET", "/linkables?name=%s-deal" % P, token=agent2["token"])
    found = [l.get("id") for l in (body or []) if l.get("type") == "deal"] if status == 200 and isinstance(body, list) else []
    check("... an agent with own rights is offered only own deals", deal_own2 in found and deal1 not in found and deal2 not in found, found)
    task_modal = client_file(os.path.join("components", "task", "TaskModal.vue"))
    check("client: the task window does not encode the search twice", "encodeURIComponent" not in task_modal)

    # deleting a task type moves its tasks to another type (a typeless task broke the board)
    status, body = http("POST", "/task-types", {"name": "%s-type" % P})
    type_tmp = body.get("id") if status == 201 and isinstance(body, dict) else None
    if type_tmp:
        sql("UPDATE task SET type_id = %d WHERE id = %d" % (type_tmp, t_notype))
        status, body = http("DELETE", "/task-types/%d" % type_tmp)
        check("DELETE /task-types/:id -> its tasks get another type, not none",
              status == 200 and scalar("SELECT type_id FROM task WHERE id = %d" % t_notype) not in (None, "", str(type_tmp)),
              "%s %s" % (status, message_of((status, body))))
    else:
        check("POST /task-types -> 201", False, "%s %s" % (status, message_of((status, body))))

    # ================================================================= desktop
    section("Desktop counters (GET /desktop)")
    day = datetime.timedelta(days=1)

    def task(label, start, end, closed=None):
        closed_sql = "'%s'" % ts(closed) if closed else "NULL"
        return int(scalar(
            "INSERT INTO task (label, start_time, end_time, closed_at, type_id, agent_id, \"createdById\", company_id) "
            "VALUES ('%s', '%s', '%s', %s, %d, %d, %d, %d) RETURNING id"
            % (label, ts(start), ts(end), closed_sql, task_type_id, agent["id"], agent["id"], company_id)))

    task("%s-overdue" % P, now - 2 * day, now - 1 * day)                       # open, deadline passed
    task("%s-active" % P, now - 1 * day, now + 1 * day)                        # open, deadline ahead
    task("%s-closed" % P, now - 3 * day, now - 2 * day, closed=now - 2 * day)  # closed
    deal_agent = new_deal("%s-deal-agent" % P, agent_id=str(agent["id"]))     # deal of the agent without tasks
    new_deal("%s-deal-agent-2" % P, agent_id=str(agent["id"]), created=now - 60 * day)  # outside of the period

    period = "from_date=%s&till_date=%s" % ((now - 7 * day).strftime("%Y-%m-%d"), (now + 7 * day).strftime("%Y-%m-%d"))
    status, body = http("GET", "/desktop?%s&my_stats=true" % period, token=agent["token"])
    check("agent: GET /desktop?my_stats=true -> 200", status == 200, "%s %s" % (status, message_of((status, body))))
    stats = (body or {}).get("task_stats", {}) if status == 200 else {}
    check("tasks_overdue = 1 (open, deadline passed) — was counting future deadlines", str(stats.get("tasks_overdue")) == "1", stats)
    check("active_tasks = 1 (open, deadline ahead) — was counting closed tasks", str(stats.get("active_tasks")) == "1", stats)
    # "my" numbers count the tasks of the agent and of their group (wave 1, group tasks are visible to the group):
    # the closed task above plus whatever the agent's real group closed in the period
    group_closed = count(
        "SELECT count(*) FROM task WHERE closed_at IS NOT NULL AND group_id = %d AND agent_id IS DISTINCT FROM %d "
        "AND closed_at >= '%s' AND closed_at < '%s'"
        % (group_id, agent["id"], (now - 7 * day).strftime("%Y-%m-%d"), (now + 8 * day).strftime("%Y-%m-%d")))
    check("tasks_closed = 1 + the group's closed tasks of the period", str(stats.get("tasks_closed")) == str(1 + group_closed), (stats, group_closed))
    check("deals_without_tasks = 1 (the agent's open deal of the period)", str(stats.get("deals_without_tasks")) == "1", stats)
    today_only = "from_date=%s&till_date=%s" % (now.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d"))
    status, body = http("GET", "/desktop?%s&my_stats=true" % today_only, token=agent["token"])
    stats = (body or {}).get("task_stats", {}) if status == 200 else {}
    check("'Сегодня': tasks_overdue counts a task overdue since yesterday (overdue is a state, not a period)",
          str(stats.get("tasks_overdue")) == "1", stats)
    status, body = http("GET", "/desktop?%s&my_stats=false&user_ids[]=%d" % (period, agent["id"]))
    stats = (body or {}).get("task_stats", {}) if status == 200 else {}
    total = (body or {}).get("total_manager_stats") or {} if status == 200 else {}
    check("admin, the agent picked (user_ids[]): the agent's numbers, not the company's",
          status == 200 and str(stats.get("tasks_overdue")) == "1" and str(stats.get("active_tasks")) == "1"
          and str(total.get("deal_count")) == "1", (status, stats, total))

    status, body = http("GET", "/desktop?%s&my_stats=false" % period, token=agent["token"])
    check("agent: company-wide numbers -> 403", status == 403, status)
    status, body = http("GET", "/desktop?%s&my_stats=false" % period)
    check("admin: company-wide numbers -> 200", status == 200, "%s %s" % (status, message_of((status, body))))
    stats = (body or {}).get("task_stats", {}) if status == 200 else {}
    check("admin: the counters are numbers and include the agent's tasks",
          all(str(stats.get(k, "")).isdigit() for k in ("tasks_overdue", "active_tasks", "tasks_closed", "deals_without_tasks"))
          and int(stats.get("tasks_overdue", 0)) >= 1 and int(stats.get("active_tasks", 0)) >= 1 and int(stats.get("tasks_closed", 0)) >= 1, stats)

    desktop_vue = client_file(os.path.join("pages", "index.vue"))
    check("client: the desktop of an agent asks only for their own numbers (no 403 widgets)",
          "ownOnly" in desktop_vue and "my_stats: ownOnly.value || sel.value === Selector.Mine" in desktop_vue)
    check("client: the placeholder row 'Jane Doe' is gone from 'Сделки по менеджерам'", "Jane Doe" not in desktop_vue)

    # ================================================================= deals kanban / profile / admin-only buttons (client)
    section("Client pages")
    status, body = http("GET", "/deals?limit=1000&skip=0")
    check("GET /deals?limit=1000 (the kanban request) -> 200", status == 200, "%s %s" % (status, message_of((status, body))))
    deals_vue = client_file(os.path.join("pages", "deals", "index.vue"))
    check("client: the kanban loads GET /deals/board column by column, the list keeps its page size",
          "GET /deals/board" in deals_vue and "if (kanban.value) return fetchBoard(" in deals_vue)
    company_feed_vue = client_file(os.path.join("components", "company", "CompanyFeed.vue"))
    on_intersect = company_feed_vue[company_feed_vue.index("async function onIntersect()"):]
    on_intersect = on_intersect[:on_intersect.index("}\n")]
    check("client: the company feed loads (onIntersect is not commented out)",
          "await fetchEvents()" in on_intersect and "// const result" not in on_intersect)
    profile_vue = client_file(os.path.join("pages", "profile", "index.vue"))
    check("client: the profile has the password form (PATCH /users/me/password)",
          "me/password" in profile_vue and "old_password" in profile_vue and "Сменить пароль" in profile_vue)
    tasks_vue = client_file(os.path.join("pages", "tasks.vue"))
    check("client: 'Управление типами задач' is shown to admin only",
          'v-if="currentUser?.role === UserRole.Admin"' in tasks_vue[:tasks_vue.index("Управление типами задач")])
    contact_vue = client_file(os.path.join("pages", "lists", "contacts", "[id].vue"))
    product_vue = client_file(os.path.join("pages", "lists", "products", "[id].vue"))
    check("client: 'Добавить поле' (a new custom field) is shown to admin only on the contact and product pages",
          contact_vue.count('v-if="currentUser?.role === UserRole.Admin"') >= 1 and product_vue.count('v-if="currentUser?.role === UserRole.Admin"') >= 1)

    # the records created through the API are removed by cleanup (AUDIT- prefix)
    _ = (new_company, deal_agent)


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
            check("no AUDIT- rows are left in the database", not left, left)
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
