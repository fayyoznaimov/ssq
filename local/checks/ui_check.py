#!/usr/bin/env python3
"""Every page of the web client opens: no JavaScript errors on the page, no 5xx from the API
while it loads, nothing wider than the screen on a PC; phone width is reported (legacy pages
are not all adapted yet). Uses local/dev/screens.sh (headless Chrome) against the dev web copy.
    local/dev/check.sh ui        (or: source local/dev/env.sh; python3 local/checks/ui_check.py)
Also what the production client had before this branch (AUDIT port): the tab titles «… — Parisa CRM»,
the card of a new company, rows of the deal list as links, the toast of a form that did not pass its checks.
And as an AUDIT-ui agent with "own" / "for the group" rights: the sections stay in the menu and open
(utils/casl.ts follows GET /auth/access), sections without the right do not.
Screenshots: local/dev/screens/ui/*.png. Only for the dev copy on the server.
"""
import json
import os
import shlex
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PSQL = shlex.split(os.environ.get("CRM_PSQL", "node local/dev/psql.js"))
results = {"PASS": 0, "FAIL": 0}
STATIC = [
    "/", "/tasks", "/tasks/calendar", "/tasks/kanban", "/deals", "/deals/new", "/deals/trash",
    "/lists/companies", "/lists/companies/new", "/lists/contacts", "/lists/products", "/lists/files", "/lists/calls",
    "/mails", "/mails/new", "/mails/settings", "/telegram", "/whatsapp", "/profile",
    "/analytics/sales", "/analytics/managers", "/analytics/employees", "/analytics/products", "/analytics/events",
    "/analytics/goals", "/analytics/goals/settings", "/analytics/consolidated", "/analytics/calls",
    "/requests", "/settings/deals", "/settings/groups", "/settings/users", "/settings/transporters", "/settings/calls",
]


NEW_COMPANY = "/lists/companies/new"
# the name and the client of a row of the deal list are links to the deal (BaseTable row-link)
DEAL_LINKS = 'table a[href*="/deals/"] span.font-medium'


def check(name, ok, detail=""):
    results["PASS" if ok else "FAIL"] += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {str(detail)[:600]}" if detail and not ok else ""), flush=True)


def one(sql):
    out = subprocess.run(PSQL + ["-At", "-c", sql], capture_output=True, text=True, cwd=ROOT).stdout.strip()
    return out.split("\n")[0] if out else ""


def screens(pages, **extra):
    """local/dev/screens.sh for these pages; the parsed report (None when it did not run) and the process"""
    env = dict(os.environ, SCREEN_JSON="1", SCREEN_OUT=os.path.join(ROOT, "local", "dev", "screens", "ui"))
    env.update(extra)
    proc = subprocess.run([os.path.join(ROOT, "local", "dev", "screens.sh")] + pages, capture_output=True, text=True, env=env, timeout=1800)
    line = next((l for l in proc.stdout.splitlines() if l.startswith("@@")), None)
    return (json.loads(line[2:]) if line else None), proc


def port_checks(report):
    """AUDIT port: what the production client showed before this branch was deployed"""
    pc = [r for r in report if r["size"] == "pc"]
    wrong = [f"{r['path']}: {r.get('title')!r}" for r in pc
             if r["url"] not in ("/login", "/403") and (not str(r.get("title") or "").endswith("Parisa CRM") or "Houston" in str(r.get("title")))]
    check("every page is titled «… — Parisa CRM»", not wrong, "; ".join(wrong[:5]))

    new = next((r for r in pc if r["path"] == NEW_COMPANY), {})
    text = new.get("text") or ""
    check("new company: the feed says it comes after saving; the crumb and the title say «Новая компания»",
          "Лента событий, задачи и сообщения появятся после сохранения компании" in text
          and "Новая компания" in text and new.get("title") == "Новая компания — Parisa CRM",
          f"title {new.get('title')!r}, empty state shown: {'появятся после сохранения' in text}")

    deals = next((r for r in pc if r["path"] == "/deals"), {})
    if one("select count(*) from deal where deleted_at is null") not in ("", "0"):
        check("/deals: the name and the client of a row are links to the deal", (deals.get("probe") or 0) > 0, f"links: {deals.get('probe')}")

    # empty forms: the save is refused before any request (nothing is created), the toast names the fields
    # that are required and not the optional ones (DEAL-3: a deal needs only its responsible, the company,
    # its e-mail and phone are optional; a company needs its name, the phone is optional)
    for path, button, field, optional_fields in [
        (NEW_COMPANY, 'form button[type="submit"].nui-button-primary', "«Название компании»", ["«Номер телефона»"]),
        ("/deals/new", 'button[type="submit"][form="deal-form"]', "«Ответственный»",
         ["«Компания»", "«Электронная почта компании»", "«Телефон компании»", "«Бюджет»"]),
    ]:
        rep, proc = screens([path], SCREEN_CLICK=button, SCREEN_OUT=os.path.join(ROOT, "local", "dev", "screens", "ui", "save"))
        row = next((r for r in rep or [] if r["size"] == "pc"), None)
        toast = next((l for l in (row or {}).get("text", "").splitlines() if "Не сохранено" in l), "")
        check(f"{path}: an empty form is not sent, the toast names its fields",
              "Не сохранено. Проверьте" in toast and field in toast and not any(f in toast for f in optional_fields),
              toast or ("no toast" if row else (proc.stderr or proc.stdout)[-300:]))


def main():
    dynamic = []
    for path, sql in [
        ("/deals/{}", "select id from deal where deleted_at is null order by id desc limit 1"),
        ("/lists/companies/{}", "select c.id from company c join \"user\" u on u.company_id = c.id where c.deleted_at is null and c.name not like 'AUDIT%' order by c.id desc limit 1"),
        ("/lists/contacts/{}", "select id from \"user\" where role = 'ctr_agent' and deleted_at is null and username not like 'AUDIT%' order by id desc limit 1"),
        ("/lists/products/{}", "select id from product where deleted_at is null order by id desc limit 1"),
        ("/lists/calls/{}", "select id from \"user\" where role = 'agent' and deleted_at is null order by id limit 1"),
        ("/mails/index/{}", "select id from email where deleted_at is null order by id desc limit 1"),
        ("/settings/groups/{}", "select id from \"group\" order by id limit 1"),
        ("/settings/users/{}", "select id from \"user\" where role <> 'ctr_agent' and deleted_at is null order by id limit 1"),
    ]:
        value = one(sql)
        if value:
            dynamic.append(path.format(value))
    pages = STATIC + dynamic
    report, proc = screens(pages, SCREEN_PROBE=DEAL_LINKS)
    if report is None:
        check("screenshots ran", False, (proc.stderr or proc.stdout)[-800:])
        return 1
    phone_wide = []
    for path in pages:
        rows = {r["size"]: r for r in report if r["path"] == path}
        pc, phone = rows.get("pc"), rows.get("phone")
        if not pc:
            check(f"{path}: rendered", False, "no result")
            continue
        problems = []
        if pc["url"] in ("/login", "/403") and path not in ("/403",):
            problems.append(f"redirected to {pc['url']}")
        for r in (pc, phone):
            if r and r["pageErrors"]:
                problems.append(f"{r['size']}: JS error {r['pageErrors'][0][:200]}")
            if r and r["api5xx"]:
                problems.append(f"{r['size']}: API {', '.join(r['api5xx'][:3])}")
        if pc["overflow"] > 1:
            problems.append(f"pc: wider than the screen by {pc['overflow']}px")
        if phone and phone["overflow"] > 1:
            phone_wide.append(f"{path} (+{phone['overflow']}px)")
        check(f"{path}: opens without errors, fits a PC screen", not problems, "; ".join(problems))
    print(f"\nphone width: {len(phone_wide)} page(s) wider than the screen (not a failure yet): {', '.join(phone_wide) or 'none'}")
    port_checks(report)
    shell_checks(report, dynamic)
    agent_rights_checks()
    settings_checks()
    feed_checks()
    print(f"\nRESULT: {results['PASS']} passed, {results['FAIL']} failed")
    return 1 if results["FAIL"] else 0


def shell_checks(report, dynamic):
    """The frame of the interface and the tables (AUDIT-ui wave 1b): the tab names the page, not only the CRM
    (SCR16); an API error is a Russian sentence, never «Cannot GET …» (SCR4-6); a list that did not load says so
    instead of «Пока ничего» (/roles has no API behind it); on a phone the deal list is cards with the stage and
    the sum, on a PC a table (SCR9); the menu lights the section of an open card (SCR16, SCR4-4)."""
    pc = [r for r in report if r["size"] == "pc" and r["url"] not in ("/login", "/403")]
    bare = [r["path"] for r in pc if str(r.get("title") or "").strip() == "Parisa CRM"]
    check("every page names itself in the tab («Сделки — Parisa CRM», not «Parisa CRM»)", not bare, ", ".join(bare[:6]))
    raw = [f"{r['path']} ({r['size']})" for r in report if "Cannot GET" in (r.get("text") or "") or "must be a" in (r.get("text") or "")]
    check("no raw English API error on any page (toasts are Russian)", not raw, ", ".join(raw[:6]))
    roles = next((r for r in pc if r["path"] == "/roles"), None)
    if roles:  # the page of roles has no API behind it: its table must say that it did not load
        text = roles.get("text") or ""
        check("/roles (no API): the table says «Не удалось загрузить список» with «Повторить», not «Пока ничего нет»",
              "Пока ничего нет" not in text and "Не удалось загрузить список" in text and "Повторить" in text, text[-300:])

    has_deals = one("select count(*) from deal where deleted_at is null") not in ("", "0")
    rep, proc = screens(["/deals"], SCREEN_PROBE="[data-cards] [data-card]", SCREEN_OUT=os.path.join(ROOT, "local", "dev", "screens", "ui", "cards"))
    rows = {r["size"]: r for r in rep or []}
    if not rows:
        check("deal list as cards on a phone: screenshots ran", False, (proc.stderr or proc.stdout)[-300:])
    elif has_deals:
        phone, pcrow = rows.get("phone") or {}, rows.get("pc") or {}
        check("/deals on a phone: every row is a card (the table showed two columns); on a PC it is a table",
              (phone.get("probe") or 0) > 0 and (pcrow.get("probe") or 0) == 0,
              f"phone cards {phone.get('probe')}, pc cards {pcrow.get('probe')}")
        text = phone.get("text") or ""
        check("/deals on a phone: a card shows the stage and the budget",
              "Этап сделки" in text and "Бюджет" in text, text[:300])

    cards = [p for p in dynamic if p.startswith("/deals/") or p.startswith("/lists/companies/")] + ["/settings/users", "/deals/trash"]
    rep, proc = screens(cards, SCREEN_PROBE='#sidebar-menu [aria-current="page"]', SCREEN_OUT=os.path.join(ROOT, "local", "dev", "screens", "ui", "menu"))
    unlit = [r["path"] for r in rep or [] if r["size"] == "pc" and r["url"] not in ("/login", "/403") and not r.get("probe")]
    check("the menu lights the section of a card and of a page under it (/deals/35, /deals/trash, /settings/users)",
          rep is not None and not unlit, ", ".join(unlit) or (proc.stderr or proc.stdout)[-300:])


def feed_checks():
    """The history of a deal (EventsList.vue) with what broke it: messages of a client in runs with other
    events between them over two pages, a closed and an open task without a type, a stage change without
    the stage before, an author deleted since, an incoming letter. The feed was drawn empty (a TypeError
    in the render) or with the messages out of order (DEAL-1, TG-2, MAIL-8, AUDIT-6, AUDIT-7)."""
    import secrets

    run = secrets.token_hex(3)
    tag = f"AUDIT-ui-feed-{run}"
    deal = None
    try:
        admin = one("select id from \"user\" where email = 'admin@gmail.com'")
        contact = one(f"insert into \"user\" (username, email, role) values ('{tag}-client', 'audit-ui-{run}-client@example.test', 'ctr_agent') returning id")
        gone = one(f"insert into \"user\" (username, email, role, deleted_at) values ('{tag}-gone', 'audit-ui-{run}-gone@example.test', 'agent', now()) returning id")
        deal = one(f"insert into deal (label, display_id, budget, stage_id, created_by, created_at) values ('{tag}', {900000000 + secrets.randbelow(90000000)}, 100, "
                   "(select s.id from deal_stage s join collection c on c.id = s.collection_id where c.is_active = true order by s.\"order\", s.id limit 1), "
                   f"{admin}, now() - interval '3 days') returning id")
        one(f"insert into deal_user (\"dealId\", \"userId\") values ({deal}, {contact})")
        msg = lambda text, out: (f"jsonb_build_object('message', '{text}', 'files', '[]'::jsonb, 'outgoing', {str(out).lower()}, "
                                 f"'contact', null, 'location', null)")
        # yesterday: the older page (30 rows), Telegram runs with comments between them
        one(f"insert into event (type, deal_id, user_id, target_user_id, outgoing, after_state, created_at) "
            f"select case when i % 3 = 0 then 5 else 12 end, {deal}, case when i % 3 = 0 then {admin} else {contact} end, "
            f"case when i % 3 = 0 then null else {admin} end, false, "
            f"case when i % 3 = 0 then jsonb_build_object('data', jsonb_build_object('comment', '{tag}-old-note-' || i, 'files', '[]'::jsonb)) "
            f"else jsonb_build_object('message', '{tag}-old-' || i, 'files', '[]'::jsonb, 'outgoing', false) end, "
            f"now() - interval '1 day' - (30 - i) * interval '1 minute' from generate_series(1, 30) i")
        rows = [
            (12, contact, admin, "false", msg(f"{tag}-in-1", False), "null"),
            (12, contact, admin, "false", msg(f"{tag}-in-2", False), "null"),
            (5, admin, "null", "true", f"jsonb_build_object('data', jsonb_build_object('comment', '{tag}-note', 'files', '[]'::jsonb))", "null"),
            (12, admin, contact, "true", msg(f"{tag}-out-1", True), "null"),
            (12, admin, contact, "true", msg(f"{tag}-out-2", True), "null"),
            (6, admin, admin, "true", f"jsonb_build_object('data', jsonb_build_object('id', null, 'label', '{tag}-task-open', 'type', null))", "null"),
            (7, admin, admin, "true", f"jsonb_build_object('data', jsonb_build_object('id', null, 'label', '{tag}-task', 'type', null, 'result', '{tag}-итог'))", "null"),
            (15, admin, "null", "true", "jsonb_build_object('data', jsonb_build_object('stage', jsonb_build_object('name', 'Новая', 'color', '#ccc')))",
             "jsonb_build_object('data', jsonb_build_object('stage', null))"),
            (5, gone, "null", "true", f"jsonb_build_object('data', jsonb_build_object('comment', '{tag}-by-gone', 'files', '[]'::jsonb))", "null"),
            (9, contact, "null", "false", f"jsonb_build_object('data', jsonb_build_object('id', null, 'subject', '{tag}-letter', 'body', '<p>{tag}</p>', "
             "'outgoing', false, 'to', '[]'::jsonb, 'files', '[]'::jsonb))", "null"),
            (16, contact, admin, "false", msg(f"{tag}-wa", False), "null"),
            # a call of the client (direction and number are shown), a Telegram message edited by the client,
            # a note whose file was deleted from the deal since (the entry says so, AUDIT-12)
            (10, contact, admin, "false", "jsonb_build_object('outgoing', false, 'path', null, 'number', '+998900000000')", "null"),
            (12, contact, admin, "false", f"jsonb_build_object('message', '{tag}-edited', 'files', '[]'::jsonb, 'outgoing', false, "
             "'edited', true, 'original_message', 'before')", "null"),
            (5, admin, "null", "true", f"jsonb_build_object('data', jsonb_build_object('comment', '{tag}-note-2', 'files', '[]'::jsonb, "
             f"'removed_files', jsonb_build_array(jsonb_build_object('id', 1, 'name', '{tag}-price.pdf', 'removed_at', now()))))", "null"),
        ]
        for i, (type_, by, to, out, after, before) in enumerate(rows):
            one(f"insert into event (type, deal_id, user_id, target_user_id, outgoing, after_state, before_state, created_at) "
                f"values ({type_}, {deal}, {by}, {to}, {out}, {after}, {before}, now() - interval '1 hour' + {i} * interval '1 minute')")

        path = f"/deals/{deal}"
        # the feed opens at its start with the newest page (25 rows): like a user, the check scrolls the feed down
        # and back up, its start comes into view again and the older page is loaded (the 44 rows are two pages
        # of 25; the Telegram run old-19, old-20 lies across them). A click on the first day separator did not
        # scroll at all: it is already in view, so the older page was never asked for.
        report, proc = screens([path], SCREEN_SCROLL='[data-feed="day"]', SCREEN_OUT=os.path.join(ROOT, "local", "dev", "screens", "ui-feed"))
        row = next((r for r in report or [] if r["size"] == "pc"), None)
        if not row:
            check("deal feed: screenshots ran", False, (proc.stderr or proc.stdout)[-800:])
            return
        text = row.get("text") or ""
        errors = (row.get("pageErrors") or []) + [e for e in row.get("consoleErrors") or [] if "TypeError" in e]
        check("deal feed with typeless tasks, a deleted author, a hidden stage before: no render error", not errors, errors[:2])
        # notes are shown as text (they were one-line textareas, SCR2-2): their text is in innerText
        wanted = [f"{tag}-in-1", f"{tag}-out-2", f"{tag}-note", f"{tag}-by-gone", "Задача выполнена", f"{tag}-итог",
                  "Задача поставлена", f"{tag}-gone (удалён)", f"{tag}-letter", f"{tag}-wa",
                  "Входящий звонок", "+998900000000", f"{tag}-edited", "(изменено)", f"Удалён файл: {tag}-price.pdf"]
        missing = [w for w in wanted if w not in text] + ([] if "Сегодня" in text or "Вчера" in text else ["day separator"])
        check("deal feed: day separator, both message runs, tasks with the result, the deleted author by name, letter, WhatsApp, "
              "a call with its direction, an edited message, a deleted file",
              not missing, missing)
        order = [text.find(w) for w in (f"{tag}-in-1", f"{tag}-in-2", f"{tag}-out-1", f"{tag}-out-2")]
        check("deal feed: oldest first down to the newest, a run of messages in its own place (not appended to another run)",
              all(x >= 0 for x in order) and order == sorted(order), order)
        # the older page: its messages in their place, the run across the two pages in order, before today's
        older = [text.find(w) for w in (f"{tag}-old-4", f"{tag}-old-5", f"{tag}-old-19", f"{tag}-old-20", f"{tag}-old-29", f"{tag}-in-1")]
        check("deal feed over two pages: the older page loads, a run across the pages stays in order, no render error",
              all(x >= 0 for x in older) and older == sorted(older), f"{older} {(proc.stderr or '').strip()[-300:]}")
    finally:
        try:
            one(";".join([
                "begin",
                f"delete from event where deal_id = {deal}" if deal else "select 1",
                f"delete from deal_user where \"dealId\" = {deal}" if deal else "select 1",
                f"delete from deal where label = '{tag}'",
                f"delete from \"user\" where email like 'audit-ui-{run}-%'",
                "commit",
            ]))
        except Exception as error:  # the report goes on; the rows are named AUDIT-ui-feed-*
            print(f"cleanup of {tag} failed: {error}")


def agent_rights_checks():
    """The menu and the pages of an agent whose rights are "own" / "for the group" (levels 1 and 2):
    the client builds its rights from GET /auth/access (utils/casl.ts), so the sections stay; before,
    anything below "Разрешено" hid them and sent the agent to the start page. Sections the agent has no
    right to (mail and files off, settings, analytics) still do not open."""
    import secrets
    import urllib.error
    import urllib.request

    api = os.environ.get("CRM_API_URL", "http://127.0.0.1:3100/api/v1").rstrip("/")
    env_file = os.environ.get("CRM_ENV_FILE") or os.path.join(ROOT, "local", "dev", "api.env")
    admin_password = next((l.split("=", 1)[1].strip().strip('"') for l in open(env_file, encoding="utf-8")
                           if l.startswith("ADMIN_PASSWORD=")), "")

    def call(method, path, body=None, token=None):
        req = urllib.request.Request(api + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json", "Accept": "application/json"})
        if token:
            req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                text = r.read()
                return r.status, json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            return e.code, None

    run = secrets.token_hex(3)
    email = f"audit-ui-{run}-agent@example.test"
    password = secrets.token_urlsafe(12)
    try:
        status, body = call("POST", "/auth/login", {"email": "admin@gmail.com", "password": admin_password})
        admin = (body or {}).get("access_token")
        status, groups = call("GET", "/groups", token=admin)
        own = {"view": 1, "create": 3, "update": 1, "delete": 1, "export": 0}
        group = {"view": 2, "create": 3, "update": 2, "delete": 0, "export": 0}
        rights = {"deal": own, "company": group, "contact": own, "task": {"update": 1, "delete": 0}, "mail": False, "file": False}
        status, body = call("POST", "/users", {"email": email, "password": password, "username": f"AUDIT-ui-{run}-agent",
                                               "role": "agent", "group_id": sorted(g["id"] for g in groups)[0], "permissions": rights}, admin)
        status2, login = call("POST", "/auth/login", {"email": email, "password": password})
        token = (login or {}).get("access_token")
        if status != 201 or not token:
            check("agent with own / group rights: test account created", False, (status, status2))
            return
        opens = ["/deals", "/deals/new", "/deals/trash", "/lists/companies", "/lists/contacts", "/lists/products", "/tasks"]
        closed = {"/mails": "/", "/lists/files": "/", "/settings/users": "/", "/analytics/sales": "/403"}
        report, proc = screens(opens + list(closed), SCREEN_TOKEN=token,
                               SCREEN_OUT=os.path.join(ROOT, "local", "dev", "screens", "ui-agent"))
        if report is None:
            check("agent with own / group rights: screenshots ran", False, (proc.stderr or proc.stdout)[-800:])
            return
        pc = {r["path"]: r for r in report if r["size"] == "pc"}

        def norm(url):  # a static web server answers /deals with /deals/: the same page
            return (url or "").rstrip("/") or "/"

        for path in opens:
            r = pc.get(path) or {}
            problems = [f"redirected to {r.get('url')}"] if norm(r.get("url")) != norm(path) else []
            problems += [f"JS error {e[:200]}" for e in (r.get("pageErrors") or [])[:1]]
            problems += [f"API {', '.join(r.get('api5xx')[:3])}"] if r.get("api5xx") else []
            check(f"agent with own / group rights: {path} opens", r and not problems, "; ".join(problems) or "no result")
        text = (pc.get("/deals") or {}).get("text") or ""
        check("agent with own / group rights: the menu has «Сделки» and «Списки»", "Сделки" in text and "Списки" in text, text[:300])
        for path, landing in closed.items():
            r = pc.get(path) or {}
            check(f"agent without the right: {path} -> {landing}", norm(r.get("url")) == landing, r.get("url"))

        # OMNI-1: a deal of the agent with a letter in its history; without the mail right the history was
        # drawn empty (TypeError on the hidden letter). Now: the messages, and the letter as one line.
        tag = f"AUDIT-ui-{run}-mail"
        agent_id = body["id"]
        deal = one(f"insert into deal (label, display_id, budget, stage_id, agent_id, created_by) values ('{tag}', "
                   f"{900000000 + secrets.randbelow(90000000)}, 100, (select s.id from deal_stage s join collection c "
                   "on c.id = s.collection_id where c.is_active = true order by s.\"order\", s.id limit 1), "
                   f"{agent_id}, {agent_id}) returning id")
        one(f"insert into event (type, deal_id, user_id, outgoing, after_state, created_at) values "
            f"(12, {deal}, {agent_id}, true, jsonb_build_object('message', '{tag}-tg', 'files', '[]'::jsonb, 'outgoing', true), now() - interval '3 minute'), "
            f"(9, {deal}, {agent_id}, false, jsonb_build_object('data', jsonb_build_object('id', null, 'subject', '{tag}-secret', "
            "'body', '<p>secret</p>', 'outgoing', false, 'to', '[]'::jsonb, 'files', '[]'::jsonb)), now() - interval '2 minute'), "
            f"(5, {deal}, {agent_id}, true, jsonb_build_object('data', jsonb_build_object('comment', '{tag}-note', 'files', '[]'::jsonb)), now() - interval '1 minute') "
            "returning id")
        report, proc = screens([f"/deals/{deal}"], SCREEN_TOKEN=token,
                               SCREEN_OUT=os.path.join(ROOT, "local", "dev", "screens", "ui-agent-mail"))
        r = next((x for x in report or [] if x["size"] == "pc"), None) or {}
        # ACL-7: with "own" deals the agent opens the card of a deal they are responsible for (was sent to «/»)
        check("agent with own rights: the card of their own deal opens (not sent to «/»)",
              bool(r) and norm(r.get("url")) == f"/deals/{deal}" and not r.get("pageErrors"), r.get("url"))
        text = r.get("text") or ""
        errors = (r.get("pageErrors") or []) + [e for e in r.get("consoleErrors") or [] if "TypeError" in e]
        check("agent without the mail right: a deal with a letter shows its history (messages, note, the letter as a line)",
              r and not errors and f"{tag}-tg" in text and f"{tag}-note" in text and "нет доступа к почте" in text
              and f"{tag}-secret" not in text, errors[:2] or text[:300])
    finally:
        try:
            one(";".join([
                "begin",
                f"delete from event where user_id in (select id from \"user\" where email like 'audit-ui-{run}-%')",
                f"delete from event where deal_id in (select id from deal where label = 'AUDIT-ui-{run}-mail')",
                f"delete from deal where label = 'AUDIT-ui-{run}-mail'",
                f"delete from \"user\" where email like 'audit-ui-{run}-%'",
                "commit",
            ]))
        except Exception as error:  # the report goes on; the row is named AUDIT-ui-*
            print(f"cleanup of the AUDIT-ui-{run} account failed: {error}")


def settings_checks():
    """«Пользователи», the user card and the group page as the admin sees them (ACL-15, SCR4-7, SCR4-9, SCR4-17):
    an agent whose card forbids everything is flagged in the list with «Выдать стандартные права»; the list
    holds staff only (no customer contacts); the matrix of the card speaks words, not 0–3; the group page
    lists its members."""
    import secrets

    run = secrets.token_hex(3)
    tag = f"AUDIT-ui-{run}-set"
    zero = {"view": 0, "create": 0, "update": 0, "delete": 0, "export": 0}
    rights = json.dumps({"deal": zero, "company": zero, "contact": zero, "task": {"update": 0, "delete": 0},
                         "mail": False, "file": False})
    try:
        group = one(f"insert into \"group\" (name) values ('{tag}-group') returning id")
        bare = one(f"insert into \"user\" (username, email, role, group_id, permissions) values ('{tag}-bare', "
                   f"'audit-ui-{run}-set-bare@example.test', 'agent', {group}, '{rights}'::jsonb) returning id")
        contact = one(f"insert into \"user\" (username, email, role) values ('{tag}-client', "
                      f"'audit-ui-{run}-set-client@example.test', 'ctr_agent') returning id")
        if not (group and bare and contact):
            check("settings pages: test rows created", False, (group, bare, contact))
            return
        pages = ["/settings/users", f"/settings/users/{bare}", f"/settings/groups/{group}"]
        report, proc = screens(pages, SCREEN_OUT=os.path.join(ROOT, "local", "dev", "screens", "ui-settings"))
        if report is None:
            check("settings pages: screenshots ran", False, (proc.stderr or proc.stdout)[-800:])
            return
        pc = {r["path"]: r for r in report if r["size"] == "pc"}
        text = (pc.get("/settings/users") or {}).get("text") or ""
        check("«Пользователи»: an agent without rights is flagged «ничего не видит» with «Выдать стандартные права»",
              f"{tag}-bare" in text and "ничего не видит" in text and "Выдать стандартные права" in text, text[:400])
        check("«Пользователи»: staff only — no customer contacts, no role «Контр Агент»",
              f"{tag}-client" not in text and "Контр Агент" not in text, text[:400])
        text = (pc.get(f"/settings/users/{bare}") or {}).get("text") or ""
        check("the user card: the rights in words (Просмотр / Свои / Группы / Все) and the warning before saving",
              "Просмотр" in text and "Группы" in text and "Нет прав на просмотр" in text and "Уровни доступа" not in text,
              text[:400])
        text = (pc.get(f"/settings/groups/{group}") or {}).get("text") or ""
        check("the group page lists its members", "Участники" in text and f"{tag}-bare" in text, text[:400])
    finally:
        try:
            one(";".join([
                "begin",
                f"delete from \"user\" where email like 'audit-ui-{run}-set-%'",
                f"delete from \"group\" where name = '{tag}-group'",
                "commit",
            ]))
        except Exception as error:  # the report goes on; the rows are named AUDIT-ui-*
            print(f"cleanup of {tag} failed: {error}")


if __name__ == "__main__":
    sys.exit(main())
