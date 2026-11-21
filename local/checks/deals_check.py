#!/usr/bin/env python3
"""
Regression checks for the deals / pipeline (stages, collections) module.

    py local/checks/deals_check.py

* Python stdlib only.
* Talks to the LOCAL stack only: API http://localhost:8080/api/v1, database through
  `docker compose -f docker-compose.local.yml exec crm-db psql` (fixtures, assertions on rows, cleanup).
  With the CRM_* variables from local/dev/env.sh it talks to the dev copy on the server instead
  (CRM_API_URL, CRM_PSQL, CRM_APP_EXEC, CRM_APP_DIR, CRM_ENV_FILE).
* Admin password is read from parisahon-api/.env and never printed.
* Everything it creates is prefixed with AUDIT- and is removed at the end (soft deleted rows are removed
  physically), also when the run is interrupted. A run starts with the same cleanup, so a crashed run
  does not poison the next one.
* Prints PASS/FAIL per check, exits 1 if anything failed.
"""
import base64
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
CLIENT_SERVICE = os.path.join(ROOT, "parisahon-client", "app", "composables", "useService.ts")
BASE = os.environ.get("CRM_API_URL", "http://localhost:8080/api/v1").rstrip("/")


def _cmd(var, default):
    """A command prefix from the environment (dev copy on the server), else the docker stack's."""
    value = os.environ.get(var)
    return shlex.split(value) if value else default


PSQL = _cmd("CRM_PSQL", ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])
APP_EXEC = _cmd("CRM_APP_EXEC", ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-app"])
APP_DIR = os.environ.get("CRM_APP_DIR", "/app")  # where the API (and its dist/) lives for APP_EXEC
MIGRATION = "Migrations1794671493802"

RUN = str(int(time.time()))[-6:]
P = "AUDIT-chk-" + RUN  # prefix of everything this run creates

EVENT_NEW_DEAL_STAGE = 15
EVENT_NEW_PRODUCT = 14

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
            if not m:
                continue
            value = m.group(1).strip()
            if value[:1] in ("'", '"'):
                return value[1:value.index(value[0], 1)]
            return value.split(" #")[0].strip()
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


def http(method, path, body=None, raw=None, headers=None, auth=True):
    """
    Returns (status, parsed json | text | None).
    The API restarts on every source change (nest --watch) and nginx answers 502 meanwhile: retry.
    """
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
    if auth and TOKEN:
        hdrs["Authorization"] = "Bearer " + TOKEN

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


def multipart(fields, files=()):
    boundary = "----auditcheck" + RUN
    out = []
    for name, value in fields.items():
        out.append("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n" % (boundary, name, value))
    body = "".join(out).encode("utf-8")
    for name, filename, content in files:
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
                 "Content-Type: text/plain\r\n\r\n" % (boundary, name, filename)).encode("utf-8")
        body += content + b"\r\n"
    body += ("--%s--\r\n" % boundary).encode("utf-8")
    return body, {"Content-Type": "multipart/form-data; boundary=" + boundary}


def wait_for(fn, expected, timeout=8):
    """Events are written by asynchronous listeners: poll for a moment."""
    deadline = time.time() + timeout
    value = fn()
    while value != expected and time.time() < deadline:
        time.sleep(0.4)
        value = fn()
    return value


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def client_query_string(query):
    """
    Serialises a query object with the client's own queryToString() (composables/useService.ts):
    the function source is taken from the file, transpiled with the TypeScript of the API container
    and executed there. Returns the query string exactly as the browser would send it.
    """
    with open(CLIENT_SERVICE, encoding="utf-8") as fh:
        text = fh.read()
    source = text[text.index("function subQueryToString"):text.index("// --- Service Response Wrapper")]
    source = source.replace("export function", "function")
    js = (
        "let input='';process.stdin.on('data',(c)=>input+=c);process.stdin.on('end',()=>{"
        "const {source,query}=JSON.parse(input);const ts=require('typescript');"
        "const out=ts.transpileModule(source,{compilerOptions:{target:'ES2021',module:'commonjs'}}).outputText;"
        "const queryToString=new Function(out+'; return queryToString;')();"
        "console.log(JSON.stringify(queryToString(query)));});"
    )
    proc = subprocess.run(APP_EXEC + ["node", "-e", js],
                          input=json.dumps({"source": source, "query": query}), capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise RuntimeError("client serialiser failed: " + proc.stderr[-300:])
    return json.loads(proc.stdout.strip().splitlines()[-1])


# --------------------------------------------------------------------------- cleanup

CLEANUP_SQL = r"""
CREATE TEMP TABLE _d AS SELECT id FROM deal WHERE label LIKE 'AUDIT-%';
CREATE TEMP TABLE _t AS SELECT id FROM task WHERE label LIKE 'AUDIT-%' OR deal_id IN (SELECT id FROM _d);
CREATE TEMP TABLE _c AS SELECT id FROM company WHERE name LIKE 'AUDIT-%';
CREATE TEMP TABLE _u AS SELECT id FROM "user" WHERE username LIKE 'AUDIT-%';
CREATE TEMP TABLE _col AS SELECT id FROM collection WHERE name LIKE 'AUDIT-%';
CREATE TEMP TABLE _s AS SELECT id FROM deal_stage WHERE collection_id IN (SELECT id FROM _col) OR name LIKE 'AUDIT-%';

DELETE FROM notification WHERE company_id IN (SELECT id FROM _c);
DELETE FROM event WHERE deal_id IN (SELECT id FROM _d) OR task_id IN (SELECT id FROM _t)
   OR (deal_id IS NULL AND (after_state::text LIKE '%AUDIT-%' OR before_state::text LIKE '%AUDIT-%'));
DELETE FROM task WHERE id IN (SELECT id FROM _t);
DELETE FROM deal_stage_record WHERE deal_id IN (SELECT id FROM _d) OR stage_id IN (SELECT id FROM _s);
DELETE FROM deal_file WHERE "dealId" IN (SELECT id FROM _d);
DELETE FROM file WHERE name LIKE 'AUDIT-%';
DELETE FROM deal WHERE id IN (SELECT id FROM _d);
DELETE FROM deal_stage WHERE id IN (SELECT id FROM _s);
DELETE FROM collection WHERE id IN (SELECT id FROM _col);
DELETE FROM filler WHERE field LIKE 'AUDIT-%';
DELETE FROM "user" WHERE id IN (SELECT id FROM _u);
DELETE FROM deal_product WHERE product_id IN (SELECT id FROM product WHERE name LIKE 'AUDIT-%');
DELETE FROM product WHERE name LIKE 'AUDIT-%';
DELETE FROM company WHERE id IN (SELECT id FROM _c);
"""

LEFTOVERS_SQL = r"""
SELECT 'deal', count(*) FROM deal WHERE label LIKE 'AUDIT-%'
UNION ALL SELECT 'task', count(*) FROM task WHERE label LIKE 'AUDIT-%'
UNION ALL SELECT 'company', count(*) FROM company WHERE name LIKE 'AUDIT-%'
UNION ALL SELECT 'user', count(*) FROM "user" WHERE username LIKE 'AUDIT-%'
UNION ALL SELECT 'product', count(*) FROM product WHERE name LIKE 'AUDIT-%'
UNION ALL SELECT 'collection', count(*) FROM collection WHERE name LIKE 'AUDIT-%'
UNION ALL SELECT 'deal_stage', count(*) FROM deal_stage WHERE name LIKE 'AUDIT-%'
UNION ALL SELECT 'filler', count(*) FROM filler WHERE field LIKE 'AUDIT-%'
UNION ALL SELECT 'file', count(*) FROM file WHERE name LIKE 'AUDIT-%'
UNION ALL SELECT 'event', count(*) FROM event WHERE after_state::text LIKE '%AUDIT-%' OR before_state::text LIKE '%AUDIT-%'
"""

ORIGINAL_ACTIVE_COLLECTION = None


def cleanup():
    # uploaded files: remove the physical file as well
    for row in sql("SELECT path FROM file WHERE name LIKE 'AUDIT-%'"):
        name = os.path.basename(row[0])
        target = os.path.join(UPLOADS_DIR, name)
        if name and os.path.isfile(target):
            try:
                os.remove(target)
            except OSError:
                pass

    if ORIGINAL_ACTIVE_COLLECTION:
        # never leave an AUDIT collection active
        sql("UPDATE collection SET is_active = (id = %d)" % ORIGINAL_ACTIVE_COLLECTION)

    sql(CLEANUP_SQL)


def leftovers():
    return {name: int(n) for name, n in sql(LEFTOVERS_SQL) if int(n) > 0}


# --------------------------------------------------------------------------- the run

def main():
    global TOKEN, ORIGINAL_ACTIVE_COLLECTION

    ORIGINAL_ACTIVE_COLLECTION = int(scalar("SELECT id FROM collection WHERE is_active = true ORDER BY id LIMIT 1"))
    cleanup()

    status, body = http("POST", "/auth/login", {"email": "admin@gmail.com", "password": env("ADMIN_PASSWORD")}, auth=False)
    if status not in (200, 201) or not isinstance(body, dict) or "access_token" not in body:
        raise SystemExit("login failed: HTTP %s" % status)
    TOKEN = body["access_token"]
    payload = TOKEN.split(".")[1]
    admin_id = int(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["sub"])

    # ----------------------------------------------------------------- fixtures (outside of the deals module)
    company_id = int(scalar("INSERT INTO company (name, email, phone, is_old) VALUES ('%s-co', 'audit-%s@example.com', '+998000000000', false) RETURNING id" % (P, RUN)))
    contact_id = int(scalar("INSERT INTO \"user\" (username, email, role, company_id) VALUES ('%s-contact', 'audit-contact-%s@example.com', 'ctr_agent', %d) RETURNING id" % (P, RUN, company_id)))
    product1 = int(scalar("INSERT INTO product (name) VALUES ('%s-prod-1') RETURNING id" % P))
    product2 = int(scalar("INSERT INTO product (name) VALUES ('%s-prod-2') RETURNING id" % P))
    f_deal1 = int(scalar("INSERT INTO filler (target, field) VALUES ('deal', '%s-field-deal-1') RETURNING id" % P))
    f_deal2 = int(scalar("INSERT INTO filler (target, field) VALUES ('deal', '%s-field-deal-2') RETURNING id" % P))
    f_user = int(scalar("INSERT INTO filler (target, field) VALUES ('user', '%s-field-user') RETURNING id" % P))
    f_company = int(scalar("INSERT INTO filler (target, field) VALUES ('company', '%s-field-company') RETURNING id" % P))
    sql("INSERT INTO user_filler (user_id, filler_id, value) VALUES (%d, %d, 'Tashkent audit')" % (contact_id, f_user))
    sql("INSERT INTO company_filler (company_id, filler_id, value) VALUES (%d, %d, 'UZ audit')" % (company_id, f_company))
    task_type_id = int(scalar("SELECT id FROM task_type ORDER BY id LIMIT 1"))

    status, stages = http("GET", "/stages")
    if status != 200:
        raise SystemExit("GET /stages -> %s" % status)
    by_name = {s["name"]: s["id"] for s in stages}
    stage_prepay = by_name[env("DEAL_STAGE_PREPAYMENT")]
    stage_created = by_name[env("DEAL_STAGE_CREATED")]
    stage_closed = by_name[env("DEAL_STAGE_CLOSED")]
    stage_unknown = by_name[env("DEAL_STAGE_UNKNOWN")]

    def create_deal(suffix, **extra):
        """POST /deals with the payload of the "new deal" form (pages/deals/main-tab.vue)."""
        payload = {
            "label": "%s-%s" % (P, suffix),
            "budget": 100,
            "agent_id": admin_id,
            "company_id": company_id,
            "ctr_agent_ids": [contact_id],
            "stage_id": stage_created,
            "fillers": [],
            "products": [],
        }
        payload.update(extra)
        payload = {k: v for k, v in payload.items() if v is not None}
        return http("POST", "/deals", payload)

    def form_patch(deal_id, label, **extra):
        """PATCH /deals/:id with the payload of the edit form (pages/deals/main-tab.vue)."""
        payload = {
            "label": label,
            "budget": 100,
            "agent_id": admin_id,
            "ctr_agent_ids": [contact_id],
            "company_id": company_id,
            "deal_stage_id": stage_created,
            "fillers_create": [],
            "fillers": [],
            "products": [],
        }
        payload.update(extra)
        return http("PATCH", "/deals/%d" % deal_id, payload)

    def stage_records(deal_id):
        return count("SELECT count(*) FROM deal_stage_record WHERE deal_id = %d" % deal_id)

    def stage_events(deal_id):
        return count("SELECT count(*) FROM event WHERE deal_id = %d AND type = %d" % (deal_id, EVENT_NEW_DEAL_STAGE))

    def deal_row(deal_id):
        row = sql("SELECT stage_id, company_id, agent_id, label, last_stage_change IS NOT NULL, closed_at IS NOT NULL, deleted_at IS NOT NULL FROM deal WHERE id = %d" % deal_id)[0]
        return {"stage": int(row[0]) if row[0] else None, "company": int(row[1]) if row[1] else None,
                "agent": int(row[2]) if row[2] else None, "label": row[3],
                "moved": row[4] == "t", "closed": row[5] == "t", "deleted": row[6] == "t"}

    def products_of(deal_id):
        return sql("SELECT id, product_id, quantity, price FROM deal_product WHERE deal_id = %d ORDER BY id" % deal_id)

    def orphan_products():
        return count("SELECT count(*) FROM deal_product WHERE deal_id IS NULL AND product_id IN (%d, %d)" % (product1, product2))

    def deals_count(query):
        status, body = http("GET", "/deals?" + query)
        if status != 200:
            return "HTTP %s %s" % (status, message_of((status, body)))
        return body["count"]

    def deal_ids(query):
        status, body = http("GET", "/deals?" + query)
        if status != 200:
            return "HTTP %s %s" % (status, message_of((status, body)))
        return sorted(d["id"] for d in body["data"])

    # ================================================================= migration / schema
    section("Schema")
    check("migration %s is applied" % MIGRATION, count("SELECT count(*) FROM migrations WHERE name = '%s'" % MIGRATION) == 1)
    check("deal.deleted_at column exists", count("SELECT count(*) FROM information_schema.columns WHERE table_name = 'deal' AND column_name = 'deleted_at'") == 1)
    check("deal.display_id has a unique index", count("SELECT count(*) FROM pg_indexes WHERE tablename = 'deal' AND indexdef ILIKE '%UNIQUE%display_id%'") == 1)

    # ================================================================= create
    section("Create deal")
    r = create_deal("main", products=[{"product_id": product1, "quantity": 2, "price": 50}],
                    fillers=[{"filler_id": f_deal1, "value": "alpha one"}, {"filler_id": f_deal2, "value": "beta two"}])
    check("POST /deals (form payload) -> 201", r[0] == 201, r)
    if r[0] != 201:
        raise SystemExit("cannot continue without a deal")
    D = r[1]["id"]
    D_display = r[1]["display_id"]
    check("new deal has one stage record", stage_records(D) == 1)
    check("new deal: NEW_PRODUCT event is linked to the deal",
          wait_for(lambda: count("SELECT count(*) FROM event WHERE deal_id = %d AND type = %d" % (D, EVENT_NEW_PRODUCT)), 1) == 1)

    r = create_deal("dup", display_id=D_display)
    check("POST /deals with an existing display_id -> 400", r[0] == 400, r)
    r = create_deal("nocompany", company_id=None, ctr_agent_ids=[])
    check("POST /deals without company (mail / telegram deals) -> 201", r[0] == 201, r)
    D_NOCO = r[1]["id"] if r[0] == 201 else None
    r = create_deal("nostage", stage_id=None)
    check("POST /deals without stage_id -> 201 in the default stage", r[0] == 201 and r[1].get("stage"), r)
    D_PLAIN = r[1]["id"] if r[0] == 201 else None
    # components/mail/AddDealModal.vue: empty label, no company, no contacts
    r = http("POST", "/deals", {"label": "", "budget": 0, "agent_id": admin_id, "ctr_agent_ids": [], "fillers": [], "products": [], "stage_id": stage_created})
    if r[0] == 201:
        # the label becomes "#<display_id>": rename at once so that the cleanup finds the row
        sql("UPDATE deal SET label = '%s-mail' WHERE id = %d" % (P, r[1]["id"]))
        sql("UPDATE deal SET deleted_at = now() WHERE id = %d" % r[1]["id"])
    check("POST /deals with the payload of the mail modal (empty label, no company) -> 201, label = #display_id",
          r[0] == 201 and r[1]["label"] == "#%s" % r[1]["display_id"], r)
    ids = sql("SELECT display_id FROM deal WHERE label LIKE '%s-%%'" % P)
    check("display_id values are distinct", len(ids) == len(set(tuple(i) for i in ids)), ids)

    # ================================================================= edit form: stage
    section("Edit form (PATCH /deals/:id): stage")
    keep_products = [{"product_id": product1, "quantity": 2, "price": 50}]
    before_products = products_of(D)
    r = form_patch(D, P + "-main", deal_stage_id=stage_prepay, products=keep_products)
    check("PATCH /deals/:id with a new deal_stage_id -> 200", r[0] == 200, r)
    row = deal_row(D)
    check("stage is changed", row["stage"] == stage_prepay, row)
    check("last_stage_change is set", row["moved"], row)
    check("exactly one new stage record", stage_records(D) == 2, stage_records(D))
    check("exactly one NEW_DEAL_STAGE event", wait_for(lambda: stage_events(D), 1) == 1, stage_events(D))
    prev = sql("SELECT moved_after_minutes FROM deal_stage_record WHERE deal_id = %d ORDER BY id LIMIT 1" % D)[0][0]
    check("previous record got its duration (0-1 min, not the time zone offset)", prev in ("0", "1"), prev)

    r = form_patch(D, P + "-main", deal_stage_id=stage_prepay, products=keep_products)
    check("second identical PATCH -> 200", r[0] == 200, r)
    time.sleep(1)
    check("second identical PATCH adds no stage record", stage_records(D) == 2, stage_records(D))
    check("second identical PATCH adds no NEW_DEAL_STAGE event", stage_events(D) == 1, stage_events(D))

    r = http("PATCH", "/deals/%d/stage" % D, {"stage_id": stage_created})
    check("PATCH /deals/:id/stage still works", r[0] == 200 and deal_row(D)["stage"] == stage_created and stage_records(D) == 3, r)
    r = http("PATCH", "/deals/%d/stage" % D, {"stage_id": stage_created})
    check("PATCH /deals/:id/stage with the same stage adds no record", r[0] == 200 and stage_records(D) == 3, stage_records(D))

    # ================================================================= edit form: products
    section("Edit form: products")
    check("edit does not duplicate products (same row is kept)", products_of(D) == before_products, (before_products, products_of(D)))
    check("edit leaves no orphan deal_product rows", orphan_products() == 0, orphan_products())
    r = form_patch(D, P + "-main", products=[{"product_id": product1, "quantity": 3, "price": 50}, {"product_id": product2, "quantity": 1, "price": 10}])
    rows = products_of(D)
    check("products: update quantity + add second product", r[0] == 200 and len(rows) == 2 and rows[0][0] == before_products[0][0] and rows[0][2] == "3", rows)
    r = form_patch(D, P + "-main", products=[{"product_id": product2, "quantity": 1, "price": 10}])
    rows = products_of(D)
    check("products: a product missing from the list is removed", r[0] == 200 and len(rows) == 1 and int(rows[0][1]) == product2, rows)
    check("products: removed product is deleted, not orphaned", orphan_products() == 0, orphan_products())
    r = http("PATCH", "/deals/%d" % D, {"agent_id": admin_id})
    check("partial PATCH {agent_id} (bulk 'change agent') keeps products, company, stage",
          r[0] == 200 and len(products_of(D)) == 1 and deal_row(D)["company"] == company_id and deal_row(D)["stage"] == stage_created, (r, deal_row(D)))

    # ================================================================= edit form: custom fields
    df = sql("SELECT id FROM deal_filler WHERE deal_id = %d AND filler_id = %d" % (D, f_deal1))
    r = form_patch(D, P + "-main", products=[{"product_id": product2, "quantity": 1, "price": 10}],
                   fillers=[{"deal_filler_id": int(df[0][0]), "value": "alpha changed"}])
    check("edit form updates a custom field value",
          r[0] == 200 and scalar("SELECT value FROM deal_filler WHERE id = %s" % df[0][0]) == "alpha changed", r)

    # ================================================================= edit form: errors
    section("Edit form: wrong ids")
    r = form_patch(99999999, P + "-x")
    check("PATCH /deals/<missing> -> 404", r[0] == 404, r)
    r = form_patch(D, P + "-main-renamed", company_id=99999999, deal_stage_id=stage_prepay, products=[{"product_id": product2, "quantity": 1, "price": 10}])
    row = deal_row(D)
    check("PATCH with a missing company_id -> 404", r[0] == 404, r)
    check("... and nothing is changed (company, label, stage)", row["company"] == company_id and row["label"] == P + "-main" and row["stage"] == stage_created, row)
    r = form_patch(D, P + "-main-renamed", deal_stage_id=99999999, products=[{"product_id": product2, "quantity": 1, "price": 10}])
    row = deal_row(D)
    check("PATCH with a missing deal_stage_id -> 404, nothing changed", r[0] == 404 and row["label"] == P + "-main" and stage_records(D) == 3, (r, row))
    r = http("GET", "/deals/99999999")
    check("GET /deals/<missing> -> 404", r[0] == 404, r)

    r = form_patch(D_PLAIN, P + "-nostage", deal_stage_id=stage_closed)
    check("moving to a closing stage through the form sets closed_at", r[0] == 200 and deal_row(D_PLAIN)["closed"], deal_row(D_PLAIN))

    # ================================================================= tasks
    section("Tasks (POST /tasks)")
    now = datetime.datetime.utcnow()

    def create_task(label, target, target_id, start, end):
        return http("POST", "/tasks", {
            "label": label, "type_id": task_type_id,
            "assign_to": {"target": "agent", "id": admin_id},
            "link_to": {"target": target, "id": target_id},
            "start_time": iso(start), "end_time": iso(end), "allDay": False,
        })

    notifications_before = count("SELECT count(*) FROM notification WHERE company_id = %d" % company_id)
    hour = datetime.timedelta(hours=1)
    for target, target_id in (("deal", D), ("ctr_agent", contact_id), ("company", company_id)):
        label = "%s-task-%s" % (P, target)
        # the deal task ended two hours ago: it is the "overdue" one for the filters below
        r = create_task(label, target, target_id, now - 3 * hour, now - 2 * hour)
        check("task linked to %s -> 201" % target, r[0] == 201, r)
        check("task linked to %s: exactly one row" % target, count("SELECT count(*) FROM task WHERE label = '%s'" % label) == 1)
    check("notification rows written for all three link targets",
          count("SELECT count(*) FROM notification WHERE company_id = %d" % company_id) == notifications_before + 3)
    if D_NOCO:
        r = create_task(P + "-task-nocompany", "deal", D_NOCO, now - hour, now + hour)
        check("task linked to a deal without company -> 201, one row", r[0] == 201 and count("SELECT count(*) FROM task WHERE label = '%s-task-nocompany'" % P) == 1, r)

    # ================================================================= comments
    section("Comments (POST /deals/:id/comments)")
    r = http("POST", "/deals/%d/comments" % D, {"comment": P + " json comment"})
    check("JSON body -> 201", r[0] == 201, r)
    raw, hdr = multipart({"comment": P + " multipart comment"})
    r = http("POST", "/deals/%d/comments" % D, raw=raw, headers=hdr)
    check("multipart without files -> 201", r[0] == 201, r)
    raw, hdr = multipart({"comment": P + " multipart comment with file"}, [("files", P + "-file.txt", b"audit")])
    r = http("POST", "/deals/%d/comments" % D, raw=raw, headers=hdr)
    check("multipart with a file -> 201, file linked to the deal",
          r[0] == 201 and count("SELECT count(*) FROM deal_file WHERE \"dealId\" = %d" % D) == 1, r)
    r = http("POST", "/deals/99999999/comments", {"comment": P + " json comment"})
    check("comment for a missing deal -> 404", r[0] == 404, r)

    # ================================================================= filters
    section("Filters (GET /deals)")
    live = [i for i in (D, D_NOCO, D_PLAIN) if i]
    lbl = "label=" + P
    check("display_id filter -> exactly that deal", deal_ids("display_id=%s" % D_display) == [D], deal_ids("display_id=%s" % D_display))
    r = http("GET", "/deals?display_id=abc")
    check("display_id=abc -> 400", r[0] == 400, r)
    check("label filter finds this run's deals", deal_ids(lbl + "&limit=100") == sorted(live), deal_ids(lbl + "&limit=100"))
    check("closed_before filters by closed_at (open deals excluded)", deal_ids(lbl + "&closed_before=2100-01-01") == [D_PLAIN], deal_ids(lbl + "&closed_before=2100-01-01"))
    check("closed_after + closed_before in the past -> nothing", deals_count(lbl + "&closed_after=2000-01-01&closed_before=2000-12-31") == 0)
    today = scalar("SELECT current_date")
    check("created_after = created_before = today (date picker range) includes today",
          deal_ids(lbl + "&created_after=%s&created_before=%s&limit=100" % (today, today)) == sorted(live))
    check("combined filters keep their own values: deal created_before=2000 & contact created_before=2100 -> nothing",
          deals_count(lbl + "&created_before=2000-01-01&ctr_agent[created_before]=2100-01-01") == 0)
    check("... and the other way round -> nothing",
          deals_count(lbl + "&created_before=2100-01-01&ctr_agent[created_before]=2000-01-01") == 0)
    check("... both in the future -> the deal with the contact",
          deal_ids(lbl + "&created_before=2100-01-01&ctr_agent[created_before]=2100-01-01&ctr_agent[username]=%s-contact" % P) == [D, D_PLAIN])
    check("company[name] is a case-insensitive substring search",
          deal_ids("company[name]=%s&limit=100" % (P.lower() + "-c")) == [D, D_PLAIN], deal_ids("company[name]=%s&limit=100" % (P.lower() + "-c")))
    check("agent[id] + agent[username] (same parameter name as contact username) work together",
          deal_ids(lbl + "&agent[id]=%d&agent[username]=adm&ctr_agent[username]=%s-contact" % (admin_id, P)) == [D, D_PLAIN])
    r = http("GET", "/deals?" + lbl + "&agent[fillers][0][id]=%d&agent[fillers][0][value]=x" % f_user)
    check("agent[fillers] does not crash -> 200", r[0] == 200, r)
    two = "&fillers[0][id]=%d&fillers[0][value]=alpha&fillers[1][id]=%d&fillers[1][value]=%s"
    check("two deal custom fields combined -> the deal", deal_ids(lbl + two % (f_deal1, f_deal2, "beta")) == [D], deal_ids(lbl + two % (f_deal1, f_deal2, "beta")))
    check("two deal custom fields, second does not match -> nothing", deals_count(lbl + two % (f_deal1, f_deal2, "zzz")) == 0)
    check("contact custom field filter", deal_ids(lbl + "&ctr_agent[fillers][0][id]=%d&ctr_agent[fillers][0][value]=tashkent" % f_user) == [D, D_PLAIN])
    check("company custom field filter", deal_ids(lbl + "&company[fillers][0][id]=%d&company[fillers][0][value]=uz" % f_company) == [D, D_PLAIN])
    check("stages[] filter", deal_ids(lbl + "&stages[]=%d" % stage_closed) == [D_PLAIN])
    # the query object pages/deals/index.vue (fetchDeals) builds when every filter group is filled,
    # turned into a query string by the client's own queryToString()
    page_object = {
        "limit": 25, "skip": 0, "sort": {"id": -1},
        "stages": [stage_created],
        "created_before": today, "created_after": today,
        "label": P,
        "ctr_agent": {"username": P + "-contact", "created_before": today, "created_after": "2000-01-01",
                      "fillers": {"0": {"id": f_user, "value": "Tashkent"}}},
        "company": {"name": P + "-co", "created_before": today, "created_after": "2000-01-01",
                    "fillers": {"0": {"id": f_company, "value": "UZ"}}},
        "fillers": {"0": {"id": f_deal1, "value": "alpha"}, "1": {"id": f_deal2, "value": "beta"}},
        "agent": {"id": admin_id},
        "budget_from": "1", "budget_till": "1000",
    }
    expected_query = (
        "limit=25&skip=0&sort[id]=-1&stages[]=%d&created_before=%s&created_after=%s&label=%s"
        "&ctr_agent[username]=%s-contact&ctr_agent[created_before]=%s&ctr_agent[created_after]=2000-01-01"
        "&ctr_agent[fillers][0][id]=%d&ctr_agent[fillers][0][value]=Tashkent"
        "&company[name]=%s-co&company[created_before]=%s&company[created_after]=2000-01-01"
        "&company[fillers][0][id]=%d&company[fillers][0][value]=UZ"
        "&fillers[0][id]=%d&fillers[0][value]=alpha&fillers[1][id]=%d&fillers[1][value]=beta"
        "&agent[id]=%d&budget_from=1&budget_till=1000"
    ) % (stage_created, today, today, P, P, today, f_user, P, today, f_company, f_deal1, f_deal2, admin_id)
    try:
        page_query = client_query_string(page_object)
    except Exception as error:
        page_query = "serialiser error: %s" % error
    check("client queryToString() turns the deals page filters into fillers[0][id]=.. (no [object Object])", page_query == expected_query, page_query)
    page_query = expected_query
    check("deals page query with every filter filled -> the deal", deal_ids(page_query) == [D], deal_ids(page_query))
    r = http("GET", "/deals?ctr_agent[fillers][]=%5Bobject%20Object%5D")
    check("the old broken shape fillers[]=[object Object] is rejected with 400 (not silently ignored)", r[0] == 400, r)
    r = http("GET", "/deals/stats?" + page_query)
    check("same query for /deals/stats -> 200", r[0] == 200, r)

    section("Task filters / statistics")
    check("tasks[]=overdue -> deal with an open task in the past", deal_ids(lbl + "&tasks[]=overdue") == [D], deal_ids(lbl + "&tasks[]=overdue"))
    check("tasks[]=no_task -> deals without tasks", deal_ids(lbl + "&tasks[]=no_task") == [D_PLAIN], deal_ids(lbl + "&tasks[]=no_task"))
    check("tasks[]=today -> deal with a task around now", D_NOCO in deal_ids(lbl + "&tasks[]=today"), deal_ids(lbl + "&tasks[]=today"))
    r = http("GET", "/deals?" + lbl + "&tasks[]=today&tasks[]=tomorrow&tasks[]=this_week&tasks[]=this_month&tasks[]=this_quarter&tasks[]=overdue&tasks[]=no_task&agent[fillers][0][id]=%d&agent[fillers][0][value]=x" % f_user)
    check("all task filters + agent custom field together -> 200", r[0] == 200, r)
    r = http("GET", "/deals/stats?" + lbl)
    stats = r[1][0] if r[0] == 200 and r[1] else {}
    check("stats: deals_with_overdue_tasks counts deals with open tasks in the past", str(stats.get("deals_with_overdue_tasks")) == "1", stats)
    check("stats: deals_without_tasks", str(stats.get("deals_without_tasks")) == "1", stats)

    # week range (pure function, checked for fixed dates inside the API container)
    js = (
        "require('reflect-metadata');"
        "const m=require(%s);" % json.dumps(APP_DIR + "/dist/deal/dto/search.deal.dto.js") +
        "const f=(t,d)=>m.getTaskDateRange(t,d).map(m.formatLocalTimestamp).join(' | ');"
        "console.log(JSON.stringify({"
        "sunday:f('this_week',new Date(2026,10,15,12)),"
        "month:f('this_week',new Date(2026,11,2,9)),"
        "year:f('this_week',new Date(2027,0,1,9)),"
        "monday:f('this_week',new Date(2026,10,9,0,0,0)),"
        "quarter:f('this_quarter',new Date(2026,10,14,9))}))"
    )
    proc = subprocess.run(APP_EXEC + ["node", "-e", js],
                          capture_output=True, text=True, encoding="utf-8")
    try:
        ranges = json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        ranges = {"error": (proc.stderr or proc.stdout)[-300:]}

    def week(day):
        monday = day - datetime.timedelta(days=day.weekday())
        return "%s 00:00:00.000 | %s 23:59:59.999" % (monday, monday + datetime.timedelta(days=6))

    check("this_week on a Sunday = Monday..Sunday of the same week", ranges.get("sunday") == week(datetime.date(2026, 11, 15)), ranges)
    check("this_week across a month boundary", ranges.get("month") == week(datetime.date(2026, 12, 2)), ranges)
    check("this_week across a year boundary", ranges.get("year") == week(datetime.date(2027, 1, 1)), ranges)
    check("this_week on a Monday starts that Monday", ranges.get("monday") == week(datetime.date(2026, 11, 9)), ranges)
    check("this_quarter ends at the end of its last day", ranges.get("quarter") == "2026-10-01 00:00:00.000 | 2026-12-31 23:59:59.999", ranges)

    # ================================================================= sorting / pagination
    section("Sorting")
    r = http("GET", "/deals?sort[anything_unknown]=1")
    check("unknown sort column -> 400 (not 500)", r[0] == 400, r)
    r = http("GET", "/deals?sort[id; DROP TABLE deal;--]=1")
    check("injection-looking sort key -> 400", r[0] == 400, r)
    r = http("GET", "/deals?sort[id) DESC, (SELECT 1]=1")
    check("another injection-looking sort key -> 400", r[0] == 400, r)
    r = http("GET", "/deals?sort[id]=sideways")
    check("unknown sort direction -> 400", r[0] == 400, r)
    r = http("GET", "/deals?sort=id")
    check("sort that is not an object -> 400", r[0] == 400, r)
    r = http("GET", "/users?sort[password]=1")
    check("hidden column (users.password) is not sortable -> 400", r[0] == 400, r)
    check("deal table is intact after the injection attempts", count("SELECT count(*) FROM deal") > 0)
    valid = [
        "/deals?sort[id]=-1", "/deals?sort[label]=1", "/deals?sort[stage]=1", "/deals?sort[budget]=-1", "/deals?sort[created_at]=-1",
        "/companies?sort[id]=-1", "/companies?sort[name]=1", "/companies?sort[deal_count]=-1",
        "/tasks?sort[id]=-1", "/tasks?sort[end_time]=1",
        "/users?sort[id]=-1", "/users?sort[username]=1",
        "/products?sort[id]=-1", "/products?sort[name]=1",
        "/emails?sort[sent_at]=-1", "/files?sort[id]=-1", "/logs?sort[id]=-1",
        "/deals/%d/events?sort[id]=-1&skip=0&limit=10" % D,
        "/contacts?sort[email]=1",
    ]
    for path in valid:
        r = http("GET", path + ("&" if "?" in path else "?") + "limit=5" if "limit=" not in path else path)
        check("valid sort still works: GET %s -> 200" % path.split("&")[0], r[0] == 200, r)
    r = http("GET", "/deals?" + lbl + "&sort[id]=1&limit=100")
    asc = [d["id"] for d in r[1]["data"]] if r[0] == 200 else []
    r = http("GET", "/deals?" + lbl + "&sort[id]=-1&limit=100")
    desc = [d["id"] for d in r[1]["data"]] if r[0] == 200 else []
    check("sort[id]=1 / -1 really orders the rows", asc == sorted(live) and desc == sorted(live, reverse=True), (asc, desc))
    r = http("GET", "/deals/%d/events?sort[id]=-1&skip=0&limit=50&exclude_event_types[]=%d" % (D, EVENT_NEW_DEAL_STAGE))
    check("deal events: exclude_event_types[] (deal page filter) is applied",
          r[0] == 200 and r[1]["count"] > 0 and all(e["type"] != EVENT_NEW_DEAL_STAGE for e in r[1]["data"]), r)

    section("Pagination")
    for bad in ("1001", "100000", "0", "-5", "abc", "1.5"):
        r = http("GET", "/deals?limit=" + bad)
        check("limit=%s -> 400" % bad, r[0] == 400, r)
    r = http("GET", "/deals?skip=-1")
    check("skip=-1 -> 400", r[0] == 400, r)
    r = http("GET", "/users?limit=1000")
    check("limit=1000 (dictionaries on the client) -> 200", r[0] == 200 and r[1]["page_size"] == 1000, r)
    n = len(live)
    r = http("GET", "/deals?" + lbl + "&limit=%d" % n)
    check("last_page: %d rows by %d -> 1 page" % (n, n), r[0] == 200 and r[1]["count"] == n and r[1]["last_page"] == 1, r[1] if r[0] != 200 else {k: r[1][k] for k in ("count", "page_size", "current_page", "last_page")})
    r = http("GET", "/deals?" + lbl + "&limit=1")
    check("last_page: %d rows by 1 -> %d pages" % (n, n), r[0] == 200 and r[1]["last_page"] == n and r[1]["page_size"] == 1, r)
    r = http("GET", "/deals?" + lbl + "&limit=%d&skip=%d" % (n - 1, n - 1))
    check("last_page: %d rows by %d -> 2 pages, second page has 1 row" % (n, n - 1),
          r[0] == 200 and r[1]["last_page"] == 2 and r[1]["current_page"] == 2 and len(r[1]["data"]) == 1, r)
    r = http("GET", "/deals?" + lbl + "-nothing-like-this")
    check("last_page: 0 rows -> 1 page", r[0] == 200 and r[1]["count"] == 0 and r[1]["last_page"] == 1, r)
    r = http("GET", "/deals?" + lbl)
    check("no limit -> default page size 25", r[0] == 200 and r[1]["page_size"] == 25, r)

    # ================================================================= stages / collections
    section("Stages and collections")
    r = http("POST", "/stages/collections", {"name": P + "-coll-A"})
    check("create collection -> 201", r[0] == 201, r)
    coll_a = r[1]["id"]
    orders = sorted(s["order"] for s in r[1]["deal_stages"])
    check("system stages of a new collection get orders 1..5", orders == [1, 2, 3, 4, 5], orders)
    r = http("POST", "/stages/collections", {"name": P + "-coll-B"})
    coll_b = r[1]["id"]

    def stage_orders(collection):
        return [int(x[0]) for x in sql("SELECT \"order\" FROM deal_stage WHERE collection_id = %d ORDER BY \"order\"" % collection)]

    # payload of pages/settings/deals/index.vue
    r = http("POST", "/stages", {"name": "AUDIT-stage-1", "order": 2, "description": None, "color": "#D5D8DB", "collection_id": coll_a})
    check("create stage at a taken position -> 201 at that position", r[0] == 201 and r[1]["order"] == 2, r)
    stage_x = r[1]["id"] if r[0] == 201 else None
    check("orders stay unique inside the collection (others moved)", stage_orders(coll_a) == [1, 2, 3, 4, 5, 6], stage_orders(coll_a))
    r = http("POST", "/stages", {"name": "AUDIT-stage-1", "order": 2, "description": None, "color": "#D5D8DB", "collection_id": coll_b})
    check("same name and order in ANOTHER collection -> 201", r[0] == 201, r)
    stage_other = r[1]["id"] if r[0] == 201 else None
    check("collection A is not touched by a stage of collection B", stage_orders(coll_a) == [1, 2, 3, 4, 5, 6], stage_orders(coll_a))
    r = http("POST", "/stages", {"name": "AUDIT-stage-1", "order": 30, "color": "#D5D8DB", "collection_id": coll_a})
    check("same name in the same collection -> 400", r[0] == 400, r)
    r = http("POST", "/stages", {"name": "AUDIT-stage-2", "color": "#D5D8DB", "collection_id": coll_a})
    check("create stage without order -> appended to the end", r[0] == 201 and r[1]["order"] == 7, r)
    stage_y = r[1]["id"] if r[0] == 201 else None
    r = http("POST", "/stages", {"name": "AUDIT-stage-3", "color": "#D5D8DB", "collection_id": coll_a})
    stage_free = r[1]["id"] if r[0] == 201 else None
    r = http("DELETE", "/stages/%s" % stage_free)
    check("delete an unused stage -> 200", r[0] == 200 and count("SELECT count(*) FROM deal_stage WHERE id = %s" % stage_free) == 0, r)

    # pages/settings/deals/index.vue on save: PATCH every stage with its position in the list
    order_before = sql("SELECT id, name FROM deal_stage WHERE collection_id = %d ORDER BY \"order\", id" % coll_a)
    reordered = list(reversed(order_before))
    statuses = []
    for position, (stage_id, name) in enumerate(reordered):
        new_name = "AUDIT-stage-2 renamed" if name == "AUDIT-stage-2" else name
        r = http("PATCH", "/stages/%s" % stage_id, {"name": new_name, "order": position, "description": None, "color": "#99ccff", "collection_id": coll_a})
        statuses.append(r[0])
    order_after = [row[0] for row in sql("SELECT id FROM deal_stage WHERE collection_id = %d ORDER BY \"order\", id" % coll_a)]
    check("reorder stages (PATCH /stages/:id for every stage) -> 200 each, new order is stored",
          set(statuses) == {200} and order_after == [row[0] for row in reordered], (statuses, order_after))
    check("custom stage can be renamed", scalar("SELECT name FROM deal_stage WHERE id = %d" % stage_y) == "AUDIT-stage-2 renamed")
    r = http("PATCH", "/stages/%d" % stage_y, {"name": "AUDIT-stage-1", "order": 0, "color": "#99ccff", "collection_id": coll_a})
    check("rename to a name taken in the same collection -> 400", r[0] == 400, r)
    system_id = int(scalar("SELECT id FROM deal_stage WHERE collection_id = %d AND name = '%s'" % (coll_a, env("DEAL_STAGE_CLOSED"))))
    r = http("PATCH", "/stages/%d" % system_id, {"name": "AUDIT-renamed-system", "order": 3, "color": "#99ccff", "collection_id": coll_a})
    check("system stage keeps its name on PATCH", r[0] == 200 and scalar("SELECT name FROM deal_stage WHERE id = %d" % system_id) == env("DEAL_STAGE_CLOSED"), r)

    r = create_deal("stage", stage_id=stage_x)
    D_STAGE = r[1]["id"]
    r = http("DELETE", "/stages/%d" % stage_x)
    check("delete a stage with a deal -> 400 with the reason", r[0] == 400 and "1 deal(s)" in message_of(r), r)
    http("PATCH", "/deals/%d/stage" % D_STAGE, {"stage_id": stage_y})
    r = http("DELETE", "/stages/%d" % stage_x)
    check("delete a stage with history only -> 400 with the reason", r[0] == 400 and "history" in message_of(r) and "move_to" in message_of(r), r)
    r = http("DELETE", "/stages/%d?move_to=%d" % (stage_x, stage_other))
    check("move_to a stage of another collection -> 400", r[0] == 400, r)
    r = http("DELETE", "/stages/%d?move_to=%d" % (stage_x, stage_x))
    check("move_to the same stage -> 400", r[0] == 400, r)
    http("PATCH", "/deals/%d/stage" % D_STAGE, {"stage_id": stage_x})
    r = http("DELETE", "/stages/%d?move_to=%d" % (stage_x, stage_y))
    check("delete with ?move_to=<stage> -> 200", r[0] == 200, r)
    check("... the stage is gone, its deal and history are in the target stage",
          count("SELECT count(*) FROM deal_stage WHERE id = %d" % stage_x) == 0
          and deal_row(D_STAGE)["stage"] == stage_y
          and count("SELECT count(*) FROM deal_stage_record WHERE deal_id = %d AND stage_id = %d" % (D_STAGE, stage_y)) == stage_records(D_STAGE))
    system_stage = int(scalar("SELECT id FROM deal_stage WHERE collection_id = %d AND name = '%s'" % (coll_a, env("DEAL_STAGE_UNKNOWN"))))
    r = http("DELETE", "/stages/%d" % system_stage)
    check("delete a system stage -> 400", r[0] == 400, r)
    r = http("DELETE", "/stages/99999999")
    check("delete a missing stage -> 404", r[0] == 404, r)
    r = http("DELETE", "/stages/%d/triggers/99999999" % stage_y)
    check("settings page trigger delete URL /stages/<id>/triggers/<id> reaches the trigger route", r[0] == 404 and "Trigger" in message_of(r), r)

    r = http("DELETE", "/stages/collections/%d" % coll_a)
    check("delete a collection with deals / history -> 400 with the reason", r[0] == 400 and "deal(s)" in message_of(r), r)
    r = http("DELETE", "/stages/collections/%d" % coll_b)
    check("delete an unused inactive collection -> 200", r[0] == 200 and count("SELECT count(*) FROM collection WHERE id = %d" % coll_b) == 0, r)
    r = http("DELETE", "/stages/collections/99999999")
    check("delete a missing collection -> 404", r[0] == 404, r)

    r = http("POST", "/stages/collections", {"name": P + "-coll-C"})
    coll_c = r[1]["id"]
    try:
        r = http("PATCH", "/stages/collections/%d/activate" % coll_c, {})
        active = sql("SELECT id FROM collection WHERE is_active = true")
        check("activate a collection -> 200, exactly one active", r[0] == 200 and active == [[str(coll_c)]], (r, active))
        r = http("GET", "/stages")
        check("GET /stages returns stages of the active collection",
              r[0] == 200 and len(r[1]) == 5 and count("SELECT count(*) FROM deal_stage WHERE collection_id = %d" % coll_c) == 5, r)
        r = http("DELETE", "/stages/collections/%d" % coll_c)
        check("delete the ACTIVE collection -> 400", r[0] == 400 and "active" in message_of(r), r)
        check("... and it still exists and is active", sql("SELECT id FROM collection WHERE is_active = true") == [[str(coll_c)]])
        check("existing deals stay in the stages of the previous collection", deal_row(D)["stage"] == stage_created, deal_row(D))
        r = http("PATCH", "/stages/collections/%d/activate" % coll_c, {})
        check("activating the active collection again -> 200", r[0] == 200, r)
    finally:
        r = http("PATCH", "/stages/collections/%d/activate" % ORIGINAL_ACTIVE_COLLECTION, {})
    check("re-activate the original collection -> 200, exactly one active",
          r[0] == 200 and sql("SELECT id FROM collection WHERE is_active = true") == [[str(ORIGINAL_ACTIVE_COLLECTION)]], r)
    r = http("PATCH", "/stages/collections/99999999/activate", {})
    check("activate a missing collection -> 404 and the active one is kept",
          r[0] == 404 and sql("SELECT id FROM collection WHERE is_active = true") == [[str(ORIGINAL_ACTIVE_COLLECTION)]], r)

    # ================================================================= delete
    section("Delete deal (soft delete)")
    wait_for(lambda: count("SELECT count(*) FROM event WHERE deal_id = %d AND type = 6" % D), 1)
    history_sql = ("SELECT (SELECT count(*) FROM deal_stage_record WHERE deal_id = %d), (SELECT count(*) FROM event WHERE deal_id = %d), "
                   "(SELECT count(*) FROM task WHERE deal_id = %d), (SELECT count(*) FROM deal_file WHERE \"dealId\" = %d), "
                   "(SELECT count(*) FROM deal_product WHERE deal_id = %d), (SELECT count(*) FROM deal_filler WHERE deal_id = %d)") % ((D,) * 6)
    before = sql(history_sql)[0]
    check("the deal has history to keep (records, events, task, file, product, fields)", all(int(x) > 0 for x in before), before)
    r = http("GET", "/tasks?deal_id=%d" % D)
    check("before delete the task of the deal is listed", r[0] == 200 and r[1]["count"] == 1, r)

    r = http("DELETE", "/deals/%d" % D)
    check("DELETE /deals/:id -> 200/204", r[0] in (200, 204), r)
    r = http("GET", "/deals/%d" % D)
    check("GET /deals/:id -> 404", r[0] == 404, r)
    check("deal is gone from GET /deals (list and kanban)", D not in deal_ids(lbl + "&limit=100"), deal_ids(lbl + "&limit=100"))
    check("deal is gone from the display_id search", deals_count("display_id=%s" % D_display) == 0)
    r = http("GET", "/deals/stats?" + lbl)
    stats = r[1][0] if r[0] == 200 and r[1] else {}
    check("deal is gone from statistics (overdue 1 -> 0)", str(stats.get("deals_with_overdue_tasks")) == "0", stats)
    check("row is kept with deleted_at", deal_row(D)["deleted"], deal_row(D))
    check("history rows still exist (stage records, events, tasks, files, products, fields)", sql(history_sql)[0] == before, (before, sql(history_sql)[0]))
    r = http("GET", "/deals/%d/events" % D)
    check("GET /deals/:id/events of a deleted deal -> 404", r[0] == 404, r)
    r = http("GET", "/tasks?deal_id=%d" % D)
    check("tasks of a deleted deal are not listed", r[0] == 200 and r[1]["count"] == 0, r)
    r = http("DELETE", "/deals/%d" % D)
    check("second DELETE -> 404", r[0] == 404, r)
    r = form_patch(D, P + "-main")
    check("PATCH a deleted deal -> 404", r[0] == 404, r)
    r = http("PATCH", "/deals/%d/stage" % D, {"stage_id": stage_prepay})
    check("PATCH /stage of a deleted deal -> 404", r[0] == 404, r)
    r = create_deal("reuse", display_id=D_display)
    check("display_id of a deleted deal cannot be reused -> 400", r[0] == 400, r)
    r = http("DELETE", "/deals/99999999")
    check("DELETE /deals/<missing> -> 404", r[0] == 404, r)
    http("DELETE", "/deals/%d" % D_STAGE)
    r = http("DELETE", "/stages/%d" % stage_y)
    check("a stage with only a DELETED deal -> 400 with the reason (no 500)", r[0] == 400 and "deleted deal(s)" in message_of(r), r)


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
            active = sql("SELECT id FROM collection WHERE is_active = true")
            check("the original collection is active", active == [[str(ORIGINAL_ACTIVE_COLLECTION)]], active)
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
