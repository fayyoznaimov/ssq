#!/usr/bin/env python3
"""
Regression checks of the readable client history (parisahon-api/src/history, components/history of the web client):
DEAL-7 (the whole client), DEAL-10 (filters and search), DEAL-11 (why a deal was lost), DEAL-14 (the deal header).

    py local/checks/history_check.py

* Python stdlib only; the conventions of deals_check.py: the LOCAL stack by default, the dev copy / QA stand
  with the CRM_* variables (CRM_API_URL, CRM_PSQL, CRM_APP_EXEC, CRM_APP_DIR, CRM_ENV_FILE).
* Everything it creates is named AUDIT-history-<run> and is removed at the end (and at the start).
* Prints PASS/FAIL per check, exits 1 if anything failed.
* Checks: GET /deals/:id/events?kind=...&q=... (Всё / Переписка / Звонки / Задачи / Изменения, the search, a bad
  kind is 400); GET /deals/:id/summary (№, the stage and days in it, the source, «клиент ждёт ответа», the
  client's other deals); GET /deals/:id/client-events (every deal of the client, each row with its deal; an
  agent sees only the deals he may see); PATCH /deals/:id/lost (only in the stage of kind lost, a reason of the
  list, «Другое» needs a comment, written to the deal and to its history); 401 without a login.
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
MIGRATION = "DealLostReason1795850000000"

RUN = str(int(time.time()))[-6:]
P = "AUDIT-history-" + RUN  # prefix of everything this run creates

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


# --------------------------------------------------------------------------- cleanup

CLEANUP_SQL = r"""
CREATE TEMP TABLE _d AS SELECT id FROM deal WHERE label LIKE 'AUDIT-history-%';
CREATE TEMP TABLE _c AS SELECT id FROM company WHERE name LIKE 'AUDIT-history-%';
CREATE TEMP TABLE _u AS SELECT id FROM "user" WHERE username LIKE 'AUDIT-history-%';
DELETE FROM notification WHERE company_id IN (SELECT id FROM _c);
DELETE FROM event WHERE deal_id IN (SELECT id FROM _d) OR company_id IN (SELECT id FROM _c) OR contact_id IN (SELECT id FROM _u)
   OR user_id IN (SELECT id FROM _u) OR target_user_id IN (SELECT id FROM _u)
   OR (deal_id IS NULL AND (after_state::text LIKE '%AUDIT-history-%' OR before_state::text LIKE '%AUDIT-history-%'));
DELETE FROM task WHERE deal_id IN (SELECT id FROM _d) OR label LIKE 'AUDIT-history-%';
DELETE FROM deal_stage_record WHERE deal_id IN (SELECT id FROM _d);
DELETE FROM deal_file WHERE "dealId" IN (SELECT id FROM _d);
DELETE FROM deal_user WHERE "dealId" IN (SELECT id FROM _d) OR "userId" IN (SELECT id FROM _u);
DELETE FROM deal_product WHERE deal_id IN (SELECT id FROM _d);
DELETE FROM deal_filler WHERE deal_id IN (SELECT id FROM _d);
DELETE FROM deal WHERE id IN (SELECT id FROM _d);
DELETE FROM "user" WHERE id IN (SELECT id FROM _u);
DELETE FROM "group" WHERE name LIKE 'AUDIT-history-%';
DELETE FROM company WHERE id IN (SELECT id FROM _c);
"""

LEFTOVERS_SQL = r"""
SELECT 'deal', count(*) FROM deal WHERE label LIKE 'AUDIT-history-%'
UNION ALL SELECT 'company', count(*) FROM company WHERE name LIKE 'AUDIT-history-%'
UNION ALL SELECT 'user', count(*) FROM "user" WHERE username LIKE 'AUDIT-history-%'
UNION ALL SELECT 'event', count(*) FROM event WHERE after_state::text LIKE '%AUDIT-history-%' OR before_state::text LIKE '%AUDIT-history-%'
"""


def cleanup():
    sql(CLEANUP_SQL)


def leftovers():
    return {name: int(n) for name, n in sql(LEFTOVERS_SQL) if int(n) > 0}


def jq(value):
    """A JSON value for SQL (single quotes doubled)."""
    return json.dumps(value, ensure_ascii=False).replace("'", "''")


# --------------------------------------------------------------------------- the run

def main():
    global TOKEN
    cleanup()

    status, body = http("POST", "/auth/login", {"email": "admin@gmail.com", "password": env("ADMIN_PASSWORD")}, auth=False)
    if status not in (200, 201) or not isinstance(body, dict) or "access_token" not in body:
        raise SystemExit("login failed: HTTP %s" % status)
    TOKEN = body["access_token"]
    payload = TOKEN.split(".")[1]
    admin_id = int(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["sub"])

    section("Schema")
    check("migration %s is applied" % MIGRATION, count("SELECT count(*) FROM migrations WHERE name = '%s'" % MIGRATION) == 1)
    check("deal.lost_reason and deal.lost_comment exist",
          count("SELECT count(*) FROM information_schema.columns WHERE table_name = 'deal' AND column_name IN ('lost_reason', 'lost_comment')") == 2)

    status, stages = http("GET", "/stages")
    if status != 200:
        raise SystemExit("GET /stages -> %s" % status)
    by_kind = {}
    for s in stages:
        if s.get("kind") and s.get("kind") != "work":
            by_kind.setdefault(s["kind"], s["id"])
    missing = [kind for kind in ("first_contact", "won", "lost") if kind not in by_kind]
    if missing:
        raise SystemExit("GET /stages: no stage of kind %s" % ", ".join(missing))

    # ----------------------------------------------------------------- fixtures
    company_id = int(scalar("INSERT INTO company (name, is_old) VALUES ('%s-co', false) RETURNING id" % P))
    contact_id = int(scalar("INSERT INTO \"user\" (username, role, company_id) VALUES ('%s-contact', 'ctr_agent', %d) RETURNING id" % (P, company_id)))

    def create_deal(suffix, agent_id):
        r = http("POST", "/deals", {"label": "%s-%s" % (P, suffix), "budget": 100, "agent_id": agent_id, "company_id": company_id,
                                    "ctr_agent_ids": [contact_id], "stage_id": by_kind["first_contact"], "fillers": [], "products": []})
        if r[0] != 201:
            raise SystemExit("POST /deals -> %s %s" % (r[0], message_of(r)))
        return int(r[1]["id"])

    def add_event(deal_id, type_, after, outgoing=True, minutes_ago=0, user_id=None):
        return int(scalar(
            "INSERT INTO event (type, deal_id, outgoing, after_state, user_id, created_at) VALUES "
            "(%d, %d, %s, '%s'::jsonb, %s, now() - interval '%d minutes') RETURNING id"
            % (type_, deal_id, "true" if outgoing else "false", jq(after), user_id or "NULL", minutes_ago)))

    old_deal = create_deal("old", admin_id)
    deal_id = create_deal("new", admin_id)
    word = "полотенцеAUDIT%s" % RUN
    note_id = add_event(deal_id, 5, {"data": {"comment": "%s клиент просил %s" % (P, word)}}, minutes_ago=30, user_id=admin_id)
    tg_id = add_event(deal_id, 12, {"message": "%s нужны простыни" % P, "files": [], "outgoing": False}, outgoing=False, minutes_ago=20, user_id=contact_id)
    call_id = add_event(deal_id, 10, {"name": P + ".mp3", "path": "audit-history-%s.mp3" % RUN, "outgoing": True}, minutes_ago=40, user_id=admin_id)
    old_note = add_event(old_deal, 5, {"data": {"comment": "%s старая сделка" % P}}, minutes_ago=600, user_id=admin_id)

    def feed(path, query=""):
        r = http("GET", "/deals/%d/%s?limit=100%s" % (deal_id, path, query))
        return r, ([e["id"] for e in r[1]["data"]] if r[0] == 200 and isinstance(r[1], dict) else None)

    # ----------------------------------------------------------------- filters and search (DEAL-10)
    section("Filters and search of the history (DEAL-10)")
    r, ids = feed("events")
    check("GET /deals/:id/events -> 200 with the test events", ids is not None and {note_id, tg_id, call_id} <= set(ids), (r[0], ids))
    r, ids = feed("events", "&kind=messages")
    check("kind=messages: the note and the Telegram message, not the call", ids is not None and {note_id, tg_id} <= set(ids) and call_id not in ids, ids)
    types = {e["type"] for e in r[1]["data"]} if ids is not None else None
    check("... and no stage / field / deal events", types is not None and not (types & {0, 1, 2, 3, 4, 6, 7, 14, 15}), types)
    r, ids = feed("events", "&kind=calls")
    check("kind=calls: only the call", ids == [call_id], ids)
    r, ids = feed("events", "&kind=changes")
    types = {e["type"] for e in r[1]["data"]} if ids is not None else None
    check("kind=changes: the creation of the deal, no messages", types is not None and 0 in types and not (types & {5, 9, 10, 12, 16}), types)
    r, ids = feed("events", "&kind=tasks")
    check("kind=tasks -> 200", r[0] == 200, r[0])
    r, ids = feed("events", "&q=" + urllib.parse.quote(word))
    check("q=<a word of the note>: the note only", ids == [note_id], ids)
    r, ids = feed("events", "&q=" + urllib.parse.quote(P + "-contact"))
    check("q=<the name of the client>: his message", ids is not None and tg_id in ids, ids)
    r = http("GET", "/deals/%d/events?kind=everything" % deal_id)
    check("an unknown kind -> 400", r[0] == 400, r[0])
    r = http("GET", "/companies/%d/events?kind=calls&limit=100" % company_id)
    ids = [e["id"] for e in r[1]["data"]] if r[0] == 200 else r
    check("the company feed takes the filter too (kind=calls: the call)", isinstance(ids, list) and ids == [call_id], ids)

    # ----------------------------------------------------------------- the header (DEAL-14)
    section("The deal header: GET /deals/:id/summary (DEAL-14)")
    r = http("GET", "/deals/%d/summary" % deal_id)
    s = r[1] if r[0] == 200 and isinstance(r[1], dict) else {}
    display = scalar("SELECT display_id FROM deal WHERE id = %d" % deal_id)
    check("200 with the number of the deal", r[0] == 200 and str(s.get("display_id")) == str(display), r)
    check("the stage with its kind", (s.get("stage") or {}).get("id") == by_kind["first_contact"] and (s.get("stage") or {}).get("kind") == "first_contact", s.get("stage"))
    check("days in the stage: 0 for a new deal", s.get("days_in_stage") == 0, s.get("days_in_stage"))
    check("the source: the first client event is the call -> call", s.get("source") == "call", s.get("source"))
    w = s.get("waiting") or {}
    check("the client wrote last after the call: «ждёт ответа» ~20 min", 18 <= int(w.get("minutes", -1)) <= 25 and w.get("channel") == "telegram", w)
    check("the client's other deals the user sees: 1", s.get("client_deals") == 1, s.get("client_deals"))
    check("the reasons of a loss are offered", "Другое" in (s.get("lost_reasons") or []), s.get("lost_reasons"))
    add_event(deal_id, 12, {"message": P + " ответ менеджера", "files": [], "outgoing": True}, outgoing=True, minutes_ago=5, user_id=admin_id)
    s2 = http("GET", "/deals/%d/summary" % deal_id)[1] or {}
    check("the manager answered: nobody waits", s2.get("waiting") is None, s2.get("waiting"))
    sql("UPDATE deal SET last_stage_change = now() - interval '3 days 1 hour' WHERE id = %d" % deal_id)
    s3 = http("GET", "/deals/%d/summary" % deal_id)[1] or {}
    check("3 days in the stage after a move 3 days ago", s3.get("days_in_stage") == 3, s3.get("days_in_stage"))
    check("GET /deals/<missing>/summary -> 404", http("GET", "/deals/999999999/summary")[0] == 404)

    # ----------------------------------------------------------------- the whole client (DEAL-7)
    section("The history of the whole client: GET /deals/:id/client-events (DEAL-7)")
    r, ids = feed("client-events")
    check("200 with the events of both deals of the client", ids is not None and {note_id, old_note} <= set(ids), (r[0], ids))
    rows = {e["id"]: e for e in r[1]["data"]} if ids is not None else {}
    old_row = rows.get(old_note) or {}
    check("each row says its deal (№ and name)", (old_row.get("deal") or {}).get("id") == old_deal and "display_id" in (old_row.get("deal") or {}), old_row)
    r, ids = feed("client-events", "&kind=messages&q=" + urllib.parse.quote("старая сделка"))
    check("the filters and the search work there too", ids == [old_note], ids)

    # an agent who sees only his own deals: the colleague's deal of the same client stays out
    group_id = int(scalar("INSERT INTO \"group\" (name) VALUES ('%s-g') RETURNING id" % P))
    # «create» is all-or-nothing (0 or 3, as the web client's Permissions.vue sends it); «own» is in view/update
    perms = {"deal": {"view": 1, "create": 3, "update": 1, "delete": 0, "export": 0},
             "contact": {"view": 3, "create": 3, "update": 1, "delete": 0, "export": 0},
             "company": {"view": 3, "create": 3, "update": 1, "delete": 0, "export": 0},
             "task": {"update": 1, "delete": 0}, "mail": False, "file": True}
    email, password = "audit-history-%s@example.test" % RUN, "Audit-%s-hist" % RUN
    r = http("POST", "/users", {"email": email, "password": password, "username": P + "-agent", "role": "agent",
                                "group_id": group_id, "permissions": perms})
    check("an agent with «own deals» -> 201", r[0] == 201, r)
    agent_id = r[1]["id"] if r[0] == 201 else None
    login = http("POST", "/auth/login", {"email": email, "password": password}, auth=False) if agent_id else (0, None)
    agent_token = login[1].get("access_token") if login[0] in (200, 201) and isinstance(login[1], dict) else None
    check("... logs in", agent_token, login)
    if agent_token:
        sql("UPDATE deal SET agent_id = %d WHERE id = %d" % (agent_id, deal_id))
        r = http_as(agent_token, "GET", "/deals/%d/client-events?limit=100" % deal_id)
        ids = [e["id"] for e in r[1]["data"]] if r[0] == 200 else r
        check("the agent: his deal's events, not those of the admin's deal of the client",
              isinstance(ids, list) and note_id in ids and old_note not in ids, ids)
        s = http_as(agent_token, "GET", "/deals/%d/summary" % deal_id)[1] or {}
        check("... and the header counts no other deal", s.get("client_deals") == 0, s.get("client_deals"))
        check("the admin's deal itself: 404 for the agent", http_as(agent_token, "GET", "/deals/%d/client-events" % old_deal)[0] == 404)
        check("... its summary too", http_as(agent_token, "GET", "/deals/%d/summary" % old_deal)[0] == 404)
        check("... and he cannot give it a reason of a loss", http_as(agent_token, "PATCH", "/deals/%d/lost" % old_deal, {"reason": "Цена"})[0] in (403, 404))
        sql("UPDATE deal SET agent_id = %d WHERE id = %d" % (admin_id, deal_id))

    # ----------------------------------------------------------------- the reason of a loss (DEAL-11)
    section("Why a deal was lost: PATCH /deals/:id/lost (DEAL-11)")
    r = http("PATCH", "/deals/%d/lost" % deal_id, {"reason": "Цена"})
    check("an open deal -> 400", r[0] == 400, r)
    r = http("PATCH", "/deals/%d/stage" % deal_id, {"stage_id": by_kind["lost"]})
    check("PATCH stage -> the stage of kind lost", r[0] == 200, r)
    r = http("PATCH", "/deals/%d/lost" % deal_id, {"reason": "Неизвестная причина"})
    check("a reason not of the list -> 400", r[0] == 400, r)
    r = http("PATCH", "/deals/%d/lost" % deal_id, {"reason": "Другое"})
    check("«Другое» without a comment -> 400", r[0] == 400, r)
    r = http("PATCH", "/deals/%d/lost" % deal_id, {"reason": "Цена", "comment": "  у конкурента дешевле  "})
    check("«Цена» with a comment -> 200", r[0] == 200 and (r[1] or {}).get("lost_reason") == "Цена", r)
    row = sql("SELECT lost_reason, lost_comment FROM deal WHERE id = %d" % deal_id)[0]
    check("stored on the deal (the comment trimmed)", row == ["Цена", "у конкурента дешевле"], row)
    text = wait_for(lambda: scalar("SELECT after_state->'data'->>'new_value' FROM event WHERE deal_id = %d AND type IN (3, 4) "
                                   "AND after_state->'data'->>'field' = 'lost_reason' ORDER BY id DESC LIMIT 1" % deal_id),
                    "Цена — у конкурента дешевле")
    check("written to the history: «Причина проигрыша: Цена — у конкурента дешевле»", text == "Цена — у конкурента дешевле", text)
    s = http("GET", "/deals/%d/summary" % deal_id)[1] or {}
    check("the header shows the reason, nobody waits on a closed deal",
          s.get("lost_reason") == "Цена" and s.get("lost_comment") == "у конкурента дешевле" and s.get("waiting") is None, s)
    r = http("PATCH", "/deals/%d/lost" % deal_id, {"reason": "Цена", "comment": "у конкурента дешевле"})
    time.sleep(1)
    events_after = count("SELECT count(*) FROM event WHERE deal_id = %d AND after_state->'data'->>'field' = 'lost_reason'" % deal_id)
    check("the same reason again: 200, no second history entry", r[0] == 200 and events_after == 1, (r[0], events_after))
    deal_row = http("GET", "/deals/%d" % deal_id)[1] or {}
    check("GET /deals/:id gives lost_reason for the reports", deal_row.get("lost_reason") == "Цена", deal_row.get("lost_reason"))

    # ----------------------------------------------------------------- without a login
    section("Without a login")
    saved = TOKEN
    TOKEN = None
    try:
        for method, path in (("GET", "/deals/%d/summary" % deal_id), ("GET", "/deals/%d/client-events" % deal_id),
                             ("PATCH", "/deals/%d/lost" % deal_id)):
            r = http(method, path, {"reason": "Цена"} if method == "PATCH" else None)
            check("%s %s -> 401" % (method, path.replace(str(deal_id), ":id")), r[0] == 401, r[0])
    finally:
        TOKEN = saved


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
            check("no AUDIT-history rows are left in the database", not left, left)
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
