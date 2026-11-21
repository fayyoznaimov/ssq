#!/usr/bin/env python3
"""Checks for the deal-stage triggers (block 7): actions, conditions, the schedule in trigger_run,
the scheduler, event triggers (Telegram) and the rights on /stages/:id/triggers.

Runs against the local stack: the docker stack (http://localhost:8080) or, with the CRM_*
variables from local/dev/env.sh, the dev copy on the server. The API must run the scheduler
often (TRIGGER_SCHEDULER_SEC=3..5 in the local env; the check waits up to 40 s for a run).
Usage: py local/checks/triggers_check.py      (exit code 1 on any FAIL)
Everything it creates is named AUDIT-trg-<run> and removed at the end (own stages, users, deals).
"""
import datetime
import json
import os
import random
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
COMPOSE_FILE = os.path.join(ROOT, "docker-compose.local.yml")
PSQL = (shlex.split(os.environ["CRM_PSQL"]) if os.environ.get("CRM_PSQL") else
        ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])

RUN = secrets.token_hex(3)
TAG = f"AUDIT-trg-{RUN}"
results = {"PASS": 0, "FAIL": 0}

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def check(name, ok, detail=""):
    results["PASS" if ok else "FAIL"] += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {str(detail)[:500]}" if detail and not ok else ""), flush=True)
    return ok


def env_value(key, default=None):
    for line in open(ENV_FILE, encoding="utf-8"):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"')
    return default


def psql(sql):
    done = subprocess.run(PSQL + ["-At", "-c", sql], capture_output=True, text=True, encoding="utf-8")
    if done.returncode != 0:
        raise RuntimeError(f"psql failed: {done.stderr.strip()}\n{sql}")
    return done.stdout.strip()


def http(method, path, body=None, token=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data, headers={"Content-Type": "application/json", **(headers or {})})
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for attempt in range(40):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                text = r.read()
                return r.status, json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            text = e.read()
            if e.code in (502, 504) and attempt < 39 and b"nginx" in text.lower():
                time.sleep(3)
                continue
            try:
                return e.code, json.loads(text)
            except Exception:
                return e.code, text.decode(errors="replace")
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            if attempt == 39:
                raise SystemExit(f"API is not reachable at {BASE}")
            time.sleep(3)


def message_of(answer):
    body = answer[1]
    if isinstance(body, dict):
        m = body.get("message")
        return " ".join(m) if isinstance(m, list) else str(m)
    return str(body)


def wait_for(fn, expected, timeout=45, step=1.0):
    deadline = time.time() + timeout
    value = fn()
    while value != expected and time.time() < deadline:
        time.sleep(step)
        value = fn()
    return value


def main():
    status, body = http("POST", "/auth/login", {"email": "admin@gmail.com", "password": env_value("ADMIN_PASSWORD")})
    if status not in (200, 201):
        raise SystemExit(f"admin login failed: {status}")
    admin = body["access_token"]
    admin_id = int(psql("select id from \"user\" where email = 'admin@gmail.com' and role = 'admin' order by id limit 1"))
    groups = sorted(g["id"] for g in http("GET", "/groups", token=admin)[1])
    collection = int(psql("select id from collection where is_active order by id desc limit 1"))
    task_type = int(psql("select id from task_type order by id limit 1"))
    perms = {"deal": {"view": 3, "create": 3, "update": 3, "delete": 0, "export": 0},
             "contact": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
             "company": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
             "task": {"update": 1, "delete": 0}, "mail": True, "file": True}

    users, stages, filler_id = {}, [], None
    try:
        print("== setup")
        for key in ("a", "b"):
            person = {"email": f"audit-trg-{RUN}-{key}@example.test", "password": secrets.token_urlsafe(12),
                      "username": f"{TAG}-{key}", "role": "agent", "group_id": groups[0], "permissions": perms,
                      "phone": f"+99890{random.randint(1000000, 9999999)}"}
            status, created = http("POST", "/users", person, admin)
            if status != 201:
                raise SystemExit(f"cannot create user {key}: {status} {created}")
            person["id"] = created["id"]
            person["token"] = http("POST", "/auth/login", {"email": person["email"], "password": person["password"]})[1]["access_token"]
            users[key] = person
        A, B = users["a"], users["b"]
        for n in (1, 2, 3):
            status, st = http("POST", "/stages", {"name": f"{TAG}-{n}", "color": "#D5D8DB", "collection_id": collection}, admin)
            if status != 201:
                raise SystemExit(f"cannot create stage {n}: {status} {st}")
            stages.append(st["id"])
        S1, S2, S3 = stages
        filler_id = int(psql(f"insert into filler (target, field) values ('deal', '{TAG}-field') returning id"))
        contact = int(psql(f"insert into \"user\" (username, role, tg_id, email) values ('{TAG}-contact', 'ctr_agent', {7_000_000_000 + random.randint(1, 900_000_000)}, 'audit-trg-{RUN}-c@example.test') returning id"))
        default_stage = int(psql("select stage_id from deal where false union all select coalesce((select default_stage_id from setting order by id desc limit 1), (select s.id from deal_stage s join collection c on c.id = s.collection_id where c.is_active and s.name = '%s' limit 1))" % env_value("DEAL_STAGE_UNKNOWN", "НЕРАЗОБРАННОЕ")))

        def new_deal(label, agent=None, budget=100, fillers=None, stage=None):
            payload = {"label": f"{TAG} {label}", "budget": budget, "agent_id": (agent or A)["id"], "ctr_agent_ids": [contact],
                       "stage_id": stage or default_stage, "fillers": fillers or [], "products": []}
            status, d = http("POST", "/deals", payload, admin)
            if status != 201:
                raise SystemExit(f"cannot create deal: {status} {d}")
            return d["id"]

        def move(deal, stage, token=None):
            return http("PATCH", f"/deals/{deal}/stage", {"stage_id": stage}, token or admin)

        def trigger(stage, body, token=None):
            return http("POST", f"/stages/{stage}/triggers", body, token or admin)

        def when_now(after=0):
            return {"when": "right_away", "after_minutes": after}

        def tasks_of(deal):
            return [row.split("|") for row in psql(f'select label, agent_id, type_id, closed_at is not null, coalesce(result, \'\'), "allDay" from task where deal_id = {deal} order by id').split("\n") if row]

        print("== rights and validation")
        r = trigger(S1, {"type": 0, "deal_filters": [], "apply_when": when_now(), "create_task_data": {"label": "x", "type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 60, "all_day": False}}, A["token"])
        check("an agent cannot create triggers -> 403", r[0] == 403, r)
        r = http("GET", f"/stages/{S1}/triggers", token=A["token"])
        check("an agent can read the triggers of a stage -> 200, empty list", r[0] == 200 and r[1] == [], r)
        r = trigger(S1, {"type": 0, "deal_filters": [{"field": "nope_field", "value": "1", "is_filler": False}], "apply_when": when_now(), "create_task_data": {"label": "x", "type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 60, "all_day": False}})
        check("unknown deal filter field -> 400", r[0] == 400 and "nope_field" in message_of(r), r)
        r = trigger(S1, {"type": 0, "deal_filters": [], "apply_when": {"when": "every_day", "time": "25:99"}, "create_task_data": {"label": "x", "type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 60, "all_day": False}})
        check("time not in HH:MM -> 400", r[0] == 400, r)
        r = trigger(S1, {"type": 1, "deal_filters": [], "apply_when": when_now(), "create_deal_data": {"stage_id": S1}})
        check("'create deal' into its own stage -> 400", r[0] == 400, r)
        r = trigger(S1, {"type": 0, "deal_filters": [], "apply_when": when_now(), "create_task_data": {"label": "x", "type_id": 999999999, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 60, "all_day": False}})
        check("unknown task type -> 404", r[0] == 404, r)
        r = trigger(S1, {"type": 4, "deal_filters": [], "apply_when": when_now(), "change_agent_data": {"agent_id": contact}})
        check("'change responsible' to a contact -> 400", r[0] == 400, r)

        print("== immediate triggers on entering a stage")
        r = trigger(S1, {"type": 0, "deal_filters": [], "apply_when": when_now(),
                         "create_task_data": {"label": f"{TAG} позвонить клиенту", "type_id": task_type, "responsible": {"user": "creator"}, "end_time_in_minutes": 1440, "all_day": True}})
        check("create 'create task' trigger -> 201 with its data and kind", r[0] == 201 and r[1].get("kind") == "immediate" and r[1].get("create_task_data", {}).get("label") == f"{TAG} позвонить клиенту", r)
        t_task = r[1]["id"]
        r = trigger(S1, {"type": 5, "deal_filters": [], "apply_when": when_now(),
                         "change_fields_data": {"fields": [{"field": "budget", "value": "777", "is_filler": False}, {"field": f"{TAG}-field", "value": "auto", "is_filler": True}]}})
        check("create 'change fields' trigger with two fields -> 201", r[0] == 201, r)
        t_fields = r[1]["id"]
        r = trigger(S1, {"type": 4, "deal_filters": [{"field": "budget", "value": "777", "is_filler": False}], "apply_when": when_now(), "change_agent_data": {"agent_id": B["id"]}})
        check("create 'change responsible' trigger with a condition -> 201", r[0] == 201 and r[1].get("deal_filters") == [{"field": "budget", "value": "777", "is_filler": False}], r)
        t_agent = r[1]["id"]
        r = http("GET", f"/stages/{S1}/triggers", token=admin)
        check("the stage lists its three triggers, each with created_at", r[0] == 200 and sorted(t["id"] for t in r[1]) == sorted([t_task, t_fields, t_agent]) and all(t.get("created_at") for t in r[1]), r)
        r = trigger(S1, {"type": 5, "deal_filters": [], "apply_when": when_now(), "change_fields_data": {"fields": [{"field": "created_at", "value": "2020-01-01", "is_filler": False}]}})
        check("'change fields' on a read-only column -> 400", r[0] == 400, r)
        r = trigger(S1, {"type": 2, "deal_filters": [], "apply_when": when_now(), "send_email_data": {"template_id": 999999999, "from": "currently_assigned"}})
        check("'send email' with an unknown template -> 404", r[0] == 404, r)

        D1 = new_deal("сделка 1")
        r = move(D1, S1)
        check("move the deal into the stage -> 200", r[0] == 200, r)
        tasks = tasks_of(D1)
        check("'create task': one task with the label, type, the creator (admin) as responsible, all day",
              tasks == [[f"{TAG} позвонить клиенту", str(admin_id), str(task_type), "f", "", "t"]], tasks)
        n = psql(f"select count(*) from event where deal_id = {D1} and type = 6")
        check("the task is in the deal history (NEW_TASK event)", n == "1", n)
        row = psql(f"select status from trigger_run where trigger_id = {t_task} and deal_id = {D1}")
        check("the immediate run is recorded as done in trigger_run", row == "done", row)
        r = http("POST", "/triggers/run-due", {}, token=A["token"])
        check("POST /triggers/run-due as an agent -> 403", r[0] == 403, r)
        r = http("POST", "/triggers/run-due", {}, token=admin)
        check("POST /triggers/run-due as admin -> one tick with counters", r[0] == 201 and isinstance(r[1], dict) and "executed" in r[1], r)
        row = psql(f"select d.budget, d.agent_id, (select value from deal_filler df where df.deal_id = d.id and df.filler_id = {filler_id}) from deal d where d.id = {D1}")
        check("'change fields' changed BOTH fields (budget and the custom field created on the fly); then 'change responsible' fired because budget = 777",
              row == f"777|{B['id']}|auto", row)
        n = psql(f"select count(*) from event where deal_id = {D1} and type = 3")
        check("field changes are in the history (NEW_FIELD_VALUE events)", int(n or 0) >= 1, n)

        D2 = new_deal("сделка 2", budget=5)
        move(D2, S1)
        row = psql(f"select budget, agent_id from deal where id = {D2}")
        check("the condition on budget is checked after 'change fields' ran: budget 777 -> responsible changed too", row == f"777|{B['id']}", row)
        D3 = new_deal("сделка 3 сразу в этапе", stage=S1)
        tasks = tasks_of(D3)
        check("a deal CREATED in the stage gets the immediate triggers too", len(tasks) == 1 and tasks[0][0] == f"{TAG} позвонить клиенту", tasks)

        print("== a condition on a custom field")
        r = trigger(S2, {"type": 0, "deal_filters": [{"field": f"{TAG}-field", "value": "vip", "is_filler": True}], "apply_when": when_now(),
                         "create_task_data": {"label": f"{TAG} VIP-задача", "type_id": task_type, "responsible": {"exact_user_id": B["id"]}, "end_time_in_minutes": 60, "all_day": False}})
        check("create a trigger with a condition on a custom field -> 201", r[0] == 201, r)
        t_vip = r[1]["id"]
        D4 = new_deal("vip", fillers=[{"filler_id": filler_id, "value": "vip"}])
        D5 = new_deal("not vip", fillers=[{"filler_id": filler_id, "value": "usual"}])
        move(D4, S2)
        move(D5, S2)
        check("the trigger fires for the deal that matches the custom field (responsible = exact user B)",
              tasks_of(D4) == [[f"{TAG} VIP-задача", str(B["id"]), str(task_type), "f", "", "f"]], tasks_of(D4))
        check("and not for the deal that does not match", tasks_of(D5) == [], tasks_of(D5))

        print("== close tasks")
        r = trigger(S3, {"type": 3, "deal_filters": [], "apply_when": when_now(),
                         "close_tasks_data": {"result": f"{TAG} закрыто автоматически", "type_id": task_type, "with_task_end_times": ["all"]}})
        check("create 'close tasks' trigger -> 201", r[0] == 201, r)
        move(D4, S3)
        tasks = tasks_of(D4)
        check("the open task of the deal is closed with the result text", tasks and tasks[0][3] == "t" and tasks[0][4] == f"{TAG} закрыто автоматически", tasks)
        n = psql(f"select count(*) from event where deal_id = {D4} and type = 7")
        check("closing is in the history (NEW_TASK_STATUS event)", n == "1", n)

        print("== create deal")
        r = trigger(S2, {"type": 1, "deal_filters": [], "apply_when": when_now(), "create_deal_data": {"stage_id": S3, "label": ""}})
        check("create 'create deal' trigger -> 201", r[0] == 201, r)
        t_copy = r[1]["id"]
        D6 = new_deal("оригинал", budget=42)
        move(D6, S2)
        row = psql(f"select label, budget, stage_id, agent_id, (select count(*) from deal_user du where du.\"dealId\" = d.id and du.\"userId\" = {contact}), created_by from deal d where label = '{TAG} оригинал (копия)'")
        check("a copy of the deal appears in the target stage with budget, responsible and contact", row == f"{TAG} оригинал (копия)|42|{S3}|{A['id']}|1|{admin_id}", row)
        n = psql(f"select count(*) from deal where label like '{TAG} оригинал (копия)%'")
        check("the copy itself does not spawn another copy", n == "1", n)
        http("DELETE", f"/stages/{S2}/triggers/{t_copy}", token=admin)

        print("== delayed triggers: the schedule lives in the database")
        r = trigger(S2, {"type": 0, "deal_filters": [], "apply_when": when_now(10),
                         "create_task_data": {"label": f"{TAG} через 10 минут", "type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 60, "all_day": False}})
        check("create a trigger 'через 10 минут' -> 201, kind delayed", r[0] == 201 and r[1].get("kind") == "delayed" and r[1].get("is_delayed") is True, r)
        t_delay = r[1]["id"]
        # a deal that entered the stage an hour BEFORE the trigger existed (API time zone) gets no run
        d_before = int(psql(f"insert into deal (label, display_id, budget, stage_id, agent_id, created_by, last_stage_change) values ('{TAG} до триггера', {random.randint(10**8, 2 * 10**9)}, 1, {S2}, {A['id']}, {admin_id}, (now() at time zone 'Asia/Karachi') - interval '1 hour') returning id"))
        http("POST", "/triggers/run-due", {}, admin)
        n = psql(f"select count(*) from trigger_run where trigger_id = {t_delay} and deal_id = {d_before}")
        check("a deal that entered the stage an hour before the trigger was created gets no run (time zones of API and DB)", n == "0", n)
        D7 = new_deal("отложенная")
        move(D7, S2)
        # timestamps are stored in the API's local time (TZ Asia/Karachi, see main.ts), now() of the database is not
        local_now = "(now() at time zone 'Asia/Karachi')"
        row = psql(f"select status, (run_at between {local_now} + interval '9 minutes' and {local_now} + interval '11 minutes') from trigger_run where trigger_id = {t_delay} and deal_id = {D7}")
        check("entering the stage plans one pending run about 10 minutes ahead", row == "pending|t", row)
        check("nothing is executed yet", tasks_of(D7) == [], tasks_of(D7))
        r = http("GET", f"/stages/{S2}/triggers/{t_delay}/runs", token=admin)
        check("GET /stages/:id/triggers/:id/runs shows the planned run", r[0] == 200 and len(r[1]) == 1 and r[1][0]["status"] == "pending" and r[1][0]["deal_id"] == D7, r)
        r = http("GET", f"/stages/{S2}/triggers/{t_delay}/runs", token=A["token"])
        check("an agent may read the schedule too -> 200", r[0] == 200, r)
        move(D7, S3)
        row = psql(f"select status || '|' || coalesce(error, '') from trigger_run where trigger_id = {t_delay} and deal_id = {D7}")
        check("the deal left the stage: the run is skipped with that reason", row == "skipped|the deal left the stage", row)
        move(D7, S2)
        psql(f"update trigger_run set run_at = now() - interval '1 minute' where trigger_id = {t_delay} and deal_id = {D7} and status = 'pending'")
        status_after = wait_for(lambda: psql(f"select status from trigger_run where trigger_id = {t_delay} and deal_id = {D7} and status <> 'skipped'"), "done")
        check("the scheduler executes the due run and marks it done (works after a restart too: nothing is in memory)", status_after == "done", status_after)
        check("the task is created by the scheduled run", tasks_of(D7) == [[f"{TAG} через 10 минут", str(A["id"]), str(task_type), "f", "", "f"]], tasks_of(D7))
        n = psql(f"select count(*) from trigger_run where trigger_id = {t_delay} and deal_id = {D7} and status = 'pending'")
        check("a one-shot run is not planned again", n == "0", n)

        print("== a failing trigger is a failed run, not a crash")
        psql(f"update trigger set data = jsonb_set(data, '{{type_id}}', '999999999') where id = {t_delay}")
        D8 = new_deal("сломанный триггер")
        move(D8, S2)
        psql(f"update trigger_run set run_at = now() - interval '1 minute' where trigger_id = {t_delay} and deal_id = {D8} and status = 'pending'")
        row = wait_for(lambda: psql(f"select status || '|' || coalesce(left(error, 40), '') from trigger_run where trigger_id = {t_delay} and deal_id = {D8}").split("|")[0], "failed")
        err = psql(f"select coalesce(error, '') from trigger_run where trigger_id = {t_delay} and deal_id = {D8}")
        check("the run is marked failed with the error text", row == "failed" and "999999999" in err, (row, err))
        check("the API is still alive", http("GET", "/groups", token=admin)[0] == 200)
        psql(f"update trigger set data = jsonb_set(data, '{{type_id}}', '{task_type}') where id = {t_delay}")

        print("== exact time and recurring")
        tomorrow = (datetime.date.today() + datetime.timedelta(days=1)).isoformat()
        r = trigger(S3, {"type": 0, "deal_filters": [], "apply_when": {"when": "at_exact_time", "date": tomorrow, "time": "09:30"},
                         "create_task_data": {"label": f"{TAG} точное время", "type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 60, "all_day": False}})
        check("create a trigger at an exact time -> 201, delayed", r[0] == 201 and r[1].get("kind") == "delayed", r)
        t_exact = r[1]["id"]
        r = trigger(S3, {"type": 0, "deal_filters": [], "apply_when": {"when": "every_day", "time": "08:00"},
                         "create_task_data": {"label": f"{TAG} ежедневно", "type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 60, "all_day": False}})
        check("create a daily trigger -> 201, recurring", r[0] == 201 and r[1].get("kind") == "recurring" and r[1].get("is_recurring") is True, r)
        t_daily = r[1]["id"]
        r = trigger(S3, {"type": 0, "deal_filters": [], "apply_when": {"when": "every_week", "time": "12:00", "week_day": 1},
                         "create_task_data": {"label": f"{TAG} по понедельникам", "type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 60, "all_day": False}})
        t_weekly = r[1]["id"] if r[0] == 201 else None
        D9 = new_deal("по расписанию")
        move(D9, S3)
        row = psql(f"select to_char(run_at, 'YYYY-MM-DD HH24:MI'), status from trigger_run where trigger_id = {t_exact} and deal_id = {D9}")
        check("exact time: one pending run at that date and time", row == f"{tomorrow} 09:30|pending", row)
        row = psql(f"select status, run_at > now(), to_char(run_at, 'HH24:MI') from trigger_run where trigger_id = {t_daily} and deal_id = {D9}")
        check("daily: the next occurrence at 08:00 is planned, in the future", row == "pending|t|08:00", row)
        row = psql(f"select status, run_at > now(), extract(isodow from run_at)::int, to_char(run_at, 'HH24:MI') from trigger_run where trigger_id = {t_weekly} and deal_id = {D9}")
        check("weekly: the next Monday 12:00 is planned", row == "pending|t|1|12:00", row)
        # a recurring run whose time came: executed and the next one planned
        psql(f"update trigger_run set run_at = now() - interval '1 minute' where trigger_id = {t_daily} and deal_id = {D9} and status = 'pending'")
        done = wait_for(lambda: psql(f"select count(*) from trigger_run where trigger_id = {t_daily} and deal_id = {D9} and status = 'done'"), "1")
        row = psql(f"select count(*) filter (where status = 'done'), count(*) filter (where status = 'pending' and run_at > now()) from trigger_run where trigger_id = {t_daily} and deal_id = {D9}")
        check("a due daily run is executed and the next day's run is planned", done == "1" and row == "1|1", row)
        check("the daily task exists", any(t[0] == f"{TAG} ежедневно" for t in tasks_of(D9)), tasks_of(D9))
        # a recurring run that waited more than a day (the API was down) is not executed
        psql(f"update trigger_run set run_at = now() - interval '2 days' where trigger_id = {t_daily} and deal_id = {D9} and status = 'pending'")
        missed = wait_for(lambda: psql(f"select count(*) from trigger_run where trigger_id = {t_daily} and deal_id = {D9} and status = 'skipped' and error like 'missed%'"), "1")
        check("a run older than a day is skipped as missed, not executed late", missed == "1", missed)
        check("the daily task was not created twice", sum(1 for t in tasks_of(D9) if t[0] == f"{TAG} ежедневно") == 1, tasks_of(D9))
        # a closed deal gets no new recurring runs
        psql(f"update deal set closed_at = now() where id = {D9}")
        psql(f"update trigger_run set status = 'skipped' where deal_id = {D9} and status = 'pending'")
        time.sleep(float(env_value("TRIGGER_SCHEDULER_SEC", "5")) + 2)
        n = psql(f"select count(*) from trigger_run where deal_id = {D9} and status = 'pending'")
        check("a closed deal gets no new recurring runs", n == "0", n)

        print("== update and delete")
        r = http("PATCH", f"/stages/{S3}/triggers/{t_exact}", {"type": 0, "deal_filters": [], "apply_when": {"when": "at_exact_time", "date": tomorrow, "time": "10:00"},
                  "create_task_data": {"label": f"{TAG} точное время 2", "type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 60, "all_day": False}}, admin)
        row = psql(f"select count(*) filter (where status = 'pending') from trigger_run where trigger_id = {t_exact}")
        check("updating a trigger drops its planned runs (they are planned again on the next stage entry)", r[0] == 200 and row == "0", (r, row))
        r = http("PATCH", f"/stages/{S1}/triggers/{t_exact}", {"type": 0, "deal_filters": [], "apply_when": when_now(), "create_task_data": {"label": "x", "type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 60, "all_day": False}}, admin)
        check("updating through another stage -> 400", r[0] == 400, r)
        r = http("DELETE", f"/stages/{S3}/triggers/{t_daily}", token=A["token"])
        check("an agent cannot delete a trigger -> 403", r[0] == 403, r)
        r = http("DELETE", f"/stages/{S3}/triggers/{t_daily}", token=admin)
        n = psql(f"select count(*) from trigger_run where trigger_id = {t_daily}")
        check("deleting a trigger removes it with its schedule", r[0] == 200 and n == "0", (r, n))

        print("== event trigger: a Telegram message")
        token = env_value("TELEGRAM_SERVICE_TOKEN")
        r = trigger(S2, {"type": 0, "deal_filters": [], "apply_when": {"when": "tg_message_received", "outgoing": False},
                         "create_task_data": {"label": f"{TAG} ответить в Telegram", "type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 30, "all_day": False}})
        check("create a trigger 'при входящем сообщении Telegram' -> 201, kind event", r[0] == 201 and r[1].get("kind") == "event", r)
        D10 = new_deal("telegram", agent=A)
        move(D10, S2)
        check("an event trigger does not fire on entering the stage", not any(t[0] == f"{TAG} ответить в Telegram" for t in tasks_of(D10)), tasks_of(D10))
        if token and len(token) >= 16:
            tg = int(psql(f"select tg_id from \"user\" where id = {contact}"))
            incoming = {"agent_id": A["id"], "agent_tg_id": 6_000_000_000 + random.randint(1, 900_000_000), "chat": {"tg_id": tg, "first_name": "Клиент"},
                        "tg_message_id": random.randint(1, 10**8), "text": "Здравствуйте", "outgoing": False, "files": []}
            r = http("POST", "/telegram/incoming", incoming, headers={"X-Telegram-Service-Token": token})
            # the contact is linked to every open deal of A in this run: the message goes to all of them,
            # the trigger fires for the one in the stage with the trigger
            check("an incoming Telegram message of the deal fires the trigger: a task 'ответить' appears once",
                  r[0] == 201 and D10 in (r[1].get("deal_ids") or []) and sum(1 for t in tasks_of(D10) if t[0] == f"{TAG} ответить в Telegram") == 1, (r, tasks_of(D10)))
            incoming.update({"tg_message_id": random.randint(1, 10**8), "outgoing": True, "text": "Ответ"})
            http("POST", "/telegram/incoming", incoming, headers={"X-Telegram-Service-Token": token})
            check("an OUTGOING message does not fire a trigger that waits for incoming ones", sum(1 for t in tasks_of(D10) if t[0] == f"{TAG} ответить в Telegram") == 1, tasks_of(D10))
        else:
            check("TELEGRAM_SERVICE_TOKEN is set for the Telegram event check", False, "not set")

    finally:
        print("== cleanup")
        ids = ",".join(str(u["id"]) for u in users.values()) or "0"
        stage_ids = ",".join(str(s) for s in stages) or "0"
        deals = f"select id from deal where label like '{TAG}%'"
        psql(";".join([
            "begin",
            f"delete from trigger_run where deal_id in ({deals}) or trigger_id in (select id from trigger where deal_stage_id in ({stage_ids}))",
            f"delete from trigger where deal_stage_id in ({stage_ids})",
            f"delete from event where deal_id in ({deals}) or task_id in (select id from task where deal_id in ({deals})) or user_id in ({ids}) or target_user_id in ({ids})",
            f"delete from task where deal_id in ({deals})",
            f"delete from deal_filler where deal_id in ({deals}) or filler_id = {filler_id or 0}",
            f"delete from deal_stage_record where deal_id in ({deals})",
            f"delete from deal_user where \"dealId\" in ({deals})",
            f"delete from deal where id in ({deals})",
            f"delete from deal_stage where id in ({stage_ids})",
            f"delete from filler where id = {filler_id or 0}",
            f"delete from \"user\" where username like '{TAG}%'",
            "commit",
        ]))
        left = psql(f"select (select count(*) from \"user\" where username like '{TAG}%') + (select count(*) from deal where label like '{TAG}%') + (select count(*) from deal_stage where id in ({stage_ids}))")
        check("test rows removed", left == "0", left)

    print(f"\nRESULT: {results['PASS']} passed, {results['FAIL']} failed")
    return 1 if results["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
