#!/usr/bin/env python3
"""Checks for the deal-stage triggers (block 7): actions, conditions, the schedule in trigger_run,
the scheduler, event triggers (Telegram, e-mail) and the rights on /stages/:id/triggers; that a trigger
never reacts to what triggers did (its own letter) and repeats are bounded (once per deal, a pause,
one open task); a failed run and the files a trigger deleted are noted in the deal's history; and
«Контроль менеджеров»: an outgoing call answers the client, «ждут ответа сейчас» does not depend on
the period. Wave 1b (business processes): exactly once (run keys), what a trigger names is checked
on save and a broken trigger is shown, a manager builds triggers, the order of the triggers and the
open tasks of a new responsible, «Перевести в этап», «Уведомить», «нет ответа N минут», conditions by
channel and «больше / меньше», «по очереди», a copy keeps its fields and products, a letter with the
deal's data and file, exact delays and a task never overdue at once.

Runs against the local stack: the docker stack (http://localhost:8080) or, with the CRM_*
variables from local/dev/env.sh, the dev copy on the server. The API must run the scheduler
often (TRIGGER_SCHEDULER_SEC=3..5 in the local env; the check waits up to 40 s for a run).
Usage: py local/checks/triggers_check.py      (exit code 1 on any FAIL)
Everything it creates is named AUDIT-trg-<run> and removed at the end (own stages, users, deals,
letters and their copies on the stand's test mail server).
"""
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
# the API's environment (the stand's mail server is reachable from there only)
APP_EXEC = (shlex.split(os.environ["CRM_APP_EXEC"]) if os.environ.get("CRM_APP_EXEC") else
            ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-app"])
APP_DIR = os.environ.get("CRM_APP_DIR", "/app")

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


def purge_mail(subject):
    """Deletes the letters with `subject` from every folder of the stand's mail server (best effort)."""
    script = r"""
import { ImapFlow } from 'imapflow';
const subject = %s;
const timer = setTimeout(() => { console.log('@@timeout'); process.exit(3); }, 90000);
const c = new ImapFlow({ host: process.env.EMAIL_HOST, port: Number(process.env.EMAIL_IMAP_PORT || 993), secure: true,
  auth: { user: process.env.EMAIL_DEFAULT_USER, pass: process.env.EMAIL_DEFAULT_PASSWORD }, logger: false, tls: { rejectUnauthorized: false } });
await c.connect();
let n = 0;
for (const box of await c.list()) {
  try {
    const lock = await c.getMailboxLock(box.path);
    try {
      const uids = await c.search({ subject }, { uid: true });
      if (uids && uids.length) { await c.messageDelete(uids, { uid: true }); n += uids.length; }
    } finally { lock.release(); }
  } catch (e) { /* a folder that cannot be selected */ }
}
await c.logout().catch(() => {});
clearTimeout(timer);
console.log('@@' + n);
""" % json.dumps(subject)
    try:
        done = subprocess.run(APP_EXEC + ["sh", "-c", "cd %s && node --input-type=module -" % shlex.quote(APP_DIR)],
                              input=script, capture_output=True, text=True, encoding="utf-8", timeout=150)
        line = next((l for l in done.stdout.splitlines() if l.startswith("@@")), None)
        return line[2:] if line else (done.stderr.strip()[-300:] or "no answer")
    except Exception as error:  # the mail server of the stand is a test one: a leftover is not a failure
        return str(error)[:300]


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
    # an agent who sees only own deals (the history of a trigger must not show the others)
    perms_own = json.loads(json.dumps(perms))
    perms_own["deal"].update({"view": 1, "update": 1})
    work_end = (env_value("CONTROL_WORK_HOURS", "09:00-18:00") or "09:00-18:00").split("-")[-1].strip().zfill(5)
    template_id = None

    users, stages, filler_id = {}, [], None
    try:
        print("== setup")
        for key in ("a", "b", "c"):
            person = {"email": f"audit-trg-{RUN}-{key}@example.test", "password": secrets.token_urlsafe(12),
                      "username": f"{TAG}-{key}", "role": "agent", "group_id": groups[0], "permissions": perms_own if key == "c" else perms,
                      "phone": f"+99890{random.randint(1000000, 9999999)}"}
            status, created = http("POST", "/users", person, admin)
            if status != 201:
                raise SystemExit(f"cannot create user {key}: {status} {created}")
            person["id"] = created["id"]
            person["token"] = http("POST", "/auth/login", {"email": person["email"], "password": person["password"]})[1]["access_token"]
            users[key] = person
        A, B, C = users["a"], users["b"], users["c"]
        for n in (1, 2, 3, 4, 5, 6, 7):
            status, st = http("POST", "/stages", {"name": f"{TAG}-{n}", "color": "#D5D8DB", "collection_id": collection}, admin)
            if status != 201:
                raise SystemExit(f"cannot create stage {n}: {status} {st}")
            stages.append(st["id"])
        S1, S2, S3, S4, S5, S6, S7 = stages
        filler_id = int(psql(f"insert into filler (target, field) values ('deal', '{TAG}-field') returning id"))
        contact = int(psql(f"insert into \"user\" (username, role, tg_id, email) values ('{TAG}-contact', 'ctr_agent', {7_000_000_000 + random.randint(1, 900_000_000)}, 'audit-trg-{RUN}-contact@example.test') returning id"))
        default_stage = int(psql("select stage_id from deal where false union all select coalesce((select default_stage_id from setting order by id desc limit 1), (select s.id from deal_stage s join collection c on c.id = s.collection_id where c.is_active and s.name = '%s' limit 1))" % env_value("DEAL_STAGE_UNKNOWN", "НЕРАЗОБРАННОЕ")))

        def new_deal(label, agent=None, budget=100, fillers=None, stage=None, contacts=None):
            payload = {"label": f"{TAG} {label}", "budget": budget, "agent_id": (agent or A)["id"], "ctr_agent_ids": contacts or [contact],
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

        def notes_of(deal, prefix):
            """Notes of the automation in the deal's history (comments without an author)."""
            return psql(f"select count(*) from event where deal_id = {deal} and type = 5 and user_id is null and after_state->'data'->>'comment' like '{prefix}%'")

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
        check("unknown task type -> 400 that names it (it used to be 404 «TaskType with id … does not exist»)",
              r[0] == 400 and "тип задачи" in message_of(r), r)
        r = trigger(S1, {"type": 4, "deal_filters": [], "apply_when": when_now(), "change_agent_data": {"agent_id": contact}})
        check("'change responsible' to a contact -> 400", r[0] == 400, r)
        r = trigger(S1, {"type": 5, "deal_filters": [], "apply_when": when_now(), "change_fields_data": {"fields": [{"field": "agent_id", "value": str(contact), "is_filler": False}]}})
        check("'change fields': a contact of a client as the responsible -> 400 (it made the client responsible)",
              r[0] == 400 and "контакт" in message_of(r), r)
        r = trigger(S1, {"type": 5, "deal_filters": [], "apply_when": when_now(), "change_fields_data": {"fields": [{"field": "budget", "value": "сто тысяч", "is_filler": False}]}})
        check("'change fields': a budget that is not a number -> 400 on save, not a failed run later", r[0] == 400 and "число" in message_of(r), r)
        r = trigger(S1, {"type": 0, "deal_filters": [{"field": "budget", "value": "много", "is_filler": False, "op": "gt"}], "apply_when": when_now(),
                         "create_task_data": {"label": "x", "type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 60, "all_day": False}})
        check("a condition «больше» with a value that is not a number -> 400", r[0] == 400, r)

        print("== immediate triggers on entering a stage")
        r = trigger(S1, {"type": 0, "deal_filters": [], "apply_when": when_now(),
                         "create_task_data": {"label": f"{TAG} позвонить клиенту", "type_id": task_type, "responsible": {"user": "creator"}, "end_time_in_minutes": 1440, "all_day": False}})
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
        check("admin gets every trigger with its run statistics (failed runs of 7 days, the last error)",
              r[0] == 200 and all(isinstance(t.get("runs"), dict) and "failed" in t["runs"] for t in r[1]), r)
        r = http("GET", f"/stages/{S1}/triggers", token=A["token"])
        check("an agent reads the triggers without their run statistics (an error may name a client)",
              r[0] == 200 and len(r[1]) == 3 and all("runs" not in t for t in r[1]), r)
        r = trigger(S1, {"type": 5, "deal_filters": [], "apply_when": when_now(), "change_fields_data": {"fields": [{"field": "created_at", "value": "2020-01-01", "is_filler": False}]}})
        check("'change fields' on a read-only column -> 400", r[0] == 400, r)
        r = trigger(S1, {"type": 2, "deal_filters": [], "apply_when": when_now(), "send_email_data": {"template_id": 999999999, "from": "currently_assigned"}})
        check("'send email' with an unknown template -> 400 that names it", r[0] == 400 and "шаблон письма" in message_of(r), r)

        D1 = new_deal("сделка 1")
        r = move(D1, S1)
        check("move the deal into the stage -> 200", r[0] == 200, r)
        tasks = tasks_of(D1)
        check("'create task': one task with the label, type, the creator (admin) as responsible",
              tasks == [[f"{TAG} позвонить клиенту", str(admin_id), str(task_type), "f", "", "f"]], tasks)
        n = psql(f"select count(*) from event where deal_id = {D1} and type = 6")
        check("the task is in the deal history (NEW_TASK event)", n == "1", n)
        row = psql(f"select status from trigger_run where trigger_id = {t_task} and deal_id = {D1}")
        check("the immediate run is recorded as done in trigger_run", row == "done", row)
        row = psql(f"select coalesce(note, '') from trigger_run where trigger_id = {t_task} and deal_id = {D1}")
        check("the done run says what it did (note: создана задача …)", row.startswith("создана задача"), row)
        row = psql(f"select to_char(end_time, 'HH24:MI'), end_time::date > (now() at time zone 'Asia/Karachi')::date from task where deal_id = {D1} and label = '{TAG} позвонить клиенту'")
        check(f"«через день» is due at the end of a working day ({work_end}) after today, not 24 h from now", row == f"{work_end}|t", row)
        r = http("POST", "/triggers/run-due", {}, token=A["token"])
        check("POST /triggers/run-due as an agent -> 403", r[0] == 403, r)
        r = http("POST", "/triggers/run-due", {}, token=admin)
        check("POST /triggers/run-due as admin -> one tick with counters", r[0] == 201 and isinstance(r[1], dict) and "executed" in r[1], r)
        # deal.budget is numeric(18,2) since DealAmountsNumeric1795620000100 (DB-7): 777 is stored as 777.00
        row = psql(f"select trim_scale(d.budget), d.agent_id, (select value from deal_filler df where df.deal_id = d.id and df.filler_id = {filler_id}) from deal d where d.id = {D1}")
        check("'change fields' changed BOTH fields (budget and the custom field created on the fly); then 'change responsible' fired because budget = 777",
              row == f"777|{B['id']}|auto", row)
        n = psql(f"select count(*) from event where deal_id = {D1} and type = 3")
        check("field changes are in the history (NEW_FIELD_VALUE events)", int(n or 0) >= 1, n)

        D2 = new_deal("сделка 2", budget=5)
        move(D2, S1)
        row = psql(f"select trim_scale(budget), agent_id from deal where id = {D2}")
        check("the condition on budget is checked after 'change fields' ran: budget 777 -> responsible changed too", row == f"777|{B['id']}", row)
        D3 = new_deal("сделка 3 сразу в этапе", stage=S1)
        tasks = tasks_of(D3)
        check("a deal CREATED in the stage gets the immediate triggers too", len(tasks) == 1 and tasks[0][0] == f"{TAG} позвонить клиенту", tasks)

        print("== a condition on a custom field")
        r = trigger(S2, {"type": 0, "deal_filters": [{"field": f"{TAG}-field", "value": "vip", "is_filler": True}], "apply_when": when_now(),
                         "create_task_data": {"label": f"{TAG} VIP-задача", "type_id": task_type, "responsible": {"exact_user_id": B["id"]}, "end_time_in_minutes": 0, "all_day": False, "deadline": "end_of_working_day"}})
        check("create a trigger with a condition on a custom field -> 201", r[0] == 201, r)
        t_vip = r[1]["id"]
        check("the condition on the custom field is kept with the field's id (a rename keeps the trigger)",
              r[0] == 201 and (r[1].get("deal_filters") or [{}])[0].get("filler_id") == filler_id, r)
        D4 = new_deal("vip", fillers=[{"filler_id": filler_id, "value": "vip"}])
        D5 = new_deal("not vip", fillers=[{"filler_id": filler_id, "value": "usual"}])
        move(D4, S2)
        move(D5, S2)
        check("the trigger fires for the deal that matches the custom field (responsible = exact user B)",
              tasks_of(D4) == [[f"{TAG} VIP-задача", str(B["id"]), str(task_type), "f", "", "f"]], tasks_of(D4))
        check("and not for the deal that does not match", tasks_of(D5) == [], tasks_of(D5))
        row = psql(f"select status || '|' || coalesce(error, '') from trigger_run where trigger_id = {t_vip} and deal_id = {D5}")
        check("a deal that does not fit the conditions is «skipped» with the reason, not «done»", row == "skipped|сделка не подходит под условия триггера", row)
        row = psql(f"select to_char(end_time, 'HH24:MI') from task where deal_id = {D4}")
        check(f"«Конец рабочего дня» is due at {work_end}", row == work_end, row)
        psql(f"update filler set field = '{TAG}-field-renamed' where id = {filler_id}")
        r = http("GET", f"/stages/{S2}/triggers/{t_vip}", token=admin)
        check("after the custom field is renamed the trigger shows its new name", r[0] == 200 and (r[1].get("deal_filters") or [{}])[0].get("field") == f"{TAG}-field-renamed", r)
        D5b = new_deal("vip после переименования", fillers=[{"filler_id": filler_id, "value": "vip"}])
        move(D5b, S2)
        check("and still fires for a deal with that field (matched by id)", any(t[0] == f"{TAG} VIP-задача" for t in tasks_of(D5b)), tasks_of(D5b))
        psql(f"update filler set field = '{TAG}-field' where id = {filler_id}")
        # a field the conditions name is deleted: the trigger can never fire, the history says why
        filler_gone = int(psql(f"insert into filler (target, field) values ('deal', '{TAG}-field-gone') returning id"))
        r = trigger(S2, {"type": 0, "deal_filters": [{"field": f"{TAG}-field-gone", "value": "x", "is_filler": True}], "apply_when": when_now(),
                         "create_task_data": {"label": f"{TAG} удалённое поле", "type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 0, "all_day": False}})
        t_gone = r[1]["id"] if r[0] == 201 else 0
        psql(f"delete from filler where id = {filler_gone}")
        D5c = new_deal("поле удалено")
        move(D5c, S2)
        row = psql(f"select status || '|' || coalesce(error, '') from trigger_run where trigger_id = {t_gone} and deal_id = {D5c}")
        check("a condition on a deleted field is a failed run that names the field, not a silent «не подходит»",
              row.startswith("failed|") and f"{TAG}-field-gone" in row, row)
        n = wait_for(lambda: notes_of(D5c, "Автоматика не сработала"), "1", timeout=15)
        check("the failure is noted in the deal's history too («Автоматика не сработала: …»), once", n == "1", n)
        if t_gone:
            http("DELETE", f"/stages/{S2}/triggers/{t_gone}", token=admin)

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
        row = psql(f"select label, trim_scale(budget), stage_id, agent_id, (select count(*) from deal_user du where du.\"dealId\" = d.id and du.\"userId\" = {contact}), created_by from deal d where label = '{TAG} оригинал (копия)'")
        check("a copy of the deal appears in the target stage with budget, responsible and contact", row == f"{TAG} оригинал (копия)|42|{S3}|{A['id']}|1|{admin_id}", row)
        n = psql(f"select count(*) from deal where label like '{TAG} оригинал (копия)%'")
        check("the copy itself does not spawn another copy", n == "1", n)
        # the deal comes back to the stage: "create deal" acts once per deal (no second production order)
        move(D6, S3)
        move(D6, S2)
        n = psql(f"select count(*) from deal where label like '{TAG} оригинал (копия)%'")
        row = psql(f"select status || '|' || coalesce(error, '') from trigger_run where trigger_id = {t_copy} and deal_id = {D6} order by id desc limit 1")
        check("a deal that enters the stage again gets no second copy (once per deal, the run says why)",
              n == "1" and row.startswith("skipped|уже выполнялся"), (n, row))
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
        row = psql(f"select abs(extract(epoch from (r.run_at - (d.last_stage_change + interval '10 minutes')))) < 0.01 from trigger_run r join deal d on d.id = r.deal_id where r.trigger_id = {t_delay} and r.deal_id = {D7} and r.status = 'pending'")
        check("«через 10 минут» is exactly 10 minutes after the entry (it was rounded down to the minute: up to 59 s early)", row == "t", row)
        check("nothing is executed yet", tasks_of(D7) == [], tasks_of(D7))
        r = http("GET", f"/stages/{S2}/triggers/{t_delay}/runs", token=admin)
        check("GET /stages/:id/triggers/:id/runs shows the planned run", r[0] == 200 and len(r[1]) == 1 and r[1][0]["status"] == "pending" and r[1][0]["deal_id"] == D7, r)
        r = http("GET", f"/stages/{S2}/triggers/{t_delay}/runs", token=A["token"])
        check("an agent may read the schedule too -> 200", r[0] == 200, r)
        r = http("GET", f"/stages/{S2}/triggers/{t_delay}/runs", token=C["token"])
        check("an agent who sees only own deals gets the runs of own deals only (none here)", r[0] == 200 and r[1] == [], r)
        try:
            psql(f"insert into trigger_run (trigger_id, deal_id, run_at, status) select trigger_id, deal_id, run_at, 'pending' from trigger_run where trigger_id = {t_delay} and deal_id = {D7} and status = 'pending'")
            dup = "inserted"
        except RuntimeError as error:
            dup = str(error)
        check("a second pending run of the same trigger and deal is refused by the database (IDX_trigger_run_pending)",
              "IDX_trigger_run_pending" in dup or "duplicate key" in dup, dup[:300])
        move(D7, S3)
        row = psql(f"select status || '|' || coalesce(error, '') from trigger_run where trigger_id = {t_delay} and deal_id = {D7}")
        check("the deal left the stage: the run is skipped with that reason", row == "skipped|сделка ушла из этапа", row)
        move(D7, S2)
        psql(f"update trigger_run set run_at = now() - interval '1 minute' where trigger_id = {t_delay} and deal_id = {D7} and status = 'pending'")
        status_after = wait_for(lambda: psql(f"select status from trigger_run where trigger_id = {t_delay} and deal_id = {D7} and status <> 'skipped'"), "done")
        check("the scheduler executes the due run and marks it done (works after a restart too: nothing is in memory)", status_after == "done", status_after)
        check("the task is created by the scheduled run", tasks_of(D7) == [[f"{TAG} через 10 минут", str(A["id"]), str(task_type), "f", "", "f"]], tasks_of(D7))
        n = psql(f"select count(*) from trigger_run where trigger_id = {t_delay} and deal_id = {D7} and status = 'pending'")
        check("a one-shot run is not planned again", n == "0", n)

        print("== a repeat visit and a changed trigger keep their schedule")
        # D7 leaves and comes back past the API: its old runs belong to the first visit
        move(D7, S3)
        psql(f"update deal set stage_id = {S2}, last_stage_change = {local_now} where id = {D7}")
        n = wait_for(lambda: psql(f"select count(*) from trigger_run where trigger_id = {t_delay} and deal_id = {D7} and status = 'pending'"), "1")
        check("the scheduler plans the delayed run of a second visit too (older runs of the deal do not count)", n == "1", n)
        before = psql(f"select id from trigger_run where trigger_id = {t_delay} and deal_id = {D7} and status = 'pending'")
        same_when = {"type": 0, "deal_filters": [], "apply_when": when_now(10),
                     "create_task_data": {"label": f"{TAG} через 10 минут", "type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 60, "all_day": False}}
        r = http("PATCH", f"/stages/{S2}/triggers/{t_delay}", same_when, admin)
        after = psql(f"select id from trigger_run where trigger_id = {t_delay} and deal_id = {D7} and status = 'pending'")
        check("saving a trigger whose schedule did not change keeps its planned runs", r[0] == 200 and before and after == before, (r, before, after))
        r = http("PATCH", f"/stages/{S2}/triggers/{t_delay}", {**same_when, "apply_when": when_now(30)}, admin)
        row = psql(f"select r.id = {before or 0} and abs(extract(epoch from (r.run_at - (d.last_stage_change + interval '30 minutes')))) < 0.01 from trigger_run r join deal d on d.id = r.deal_id where r.trigger_id = {t_delay} and r.deal_id = {D7} and r.status = 'pending'")
        check("a changed schedule moves the planned run, never drops it: the same row, exactly 30 minutes from the entry into the stage",
              r[0] == 200 and row == "t", (r, row))
        http("PATCH", f"/stages/{S2}/triggers/{t_delay}", same_when, admin)

        print("== a failing trigger is a failed run, not a crash")
        psql(f"update trigger set data = jsonb_set(data, '{{type_id}}', '999999999') where id = {t_delay}")
        D8 = new_deal("сломанный триггер")
        move(D8, S2)
        psql(f"update trigger_run set run_at = now() - interval '1 minute' where trigger_id = {t_delay} and deal_id = {D8} and status = 'pending'")
        row = wait_for(lambda: psql(f"select status || '|' || coalesce(left(error, 40), '') from trigger_run where trigger_id = {t_delay} and deal_id = {D8}").split("|")[0], "failed")
        err = psql(f"select coalesce(error, '') from trigger_run where trigger_id = {t_delay} and deal_id = {D8}")
        check("the run is marked failed with the error text", row == "failed" and "999999999" in err, (row, err))
        n = wait_for(lambda: notes_of(D8, "Автоматика не сработала"), "1", timeout=15)
        note = psql(f"select after_state->'data'->>'comment' from event where deal_id = {D8} and type = 5 and user_id is null order by id limit 1")
        check("the people of the deal see it in its history, in words: the action and the missing task type",
              n == "1" and "«Создать задачу»" in note and "тип задачи" in note, (n, note))
        check("the API is still alive", http("GET", "/groups", token=admin)[0] == 200)
        r = http("GET", f"/stages/{S2}/triggers", token=admin)
        broken = next((t for t in (r[1] or []) if t.get("id") == t_delay), {}) if r[0] == 200 else {}
        check("the settings see the failure: the trigger's run statistics count it, with the last error",
              (broken.get("runs") or {}).get("failed", 0) >= 1 and "999999999" in str((broken.get("runs") or {}).get("last_error")), broken.get("runs"))
        psql(f"update trigger set data = jsonb_set(data, '{{type_id}}', '{task_type}') where id = {t_delay}")

        print("== exact time and recurring")
        # tomorrow of the CRM (Asia/Karachi), not of the machine that runs the check
        tomorrow = psql("select to_char((now() at time zone 'Asia/Karachi')::date + 1, 'YYYY-MM-DD')")
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
        # a recurring run whose time came: executed and the next one planned. An occurrence is its run key
        # (at:<ms>, IDX_trigger_run_key, TRG-2): the time that «came» moves the key with run_at, otherwise
        # the row would still be tomorrow's 08:00 and the next occurrence (tomorrow 08:00) a duplicate of it
        occurrence = lambda ago: (f"run_at = (now() at time zone 'Asia/Karachi') - interval '{ago}', "
                                  f"run_key = 'at:' || (extract(epoch from now() - interval '{ago}') * 1000)::bigint")
        psql(f"update trigger_run set {occurrence('1 minute')} where trigger_id = {t_daily} and deal_id = {D9} and status = 'pending'")
        done = wait_for(lambda: psql(f"select count(*) from trigger_run where trigger_id = {t_daily} and deal_id = {D9} and status = 'done'"), "1")
        row = wait_for(lambda: psql(f"select count(*) filter (where status = 'done'), count(*) filter (where status = 'pending' and run_at > (now() at time zone 'Asia/Karachi')) from trigger_run where trigger_id = {t_daily} and deal_id = {D9}"), "1|1", timeout=15)
        check("a due daily run is executed and the next day's run is planned", done == "1" and row == "1|1", row)
        check("the daily task exists", any(t[0] == f"{TAG} ежедневно" for t in tasks_of(D9)), tasks_of(D9))
        # a recurring run that waited more than a day (the API was down) is not executed
        psql(f"update trigger_run set {occurrence('2 days')} where trigger_id = {t_daily} and deal_id = {D9} and status = 'pending'")
        missed = wait_for(lambda: psql(f"select count(*) from trigger_run where trigger_id = {t_daily} and deal_id = {D9} and status = 'skipped' and error like 'не выполнен вовремя%'"), "1")
        check("a run older than a day is skipped as missed, not executed late", missed == "1", missed)
        nxt = wait_for(lambda: psql(f"select count(*) from trigger_run where trigger_id = {t_daily} and deal_id = {D9} and status = 'pending' and run_at > (now() at time zone 'Asia/Karachi')"), "1", timeout=15)
        check("a missed occurrence does not stop the schedule: the next one is planned", nxt == "1", nxt)
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
        row = psql(f"select count(*) filter (where status = 'pending' and to_char(run_at, 'HH24:MI') = '09:30'), count(*) filter (where status = 'pending' and deal_id = {D9}) from trigger_run where trigger_id = {t_exact}")
        check("changing the schedule of a trigger moves its planned runs: none left at the old time, none for the closed deal",
              r[0] == 200 and row == "0|0", (r, row))
        row = wait_for(lambda: psql(f"select count(*) from trigger_run where trigger_id = {t_exact} and deal_id = {D4} and status = 'pending' and to_char(run_at, 'YYYY-MM-DD HH24:MI') = '{tomorrow} 10:00'"), "1")
        check("an open deal of the stage gets its run at the new time from the scheduler", row == "1", row)
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
        t_tg = r[1]["id"] if r[0] == 201 else 0
        D10 = new_deal("telegram", agent=A)
        move(D10, S2)
        check("an event trigger does not fire on entering the stage", not any(t[0] == f"{TAG} ответить в Telegram" for t in tasks_of(D10)), tasks_of(D10))
        if token and len(token) >= 16:
            tg = int(psql(f"select tg_id from \"user\" where id = {contact}"))
            incoming = {"agent_id": A["id"], "agent_tg_id": 6_000_000_000 + random.randint(1, 900_000_000), "chat": {"tg_id": tg, "first_name": "Клиент"},
                        "tg_message_id": random.randint(1, 10**8), "text": "Здравствуйте", "outgoing": False, "files": []}
            r = http("POST", "/telegram/incoming", incoming, headers={"X-Telegram-Service-Token": token})
            # the message goes into ONE deal of the client (ClientDealsService): A's newest open deal with
            # the contact, D10, the one in the stage with the trigger
            check("an incoming Telegram message of the deal fires the trigger: a task 'ответить' appears once",
                  r[0] == 201 and D10 in (r[1].get("deal_ids") or []) and sum(1 for t in tasks_of(D10) if t[0] == f"{TAG} ответить в Telegram") == 1, (r, tasks_of(D10)))
            incoming.update({"tg_message_id": random.randint(1, 10**8), "outgoing": True, "text": "Ответ"})
            http("POST", "/telegram/incoming", incoming, headers={"X-Telegram-Service-Token": token})
            check("an OUTGOING message does not fire a trigger that waits for incoming ones", sum(1 for t in tasks_of(D10) if t[0] == f"{TAG} ответить в Telegram") == 1, tasks_of(D10))
            incoming.update({"tg_message_id": random.randint(1, 10**8), "outgoing": False, "text": "И ещё вопрос"})
            http("POST", "/telegram/incoming", incoming, headers={"X-Telegram-Service-Token": token})
            n = psql(f"select count(*) from trigger_run where trigger_id = {t_tg} and deal_id = {D10}")
            check("the next message while the task «ответить» is open adds no second task and no row in the history",
                  sum(1 for t in tasks_of(D10) if t[0] == f"{TAG} ответить в Telegram") == 1 and n == "1", (tasks_of(D10), n))
        else:
            check("TELEGRAM_SERVICE_TOKEN is set for the Telegram event check", False, "not set")

        print("== event trigger: a WhatsApp message, the employee of the chat")
        wa_token = env_value("WHATSAPP_SERVICE_TOKEN")
        task_30 = {"type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 30, "all_day": False}
        r = trigger(S2, {"type": 0, "deal_filters": [], "apply_when": {"when": "wa_message_received", "outgoing": False, "from_user_id": A["id"]},
                         "create_task_data": {"label": f"{TAG} ответить в WhatsApp", **task_30}})
        check("create a trigger 'при входящем сообщении WhatsApp', employee A -> 201, kind event",
              r[0] == 201 and r[1].get("kind") == "event" and (r[1].get("apply_when_data") or {}).get("from_user_id") == A["id"], r)
        r = trigger(S2, {"type": 0, "deal_filters": [], "apply_when": {"when": "wa_message_received", "outgoing": False, "from_user_id": B["id"]},
                         "create_task_data": {"label": f"{TAG} WhatsApp сотрудника B", **task_30}})
        check("the same for employee B -> 201", r[0] == 201, r)
        if wa_token and len(wa_token) >= 16:
            digits = f"99893{random.randint(1000000, 9999999)}"
            # tg_id given: no lookup of the number in Telegram in the background
            wa_contact = int(psql(f"insert into \"user\" (username, role, phone, wa_id, tg_id) values ('{TAG}-wa', 'ctr_agent', '+{digits}', '{digits}@s.whatsapp.net', {7_000_000_000 + random.randint(1, 900_000_000)}) returning id"))
            D18 = new_deal("whatsapp", agent=A, contacts=[wa_contact])
            move(D18, S2)
            message = {"agent_id": A["id"], "agent_phone": A["phone"], "wa_message_id": f"WA{RUN}t1", "text": "Narx qancha?", "outgoing": False, "files": [],
                       "chat": {"wa_id": f"{digits}@s.whatsapp.net", "phone": "+" + digits, "name": f"{TAG} Клиент WA"}}
            r = http("POST", "/whatsapp/incoming", message, headers={"X-WhatsApp-Service-Token": wa_token})
            labels = [t[0] for t in tasks_of(D18)]
            check("an incoming WhatsApp message fires the trigger of the chat's employee (A) once, not the one of B",
                  r[0] == 201 and D18 in (r[1].get("deal_ids") or []) and labels.count(f"{TAG} ответить в WhatsApp") == 1
                  and f"{TAG} WhatsApp сотрудника B" not in labels, (r, labels))
        else:
            check("WHATSAPP_SERVICE_TOKEN is set for the WhatsApp event check", False, "not set")

        print("== no loops: a letter trigger and its own letters")
        contact_email = f"audit-trg-{RUN}-contact@example.test"
        template_a = int(psql(f"insert into email_template (template_body, name, subject) values ('<p>AUDIT</p>', '{TAG}-tpl-a', '{TAG} шаблон А') returning id"))
        template_b = int(psql(f"insert into email_template (template_body, name, subject) values ('<p>AUDIT</p>', '{TAG}-tpl-b', '{TAG} шаблон Б') returning id"))
        template_id = template_a
        # «при письме» in any direction, «каждый раз»: only the loop guard stands between it and its own letter
        r = trigger(S4, {"type": 2, "deal_filters": [], "apply_when": {"when": "email_received", "cooldown_minutes": 0, "once_per_deal": False},
                         "send_email_data": {"template_id": template_a, "from": "currently_assigned"}})
        check("create 'send email' on any letter, every time -> 201", r[0] == 201, r)
        t_mail_every = r[1]["id"] if r[0] == 201 else 0
        # the same with the default repeat of letters (once a day per deal)
        r = trigger(S4, {"type": 2, "deal_filters": [], "apply_when": {"when": "email_received"},
                         "send_email_data": {"template_id": template_b, "from": "currently_assigned"}})
        t_mail_daily = r[1]["id"] if r[0] == 201 else 0
        D11 = new_deal("письма", agent=A, stage=S4)

        def letters(subject):
            return psql(f"select count(distinct coalesce(message_id, id::text)) from email where subject = '{subject}'")

        def done_runs(trigger_id):
            return psql(f"select count(*) from trigger_run where trigger_id = {trigger_id} and deal_id = {D11} and status = 'done'")

        r = http("POST", "/emails", {"subject": f"{TAG} письмо клиенту 1", "body": "<p>AUDIT</p>", "to": [contact_email], "deal_id": str(D11)}, admin)
        check("a letter from the CRM to the contact of the deal -> 201", r[0] == 201, r)
        wait_for(lambda: (done_runs(t_mail_every), done_runs(t_mail_daily)), ("1", "1"))
        time.sleep(5)  # a loop would go on by itself: give it time
        check("the letter fires both letter triggers once; their own letters fire nothing (no loop, no copies for the other open deals of the contact)",
              (done_runs(t_mail_every), done_runs(t_mail_daily), letters(f"{TAG} шаблон А"), letters(f"{TAG} шаблон Б")) == ("1", "1", "1", "1"),
              (done_runs(t_mail_every), done_runs(t_mail_daily), letters(f"{TAG} шаблон А"), letters(f"{TAG} шаблон Б")))
        http("POST", "/emails", {"subject": f"{TAG} письмо клиенту 2", "body": "<p>AUDIT</p>", "to": [contact_email], "deal_id": str(D11)}, admin)
        wait_for(lambda: done_runs(t_mail_every), "2")
        time.sleep(5)
        check("the next letter: «каждый раз» answers once more, the default (once a day) does not, nothing else",
              (done_runs(t_mail_every), done_runs(t_mail_daily), letters(f"{TAG} шаблон А"), letters(f"{TAG} шаблон Б")) == ("2", "1", "2", "1"),
              (done_runs(t_mail_every), done_runs(t_mail_daily), letters(f"{TAG} шаблон А"), letters(f"{TAG} шаблон Б")))
        n = psql(f"select count(*) from trigger_run where trigger_id = {t_mail_daily} and deal_id = {D11}")
        check("a letter within the pause leaves no row in the history", n == "1", n)
        # the letters below go to every open deal of the contact, D11 too: its triggers are done here
        for t_id in (t_mail_every, t_mail_daily):
            if t_id:
                http("DELETE", f"/stages/{S4}/triggers/{t_id}", token=admin)

        print("== an immediate letter is queued, the old «Конец дня» is the end of the working day")
        template_c = int(psql(f"insert into email_template (template_body, name, subject) values ('<p>AUDIT</p>', '{TAG}-tpl-c', '{TAG} шаблон В') returning id"))
        r = trigger(S5, {"type": 2, "deal_filters": [], "apply_when": when_now(), "send_email_data": {"template_id": template_c, "from": "currently_assigned"}})
        check("create 'send email' right after entering the stage -> 201", r[0] == 201, r)
        t_mail_now = r[1]["id"] if r[0] == 201 else 0
        # the web client of before sent «Конец дня» as 1440 minutes, all day
        r = trigger(S5, {"type": 0, "deal_filters": [], "apply_when": when_now(),
                         "create_task_data": {"label": f"{TAG} конец дня", "type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 1440, "all_day": True}})
        check("create 'create task' with the old «Конец дня» (1440 minutes, all day) -> 201", r[0] == 201, r)
        D17 = new_deal("письмо сразу", agent=A)
        started = time.time()
        r = move(D17, S5)
        check("moving the deal into a stage with an immediate letter -> 200", r[0] == 200, r)
        status_now = wait_for(lambda: psql(f"select status from trigger_run where trigger_id = {t_mail_now} and deal_id = {D17}"), "done", timeout=60)
        note = psql(f"select coalesce(note, '') from trigger_run where trigger_id = {t_mail_now} and deal_id = {D17}")
        check("the letter is queued and goes out within seconds after the request (a done run that says what it did)",
              status_now == "done" and note.startswith("письмо") and time.time() - started < 30, (status_now, note, round(time.time() - started)))
        check("exactly one letter of the template", letters(f"{TAG} шаблон В") == "1", letters(f"{TAG} шаблон В"))
        n = wait_for(lambda: psql(f"select count(*) from event where deal_id = {D17} and type = 9 and after_state->'data'->>'subject' = '{TAG} шаблон В'"), "1")
        check("the letter is in the history of the deal", n == "1", n)
        row = psql(f"select to_char(end_time, 'HH24:MI'), \"allDay\" from task where deal_id = {D17} and label = '{TAG} конец дня'")
        check(f"the old «Конец дня» is due at the end of the working day ({work_end}), not tomorrow at this time, and not all day",
              row == f"{work_end}|f", row)

        print("== one letter in two open deals is answered once")
        template_d = int(psql(f"insert into email_template (template_body, name, subject) values ('<p>AUDIT</p>', '{TAG}-tpl-d', '{TAG} шаблон Г') returning id"))
        r = trigger(S6, {"type": 2, "deal_filters": [], "apply_when": {"when": "email_received", "cooldown_minutes": 0, "once_per_deal": False},
                         "send_email_data": {"template_id": template_d, "from": "currently_assigned"}})
        check("create 'send email' on any letter, every time, in a stage with two deals of the contact -> 201", r[0] == 201, r)
        t_mail_once = r[1]["id"] if r[0] == 201 else 0
        D15 = new_deal("письмо в две сделки 1", agent=A, stage=S6)
        D16 = new_deal("письмо в две сделки 2", agent=A, stage=S6)
        r = http("POST", "/emails", {"subject": f"{TAG} письмо клиенту 3", "body": "<p>AUDIT</p>", "to": [contact_email], "deal_id": str(D15)}, admin)
        check("a letter to the contact of both deals -> 201", r[0] == 201, r)

        def answered_once():
            return psql(f"select count(*) from trigger_run where trigger_id = {t_mail_once} and deal_id in ({D15}, {D16}) and status = 'done'")

        wait_for(answered_once, "1")
        time.sleep(5)
        check("the trigger answers the letter once, not once per deal (one run, one letter)",
              (answered_once(), letters(f"{TAG} шаблон Г")) == ("1", "1"), (answered_once(), letters(f"{TAG} шаблон Г")))

        print("== delete files: what went is in the deal's history")
        r = trigger(S7, {"type": 6, "deal_filters": [], "apply_when": when_now(),
                         "delete_files_data": {"with_extensions": [".pdf"], "which_files": []}})
        check("create 'delete files' (.pdf) right after entering the stage -> 201", r[0] == 201, r)
        t_files = r[1]["id"] if r[0] == 201 else 0
        D19 = new_deal("файлы", agent=A)
        # rows only: the paths do not exist on disk (the trigger's unlink finds nothing to delete)
        pdf = int(psql(f"insert into file (name, path, size, \"from\", extension) values ('{TAG}-договор.pdf', '{TAG}-dogovor.pdf', 10, 'uploaded_from_files_tab', '.pdf') returning id"))
        txt = int(psql(f"insert into file (name, path, size, \"from\", extension) values ('{TAG}-заметка.txt', '{TAG}-note.txt', 10, 'uploaded_from_files_tab', '.txt') returning id"))
        psql(f"insert into deal_file (\"dealId\", \"fileId\") values ({D19}, {pdf}), ({D19}, {txt})")
        r = move(D19, S7)
        check("moving the deal into the stage -> 200", r[0] == 200, r)
        row = psql(f"select status || '|' || coalesce(note, '') from trigger_run where trigger_id = {t_files} and deal_id = {D19}")
        check("the run is done and names what it deleted", row == f"done|удалено файлов: 1 ({TAG}-договор.pdf)", row)
        row = psql(f"select (select count(*) from file where id = {pdf}), (select count(*) from deal_file where \"dealId\" = {D19} and \"fileId\" = {txt})")
        check("the .pdf is gone (used nowhere else), the .txt stays in the deal", row == "0|1", row)
        n = psql(f"select count(*) from event where deal_id = {D19} and type = 5 and user_id is null and after_state->'data'->>'comment' like 'Автоматика удалила файлы%' and after_state->'data'->'removed_files' @> '[{{\"name\": \"{TAG}-договор.pdf\"}}]'::jsonb")
        check("the deal's history says which files the automation deleted (removed_files: «Удалены файлы: …»)", n == "1", n)

        print("== wave 1b: exactly once, broken triggers, the rights of a manager")
        more = []
        for n in range(8, 17):
            status, st = http("POST", "/stages", {"name": f"{TAG}-{n}", "color": "#D5D8DB", "collection_id": collection}, admin)
            if status != 201:
                raise SystemExit(f"cannot create stage {n}: {status} {st}")
            stages.append(st["id"])
            more.append(st["id"])
        S8, S9, S10, S11, S12, S13, S14, S15, S16 = more
        task_now = {"type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 0, "all_day": False}
        for key, role in (("m", "manager"), ("x", "agent")):
            person = {"email": f"audit-trg-{RUN}-{key}@example.test", "password": secrets.token_urlsafe(12), "username": f"{TAG}-{key}",
                      "role": role, "group_id": groups[0], "permissions": perms, "phone": f"+99890{random.randint(1000000, 9999999)}"}
            status, created = http("POST", "/users", person, admin)
            if status != 201:
                raise SystemExit(f"cannot create user {key}: {status} {created}")
            person["id"] = created["id"]
            person["token"] = http("POST", "/auth/login", {"email": person["email"], "password": person["password"]})[1]["access_token"]
            users[key] = person
        M, X = users["m"], users["x"]

        dup_key = f"enter:{random.randint(10**12, 2 * 10**12)}"
        D20 = new_deal("ключ запуска")
        try:
            psql(f"insert into trigger_run (trigger_id, deal_id, run_at, status, run_key) values ({t_task}, {D20}, now(), 'done', '{dup_key}'), ({t_task}, {D20}, now(), 'running', '{dup_key}')")
            dup = "inserted"
        except RuntimeError as error:
            dup = str(error)
        check("one execution per entry, letter or occurrence: a second run with the same key is refused by the database (IDX_trigger_run_key)",
              "IDX_trigger_run_key" in dup or "duplicate key" in dup, dup[:300])

        r = trigger(S8, {"type": 0, "deal_filters": [], "apply_when": when_now(), "create_task_data": {"label": f"{TAG} руководитель", **task_now}}, M["token"])
        check("a manager (руководитель) builds the triggers of a stage -> 201", r[0] == 201, r)
        r = http("PATCH", f"/stages/{S8}/trigger-order", {"ids": [r[1]["id"]] if r[0] == 201 else []}, A["token"])
        check("an agent cannot reorder the triggers -> 403", r[0] == 403, r)

        http("DELETE", f"/users/{X['id']}", token=admin)
        r = trigger(S8, {"type": 0, "deal_filters": [], "apply_when": when_now(), "create_task_data": {"label": "x", **task_now, "responsible": {"exact_user_id": X["id"]}}})
        check("a trigger that names a dismissed employee is not saved: 400 that says so", r[0] == 400 and "уволен" in message_of(r), r)
        template_e = int(psql(f"insert into email_template (template_body, name, subject) values ('<p>AUDIT</p>', '{TAG}-tpl-e', '{TAG} шаблон Д') returning id"))
        r = trigger(S8, {"type": 2, "deal_filters": [], "apply_when": {"when": "email_received", "outgoing": False}, "send_email_data": {"template_id": template_e, "from": "currently_assigned"}})
        t_broken = r[1]["id"] if r[0] == 201 else 0
        psql(f"delete from email_template where id = {template_e}")
        r = http("GET", f"/stages/{S8}/triggers", token=admin)
        mine = next((t for t in (r[1] or []) if t.get("id") == t_broken), {}) if r[0] == 200 else {}
        check("the template of a trigger is deleted: the trigger is marked broken in the settings (problems)",
              any("шаблон письма" in p for p in mine.get("problems") or []), mine.get("problems"))
        r = http("GET", "/triggers/broken", token=admin)
        check("GET /triggers/broken lists it with the stage and what is wrong", r[0] == 200 and any(b.get("id") == t_broken and b.get("problems") for b in r[1]), r)
        check("an agent does not get the list of broken triggers -> 403", http("GET", "/triggers/broken", token=A["token"])[0] == 403)
        r = http("PATCH", f"/stages/{S8}/triggers/{t_broken}", {"type": 2, "deal_filters": [], "apply_when": {"when": "email_received", "outgoing": False}, "send_email_data": {"template_id": template_e, "from": "currently_assigned"}}, admin)
        check("saving the broken trigger again says what to fix (400), the others of the page are saved one by one", r[0] == 400 and "шаблон письма" in message_of(r), r)
        if t_broken:
            http("DELETE", f"/stages/{S8}/triggers/{t_broken}", token=admin)

        print("== wave 1b: the order of the triggers, the tasks of a new responsible, «по очереди»")
        r1 = trigger(S9, {"type": 0, "deal_filters": [], "apply_when": when_now(), "create_task_data": {"label": f"{TAG} порядок", **task_now}})
        r2 = trigger(S9, {"type": 4, "deal_filters": [], "apply_when": when_now(), "change_agent_data": {"agent_id": B["id"], "transfer_tasks": False}})
        t_o1, t_o2 = (r1[1] or {}).get("id"), (r2[1] or {}).get("id")
        r = http("PATCH", f"/stages/{S9}/trigger-order", {"ids": [t_o2, t_o1]}, admin)
        listed = [t["id"] for t in http("GET", f"/stages/{S9}/triggers", token=admin)[1] or []]
        check("PATCH trigger-order: the stage lists its triggers in the new order", r[0] == 200 and listed == [t_o2, t_o1], (r, listed))
        r = http("PATCH", f"/stages/{S9}/trigger-order", {"ids": [t_o1]}, admin)
        check("an order that leaves a trigger out -> 400", r[0] == 400, r)
        D21 = new_deal("порядок", agent=A)
        move(D21, S9)
        tasks = tasks_of(D21)
        check("they run in that order: «сменить ответственного» first, the task goes to the new responsible (B)",
              any(t[0] == f"{TAG} порядок" and t[1] == str(B["id"]) for t in tasks), tasks)
        trigger(S10, {"type": 0, "deal_filters": [], "apply_when": when_now(), "create_task_data": {"label": f"{TAG} передать", **task_now}})
        trigger(S10, {"type": 4, "deal_filters": [], "apply_when": when_now(), "change_agent_data": {"agent_id": B["id"]}})
        D22 = new_deal("передача задач", agent=A)
        move(D22, S10)
        tasks = tasks_of(D22)
        check("the task made for the previous responsible goes to the new one with the deal (transfer_tasks)",
              any(t[0] == f"{TAG} передать" and t[1] == str(B["id"]) for t in tasks), tasks)
        r = trigger(S11, {"type": 4, "deal_filters": [], "apply_when": when_now(), "change_agent_data": {"rotate_user_ids": [A["id"], B["id"]]}})
        check("«по очереди» between two employees -> 201", r[0] == 201, r)
        r_one = trigger(S16, {"type": 4, "deal_filters": [], "apply_when": when_now(), "change_agent_data": {"rotate_user_ids": [A["id"]]}})
        check("«по очереди» with one employee -> 400", r_one[0] == 400, r_one)
        D23, D24 = new_deal("очередь 1", agent=C), new_deal("очередь 2", agent=C)
        move(D23, S11)
        move(D24, S11)
        row = psql(f"select string_agg(agent_id::text, ',' order by agent_id) from deal where id in ({D23}, {D24})")
        check("two new deals go to the two employees in turn", row == ",".join(sorted([str(A["id"]), str(B["id"])], key=int)), row)

        print("== wave 1b: «перевести в этап», a copy with its fields and products, «уведомить»")
        product = int(psql(f"insert into product (name) values ('{TAG}-полотенце') returning id"))
        trigger(S12, {"type": 7, "deal_filters": [], "apply_when": when_now(), "move_stage_data": {"stage_id": S13}})
        trigger(S13, {"type": 1, "deal_filters": [], "apply_when": when_now(), "create_deal_data": {"stage_id": S14, "label": f"{TAG} производство"}})
        trigger(S13, {"type": 8, "deal_filters": [], "apply_when": when_now(), "notify_data": {"text": f"{TAG} заказ {{{{сделка}}}} на {{{{сумма}}}}", "to": "responsible"}})
        D25 = new_deal("заказ", agent=A, budget=1500, fillers=[{"filler_id": filler_id, "value": "артикул-7"}])
        psql(f"insert into deal_product (deal_id, product_id, quantity, price) values ({D25}, {product}, 12, 3500)")
        r = move(D25, S12)
        row = psql(f"select stage_id from deal where id = {D25}")
        check("«перевести в этап»: the deal goes on to the next stage by itself", r[0] == 200 and row == str(S13), (r, row))
        row = psql(f"select count(*) from deal_stage_record where deal_id = {D25} and stage_id = {S13} and from_stage_id = {S12}")
        check("the move is in the stage history (from the stage it came from)", row == "1", row)
        copy = psql(f"select id from deal where label = '{TAG} производство'")
        check("the triggers of that stage ran: «Создать сделку» made the copy (a deal moved by a trigger still gets its copy)", copy.isdigit(), copy)
        if copy.isdigit():
            row = psql(f"select (select value from deal_filler where deal_id = {copy} and filler_id = {filler_id}), (select (quantity = 12 and price = 3500)::text from deal_product where deal_id = {copy} and product_id = {product})")
            check("the copy keeps the custom fields and the products of the order", row == "артикул-7|true", row)
            n = psql(f"select count(*) from event where deal_id = {copy} and type = 5 and user_id is null and (after_state->'data'->>'source_deal_id')::int = {D25}")
            m = psql(f"select count(*) from event where deal_id = {D25} and type = 5 and user_id is null and (after_state->'data'->>'copy_deal_id')::int = {copy}")
            check("both deals say where the other one is (a note in each history)", (n, m) == ("1", "1"), (n, m))
        tasks = tasks_of(D25)
        check("«уведомить» the responsible who has no bot: a task with the text and the deal's data instead",
              any(t[0].startswith(f"Авто: {TAG} заказ {TAG} заказ на 1") and t[1] == str(A["id"]) for t in tasks), tasks)

        print("== wave 1b: conditions by channel and «больше», «нет ответа N минут»")
        trigger(S15, {"type": 0, "deal_filters": [{"field": "source", "value": "telegram", "is_filler": False}, {"field": "budget", "value": "500", "is_filler": False, "op": "gt"}],
                      "apply_when": when_now(), "create_task_data": {"label": f"{TAG} из Telegram", **task_now}})
        D26, D27, D28 = new_deal("telegram 900", budget=900), new_deal("telegram 100", budget=100), new_deal("вручную 900", budget=900)
        for d in (D26, D27):
            psql(f"insert into event (type, outgoing, deal_id, user_id, after_state, created_at) values (12, false, {d}, {contact}, '{{\"message\": \"AUDIT привет\"}}', (now() at time zone 'Asia/Karachi') - interval '5 minutes')")
        for d in (D26, D27, D28):
            move(d, S15)
        got = [any(t[0] == f"{TAG} из Telegram" for t in tasks_of(d)) for d in (D26, D27, D28)]
        check("«источник сделки = Telegram» and «бюджет больше 500»: only the Telegram deal of 900 fits", got == [True, False, False], got)
        row = psql(f"select extract(epoch from (end_time - start_time)) >= 1799 from task where deal_id = {D26} and label = '{TAG} из Telegram'")
        check("a task «сразу» is due in 30 minutes, not overdue as soon as it appears", row == "t", row)
        r = trigger(S16, {"type": 0, "deal_filters": [], "apply_when": {"when": "no_reply", "after_minutes": 1},
                          "create_task_data": {"label": f"{TAG} клиент ждёт", **task_now}})
        check("create «если клиент ждёт ответа 1 мин» -> 201", r[0] == 201 and r[1].get("kind") == "event", r)
        D29 = new_deal("ждёт ответа", agent=A, stage=S16)
        psql(f"insert into event (type, outgoing, deal_id, user_id, after_state, created_at) values (12, false, {D29}, {contact}, '{{\"message\": \"AUDIT ау\"}}', (now() at time zone 'Asia/Karachi') - interval '2 days')")
        n = wait_for(lambda: psql(f"select count(*) from task where deal_id = {D29} and label = '{TAG} клиент ждёт'"), "1", timeout=60)
        check("the client wrote and nobody answered: the scheduler runs the trigger (one task)", n == "1", n)
        http("POST", "/triggers/run-due", {}, admin)
        time.sleep(float(env_value("TRIGGER_SCHEDULER_SEC", "5")) + 2)
        n = psql(f"select count(*) from trigger_run where deal_id = {D29} and run_key like 'noreply:%'")
        check("once per unanswered message (run key noreply:<event>), not on every tick", n == "1", n)

        print("== wave 1b: a letter with the deal's data and its file")
        template_f = int(psql(f"insert into email_template (template_body, name, subject) values ('<p>Сделка {{{{сделка}}}}, сумма {{{{сумма}}}}</p>', '{TAG}-tpl-f', '{TAG} КП: {{{{сделка}}}}') returning id"))
        r = trigger(S16, {"type": 2, "deal_filters": [], "apply_when": when_now(), "send_email_data": {"template_id": template_f, "from": "currently_assigned", "attach_extensions": ["PDF"]}})
        check("'send email' with the deal's .pdf attached -> 201, the extension kept as .pdf",
              r[0] == 201 and (r[1].get("send_email_data") or {}).get("attach_extensions") == [".pdf"], r)
        r = trigger(S16, {"type": 2, "deal_filters": [], "apply_when": when_now(), "send_email_data": {"template_id": template_f, "from": "currently_assigned", "attach_extensions": ["../x"]}})
        check("an extension that is not one -> 400", r[0] == 400, r)
        D30 = new_deal("письмо без файла", agent=A)
        move(D30, S16)
        row = wait_for(lambda: psql(f"select status from trigger_run r join trigger t on t.id = r.trigger_id where r.deal_id = {D30} and t.type = 2"), "failed", timeout=60)
        err = psql(f"select coalesce(error, '') from trigger_run r join trigger t on t.id = r.trigger_id where r.deal_id = {D30} and t.type = 2")
        check("no .pdf in the deal: the letter does not go without its file, the run says why", row == "failed" and "нет файла" in err, (row, err))
        D31 = new_deal("письмо с файлом", agent=A)
        disk = f"{TAG}-kp.pdf"
        written = subprocess.run(APP_EXEC + ["sh", "-c", "cd %s && mkdir -p public/uploads && printf AUDIT-PDF > public/uploads/%s" % (shlex.quote(APP_DIR), shlex.quote(disk))],
                                 capture_output=True, text=True, encoding="utf-8")
        pdf_file = int(psql(f"insert into file (name, path, size, \"from\", extension) values ('{TAG}-КП.pdf', '{disk}', 9, 'uploaded_from_files_tab', '.pdf') returning id"))
        psql(f"insert into deal_file (\"dealId\", \"fileId\") values ({D31}, {pdf_file})")
        move(D31, S16)
        row = wait_for(lambda: psql(f"select status from trigger_run r join trigger t on t.id = r.trigger_id where r.deal_id = {D31} and t.type = 2"), "done", timeout=60)
        note = psql(f"select coalesce(note, '') from trigger_run r join trigger t on t.id = r.trigger_id where r.deal_id = {D31} and t.type = 2")
        subject = f"{TAG} КП: {TAG} письмо с файлом"
        sent = psql(f"select count(*), coalesce(sum((select count(*) from file f where f.email_id = e.id)), 0) from email e where e.subject = '{subject}'")
        check("the letter goes with the deal's data in the subject ({{сделка}}) and the .pdf of the deal attached",
              written.returncode == 0 and row == "done" and "вложения" in note and sent == "1|1", (written.stderr[-200:], row, note, sent))
        body = psql(f"select position('сумма 100' in body) > 0 from email where subject = '{subject}'")
        check("the body has the deal's data too ({{сумма}})", body == "t", body)

        print("== control: a call answers the client, «ждут сейчас» does not depend on the period")
        D12 = new_deal("контроль: перезвонил", agent=A)
        D13 = new_deal("контроль: ждёт", agent=A)
        D14 = new_deal("контроль: перезвонил другой менеджер", agent=A)
        base = "((now() at time zone 'Asia/Karachi')::date - 3)"
        psql(";".join([
            # a call of before: the client is user_id, the manager target_user_id
            f"insert into event (type, outgoing, deal_id, user_id, target_user_id, after_state, created_at) values (16, false, {D12}, {contact}, {A['id']}, '{{\"message\": \"AUDIT вопрос 1\"}}', {base} + time '10:00')",
            f"insert into event (type, outgoing, deal_id, user_id, target_user_id, after_state, created_at) values (10, true, {D12}, {contact}, {A['id']}, '{{\"outgoing\": true}}', {base} + 1 + time '10:30')",
            f"insert into event (type, outgoing, deal_id, user_id, target_user_id, after_state, created_at) values (16, false, {D13}, {contact}, {A['id']}, '{{\"message\": \"AUDIT вопрос 2\"}}', {base} + time '10:00')",
            f"insert into event (type, outgoing, deal_id, user_id, target_user_id, after_state, created_at) values (10, false, {D13}, {contact}, {A['id']}, '{{\"outgoing\": false}}', {base} + time '10:20')",
            # an outgoing call as it is written now: the manager (B, not the responsible) is user_id
            f"insert into event (type, outgoing, deal_id, user_id, target_user_id, after_state, created_at) values (16, false, {D14}, {contact}, {A['id']}, '{{\"message\": \"AUDIT вопрос 3\"}}', {base} + time '11:00')",
            f"insert into event (type, outgoing, deal_id, user_id, target_user_id, after_state, created_at) values (10, true, {D14}, {B['id']}, {contact}, '{{\"outgoing\": true}}', {base} + time '11:20')",
        ]))
        day = psql(f"select to_char({base}, 'YYYY-MM-DD')")
        today = psql("select to_char((now() at time zone 'Asia/Karachi')::date, 'YYYY-MM-DD')")
        r = http("GET", f"/analytics/control?from_date={day}&till_date={day}&agent_id={A['id']}&waiting_hours=2", token=admin)
        mine = next((a for a in (r[1] or {}).get("agents", []) if a.get("id") == A["id"]), {}) if r[0] == 200 else {}
        check("a past day: the outgoing call the next day answers the first client (answers after the period count), the incoming call does not answer the second",
              r[0] == 200 and (mine.get("turns"), mine.get("answered"), mine.get("unanswered")) == (2, 1, 1), (r[0], mine))
        r = http("GET", f"/analytics/control?from_date={day}&till_date={day}&agent_id={B['id']}&waiting_hours=2", token=admin)
        other = next((a for a in (r[1] or {}).get("agents", []) if a.get("id") == B["id"]), {}) if r[0] == 200 else {}
        check("the answer by a call is the caller's: B called back the client of A's deal (a call written with the manager as its author)",
              r[0] == 200 and (other.get("turns"), other.get("answered"), other.get("unanswered")) == (1, 1, 0), (r[0], other))
        r = http("GET", f"/analytics/control?from_date={today}&till_date={today}&agent_id={A['id']}&waiting_hours=2", token=admin)
        waiting = [w.get("deal_id") for w in (r[1] or {}).get("waiting", [])] if r[0] == 200 else None
        check("«ждут ответа сейчас» for «за сегодня» lists the client who wrote 3 days ago, not the one who was called back",
              r[0] == 200 and D13 in waiting and D12 not in waiting, (r[0], waiting))

    finally:
        print("== cleanup")
        # the letters on the stand's mail server first: a sync after the cleanup would bring them back
        purged = purge_mail(TAG)
        print(f"       mail server: {purged} letter(s) of this run removed")
        try:
            # the files of this run on the disk of the API: the deal's .pdf and the copies the letters keep
            paths = [p for p in psql(f"select path from file where name like '{TAG}%' or email_id in (select id from email where subject like '{TAG}%')").split("\n") if p]
            if paths:
                subprocess.run(APP_EXEC + ["sh", "-c", "cd %s/public/uploads && rm -f %s" % (shlex.quote(APP_DIR), " ".join(shlex.quote(os.path.basename(p)) for p in paths))],
                               capture_output=True, text=True, encoding="utf-8")
        except Exception as error:  # the files are test ones: a leftover is not a failure
            print(f"       files on disk: {str(error)[:200]}")
        ids = ",".join(str(u["id"]) for u in users.values()) or "0"
        stage_ids = ",".join(str(s) for s in stages) or "0"
        deals = f"select id from deal where label like '{TAG}%'"
        psql(";".join([
            "begin",
            f"delete from trigger_run where deal_id in ({deals}) or trigger_id in (select id from trigger where deal_stage_id in ({stage_ids}))",
            f"delete from trigger where deal_stage_id in ({stage_ids})",
            f"delete from event where deal_id in ({deals}) or task_id in (select id from task where deal_id in ({deals})) or user_id in ({ids}) or target_user_id in ({ids})",
            f"delete from task where deal_id in ({deals})",
            f"delete from deal_file where \"fileId\" in (select id from file where email_id in (select id from email where subject like '{TAG}%'))",
            f"delete from deal_file where \"dealId\" in ({deals}) or \"fileId\" in (select id from file where name like '{TAG}%')",
            f"delete from file where name like '{TAG}%'",
            f"delete from file where email_id in (select id from email where subject like '{TAG}%')",
            f"delete from email_to where email_id in (select id from email where subject like '{TAG}%')",
            f"delete from email_cc where email_id in (select id from email where subject like '{TAG}%')",
            f"delete from email where subject like '{TAG}%'",
            f"delete from email_template where name like '{TAG}%'",
            f"delete from deal_filler where deal_id in ({deals}) or filler_id = {filler_id or 0}",
            f"delete from deal_product where deal_id in ({deals}) or product_id in (select id from product where name like '{TAG}%')",
            f"delete from product where name like '{TAG}%'",
            f"delete from deal_stage_record where deal_id in ({deals})",
            f"delete from deal_user where \"dealId\" in ({deals})",
            f"delete from deal where id in ({deals})",
            f"delete from deal_stage where id in ({stage_ids})",
            f"delete from filler where id = {filler_id or 0}",
            f"delete from \"user\" where username like '{TAG}%'",
            "commit",
        ]))
        left = psql(f"select (select count(*) from \"user\" where username like '{TAG}%') + (select count(*) from deal where label like '{TAG}%') + (select count(*) from deal_stage where id in ({stage_ids})) + (select count(*) from email where subject like '{TAG}%') + (select count(*) from email_template where name like '{TAG}%')")
        check("test rows removed", left == "0", left)

    print(f"\nRESULT: {results['PASS']} passed, {results['FAIL']} failed")
    return 1 if results["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
