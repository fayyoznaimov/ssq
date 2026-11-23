#!/usr/bin/env python3
"""
Regression checks for the analytics and goals block (AUDIT.md, block 8).

    py local/checks/analytics_check.py

* Python stdlib only.
* Talks to the LOCAL stack only: API http://localhost:8080/api/v1, database through
  `docker compose -f docker-compose.local.yml exec crm-db psql` (fixtures, assertions on rows, cleanup).
* Admin password is read from parisahon-api/.env and never printed.
* Everything it creates is prefixed with AUDITAN- and is removed at the end, also when the run
  is interrupted. A run starts with the same cleanup. Only AUDITAN- rows are touched: the other
  check sets use AUDIT- and clean up their own rows.
* The fixtures live in March 2031, a month that holds no real data, so every report has an
  exact expected value.
* Prints PASS/FAIL per check, exits 1 if anything failed.
"""
import base64
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
ENV_FILES = ([os.environ["CRM_ENV_FILE"]] if os.environ.get("CRM_ENV_FILE") else []) + [os.path.join(ROOT, "parisahon-api", ".env"), os.path.join(ROOT, "local", "api.env")]
COMPOSE_FILE = os.path.join(ROOT, "docker-compose.local.yml")
CLIENT = os.path.join(ROOT, "parisahon-client", "app")
BASE = os.environ.get("CRM_API_URL", "http://localhost:8080/api/v1").rstrip("/")
# psql of the local database: CRM_PSQL (dev copy on the server: local/dev/psql.js) or the docker container
PSQL = (shlex.split(os.environ["CRM_PSQL"]) if os.environ.get("CRM_PSQL") else
        ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])
APP_EXEC = (shlex.split(os.environ["CRM_APP_EXEC"]) if os.environ.get("CRM_APP_EXEC") else
            ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-app"])
APP_DIR = os.environ.get("CRM_APP_DIR", "/app")

RUN = str(int(time.time()))[-6:]
P = "AUDITAN-" + RUN  # prefix of everything this run creates

# the month of the fixtures (no real data there) and the dates the client would send
FROM, TILL = "2031-03-01", "2031-03-31"
PERIOD = "from_date=%s&till_date=%s" % (FROM, TILL)

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
    for path in ENV_FILES:
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                m = re.match(r"\s*%s\s*=\s*(.*)" % re.escape(key), line)
                if m and m.group(1).strip():
                    return m.group(1).strip().strip('"').strip("'")
    raise SystemExit("%s is not set in %s" % (key, " or ".join(ENV_FILES)))


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


def num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def row_of(rows, key, value):
    for row in rows or []:
        if row.get(key) == value:
            return row
    return None


# --------------------------------------------------------------------------- cleanup

CLEANUP_SQL = r"""
CREATE TEMP TABLE _d AS SELECT id FROM deal WHERE label LIKE 'AUDITAN-%';
CREATE TEMP TABLE _u AS SELECT id FROM "user" WHERE username LIKE 'AUDITAN-%';
CREATE TEMP TABLE _t AS SELECT id FROM task WHERE label LIKE 'AUDITAN-%' OR deal_id IN (SELECT id FROM _d) OR agent_id IN (SELECT id FROM _u);
CREATE TEMP TABLE _c AS SELECT id FROM company WHERE name LIKE 'AUDITAN-%';

DELETE FROM notification WHERE company_id IN (SELECT id FROM _c);
DELETE FROM event WHERE deal_id IN (SELECT id FROM _d) OR task_id IN (SELECT id FROM _t)
   OR user_id IN (SELECT id FROM _u) OR target_user_id IN (SELECT id FROM _u)
   OR (deal_id IS NULL AND (after_state::text LIKE '%AUDITAN-%' OR before_state::text LIKE '%AUDITAN-%'));
DELETE FROM recording WHERE user_id IN (SELECT id FROM _u);
DELETE FROM bot_reminder WHERE task_id IN (SELECT id FROM _t);
DELETE FROM task WHERE id IN (SELECT id FROM _t);
DELETE FROM deal_stage_record WHERE deal_id IN (SELECT id FROM _d);
DELETE FROM deal_user WHERE "dealId" IN (SELECT id FROM _d) OR "userId" IN (SELECT id FROM _u);
DELETE FROM deal_product WHERE deal_id IN (SELECT id FROM _d);
DELETE FROM deal WHERE id IN (SELECT id FROM _d);
DELETE FROM user_filler WHERE user_id IN (SELECT id FROM _u);
DELETE FROM bot_account WHERE user_id IN (SELECT id FROM _u);
DELETE FROM bot_link_code WHERE user_id IN (SELECT id FROM _u);
DELETE FROM "user" WHERE id IN (SELECT id FROM _u);
DELETE FROM company WHERE id IN (SELECT id FROM _c);
"""

LEFTOVERS_SQL = r"""
SELECT 'deal', count(*) FROM deal WHERE label LIKE 'AUDITAN-%'
UNION ALL SELECT 'task', count(*) FROM task WHERE label LIKE 'AUDITAN-%'
UNION ALL SELECT 'company', count(*) FROM company WHERE name LIKE 'AUDITAN-%'
UNION ALL SELECT 'user', count(*) FROM "user" WHERE username LIKE 'AUDITAN-%'
UNION ALL SELECT 'recording', count(*) FROM recording r WHERE NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = r.user_id)
UNION ALL SELECT 'event', count(*) FROM event WHERE after_state::text LIKE '%AUDITAN-%' OR before_state::text LIKE '%AUDITAN-%'
"""


def cleanup():
    sql(CLEANUP_SQL)


def leftovers():
    return {name: int(n) for name, n in sql(LEFTOVERS_SQL) if int(n) > 0}


# --------------------------------------------------------------------------- the run

ANALYTICS_ENDPOINTS = [
    "/analytics/users?" + PERIOD,
    "/analytics/managers?" + PERIOD,
    "/analytics/deals",
    "/analytics/deals?is_active=true",
    "/analytics/calls",
    "/analytics/consolidated-report?period=monthly&" + PERIOD,
    "/analytics/objectives",
    "/analytics/objectives/results?" + PERIOD,
]


def main():
    global TOKEN

    cleanup()
    TOKEN = login("admin@gmail.com", env("ADMIN_PASSWORD"))
    admin_id = user_id_of(TOKEN)

    won_name = env("DEAL_STAGE_CLOSED")
    lost_name = env("DEAL_STAGE_CLOSED_NOT_REALIZED")
    open_name = env("DEAL_STAGE_CREATED")

    if count("SELECT count(*) FROM deal WHERE created_at >= '2031-01-01' OR closed_at >= '2031-01-01'") or \
            count("SELECT count(*) FROM task WHERE created_at >= '2031-01-01'"):
        raise SystemExit("the database holds deals or tasks dated 2031+: the expected values would be off")

    # ----------------------------------------------------------------- fixtures
    def stage(name):
        value = scalar("SELECT s.id FROM deal_stage s JOIN collection c ON c.id = s.collection_id "
                       "WHERE c.is_active = true AND s.name = '%s' ORDER BY s.id LIMIT 1" % name.replace("'", "''"))
        if value is None:
            raise SystemExit("stage '%s' is missing in the active pipeline" % name)
        return int(value)

    won_stage, lost_stage, open_stage = stage(won_name), stage(lost_name), stage(open_name)
    task_type_id = int(scalar("SELECT id FROM task_type ORDER BY id LIMIT 1"))
    group_id = int(scalar('SELECT id FROM "group" ORDER BY id LIMIT 1'))
    group_name = scalar('SELECT name FROM "group" WHERE id = %d' % group_id)

    company_id = int(scalar("INSERT INTO company (name, is_old, created_by) VALUES ('%s-co', false, %d) RETURNING id" % (P, admin_id)))
    contact_id = int(scalar("INSERT INTO \"user\" (username, email, role, company_id, group_id) VALUES ('%s-contact', 'auditan-contact-%s@example.test', 'ctr_agent', %d, %d) RETURNING id"
                            % (P, RUN, company_id, group_id)))

    permissions = {
        "deal": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
        "contact": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
        "company": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
        "task": {"update": 3, "delete": 3},
        "mail": True,
        "file": True,
    }

    def staff(role, name=None):
        name = name or role
        user = {"email": "auditan-%s-%s@example.test" % (name, RUN), "password": secrets.token_urlsafe(12)}
        status, body = http("POST", "/users", {
            "email": user["email"], "password": user["password"], "username": "%s-%s" % (P, name),
            "role": role, "group_id": group_id, "permissions": permissions,
        })
        if status != 201 or not isinstance(body, dict):
            raise SystemExit("cannot create the test %s: %s %s" % (role, status, body))
        user["id"] = body["id"]
        user["token"] = login(user["email"], user["password"])
        return user

    agent = staff("agent")        # the sales manager whose numbers are known
    manager = staff("manager")    # a head of sales: may read the analytics, has no deals

    # plan of the agent: 1000 a month
    sql("UPDATE \"user\" SET objectives = '{\"monthly\": 1000, \"quarterly\": 3000, \"yearly\": 12000}' WHERE id = %d" % agent["id"])

    def deal(label, stage_id, budget, created, closed=None, deleted=False):
        closed_sql = "'%s'" % closed if closed else "NULL"
        deleted_sql = "now()" if deleted else "NULL"
        return int(scalar(
            "INSERT INTO deal (label, display_id, budget, stage_id, agent_id, created_by, company_id, created_at, closed_at, deleted_at) "
            "VALUES ('%s-%s', %d, %d, %d, %d, %d, %d, '%s', %s, %s) RETURNING id"
            % (P, label, 900000000 + secrets.randbelow(90000000), budget, stage_id, agent["id"], admin_id, company_id, created, closed_sql, deleted_sql)))

    # in March 2031:                                           new?  won?  lost?  fact
    deal("won-in", won_stage, 300, "2031-03-05 10:00", closed="2031-03-10 10:00")              # yes   yes   -      300
    deal("won-old", won_stage, 500, "2031-02-20 10:00", closed="2031-03-20 10:00")             # no    yes   -      500
    deal("won-later", won_stage, 700, "2031-03-06 10:00", closed="2031-04-02 10:00")           # yes   no    -      -
    deal("lost-in", lost_stage, 110, "2031-03-07 10:00", closed="2031-03-15 10:00")            # yes   -     yes    -
    deal("open", open_stage, 130, "2031-03-08 10:00")                                          # yes   -     -      -
    deal("deleted-won", won_stage, 900, "2031-03-09 10:00", closed="2031-03-12 10:00", deleted=True)  # excluded everywhere
    deal("last-day", open_stage, 170, "2031-03-31 12:00")                                      # yes (last day of the period counts)

    EXPECTED_NEW, EXPECTED_NEW_BUDGET = 5, 300 + 700 + 110 + 130 + 170
    EXPECTED_WON, EXPECTED_WON_BUDGET = 2, 300 + 500
    EXPECTED_LOST, EXPECTED_LOST_BUDGET = 1, 110
    EXPECTED_WON_STAGE_CREATED = 2  # won-in, won-later (deleted-won is out, won-old was created in February)

    def task(label, created):
        return int(scalar(
            "INSERT INTO task (label, start_time, end_time, type_id, agent_id, \"createdById\", company_id, created_at) "
            "VALUES ('%s-%s', '%s', '%s', %d, %d, %d, %d, '%s') RETURNING id"
            % (P, label, created, created, task_type_id, agent["id"], admin_id, company_id, created)))

    task("t1", "2031-03-02 09:00")
    task("t2", "2031-03-12 09:00")
    task("t3", "2031-03-31 18:00")
    task("t-old", "2031-02-01 09:00")  # outside the period
    EXPECTED_TASKS = 3

    # calls of the agent: the recorder writes milliseconds
    sql("INSERT INTO recording (duration, outgoing, user_id) VALUES (120000, true, %d), (60000, false, %d)" % (agent["id"], agent["id"]))

    # ================================================================= access
    section("Access: analytics is for admin and manager, 403 for an agent")
    for path in ANALYTICS_ENDPOINTS:
        short = path.split("?")[0]
        status, body = http("GET", path, token=agent["token"])
        check("agent  GET %s -> 403" % short, status == 403, status)
        status, body = http("GET", path, token=manager["token"])
        check("manager GET %s -> 200" % short, status == 200, "%s %s" % (status, message_of((status, body))))
        status, body = http("GET", path)
        check("admin  GET %s -> 200" % short, status == 200, "%s %s" % (status, message_of((status, body))))
    status, body = http("GET", "/analytics/users?" + PERIOD, auth=False)
    check("no token -> 401", status == 401, status)
    status, body = http("PATCH", "/analytics/objectives", {"data": []}, token=manager["token"])
    check("manager PATCH /analytics/objectives (change the plan) -> 403, admin only", status == 403, status)
    status, body = http("PATCH", "/analytics/objectives", {"data": []}, token=agent["token"])
    check("agent  PATCH /analytics/objectives -> 403", status == 403, status)

    # ================================================================= employees
    section("По сотрудникам (GET /analytics/users): deals and tasks are counted apart")
    status, body = http("GET", "/analytics/users?" + PERIOD)
    rows = body if status == 200 and isinstance(body, list) else []
    me = row_of(rows, "id", agent["id"])
    check("the agent has a row", me is not None, rows[:3])
    check("deal_count = %d (was deals x tasks = %d)" % (EXPECTED_NEW, EXPECTED_NEW * EXPECTED_TASKS),
          me and num(me.get("deal_count")) == EXPECTED_NEW, me)
    check("deal_budget = %d: deleted deal and the deal created in February are not counted" % EXPECTED_NEW_BUDGET,
          me and num(me.get("deal_budget")) == EXPECTED_NEW_BUDGET, me)
    check("task_count = %d (was tasks x deals = %d)" % (EXPECTED_TASKS, EXPECTED_NEW * EXPECTED_TASKS),
          me and num(me.get("task_count")) == EXPECTED_TASKS, me)
    boss = row_of(rows, "id", manager["id"])
    check("an employee without deals and tasks in the period is listed with zeros (was dropped)",
          boss is not None and num(boss.get("deal_count")) == 0 and num(boss.get("task_count")) == 0 and num(boss.get("deal_budget")) == 0, boss)
    check("a client's contact (ctr_agent) is not an employee", row_of(rows, "id", contact_id) is None)
    check("every row is a staff member", rows and all(r.get("role") in ("admin", "manager", "agent") for r in rows), [r.get("role") for r in rows][:10])
    check("numbers come as numbers, not strings", me and all(isinstance(me.get(k), (int, float)) for k in ("deal_count", "deal_budget", "task_count")), me)

    status, body = http("GET", "/analytics/users?from_date=2031-03-31&till_date=2031-03-31")
    me = row_of(body if status == 200 and isinstance(body, list) else [], "id", agent["id"])
    check("'today' (from = till): the deal and the task of that day are counted (the last day used to be dropped)",
          me and num(me.get("deal_count")) == 1 and num(me.get("task_count")) == 1, me)

    status, body = http("GET", "/analytics/users?from_date=2031-03-01")
    check("till_date missing -> 400", status == 400, status)

    # ================================================================= consolidated
    section("Сводный отчёт (GET /analytics/consolidated-report)")
    status, body = http("GET", "/analytics/consolidated-report?period=monthly&" + PERIOD)
    report = body if status == 200 and isinstance(body, dict) else {}
    graph = report.get("graph", [])
    check("monthly: one bucket, date_start = 2031-03-01 and date_end = 2031-03-31 as plain dates (no time-zone shift)",
          len(graph) == 1 and graph[0].get("date_start") == "2031-03-01" and graph[0].get("date_end") == "2031-03-31", graph)
    bucket = graph[0] if graph else {}
    check("new_count = %d — deals CREATED in the period (was: deals that visited НЕРАЗОБРАННОЕ and ПРЕДОПЛАТА)" % EXPECTED_NEW,
          bucket.get("new_count") == EXPECTED_NEW, bucket)
    check("won_count = %d — deals in '%s' with closed_at in the period (one of them was created in February)" % (EXPECTED_WON, won_name),
          bucket.get("won_count") == EXPECTED_WON, bucket)
    check("lost_count = %d — closed without success, reported apart" % EXPECTED_LOST, bucket.get("lost_count") == EXPECTED_LOST, bucket)

    totals = report.get("deals", {}).get("total_stats", {})
    check("total_deal_count = %d, total_deal_budget = %d (created in the period, deleted excluded)" % (EXPECTED_NEW, EXPECTED_NEW_BUDGET),
          num(totals.get("total_deal_count")) == EXPECTED_NEW and num(totals.get("total_deal_budget")) == EXPECTED_NEW_BUDGET, totals)
    check("won_deal_count = %d, won_deal_budget = %d" % (EXPECTED_WON, EXPECTED_WON_BUDGET),
          num(totals.get("won_deal_count")) == EXPECTED_WON and num(totals.get("won_deal_budget")) == EXPECTED_WON_BUDGET, totals)
    check("lost_deal_count = %d, lost_deal_budget = %d" % (EXPECTED_LOST, EXPECTED_LOST_BUDGET),
          num(totals.get("lost_deal_count")) == EXPECTED_LOST and num(totals.get("lost_deal_budget")) == EXPECTED_LOST_BUDGET, totals)

    stage_rows = report.get("deals", {}).get("stage_stats", [])
    won_row = row_of(stage_rows, "id", won_stage)
    check("stage '%s': %d deals created in the period (the deleted one is out)" % (won_name, EXPECTED_WON_STAGE_CREATED),
          won_row and num(won_row.get("deal_count_in_stage")) == EXPECTED_WON_STAGE_CREATED, won_row)
    check("every stage of the active pipeline is listed, with zeros where empty",
          len(stage_rows) == count("SELECT count(*) FROM deal_stage s JOIN collection c ON c.id = s.collection_id WHERE c.is_active")
          and all(num(r.get("deal_count_in_stage")) is not None for r in stage_rows), [(r.get("name"), r.get("deal_count_in_stage")) for r in stage_rows])

    user_rows = report.get("deals", {}).get("user_stats", [])
    me = row_of(user_rows, "id", agent["id"])
    check("deals by employee: the agent has %d deals, %d" % (EXPECTED_NEW, EXPECTED_NEW_BUDGET),
          me and num(me.get("deal_count")) == EXPECTED_NEW and num(me.get("deal_budget")) == EXPECTED_NEW_BUDGET, me)
    check("deals by employee: no client's contacts", row_of(user_rows, "id", contact_id) is None)

    task_rows = report.get("tasks", {}).get("user_stats", [])
    me = row_of(task_rows, "id", agent["id"])
    check("tasks by employee: the agent has %d tasks in the period" % EXPECTED_TASKS, me and num(me.get("task_count")) == EXPECTED_TASKS, me)
    check("tasks total = %d — tasks of the period (was: all tasks ever)" % EXPECTED_TASKS,
          num(report.get("tasks", {}).get("total_stats", {}).get("count")) == EXPECTED_TASKS, report.get("tasks", {}).get("total_stats"))

    status, body = http("GET", "/analytics/consolidated-report?period=weekly&" + PERIOD)
    graph = (body or {}).get("graph", []) if status == 200 else []
    starts = [str(b.get("date_start")) for b in graph]
    check("weekly: 200, buckets in ascending order", status == 200 and graph and starts == sorted(starts), starts)
    check("weekly: the sums over the weeks are the same %d / %d / %d" % (EXPECTED_NEW, EXPECTED_WON, EXPECTED_LOST),
          sum(b.get("new_count", 0) for b in graph) == EXPECTED_NEW and sum(b.get("won_count", 0) for b in graph) == EXPECTED_WON
          and sum(b.get("lost_count", 0) for b in graph) == EXPECTED_LOST, graph)
    check("weekly: new and won of the same week are merged into one bucket (Map keyed by Date never matched)",
          len(starts) == len(set(starts)), starts)
    status, body = http("GET", "/analytics/consolidated-report?period=yearly&" + PERIOD)
    check("yearly: 200, one bucket", status == 200 and len((body or {}).get("graph", [])) == 1, (body or {}).get("graph"))
    status, body = http("GET", "/analytics/consolidated-report?period=daily&" + PERIOD)
    check("unknown period -> 400", status == 400, status)

    # ================================================================= goals
    section("Цели (GET /analytics/objectives/results): fact = successfully closed deals only")
    status, body = http("GET", "/analytics/objectives/results?" + PERIOD)
    groups = (body or {}).get("groups", []) if status == 200 else []
    group = row_of(groups, "id", group_id)
    check("the agent's group is listed", group is not None, [g.get("id") for g in groups])
    users = (group or {}).get("users", [])
    me = row_of(users, "id", agent["id"])
    check("fact of the agent = %d: two deals closed in '%s' in March (was: every non-cancelled deal by creation date, open ones too)" % (EXPECTED_WON_BUDGET, won_name),
          me and num(me.get("total_budget")) == EXPECTED_WON_BUDGET, me)
    check("…and deal_count = %d" % EXPECTED_WON, me and num(me.get("deal_count")) == EXPECTED_WON, me)
    check("the agent's plan is returned (monthly 1000)", me and (me.get("objectives") or {}).get("monthly") == 1000, me)
    check("group total = %d (nobody else closed anything in March 2031)" % EXPECTED_WON_BUDGET, group and num(group.get("total_budget")) == EXPECTED_WON_BUDGET, group and group.get("total_budget"))
    check("group plan under 'objectives' (the old misspelled 'objetives' is kept too)",
          group and "objectives" in group and group.get("objetives") == group.get("objectives"), group and list(group.keys()))
    boss = row_of(users, "id", manager["id"])
    check("an employee without closed deals is listed with fact 0 (was missing)", boss is not None and num(boss.get("total_budget")) == 0, boss)
    check("a client's contact is not in the group's list", row_of(users, "id", contact_id) is None, [u.get("id") for u in users])
    check("every group is listed", len(groups) == count('SELECT count(*) FROM "group"'), len(groups))

    status, body = http("GET", "/analytics/objectives/results?from_date=2031-04-01&till_date=2031-04-30")
    me = row_of((row_of((body or {}).get("groups", []), "id", group_id) or {}).get("users", []), "id", agent["id"])
    check("April 2031: fact = 700 — the deal created in March but closed on 2 April counts in April",
          me and num(me.get("total_budget")) == 700, me)

    status, body = http("GET", "/analytics/objectives")
    plan = body if status == 200 and isinstance(body, list) else []
    group = row_of(plan, "id", group_id)
    check("GET /analytics/objectives: groups with their staff and plans", group and row_of(group.get("users", []), "id", agent["id"]) is not None, group and [u.get("id") for u in group.get("users", [])])
    check("…without clients' contacts", group and row_of(group.get("users", []), "id", contact_id) is None)

    # ================================================================= calls
    section("Звонки (GET /analytics/calls): durations in minutes")
    status, body = http("GET", "/analytics/calls")
    rows = body if status == 200 and isinstance(body, list) else []
    me = row_of(rows, "user_id", agent["id"])
    check("the agent has a row", me is not None, [r.get("user_name") for r in rows])
    check("avg_duration = 1.5 min for 120000 and 60000 ms (was 90000 'minutes')", me and num(me.get("avg_duration")) == 1.5, me)
    check("total_call_duration = 3.0 min, outgoing 2.0, incoming 1.0",
          me and num(me.get("total_call_duration")) == 3.0 and num(me.get("total_outgoing_duration")) == 2.0 and num(me.get("total_incoming_duration")) == 1.0, me)
    check("call_count 2, outgoing 1, incoming 1",
          me and num(me.get("call_count")) == 2 and num(me.get("outgoing_call_count")) == 1 and num(me.get("incoming_call_count")) == 1, me)
    check("the unit is stated: duration_unit = 'minutes'", me and me.get("duration_unit") == "minutes", me)
    check("the key the page reads is 'avg_duration' (the API used to answer 'avg_duration_in_minutes')", me and "avg_duration" in me and "avg_duration_in_minutes" not in me)

    # ================================================================= one definition of the numbers (CALL-13)
    section("Звонки за период, «По менеджерам» (GET /analytics/calls?period, /analytics/managers)")
    sql("INSERT INTO recording (duration, outgoing, user_id, created_at) VALUES "
        "(300000, true, %d, '2031-03-15 10:00'), (60000, false, %d, '2031-03-16 11:00'), (60000, true, %d, '2031-04-01 09:00')"
        % (agent["id"], agent["id"], agent["id"]))
    status, body = http("GET", "/analytics/calls?" + PERIOD)
    me = row_of(body if status == 200 and isinstance(body, list) else [], "user_id", agent["id"])
    check("calls of March 2031 only: 2 calls, 6.0 min (the calls of other days are not counted)",
          me and num(me.get("call_count")) == 2 and num(me.get("total_call_duration")) == 6.0, me)
    status, body = http("GET", "/analytics/calls?from_date=2031-03-01")
    me = row_of(body if status == 200 and isinstance(body, list) else [], "user_id", agent["id"])
    check("one end of the period only: all time (the page's field cleared)", status == 200 and me and num(me.get("call_count")) == 5, (status, me))

    status, body = http("GET", "/analytics/managers?" + PERIOD)
    rows = (body or {}).get("data", []) if status == 200 and isinstance(body, dict) else []
    me = row_of(rows, "id", agent["id"])
    check("«По менеджерам»: the agent (a salesperson) is listed — was role 'manager' only", me is not None and me.get("role") == "agent", [r.get("role") for r in rows][:10])
    check("... new deals %d / %d: responsible = the agent, created in the period, deleted out" % (EXPECTED_NEW, EXPECTED_NEW_BUDGET),
          me and me.get("deal_count") == EXPECTED_NEW and me.get("deal_budget") == EXPECTED_NEW_BUDGET, me)
    check("... won %d / %d: closed in the period in '%s', as the consolidated report and the goals" % (EXPECTED_WON, EXPECTED_WON_BUDGET, won_name),
          me and me.get("won_count") == EXPECTED_WON and me.get("won_budget") == EXPECTED_WON_BUDGET, me)
    check("... calls of the period from the recordings: 2 (1 out, 1 in), 6.0 minutes — was raw milliseconds",
          me and me.get("call_count") == 2 and me.get("outgoing_call_count") == 1 and me.get("call_minutes") == 6.0, me)
    check("... the answer times come from «Контроль» (working hours): the keys are there",
          me and all(k in me for k in ("first_response_median_sec", "response_median_sec", "in_sla_share")), me)
    boss = row_of(rows, "id", manager["id"])
    check("... a staff member without numbers is listed with zeros", boss is not None and boss.get("deal_count") == 0 and boss.get("call_count") == 0, boss)
    check("... no client's contacts", row_of(rows, "id", contact_id) is None)
    status, body = http("GET", "/analytics/managers?from_date=2031-04-01&till_date=2031-04-30")
    me = row_of((body or {}).get("data", []) if status == 200 else [], "id", agent["id"])
    check("April 2031: won 1 / 700 (closed on 2 April), 1 call", me and me.get("won_count") == 1 and me.get("won_budget") == 700 and me.get("call_count") == 1, me)
    status, body = http("GET", "/analytics/managers")
    check("no period: the current month (200, the period in the answer)", status == 200 and (body or {}).get("period", {}).get("from"), (status, body and list(body)))
    status, body = http("GET", "/analytics/managers?" + PERIOD, token=agent["token"])
    check("agent GET /analytics/managers -> 403", status == 403, status)

    # ================================================================= goals of a departed / groupless employee (CALL-14)
    section("Цели: an employee who left and one without a group still count")
    leaver = staff("agent", "leaver")
    loner = staff("agent", "loner")
    for who, budget in ((leaver, 50), (loner, 30)):
        scalar("INSERT INTO deal (label, display_id, budget, stage_id, agent_id, created_by, company_id, created_at, closed_at) "
               "VALUES ('%s-won-%d', %d, %d, %d, %d, %d, %d, '2031-03-11 10:00', '2031-03-21 10:00') RETURNING id"
               % (P, who["id"], 900000000 + secrets.randbelow(90000000), budget, won_stage, who["id"], admin_id, company_id))
    sql("UPDATE \"user\" SET deleted_at = now() WHERE id = %d" % leaver["id"])
    sql("UPDATE \"user\" SET group_id = NULL WHERE id = %d" % loner["id"])
    status, body = http("GET", "/analytics/objectives/results?" + PERIOD)
    groups = (body or {}).get("groups", []) if status == 200 else []
    group = row_of(groups, "id", group_id) or {}
    gone = row_of(group.get("users", []), "id", leaver["id"])
    check("a deleted employee with sales in the period stays in the group (marked deleted)",
          gone is not None and gone.get("deleted") is True and num(gone.get("total_budget")) == 50, gone)
    check("... and the group's fact keeps them: %d" % (EXPECTED_WON_BUDGET + 50), num(group.get("total_budget")) == EXPECTED_WON_BUDGET + 50, group.get("total_budget"))
    outside = row_of(groups, "id", None)
    check("sales of staff in no group: the group «Вне групп» without a plan",
          outside is not None and outside.get("name") == "Вне групп" and outside.get("objectives") is None
          and row_of(outside.get("users", []), "id", loner["id"]) and num(outside.get("total_budget")) >= 30, outside)
    status, body = http("GET", "/analytics/objectives/results?from_date=2031-05-01&till_date=2031-05-31")
    group = row_of((body or {}).get("groups", []), "id", group_id) or {}
    check("a deleted employee without sales in the period is not listed", row_of(group.get("users", []), "id", leaver["id"]) is None, group.get("users"))
    goals_vue = client_file(os.path.join("pages", "analytics", "goals", "index.vue"))
    check("goals page: the fact is counted for the month / quarter / year of the plan (was 2020-2100 against the monthly plan)",
          "set('year', 2100)" not in goals_vue and "startOf(unit)" in goals_vue and "endOf(unit)" in goals_vue, "")

    # ================================================================= sales
    section("Продажи (GET /analytics/deals)")
    status, body = http("GET", "/analytics/deals?" + PERIOD)
    # the five of the agent and the two of the goals section above
    check("with a period: 200, the deals created in it", status == 200 and isinstance((body or {}).get("stages"), list)
          and num((body or {}).get("total_deal_count")) == EXPECTED_NEW + 2, (status, body and body.get("total_deal_count")))
    status, body = http("GET", "/analytics/deals")
    check("200 with the stages of the active pipeline", status == 200 and isinstance((body or {}).get("stages"), list) and body["stages"], "%s %s" % (status, message_of((status, body))))
    status, body = http("GET", "/analytics/deals?is_active=maybe")
    check("is_active must be a boolean string -> 400", status == 400, status)

    # ================================================================= client
    section("Client")
    middleware = client_file(os.path.join("middleware", "auth.global.ts"))
    check("auth middleware sends a non-admin/manager from /analytics/** to /403 (was: open to everybody by a direct link)",
          "to.path.startsWith('/analytics/')" in middleware and "ability.can('read', 'Analytics')" in middleware and "navigateTo('/403')" in middleware)
    casl = client_file(os.path.join("utils", "casl.ts"))
    check("casl: the manager may read the analytics subjects (the menu shows the section to admin and manager)",
          "UserRole.Manager" in casl and "ANALYTICS_SUBJECTS.forEach((subject) => can('read', subject))" in casl)
    config = client_file("app.config.ts")
    check("app.config: every analytics menu item has a subject", all(
        "subject" in config[config.index(path):config.index(path) + 120]
        for path in ("/analytics/sales", "/analytics/managers", "/analytics/employees", "/analytics/products", "/analytics/events", "/analytics/goals", "/analytics/consolidated", "/analytics/calls")))
    check("the two stub pages (manager and event by id) are removed; nothing linked to them",
          not os.path.exists(os.path.join(CLIENT, "pages", "analytics", "managers", "[id].vue"))
          and not os.path.exists(os.path.join(CLIENT, "pages", "analytics", "events", "[id].vue")))
    calls_vue = client_file(os.path.join("pages", "analytics", "calls", "index.vue"))
    check("calls page: durations are labelled in minutes", calls_vue.count("(мин)") == 4 and "name: 'avg_duration'" in calls_vue)
    consolidated_vue = client_file(os.path.join("pages", "analytics", "consolidated.vue"))
    check("consolidated page: the chart has the third line 'Закрытых без успеха'", "Закрытых без успеха" in consolidated_vue and "item.lost_count" in consolidated_vue)
    goals_vue = client_file(os.path.join("pages", "analytics", "goals", "index.vue"))
    check("goals page reads the group plan from 'objectives'", "objetives" not in goals_vue and "group.objectives" in goals_vue)


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
            check("no AUDITAN- rows are left in the database", not left, left)
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
