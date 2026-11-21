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
DELETE FROM deal_stage_record WHERE deal_id IN (SELECT id FROM _d);
DELETE FROM deal_file WHERE "dealId" IN (SELECT id FROM _d);
DELETE FROM file WHERE name LIKE 'AUDIT-%';
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
    section("Primary contact of a company: its phone and email stand in for the company's")
    status, body = http("POST", "/companies", company_payload("%s-co-prim" % P, phone=None, users=[
        {"username": "%s-prim-1" % P, "email": "audit-mod-prim1-%s@example.test" % RUN, "phone": "+998901110001", "role": "ctr_agent", "fillers": []},
        {"username": "%s-prim-2" % P, "email": "audit-mod-prim2-%s@example.test" % RUN, "phone": "+998901110002", "role": "ctr_agent", "fillers": []}]))
    check("company created without a phone of its own, with two contacts -> 201", status == 201, "%s %s" % (status, message_of((status, body))))
    co_prim = body["id"] if status == 201 else 0
    row = sql("SELECT phone, email, primary_contact_id = (SELECT id FROM \"user\" WHERE username = '%s-prim-1') FROM company WHERE id = %d" % (P, co_prim))
    check("the first contact is the primary one and lent the company its phone and email",
          row and row[0] == ["+998901110001", "audit-mod-prim1-%s@example.test" % RUN, "t"], row)
    status, body = http("GET", "/companies/%d" % co_prim)
    prim2 = int(scalar("SELECT id FROM \"user\" WHERE username = '%s-prim-2'" % P))
    check("GET /companies/:id shows primary_contact_id", status == 200 and body.get("primary_contact_id") == int(scalar("SELECT id FROM \"user\" WHERE username = '%s-prim-1'" % P)), body.get("primary_contact_id") if status == 200 else status)
    status, body = http("PATCH", "/companies/%d" % co_prim, {"name": "%s-co-prim" % P, "is_old": False, "fillers": [], "fillers_create": [], "users": [], "primary_contact_id": prim2})
    check("PATCH with primary_contact_id of the second contact -> 200", status == 200, "%s %s" % (status, message_of((status, body))))
    # the phone copied at creation is the company's own now; when the company has none, the primary contact's is shown
    sql("UPDATE company SET phone = NULL, email = NULL WHERE id = %d" % co_prim)
    status, body = http("GET", "/companies/%d" % co_prim)
    check("with an empty phone of its own the company shows the new primary contact's phone and says so",
          status == 200 and body.get("primary_contact_id") == prim2 and body.get("phone") == "+998901110002" and body.get("phone_from_contact") == "%s-prim-2" % P, (status, body.get("phone"), body.get("phone_from_contact")))
    status, body = http("PATCH", "/companies/%d" % co_prim, {"name": "%s-co-prim" % P, "is_old": False, "fillers": [], "fillers_create": [], "users": [], "primary_contact_id": contact_id})
    check("a contact of another company cannot be the primary one -> 400", status == 400, status)
    status, body = http("GET", "/companies?limit=100&name=%s-co-prim" % P)
    listed = next((c for c in (body.get("data") or []) if c.get("id") == co_prim), None) if status == 200 else None
    check("the companies list shows the contact's phone too", listed and listed.get("phone") == "+998901110002", listed and listed.get("phone"))

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

    # ================================================================= products
    section("Products")
    status, body = http("GET", "/products?name=Пижам&limit=50")
    check("GET /products?name=<part of the name> finds the product (was: whole name only)",
          status == 200 and any(p["id"] == product_id for p in body.get("data", [])), "%s %s" % (status, message_of((status, body))))
    products_vue = client_file(os.path.join("pages", "lists", "products", "index.vue"))
    check("client: the products search sends the typed text, not the ref object",
          "productService.find({name})" not in products_vue and "{name: value}" in products_vue)

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
    check("tasks_closed = 1", str(stats.get("tasks_closed")) == "1", stats)
    check("deals_without_tasks = 1 (the agent's open deal of the period)", str(stats.get("deals_without_tasks")) == "1", stats)

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
    check("client: the kanban asks for all deals, the list keeps its page size",
          "kanban.value ? 1000 : perPage.value" in deals_vue and "watch(kanban, fetchDeals)" in deals_vue)
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
