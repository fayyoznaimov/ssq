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
* Stages are found by their kind (deal_stage.kind: new, first_contact, prepayment, won, lost, work),
  not by the DEAL_STAGE_* names of .env (migration 1795620000000-deal-stage-kind).
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


def http_as(token, method, path, body=None):
    """http() with the token of another user (an agent of the ACL checks)."""
    global TOKEN
    saved = TOKEN
    TOKEN = token
    try:
        return http(method, path, body)
    finally:
        TOKEN = saved


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
    # only the two serialiser functions: the rest of the file uses Nuxt auto-imports (ref, ...) that plain node lacks
    start = text.index("function subQueryToString")
    end = re.compile(r"\n\}\r?\n").search(text, text.index("export function queryToString", start)).end()
    source = text[start:end]
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
DELETE FROM deal_user WHERE "userId" IN (SELECT id FROM _u);
DELETE FROM "user" WHERE id IN (SELECT id FROM _u);
DELETE FROM "group" WHERE name LIKE 'AUDIT-chk-%';
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
# setting rows (id, default_stage_id) before the run: «Этап для новых сделок» is changed by the run and put back
ORIGINAL_SETTINGS = None


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

    if ORIGINAL_SETTINGS is not None:
        # the stage for new deals as it was (PATCH /stages/default and the activation of a collection move it)
        for setting_id, stage_id in ORIGINAL_SETTINGS:
            sql("UPDATE setting SET default_stage_id = %s WHERE id = %s" % (stage_id or "NULL", setting_id))
        known = ",".join(str(setting_id) for setting_id, _ in ORIGINAL_SETTINGS) or "0"
        sql("DELETE FROM setting WHERE id NOT IN (%s)" % known)

    sql(CLEANUP_SQL)


def leftovers():
    return {name: int(n) for name, n in sql(LEFTOVERS_SQL) if int(n) > 0}


# --------------------------------------------------------------------------- the run

def main():
    global TOKEN, ORIGINAL_ACTIVE_COLLECTION, ORIGINAL_SETTINGS

    ORIGINAL_ACTIVE_COLLECTION = int(scalar("SELECT id FROM collection WHERE is_active = true ORDER BY id LIMIT 1"))
    ORIGINAL_SETTINGS = [(int(row[0]), row[1]) for row in sql("SELECT id, COALESCE(default_stage_id::text, '') FROM setting ORDER BY id")]
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
    # the meaning of a stage is its kind: GET /stages gives it (the names are labels)
    by_kind = {s.get("kind"): s["id"] for s in stages if s.get("kind") and s.get("kind") != "work"}
    missing = [kind for kind in ("new", "first_contact", "prepayment", "won", "lost") if kind not in by_kind]
    if missing:
        raise SystemExit("GET /stages: no stage of kind %s (migration 1795620000000-deal-stage-kind?)" % ", ".join(missing))
    stage_prepay = by_kind["prepayment"]
    stage_created = by_kind["first_contact"]
    stage_closed = by_kind["won"]
    stage_unknown = by_kind["new"]

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
    for name in ("DealClosedAt1795220000000", "DefaultStageActive1795220000100", "CompanyIsOldRestore1795220000200",
                 "DealStageKind1795620000000", "DealAmountsNumeric1795620000100"):
        check("migration %s is applied" % name, count("SELECT count(*) FROM migrations WHERE name = '%s'" % name) == 1)
    check("closed_at follows the stage: no deal of a working stage is marked closed",
          count("SELECT count(*) FROM deal d JOIN deal_stage s ON s.id = d.stage_id WHERE d.closed_at IS NOT NULL AND s.kind NOT IN ('won', 'lost')") == 0)
    check("... and no live deal of a closing stage is open",
          count("SELECT count(*) FROM deal d JOIN deal_stage s ON s.id = d.stage_id WHERE d.closed_at IS NULL AND d.deleted_at IS NULL AND s.kind IN ('won', 'lost')") == 0)
    # K10: every pipeline has exactly one stage of each system kind
    bad = sql("SELECT c.id, k.kind, count(s.id) FROM collection c CROSS JOIN (VALUES ('new'), ('first_contact'), ('prepayment'), ('won'), ('lost')) k(kind) "
              "LEFT JOIN deal_stage s ON s.collection_id = c.id AND s.kind = k.kind GROUP BY 1, 2 HAVING count(s.id) <> 1")
    check("every pipeline has one stage of each system kind (new, first_contact, prepayment, won, lost)", bad == [], bad)
    types = dict(sql("SELECT table_name || '.' || column_name, data_type FROM information_schema.columns "
                     "WHERE (table_name, column_name) IN (('deal', 'budget'), ('deal_product', 'quantity'), ('deal_product', 'price'))"))
    check("deal.budget, deal_product.quantity / price are numeric (metres, cents)",
          types == {"deal.budget": "numeric", "deal_product.quantity": "numeric", "deal_product.price": "numeric"}, types)

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
    last = sql("SELECT COALESCE(from_stage_id::text, ''), COALESCE(moved_by::text, '') FROM deal_stage_record WHERE deal_id = %d ORDER BY id DESC LIMIT 1" % D)
    check("the stage record says from which stage and who moved the deal", last == [[str(stage_created), str(admin_id)]], last)
    first = sql("SELECT COALESCE(from_stage_id::text, ''), COALESCE(moved_by::text, '') FROM deal_stage_record WHERE deal_id = %d ORDER BY id LIMIT 1" % D)
    check("... the first record of a deal: no previous stage, its creator", first == [["", str(admin_id)]], first)
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
    last = sql("SELECT from_stage_id, moved_by FROM deal_stage_record WHERE deal_id = %d ORDER BY id DESC LIMIT 1" % D)
    check("... the kanban move is recorded from the previous stage, by the user", last == [[str(stage_prepay), str(admin_id)]], last)
    r = http("PATCH", "/deals/%d/stage" % D, {"stage_id": stage_created})
    check("PATCH /deals/:id/stage with the same stage adds no record", r[0] == 200 and stage_records(D) == 3, stage_records(D))

    # ================================================================= edit form: products
    section("Edit form: products")
    check("edit does not duplicate products (same row is kept)", products_of(D) == before_products, (before_products, products_of(D)))
    check("edit leaves no orphan deal_product rows", orphan_products() == 0, orphan_products())
    r = form_patch(D, P + "-main", products=[{"product_id": product1, "quantity": 3, "price": 50}, {"product_id": product2, "quantity": 1, "price": 10}])
    rows = products_of(D)
    check("products: update quantity + add second product", r[0] == 200 and len(rows) == 2 and rows[0][0] == before_products[0][0] and float(rows[0][2]) == 3, rows)  # numeric(14,3): "3.000"
    # the history says which product the quantity is of (it said «quantity: 2 → 3» of no product, DEAL-9)
    change = []
    for _ in range(10):  # the history is written by an event listener, right after the answer
        change = sql("SELECT after_state->'data'->>'subject', after_state->'data'->>'old_value', after_state->'data'->>'new_value' FROM event "
                     "WHERE deal_id = %d AND after_state->'data'->>'field' = 'quantity' ORDER BY id DESC LIMIT 1" % D)
        if change:
            break
        time.sleep(0.5)
    check("... the quantity change in the history names the product", change == [[P + "-prod-1", "2", "3"]], change)
    # DB-7: fabric is sold by the metre and the kilo, prices have cents (bigint answered 500)
    r = form_patch(D, P + "-main", budget=1250.5, products=[{"product_id": product1, "quantity": 12.5, "price": 1250.75},
                                                            {"product_id": product2, "quantity": 1, "price": 10}])
    stored = sql("SELECT quantity::text, price::text FROM deal_product WHERE deal_id = %d AND product_id = %d" % (D, product1))
    check("12.5 metres at 1250.75 and a budget of 1250.50 -> 200, stored as they are",
          r[0] == 200 and stored == [["12.500", "1250.75"]] and scalar("SELECT budget::text FROM deal WHERE id = %d" % D) == "1250.50", (r, stored))
    r = http("GET", "/deals/%d" % D)
    line = [p for p in (r[1] or {}).get("deal_products", []) if (p.get("product") or {}).get("id") == product1] if r[0] == 200 else []
    check('... GET /deals/:id gives them as text without trailing zeros ("12.5", "1250.75", "1250.5")',
          r[0] == 200 and r[1].get("budget") == "1250.5" and line and line[0]["quantity"] == "12.5" and line[0]["price"] == "1250.75",
          r[1] if r[0] == 200 else r)
    r = form_patch(D, P + "-main", products=[{"product_id": product1, "quantity": 1.2345, "price": 10}])
    check("4 decimals of a quantity -> 400 (numeric(14,3)), not 500", r[0] == 400, r)
    r = form_patch(D, P + "-main", products=[{"product_id": product1, "quantity": 1, "price": -5}])
    check("a negative price -> 400", r[0] == 400, r)
    r = form_patch(D, P + "-main", budget=10.555)
    check("a budget with 3 decimals -> 400", r[0] == 400, r)
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

    # ================================================================= edit form: the company of the deal
    section("Edit form: the company of the deal")
    # the deal form saves the company only when its fields were changed and never sends «Старый клиент»;
    # it used to send is_old: false (a repeat client became "new") and {company_filler_id, value} (-> 400)
    sql("UPDATE company SET is_old = true WHERE id = %d" % company_id)
    cf = int(scalar("SELECT id FROM company_filler WHERE company_id = %d AND filler_id = %d" % (company_id, f_company)))
    r = http("PATCH", "/companies/%d" % company_id, {
        "name": P + "-co", "email": "audit-%s@example.com" % RUN, "phone": "+998000000000",
        "fillers": [{"id": cf, "company_filler_id": cf, "value": "UZ audit"}], "fillers_create": [],
    })
    time.sleep(1)
    check("PATCH /companies/:id with the deal form's payload -> 200, «Старый клиент» is kept",
          r[0] == 200 and scalar("SELECT is_old FROM company WHERE id = %d" % company_id) == "t", r)
    check("... and no «is_old» change in the history of the company's deals",
          count("SELECT count(*) FROM event e JOIN deal d ON d.id = e.deal_id WHERE d.company_id = %d "
                "AND e.after_state -> 'data' ->> 'field' = 'is_old'" % company_id) == 0)
    sql("UPDATE company SET is_old = false WHERE id = %d" % company_id)
    # the company field cleared in the form: company_id: null takes the company off the deal
    r = create_deal("company-off")
    off = r[1]["id"] if r[0] == 201 else None
    r = form_patch(off, P + "-company-off", company_id=None) if off else r
    check("PATCH {company_id: null} -> the deal has no company", off and r[0] == 200 and deal_row(off)["company"] is None, (r, off and deal_row(off)))
    if off:
        http("DELETE", "/deals/%d" % off)

    # ================================================================= ACL-4: linking what one may not see
    section("Linking a company / contact the user may not see (ACL-4)")
    group_id = int(scalar("INSERT INTO \"group\" (name) VALUES ('%s-g') RETURNING id" % P))
    # «create» has only two levels: 0 (banned) or 3 (allowed); 1/2 (own / group) are for view, update, delete, export
    own_perms = {"deal": {"view": 1, "create": 3, "update": 1, "delete": 0, "export": 0},
                 "contact": {"view": 1, "create": 3, "update": 1, "delete": 0, "export": 0},
                 "company": {"view": 1, "create": 3, "update": 1, "delete": 0, "export": 0},
                 "task": {"update": 1, "delete": 1}, "mail": False, "file": True}
    agent_email, agent_password = "audit-chk-%s-own@example.test" % RUN, "Audit-%s-own" % RUN
    r = http("POST", "/users", {"email": agent_email, "password": agent_password, "username": P + "-own",
                                "role": "agent", "group_id": group_id, "permissions": own_perms})
    check("an agent who sees only his own -> 201", r[0] == 201, r)
    agent_id = r[1]["id"] if r[0] == 201 else None
    login = http("POST", "/auth/login", {"email": agent_email, "password": agent_password}, auth=False) if agent_id else (0, None)
    agent_token = login[1].get("access_token") if login[0] in (200, 201) and isinstance(login[1], dict) else None
    check("... and logs in", agent_token, login)
    if agent_token:
        hidden_co = int(scalar("INSERT INTO company (name, is_old) VALUES ('%s-hidden-co', false) RETURNING id" % P))
        hidden_ct = int(scalar("INSERT INTO \"user\" (username, role) VALUES ('%s-hidden-contact', 'ctr_agent') RETURNING id" % P))
        check("the agent does not see the company", http_as(agent_token, "GET", "/companies/%d" % hidden_co)[0] == 404)
        r = http_as(agent_token, "GET", "/contacts?name=" + urllib.parse.quote(P + "-hidden"))
        names = [c.get("name") for c in (r[1] or {}).get("data", [])] if r[0] == 200 else r
        check("... and the pickers (GET /contacts) do not offer them", r[0] == 200 and names == [], names)
        r = http_as(agent_token, "POST", "/deals", {"label": P + "-acl", "budget": 0, "agent_id": agent_id, "ctr_agent_ids": [],
                                                   "fillers": [], "products": [], "stage_id": stage_created})
        check("the agent creates his own deal -> 201", r[0] == 201, r)
        mine = r[1]["id"] if r[0] == 201 else None
        if mine:
            r = http_as(agent_token, "PATCH", "/deals/%d" % mine, {"company_id": hidden_co})
            check("PATCH his deal {company_id: <not visible>} -> 404", r[0] == 404, r)
            check("... the company is not linked and still not visible to him",
                  deal_row(mine)["company"] is None and http_as(agent_token, "GET", "/companies/%d" % hidden_co)[0] == 404)
            r = http_as(agent_token, "PATCH", "/deals/%d" % mine, {"ctr_agent_ids": [hidden_ct]})
            check("PATCH his deal {ctr_agent_ids: [<not visible>]} -> 404, not linked",
                  r[0] == 404 and count("SELECT count(*) FROM deal_user WHERE \"dealId\" = %d" % mine) == 0, r)
            r = http_as(agent_token, "POST", "/deals", {"label": P + "-acl-2", "budget": 0, "agent_id": agent_id, "company_id": hidden_co,
                                                       "ctr_agent_ids": [hidden_ct], "fillers": [], "products": [], "stage_id": stage_created})
            check("POST /deals with a company and a contact he does not see -> 404", r[0] == 404, r)
            # the admin links them: the agent keeps saving his deal with what it already has
            r = http("PATCH", "/deals/%d" % mine, {"company_id": hidden_co, "ctr_agent_ids": [hidden_ct]})
            check("the admin links them -> 200", r[0] == 200, r)
            r = http_as(agent_token, "PATCH", "/deals/%d" % mine, {"company_id": hidden_co, "ctr_agent_ids": [hidden_ct], "budget": 5})
            check("... then the agent saves his deal with the links it already has -> 200", r[0] == 200, r)
            change = wait_for(lambda: count("SELECT count(*) FROM event WHERE deal_id = %d AND after_state::text LIKE '%%%s-hidden-co%%'" % (mine, P)) > 0, True)
            check("... the change of the company is in the history of the deal", change)
            http("DELETE", "/deals/%d" % mine)

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

    # a deal taken back to work is open again: messages, calls, letters, triggers, the autopilot and
    # «клиент ждёт» read closed_at IS NULL as open (closed_at used to stay forever)
    r = http("PATCH", "/deals/%d/stage" % D_PLAIN, {"stage_id": stage_created})
    check("taken back from a closing stage (kanban) -> closed_at is cleared", r[0] == 200 and not deal_row(D_PLAIN)["closed"], deal_row(D_PLAIN))
    check("... and the «Закрыты» filter (closed_before) no longer lists it",
          deal_ids("ids=%d&closed_before=2100-01-01" % D_PLAIN) == [], deal_ids("ids=%d&closed_before=2100-01-01" % D_PLAIN))
    r = form_patch(D_PLAIN, P + "-nostage", deal_stage_id=stage_closed)
    check("... closed again through the form -> closed_at is set again", r[0] == 200 and deal_row(D_PLAIN)["closed"], deal_row(D_PLAIN))
    r = create_deal("born-closed", stage_id=stage_closed)
    born = r[1]["id"] if r[0] == 201 else None
    check("a deal created right in a closing stage is closed (closed_at set)", born and deal_row(born)["closed"], r)
    if born:
        http("DELETE", "/deals/%d" % born)

    # ================================================================= tasks
    section("Tasks (POST /tasks)")
    now = datetime.datetime.utcnow()

    def create_task(label, target, target_id, start, end):
        return http("POST", "/tasks", {
            "label": label, "type_id": task_type_id,
            "assign_to": {"target": "agent", "id": admin_id},
            "link_to": {"target": target, "id": target_id},
            "start_time": iso(start), "end_time": iso(end), "allDay": False,
            # overdue and same-time fixtures on purpose (the API refuses them otherwise: TASK_IN_PAST / TASK_DUPLICATE)
            "allow_past": True, "allow_duplicate": True,
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

    # ================================================================= files tab
    section("Files tab (GET / DELETE /deals/:id/files)")
    if D_NOCO:
        for name in ("old", "new"):
            raw, hdr = multipart({}, [("files", "%s-%s.txt" % (P, name), b"audit " + name.encode())])
            r = http("POST", "/deals/%d/files" % D_NOCO, raw=raw, headers=hdr)
            check("upload %s file -> 201" % name, r[0] == 201, r)
        r = http("GET", "/deals/%d/files?sort[id]=-1&limit=1" % D_NOCO)
        newest = r[1]["data"][0] if r[0] == 200 and r[1]["data"] else {}
        check("the files tab asks the newest first, page by page (count of all files)",
              newest.get("name") == P + "-new.txt" and r[1]["count"] == 2 and newest.get("from") == "uploaded_from_files_tab", r)
        if newest.get("id"):
            r = http("DELETE", "/deals/%d/files/%d" % (D_NOCO, newest["id"]))
            check("DELETE a file of the deal -> 200, the history says who removed which file",
                  r[0] in (200, 204) and wait_for(lambda: count(
                      "SELECT count(*) FROM event WHERE deal_id = %d AND user_id = %d AND after_state -> 'data' ->> 'new_value' = '%s-new.txt'"
                      % (D_NOCO, admin_id, P)), 1) == 1, r)

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
    # "Сделки без задач" = an open deal without an OPEN task (no next step), as on the desktop and in the
    # autopilot: D_NEXT has only a done task; D_PLAIN is closed (no tasks at all) and does not count
    r = create_deal("next")
    D_NEXT = r[1]["id"] if r[0] == 201 else None
    check("deal with a done task only -> 201", D_NEXT is not None, r)
    if D_NEXT:
        live.append(D_NEXT)
        r = create_task(P + "-task-done", "deal", D_NEXT, now - 5 * hour, now - 4 * hour)
        done_id = r[1]["id"] if r[0] == 201 else None
        r = http("PATCH", "/tasks/%s/close" % done_id, {"result": P + " done"}) if done_id else r
        check("its only task is closed", done_id and r[0] == 200 and count("SELECT count(*) FROM task WHERE id = %d AND closed_at IS NOT NULL" % done_id) == 1, r)
    check("tasks[]=overdue -> deal with an open task in the past", deal_ids(lbl + "&tasks[]=overdue") == [D], deal_ids(lbl + "&tasks[]=overdue"))
    check("tasks[]=no_task -> open deals without an open task (not the closed deal, not deals with open tasks)",
          deal_ids(lbl + "&tasks[]=no_task") == [D_NEXT], (deal_ids(lbl + "&tasks[]=no_task"), D_NEXT))
    check("tasks[]=today -> deal with a task around now", D_NOCO in deal_ids(lbl + "&tasks[]=today"), deal_ids(lbl + "&tasks[]=today"))
    r = http("GET", "/deals?" + lbl + "&tasks[]=today&tasks[]=tomorrow&tasks[]=this_week&tasks[]=this_month&tasks[]=this_quarter&tasks[]=overdue&tasks[]=no_task&agent[fillers][0][id]=%d&agent[fillers][0][value]=x" % f_user)
    check("all task filters + agent custom field together -> 200", r[0] == 200, r)
    r = http("GET", "/deals/stats?" + lbl)
    stats = r[1][0] if r[0] == 200 and r[1] else {}
    check("stats: deals_with_overdue_tasks counts deals with open tasks in the past", str(stats.get("deals_with_overdue_tasks")) == "1", stats)
    check("stats: deals_without_tasks = open deals without an open task", str(stats.get("deals_without_tasks")) == "1", stats)
    # "Задач на сегодня" = open tasks due today (the API's day, Asia/Karachi), not the tasks created today
    local_now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=5)))
    utc = datetime.timezone.utc
    due_today = sum(1 for end in (now - 2 * hour, now + hour)  # the open tasks of D and D_NOCO (the done one is not counted)
                    if end.replace(tzinfo=utc).astimezone(local_now.tzinfo).date() == local_now.date())
    check("stats: task_count_for_today = open tasks due today (%d)" % due_today, str(stats.get("task_count_for_today")) == str(due_today), stats)

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

    # ================================================================= search box, sort by stage, kanban
    section("Search box (q), sort by stage, kanban board (GET /deals/board)")
    qs = lambda text: urllib.parse.quote(text, safe="")
    run_deals = lambda where="TRUE": sorted(int(row[0]) for row in sql(
        "SELECT d.id FROM deal d WHERE d.label LIKE '%s-%%' AND d.deleted_at IS NULL AND (%s)" % (P, where)))
    check("q=№<number> -> that deal", deal_ids(lbl + "&q=" + qs("№%s" % D_display)) == [D], deal_ids(lbl + "&q=" + qs("№%s" % D_display)))
    with_contact = run_deals('EXISTS (SELECT 1 FROM deal_user du WHERE du."dealId" = d.id AND du."userId" = %d)' % contact_id)
    check("q=<the client's name> -> the deals of that contact",
          with_contact and deal_ids(lbl + "&limit=100&q=" + qs(P + "-contact")) == with_contact, (deal_ids(lbl + "&limit=100&q=" + qs(P + "-contact")), with_contact))
    with_company = run_deals("d.company_id = %d" % company_id)
    check("q=<the company's phone as typed> (+998 00 000-00-00) -> the deals of the company, by digits",
          with_company and deal_ids(lbl + "&limit=100&q=" + qs("+998 00 000-00-00")) == with_company,
          (deal_ids(lbl + "&limit=100&q=" + qs("+998 00 000-00-00")), with_company))
    of_company = run_deals('d.company_id = %d OR EXISTS (SELECT 1 FROM deal_user du JOIN "user" u ON u.id = du."userId" '
                           'WHERE du."dealId" = d.id AND u.company_id = %d)' % (company_id, company_id))
    check("q=<the company's name> -> the deals of the company and of its contacts",
          deal_ids(lbl + "&limit=100&q=" + qs(P + "-co")) == of_company, (deal_ids(lbl + "&limit=100&q=" + qs(P + "-co")), of_company))
    check("q that matches nothing -> 0", deals_count(lbl + "&q=" + qs("zz-nothing-" + RUN)) == 0)

    r = http("GET", "/deals?" + lbl + "&limit=100&sort[stage]=1")
    got = [d["id"] for d in r[1]["data"]] if r[0] == 200 else r
    want = [int(row[0]) for row in sql("SELECT d.id FROM deal d JOIN deal_stage s ON s.id = d.stage_id WHERE d.label LIKE '%s-%%' "
                                       "AND d.deleted_at IS NULL ORDER BY s.\"order\", s.id, d.id" % P)]
    check("sort[stage] follows the pipeline (the position of the stage), then the deal id", got == want, (got, want))
    pages = []
    for skip in range(len(live)):
        r = http("GET", "/deals?" + lbl + "&limit=1&skip=%d&sort[budget]=-1" % skip)
        pages += [d["id"] for d in r[1]["data"]] if r[0] == 200 else [None]
    check("pages of an equal sort key (budget) neither repeat nor skip deals", sorted(pages) == sorted(live), pages)

    def board(query):
        r = http("GET", "/deals/board?" + lbl + query)
        return r if r[0] == 200 else (r[0], {"stages": [], "data": [], "error": r[1]})

    def board_totals(body):
        return {s["stage_id"]: s["count"] for s in body["stages"]}

    expected = {}
    for stage_id, n in sql("SELECT stage_id, count(*) FROM deal WHERE label LIKE '%s-%%' AND deleted_at IS NULL GROUP BY stage_id" % P):
        expected[int(stage_id)] = int(n)
    r = board("")
    check("GET /deals/board -> 200, the totals of every column counted over all its deals", r[0] == 200 and board_totals(r[1]) == expected, (r, expected))
    check("... the cards of the board are this run's deals with the filters applied",
          r[0] == 200 and sorted(d["id"] for d in r[1]["data"]) == run_deals(), r)
    budget = scalar("SELECT COALESCE(sum(budget), 0) FROM deal WHERE label LIKE '%s-%%' AND deleted_at IS NULL AND stage_id = %d" % (P, stage_created))
    column = [s for s in r[1]["stages"] if s["stage_id"] == stage_created] if r[0] == 200 else []
    check("... the budget of a column is summed by the server", column and float(column[0]["budget"]) == float(budget), (column, budget))
    in_created = sorted(run_deals("d.stage_id = %d" % stage_created), reverse=True)
    r = board("&per_stage=1")
    cards = [d["id"] for d in r[1]["data"] if (d.get("stage") or {}).get("id") == stage_created]
    check("per_stage=1 -> the newest card of a column, the totals are still of the whole column",
          len(in_created) >= 2 and cards == in_created[:1] and board_totals(r[1]).get(stage_created) == len(in_created), (cards, in_created))
    r = board("&per_stage=1&stages=%d&before_id=%d" % (stage_created, in_created[0] if in_created else 0))
    check("«Показать ещё»: before_id gives the next card of the column", [d["id"] for d in r[1]["data"]] == in_created[1:2], (r, in_created))
    r = board("&ids=%d" % D)
    check("ids= -> only that deal (a live update re-reads the changed cards)", [d["id"] for d in r[1]["data"]] == [D], r)
    # a closing column shows the deals closed lately; older ones are counted in the list only
    sql("UPDATE deal SET closed_at = now() - interval '40 days' WHERE id = %d" % D_PLAIN)
    try:
        r = board("")
        check("a deal closed 40 days ago is not on the board (closed_days=30)",
              D_PLAIN not in [d["id"] for d in r[1]["data"]] and board_totals(r[1]).get(stage_closed, 0) == expected.get(stage_closed, 0) - 1, r)
        r = board("&closed_days=0")
        check("... closed_days=0 -> every closed deal", D_PLAIN in [d["id"] for d in r[1]["data"]], r)
        check("... and the list still has it", D_PLAIN in deal_ids(lbl + "&limit=100"), deal_ids(lbl + "&limit=100"))
    finally:
        sql("UPDATE deal SET closed_at = now() WHERE id = %d" % D_PLAIN)
    r = http("GET", "/deals/board?per_stage=500")
    check("per_stage over 200 -> 400", r[0] == 400, r)

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
    check("a new collection gets one stage of each system kind",
          sorted(row[0] for row in sql("SELECT kind FROM deal_stage WHERE collection_id = %d AND kind <> 'work'" % coll_a))
          == ["first_contact", "lost", "new", "prepayment", "won"])
    check("a stage made by an admin is of kind work", scalar("SELECT kind FROM deal_stage WHERE id = %d" % stage_y) == "work")
    # K10: the name of a system stage is only its label: it can be renamed, the kind decides
    system_id = int(scalar("SELECT id FROM deal_stage WHERE collection_id = %d AND kind = 'won'" % coll_a))
    r = http("PATCH", "/stages/%d" % system_id, {"name": "AUDIT-renamed-won", "order": 3, "color": "#99ccff", "collection_id": coll_a})
    check("a system stage can be renamed and keeps its kind",
          r[0] == 200 and sql("SELECT name, kind FROM deal_stage WHERE id = %d" % system_id) == [["AUDIT-renamed-won", "won"]], r)
    r = http("PATCH", "/stages/%d" % system_id, {"name": "AUDIT-renamed-won", "order": 3, "color": "#99ccff", "collection_id": coll_b})
    check("... it cannot be moved to another collection", scalar("SELECT collection_id FROM deal_stage WHERE id = %d" % system_id) == str(coll_a), r)
    r = create_deal("renamed-won", stage_id=system_id)
    renamed = r[1]["id"] if r[0] == 201 else None
    check("... a deal put into the renamed «won» stage is closed", renamed and deal_row(renamed)["closed"], r)
    if renamed:
        http("DELETE", "/deals/%d" % renamed)

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
    system_stage = int(scalar("SELECT id FROM deal_stage WHERE collection_id = %d AND kind = 'new'" % coll_a))
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

    # «Этап для новых сделок» (Telegram, WhatsApp, calls, mail, the bot): chosen in «Настроить воронку»
    section("Stage for new deals (GET / PATCH /stages/default)")
    r = http("GET", "/stages/default")
    check("GET /stages/default -> a working stage of the active collection",
          r[0] == 200 and isinstance(r[1], dict) and scalar("SELECT collection_id FROM deal_stage WHERE id = %d" % r[1]["id"]) == str(ORIGINAL_ACTIVE_COLLECTION)
          and r[1].get("kind") not in ("won", "lost"), r)
    r = http("PATCH", "/stages/default", {"stage_id": stage_closed})
    check("PATCH /stages/default with a closing stage -> 400", r[0] == 400, r)
    r = http("PATCH", "/stages/default", {"stage_id": stage_y})
    check("PATCH /stages/default with a stage of an inactive collection -> 400", r[0] == 400, r)
    r = http("PATCH", "/stages/default", {"stage_id": stage_prepay})
    check("PATCH /stages/default with a working stage of the active collection -> 200",
          r[0] == 200 and http("GET", "/stages/default")[1].get("id") == stage_prepay, r)
    r = create_deal("default-stage", stage_id=None)
    check("a deal without a stage goes to the chosen stage", r[0] == 201 and (r[1].get("stage") or {}).get("id") == stage_prepay, r)
    if r[0] == 201:
        http("DELETE", "/deals/%d" % r[1]["id"])

    r = http("POST", "/stages/collections", {"name": P + "-coll-C"})
    coll_c = r[1]["id"]
    try:
        r = http("PATCH", "/stages/collections/%d/activate" % coll_c, {})
        active = sql("SELECT id FROM collection WHERE is_active = true")
        check("activate a collection -> 200, exactly one active", r[0] == 200 and active == [[str(coll_c)]], (r, active))
        same_name = scalar("SELECT id FROM deal_stage WHERE collection_id = %d AND kind = 'prepayment'" % coll_c)
        r = http("GET", "/stages/default")
        check("... the stage for new deals moved to the stage of the same kind of the new collection",
              r[0] == 200 and str((r[1] or {}).get("id")) == same_name, (r, same_name))
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
    r = http("GET", "/stages/default")
    check("... and the stage for new deals came back to it", r[0] == 200 and (r[1] or {}).get("id") == stage_prepay, r)
    r = http("PATCH", "/stages/collections/99999999/activate", {})
    check("activate a missing collection -> 404 and the active one is kept",
          r[0] == 404 and sql("SELECT id FROM collection WHERE is_active = true") == [[str(ORIGINAL_ACTIVE_COLLECTION)]], r)

    # ================================================================= history feed
    section("History feed (GET /deals/:id/events)")
    # newest first by the time of the event: a row written later about an earlier moment stands where it happened
    e_now = int(scalar("INSERT INTO event (type, deal_id, user_id, after_state) VALUES (5, %d, %d, "
                       "jsonb_build_object('data', jsonb_build_object('comment', '%s-feed-now', 'files', '[]'::jsonb))) RETURNING id" % (D, admin_id, P)))
    e_past = int(scalar("INSERT INTO event (type, deal_id, user_id, after_state, created_at) VALUES (5, %d, %d, "
                        "jsonb_build_object('data', jsonb_build_object('comment', '%s-feed-past', 'files', '[]'::jsonb)), now() - interval '2 days') RETURNING id"
                        % (D, admin_id, P)))
    r = http("GET", "/deals/%d/events?sort[id]=-1&skip=0&limit=100" % D)
    ids = [e["id"] for e in r[1]["data"]] if r[0] == 200 else []
    check("the feed is newest first by the time of the event, not by id",
          e_now in ids and e_past in ids and ids.index(e_now) < ids.index(e_past), ids[:10])

    # who did it: a deleted account by its name, marked deleted (it was «—»); a person, not the whole account
    gone = int(scalar("INSERT INTO \"user\" (username, email, role, deleted_at) VALUES ('%s-gone', 'audit-gone-%s@example.com', 'agent', now()) RETURNING id"
                      % (P, RUN)))
    e_gone = int(scalar("INSERT INTO event (type, deal_id, user_id, after_state) VALUES (5, %d, %d, "
                        "jsonb_build_object('data', jsonb_build_object('comment', '%s-by-gone', 'files', '[]'::jsonb))) RETURNING id" % (D, gone, P)))
    r = http("GET", "/deals/%d/events?limit=100" % D)
    rows = {e["id"]: e for e in r[1]["data"]} if r[0] == 200 else {}
    by_gone = (rows.get(e_gone) or {}).get("originated_by") or {}
    check("an event of a deleted employee keeps the name, marked deleted", by_gone.get("username") == P + "-gone" and by_gone.get("deleted_at"), by_gone)
    by_admin = (rows.get(e_now) or {}).get("originated_by") or {}
    check("the author in the feed is a name, not the account (no rights, e-mail, Telegram id)",
          by_admin.get("id") == admin_id and not any(k in by_admin for k in ("permissions", "email", "tg_id", "objectives")), by_admin)

    # a task change is a new entry with its author; the entry of the creation stays as it was written
    t_deal = int(scalar("SELECT id FROM task WHERE label = '%s-task-deal'" % P))
    first_label = lambda: scalar("SELECT after_state->'data'->>'label' FROM event WHERE type = 6 AND task_id = %d ORDER BY id LIMIT 1" % t_deal)
    updates = lambda: count("SELECT count(*) FROM event WHERE type = 17 AND task_id = %d" % t_deal)
    task_body = {"label": P + "-task-deal-renamed", "type_id": task_type_id, "assign_to": {"target": "agent", "id": admin_id},
                 "link_to": {"target": "deal", "id": D}, "start_time": iso(now - 3 * hour), "end_time": iso(now - 2 * hour), "allDay": False}
    r = http("PATCH", "/tasks/%d" % t_deal, task_body)
    check("PATCH /tasks/:id -> a «Задача изменена» entry by the editor",
          r[0] == 200 and wait_for(updates, 1) == 1
          and scalar("SELECT user_id FROM event WHERE type = 17 AND task_id = %d" % t_deal) == str(admin_id), (r, updates()))
    check("... the entry of the creation keeps the text the task was created with", first_label() == P + "-task-deal", first_label())
    r = http("PATCH", "/tasks/%d" % t_deal, task_body)
    time.sleep(1)
    check("... the same PATCH again adds no entry", r[0] == 200 and updates() == 1, updates())

    # a comment edit says so and keeps the earlier text
    c_id = int(scalar("SELECT id FROM event WHERE deal_id = %d AND type = 5 AND after_state->'data'->>'comment' = '%s json comment'" % (D, P)))
    r = http("PATCH", "/deals/%d/comments/%d" % (D, c_id), {"comment": P + " json comment edited"})
    state = sql("SELECT after_state->'data'->>'comment', (after_state->'data'->>'edited_at') IS NOT NULL, "
                "before_state->'data'->'versions'->0->>'comment' FROM event WHERE id = %d" % c_id)
    check("a comment edit: the new text, marked edited, the earlier text kept",
          r[0] == 200 and state == [[P + " json comment edited", "t", P + " json comment"]], (r, state))

    # a message moved to another deal leaves a trace in the deal it left and says where it came from
    if D_PLAIN:
        wa = int(scalar("INSERT INTO event (type, deal_id, user_id, outgoing, external_id, after_state) VALUES (16, %d, %d, false, '%s-wa', "
                        "jsonb_build_object('message', '%s-wa message', 'files', '[]'::jsonb, 'outgoing', false)) RETURNING id"
                        % (D_PLAIN, contact_id, P, P)))
        r = http("PATCH", "/deals/events/remap", {"event_id": wa, "replace_with_deal_id": D})
        trace = sql("SELECT user_id, after_state->'data'->'to_deal'->>'id', after_state->'data'->>'event_id' FROM event WHERE type = 18 AND deal_id = %d" % D_PLAIN)
        came = scalar("SELECT after_state->'moved'->0->'from_deal'->>'id' FROM event WHERE id = %d AND deal_id = %d" % (wa, D))
        check("remap: the deal it left keeps a trace (who, where to), the message says where it came from",
              r[0] == 200 and trace == [[str(admin_id), str(D), str(wa)]] and came == str(D_PLAIN), (r, trace, came))

    # the closing of a task points to the task (a task of a company or a contact is in their feed)
    if D_NOCO:
        r = create_task(P + "-task-close", "deal", D_NOCO, now - hour, now + hour)
        closing = r[1]["id"] if r[0] == 201 else None
        r = http("PATCH", "/tasks/%d/close" % closing, {"result": P + " closed"}) if closing else r
        check("the «Задача выполнена» entry points to its task",
              closing and r[0] == 200
              and wait_for(lambda: count("SELECT count(*) FROM event WHERE type = 7 AND task_id = %d" % closing), 1) == 1, r)

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
