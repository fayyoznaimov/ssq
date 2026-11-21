"""Checks for the CRM Telegram bot (parisahon-api/src/bot).

Runs against the local stack: the bot talks to local/fake-telegram (test side on
localhost:8098) and the assistant runs local/fake-claude, which calls the CRM tools
over MCP exactly as written in the message: [[tool NAME {json}]].
Voice messages go through the real speech-to-text service (parisahon-stt, CRM_BOT_STT_URL from the
env file; on the dev copy the unit crm-dev-stt with STT_TEST_HOOKS=1 for the outage test). The
sample local/fake-telegram/voice-sample.ogg says "Покажи мои открытые сделки, пожалуйста." (Russian,
synthesized offline with Piper TTS, voice ru_RU-dmitri-medium, ogg/opus like a Telegram voice note).
Creates its own users, company, deals and tasks (AUDIT-bot-*) and removes them.
Usage: py local/checks/bot_check.py      (exit code 1 on any FAIL)
"""
import base64
import json
import os
import random
import secrets
import shlex
import subprocess
import sys
import time
import urllib.error
import wave
import io
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASE = os.environ.get("CRM_API_URL", "http://localhost:8080/api/v1").rstrip("/")
# the same API reached from a non-loopback address (through nginx in docker); the MCP endpoint must refuse it
EXTERNAL_BASE = os.environ.get("CRM_API_EXTERNAL_URL", BASE).rstrip("/")
TG = os.environ.get("CRM_FAKE_TG_URL", "http://localhost:8098").rstrip("/")
ENV_FILE = os.environ.get("CRM_ENV_FILE") or os.path.join(ROOT, "parisahon-api", ".env")
COMPOSE_FILE = os.path.join(ROOT, "docker-compose.local.yml")
APP_PORT = os.environ.get("CRM_APP_PORT", "3000")  # the API port as seen from inside APP_EXEC

def _cmd(var, default):
    """A command prefix from the environment (dev copy on the server), else the docker stack's."""
    value = os.environ.get(var)
    return shlex.split(value) if value else default

PSQL = _cmd("CRM_PSQL", ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])
APP_EXEC = _cmd("CRM_APP_EXEC", ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-app"])
RUN = secrets.token_hex(3)
TAG = "AUDIT-bot-" + RUN
CARD_NAME = 'ООО "AUDIT Textile Test"'  # what local/fake-claude reads from any card
VOICE_SAMPLE = os.path.join(ROOT, "local", "fake-telegram", "voice-sample.ogg")
results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {str(detail)[:400]}" if detail and not ok else ""))


def env_value(key, default=None):
    """A value from the API env file (CRM_ENV_FILE), never printed."""
    for line in open(ENV_FILE, encoding="utf-8"):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"')
    return default


def admin_password():
    for line in open(ENV_FILE, encoding="utf-8"):
        if line.startswith("ADMIN_PASSWORD="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("ADMIN_PASSWORD not found in " + ENV_FILE)


def http(method, url, body=None, token=None, headers=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read()
            return r.status, json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        text = e.read()
        try:
            return e.code, json.loads(text)
        except Exception:
            return e.code, text.decode(errors="replace")


def api(method, path, body=None, token=None):
    return http(method, BASE + path, body, token)


def run(command, stdin=None):
    return subprocess.run(command, input=stdin, capture_output=True, text=True, encoding="utf-8")


def psql(sql):
    return run(PSQL + ["-At", "-c", sql]).stdout.strip()


def in_app(cmd, stdin=None):
    return run(APP_EXEC + ["sh", "-c", cmd], stdin=stdin).stdout.strip()


def fake_claude():
    try:
        return json.loads(in_app("cat /tmp/fake-claude-mcp-last.json"))
    except Exception:
        return {}


# ------------------------------------------------------------- fake Telegram

LOG_SEQ = [0]


def tg_mark():
    LOG_SEQ[0] = http("GET", f"{TG}/_test/log?since=0")[1]["seq"]


def tg_wait(pred, timeout=20):
    """First entry after the mark that matches pred (entries the bot sent)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for e in http("GET", f"{TG}/_test/log?since={LOG_SEQ[0]}")[1]["entries"]:
            if pred(e):
                return e
        time.sleep(0.4)
    return None


def tg_entries(chat=None):
    entries = http("GET", f"{TG}/_test/log?since={LOG_SEQ[0]}")[1]["entries"]
    return [e for e in entries if chat is None or e.get("chat_id") == str(chat)]


def send_text(chat, text, username="tester"):
    tg_mark()
    http("POST", f"{TG}/_test/update", {"message": {
        "message_id": random.randint(1, 10**6), "from": {"id": chat, "is_bot": False, "first_name": "T", "username": username},
        "chat": {"id": chat, "type": "private"}, "date": int(time.time()), "text": text}})


def send_photo(chat, data):
    file_id = "photo-" + secrets.token_hex(4)
    http("POST", f"{TG}/_test/file", {"file_id": file_id, "base64": base64.b64encode(data).decode()})
    tg_mark()
    http("POST", f"{TG}/_test/update", {"message": {
        "message_id": random.randint(1, 10**6), "from": {"id": chat, "is_bot": False, "first_name": "T"},
        "chat": {"id": chat, "type": "private"}, "date": int(time.time()),
        "photo": [{"file_id": file_id + "-small", "width": 90, "height": 60}, {"file_id": file_id, "width": 1280, "height": 860}]}})


def send_voice(chat, data, duration, kind="voice"):
    """A voice note (or an audio file with kind="audio"); duration is what Telegram reports."""
    file_id = f"{kind}-" + secrets.token_hex(4)
    http("POST", f"{TG}/_test/file", {"file_id": file_id, "base64": base64.b64encode(data).decode()})
    tg_mark()
    http("POST", f"{TG}/_test/update", {"message": {
        "message_id": random.randint(1, 10**6), "from": {"id": chat, "is_bot": False, "first_name": "T"},
        "chat": {"id": chat, "type": "private"}, "date": int(time.time()),
        kind: {"file_id": file_id, "duration": duration, "mime_type": "audio/ogg", "file_size": len(data)}}})
    return file_id


def fetched(file_id):
    """The bot downloaded this file (getFile) after the mark."""
    return any(e["method"] == "getFile" and e.get("file_id") == file_id for e in tg_entries())


def silence_wav(seconds):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(8000)
        w.writeframes(b"\x80" * 8000 * seconds)
    return buffer.getvalue()


def press(chat, data, message_id):
    tg_mark()
    http("POST", f"{TG}/_test/update", {"callback_query": {
        "id": secrets.token_hex(4), "from": {"id": chat, "is_bot": False, "first_name": "T"}, "data": data,
        "message": {"message_id": message_id, "chat": {"id": chat, "type": "private"}, "date": int(time.time()), "text": ""}}})


def reply(chat, contains=None, timeout=20):
    return tg_wait(lambda e: e["method"] == "sendMessage" and e["chat_id"] == str(chat)
                   and (contains is None or contains in e["text"]), timeout)


def ask(chat, text, contains="FAKE ANSWER"):
    send_text(chat, text)
    return reply(chat, contains, timeout=40)


def confirm_message(chat, timeout=20):
    """The bot's message with confirm/cancel buttons."""
    return tg_wait(lambda e: e["method"] == "sendMessage" and e["chat_id"] == str(chat) and button(e, "ok:"), timeout)


def button(entry, prefix):
    for row in (entry or {}).get("keyboard") or []:
        for b in row:
            if b.get("callback_data", "").startswith(prefix):
                return b["callback_data"]
    return None


def tool_result(entry, name):
    """JSON returned by a tool, from the fake assistant's answer."""
    for line in (entry or {}).get("text", "").split("\n"):
        if line.startswith(name + " -> "):
            raw = line[len(name) + 4:]
            try:
                return json.loads(raw)
            except Exception:
                return raw
    return None


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


# ------------------------------------------------------------- main

def main():
    status, body = api("POST", "/auth/login", {"email": "admin@gmail.com", "password": admin_password()})
    admin = body["access_token"]
    full = {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3}
    own = {"view": 1, "create": 3, "update": 1, "delete": 0, "export": 0}
    banned = {"view": 0, "create": 0, "update": 0, "delete": 0, "export": 0}
    perms_agent = {"deal": own, "contact": full, "company": full, "task": {"update": 1, "delete": 0}, "mail": True, "file": True}
    perms_banned = {"deal": banned, "contact": banned, "company": banned, "task": {"update": 0, "delete": 0}, "mail": False, "file": False}
    groups = sorted(g["id"] for g in api("GET", "/groups", token=admin)[1])

    users = {}
    try:
        for key, perms, group in (("a", perms_agent, groups[0]), ("b", perms_agent, groups[-1]), ("c", perms_banned, groups[0])):
            person = {"email": f"audit-bot-{RUN}-{key}@example.test", "password": secrets.token_urlsafe(12),
                      "username": f"{TAG}-{key}", "role": "agent", "group_id": group, "permissions": perms}
            status, created = api("POST", "/users", person, admin)
            if status != 201:
                raise SystemExit(f"cannot create user {key}: {status} {created}")
            person["id"] = created["id"]
            person["token"] = api("POST", "/auth/login", {"email": person["email"], "password": person["password"]})[1]["access_token"]
            person["chat"] = 7_000_000_000 + random.randint(1, 900_000_000)  # above 2^31 on purpose
            users[key] = person
        A, B, C = users["a"], users["b"], users["c"]

        # test data: one company, a deal for A and one for B, a Telegram message on each deal
        company_id = int(psql(f"insert into company (name, inn, phone) values ('{TAG} Текстиль', '30{random.randint(1000000, 9999999)}', '+998 90 111 22 33') returning id").split("\n")[0])
        stage = psql("select id from deal_stage where name = 'ПЕРВИЧНЫЙ КОНТАКТ' order by id desc limit 1")
        deal_a = int(psql(f"insert into deal (label, display_id, budget, stage_id, agent_id, company_id) values ('{TAG} сделка A', {random.randint(10**8, 2 * 10**9)}, 5000000, {stage}, {A['id']}, {company_id}) returning id").split("\n")[0])
        deal_b = int(psql(f"insert into deal (label, display_id, budget, stage_id, agent_id, company_id) values ('{TAG} сделка B', {random.randint(10**8, 2 * 10**9)}, 7000000, {stage}, {B['id']}, {company_id}) returning id").split("\n")[0])
        for deal, text in ((deal_a, "msg-A"), (deal_b, "msg-B")):
            psql(f"""insert into event (type, outgoing, deal_id, after_state) values (12, false, {deal}, '{{"message": "{TAG} {text}", "outgoing": false}}')""")

        # tasks of A: one starts in 5 minutes (reminder), one is overdue (digest, /tasks)
        now = datetime.now(timezone.utc)
        type_id = api("GET", "/task-types", token=admin)[1]
        type_id = (type_id["data"] if isinstance(type_id, dict) else type_id)[0]["id"]
        task_ids = {}
        for key, start, end in (("soon", now + timedelta(minutes=5), now + timedelta(minutes=35)),
                                ("overdue", now - timedelta(hours=3), now - timedelta(hours=2))):
            status, task = api("POST", "/tasks", {"label": f"{TAG} {key}", "type_id": type_id,
                                                  "assign_to": {"target": "agent", "id": A["id"]},
                                                  "link_to": {"target": "company", "id": company_id},
                                                  "start_time": iso(start), "end_time": iso(end), "allDay": False}, A["token"])
            task_ids[key] = task.get("id") if isinstance(task, dict) else None
        check("test tasks created through the API", all(task_ids.values()), task_ids)

        print("== linking")
        status, st = api("GET", "/bot/link", token=A["token"])
        check("GET /bot/link: bot is on, user not linked", status == 200 and st["enabled"] and st["bot_username"] == "parisa_crm_test_bot" and not st["linked"], st)
        check("GET /bot/link needs a login", api("GET", "/bot/link")[0] == 401)

        stranger = 6_100_000_000 + random.randint(1, 10**6)
        e = ask(stranger, "привет", contains="не подключён")
        check("an unknown Telegram user gets 'not linked' and nothing else", e is not None and len(tg_entries(stranger)) == 1, tg_entries(stranger))
        e = ask(stranger, "/start bogus-code", contains="недействительна")
        check("/start with a wrong code is refused", e is not None)

        links = {}
        for key in ("a", "b", "c"):
            status, link = api("POST", "/bot/link", token=users[key]["token"])
            links[key] = link
            check(f"POST /bot/link gives a t.me link ({key})", status == 201 and link["url"].startswith("https://t.me/parisa_crm_test_bot?start="), link)
        code_a = links["a"]["url"].split("start=")[1]
        stored = psql(f"select code_hash from bot_link_code where user_id = {A['id']}")
        check("only the hash of the link code is stored", stored and code_a not in stored and len(stored) == 64, stored)

        for key in ("a", "b", "c"):
            u = users[key]
            e = ask(u["chat"], "/start " + links[key]["url"].split("start=")[1], contains="вы вошли как")
            check(f"/start <code> links the chat ({key})", e is not None and u["username"] in e["text"])
        check("the same code cannot be used twice", ask(stranger, "/start " + code_a, contains="недействительна") is not None)
        check("bot_account stores the chat id (bigint) of A",
              psql(f"select chat_id from bot_account where user_id = {A['id']}") == str(A["chat"]))
        st = api("GET", "/bot/link", token=A["token"])[1]
        check("GET /bot/link shows linked", st["linked"] is True and st["tg_username"] == "tester", st)

        print("== digest and reminders")
        LOG_SEQ[0] = 0
        digest = tg_wait(lambda e: e["method"] == "sendMessage" and e["chat_id"] == str(A["chat"]) and "Доброе утро" in e["text"], 20)
        check("morning digest to A lists the overdue task with a done button",
              digest is not None and f"{TAG} overdue" in digest["text"] and button(digest, "done:"), digest)
        reminder = tg_wait(lambda e: e["method"] == "sendMessage" and e["chat_id"] == str(A["chat"]) and e["text"].startswith("⏰"), 20)
        check("reminder ~5 minutes before the task, to A", reminder is not None and f"{TAG} soon" in reminder["text"], reminder)
        time.sleep(8)
        sent_a = [e for e in tg_entries(A["chat"]) if e["method"] == "sendMessage"]
        check("digest and reminder are sent once", sum("Доброе утро" in e["text"] for e in sent_a) == 1 and sum(e["text"].startswith("⏰") for e in sent_a) == 1,
              [e["text"][:40] for e in sent_a])
        check("B has no tasks: no digest", not any("Доброе утро" in e["text"] for e in tg_entries(B["chat"])))
        check("digest date is stored", psql(f"select digest_on is not null from bot_account where user_id = {A['id']}") == "t")

        press(A["chat"], f"done:{task_ids['soon']}", reminder["message_id"])
        ans = tg_wait(lambda e: e["method"] == "answerCallbackQuery", 15)
        check("'Выполнено' under the reminder closes the task", ans and ans["text"] == "Задача закрыта"
              and psql(f"select result from task where id = {task_ids['soon']}") == "Выполнено (отмечено в Telegram)", ans)
        press(B["chat"], f"done:{task_ids['overdue']}", 1)
        ans = tg_wait(lambda e: e["method"] == "answerCallbackQuery", 15)
        check("B cannot close A's task", ans and "нет прав" in (ans["text"] or "") and psql(f"select closed_at is null from task where id = {task_ids['overdue']}") == "t", ans)

        print("== commands")
        send_text(A["chat"], "/tasks")
        e = reply(A["chat"])
        check("/tasks: A's overdue task", e and "Просрочено" in e["text"] and f"{TAG} overdue" in e["text"], e)
        send_text(A["chat"], "/deals")
        e = reply(A["chat"])
        check("/deals: A sees own deal, not B's", e and f"{TAG} сделка A" in e["text"] and f"{TAG} сделка B" not in e["text"], e)
        send_text(B["chat"], "/deals")
        e = reply(B["chat"])
        check("/deals: B sees own deal, not A's", e and f"{TAG} сделка B" in e["text"] and f"{TAG} сделка A" not in e["text"], e)

        print("== assistant over MCP")
        e = ask(A["chat"], f'Найди [[tool find_clients {{"query": "{TAG}"}}]]')
        found = tool_result(e, "find_clients")
        check("assistant: find_clients finds the company", isinstance(found, dict) and any(c["id"] == company_id for c in found.get("companies", [])), e)
        rec = fake_claude()
        args = rec.get("args", [])
        check("Claude CLI: no built-in tools, only this MCP config, one-run settings",
              args[args.index("--tools") + 1] == "" and "--strict-mcp-config" in args and "--setting-sources" in args
              and "--no-session-persistence" in args, args)
        check("Claude CLI: allowed tools are only the CRM tools",
              rec.get("allowedTools") and all(t.startswith("mcp__crm__") for t in rec["allowedTools"]) and len(rec["allowedTools"]) == 8, rec.get("allowedTools"))
        check("MCP config is a private file (0600), removed after the run",
              rec.get("mcpFileMode") == "600" and in_app("ls /tmp | grep -c crm-mcp- || true") == "0", rec.get("mcpFileMode"))
        check("MCP endpoint is on 127.0.0.1 and lists 8 tools with plain JSON schemas",
              rec.get("mcpUrl", "").startswith("http://127.0.0.1:") and len(rec.get("toolsListed", [])) == 8 and rec.get("schemasOk") and rec.get("notifyStatus") == 202, rec)
        check("model Opus with medium effort", rec.get("model") == "claude-opus-5-5" and rec.get("effort") == "medium", rec)
        check("our system prompt, current date, no API key passed",
              rec.get("systemIsBot") and rec.get("textHasNow") and rec.get("envHasApiKey") is False, rec)
        check("Markdown bold is stripped from the answer", e and "**" not in e["text"])

        e = ask(A["chat"], f'[[tool list_deals {{"company_id": {company_id}, "status": "all"}}]]')
        deals = tool_result(e, "list_deals")
        check("rights: A's list_deals shows only A's deal", isinstance(deals, dict) and [d["id"] for d in deals["deals"]] == [deal_a], deals)
        check("assistant keeps the dialog (history in the next prompt)", fake_claude().get("hasHistory") is True)
        e = ask(B["chat"], f'[[tool list_deals {{"company_id": {company_id}, "status": "all"}}]]')
        deals = tool_result(e, "list_deals")
        check("rights: B's list_deals shows only B's deal", isinstance(deals, dict) and [d["id"] for d in deals["deals"]] == [deal_b], deals)
        e = ask(A["chat"], f'[[tool client_history {{"company_id": {company_id}}}]]')
        hist = json.dumps(tool_result(e, "client_history"), ensure_ascii=False)
        check("rights: A's client history has the message of A's deal, not of B's", "msg-A" in hist and "msg-B" not in hist, hist)
        e = ask(A["chat"], f'[[tool get_client {{"company_id": {company_id}}}]]')
        card = tool_result(e, "get_client")
        check("get_client: requisites, deals of A, CRM link", isinstance(card, dict) and card["requisites"]["inn"] and [d["id"] for d in card["deals"]] == [deal_a]
              and card["crm_url"] == f"{env_value('CRM_PUBLIC_URL', 'http://localhost:4100').rstrip('/')}/lists/companies/{company_id}", card)
        e = ask(C["chat"], f'[[tool find_clients {{"query": "{TAG}"}}]]')
        check("rights: C (companies banned) finds nothing", e and "нет доступа к компаниям" in e["text"], e)
        e = ask(C["chat"], f'[[tool get_client {{"company_id": {company_id}}}]]')
        check("rights: C cannot open the company by id", e and "не найдена или нет доступа" in e["text"], e)
        e = ask(A["chat"], '[[tool get_client {"company_id": "1; drop table task"}]]')
        check("bad tool arguments are rejected by the schema", e and "Неверные параметры" in e["text"], e)

        print("== changes need a button")
        day = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d")
        label = f"{TAG} позвонить"
        e = ask(A["chat"], f'[[tool prepare_task {{"title": "{label}", "date": "{day}", "time": "15:00", "company_id": {company_id}}}]]')
        prepared = confirm_message(A["chat"])
        check("prepare_task saves nothing yet", psql(f"select count(*) from task where label = '{label}'") == "0")
        check("bot shows the task with confirm/cancel buttons", prepared and button(prepared, "ok:") and button(prepared, "no:") and "15:00" in prepared["text"], prepared)
        ok_data = button(prepared, "ok:")
        press(B["chat"], ok_data, prepared["message_id"])
        ans = tg_wait(lambda e: e["method"] == "answerCallbackQuery", 15)
        check("B cannot confirm A's action", ans and ans["text"] == "Это действие устарело" and psql(f"select count(*) from task where label = '{label}'") == "0", ans)
        press(A["chat"], ok_data, prepared["message_id"])
        edit = tg_wait(lambda e: e["method"] == "editMessageText" and "Задача создана" in e["text"], 15)
        row = psql(f"select agent_id, company_id, to_char(start_time, 'HH24:MI') from task where label = '{label}'")
        check("confirm creates the task for A, linked to the company, at 15:00 local",
              edit is not None and row == f"{A['id']}|{company_id}|15:00", row)
        press(A["chat"], ok_data, prepared["message_id"])
        ans = tg_wait(lambda e: e["method"] == "answerCallbackQuery", 15)
        check("a second press does not create a duplicate", psql(f"select count(*) from task where label = '{label}'") == "1", ans)

        e = ask(A["chat"], f'[[tool prepare_task {{"title": "{label} 2", "date": "{day}", "company_id": {company_id}}}]]')
        prepared = confirm_message(A["chat"])
        press(A["chat"], button(prepared, "no:"), prepared["message_id"])
        edit = tg_wait(lambda e: e["method"] == "editMessageText" and "Отменено" in e["text"], 15)
        check("cancel saves nothing", edit is not None and psql(f"select count(*) from task where label = '{label} 2'") == "0")

        e = ask(A["chat"], f'[[tool prepare_task {{"title": "{label} 3", "date": "{day}", "deal_id": {deal_b}}}]]')
        check("A cannot attach a task to B's deal", e and "не найдена или нет доступа" in e["text"], e)
        e = ask(C["chat"], f'[[tool prepare_company {{"name": "{TAG} Новая"}}]]')
        check("C (no right to create companies) cannot prepare one", e and "нет права создавать" in e["text"], e)

        print("== card photo")
        psql(f"delete from \"user\" where company_id in (select id from company where name = '{CARD_NAME}'); delete from company where name = '{CARD_NAME}'")
        send_photo(A["chat"], b"\xff\xd8\xff\xe0" + os.urandom(800))
        card_msg = reply(A["chat"], "Прочитал карточку", timeout=40)
        check("photo: bot shows the recognized company with buttons",
              card_msg and "ИНН: 305123456" in card_msg["text"] and "Аудитова Анна" in card_msg["text"] and button(card_msg, "ok:"), card_msg)
        check("photo: warnings are shown (unclear ОКЭД)", card_msg and "⚠️" in card_msg["text"], card_msg)
        # the CRM has required custom fields a card cannot fill ("Страна", "Код Клиента"): the bot
        # warns about them and still creates the company (the web form would insist on them)
        required_fields = psql("select string_agg(field, ',') from filler where target = 'company' and is_required")
        check("photo: the required CRM fields that are missing are named in the warning",
              not required_fields or (card_msg and "Обязательные поля не заполнены" in card_msg["text"]
                                      and all(f in card_msg["text"] for f in required_fields.split(","))), (required_fields, card_msg))
        press(A["chat"], button(card_msg, "ok:"), card_msg["message_id"])
        edit = tg_wait(lambda e: e["method"] == "editMessageText" and "Компания создана" in e["text"], 20)
        row = psql(f"select c.inn, c.created_by, u.username, u.email from company c join \"user\" u on u.company_id = c.id where c.name = '{CARD_NAME}'")
        check("confirm creates the company with requisites and the contact, created by A",
              edit is not None and row.startswith(f"305123456|{A['id']}|Аудитова Анна|"), row)
        send_photo(A["chat"], b"\xff\xd8\xff\xe0" + os.urandom(800))
        e = reply(A["chat"], "уже есть в CRM", timeout=40)
        check("the same card again: 'already in the CRM', no buttons", e is not None and not e.get("keyboard"), e)
        send_photo(C["chat"], b"\xff\xd8\xff\xe0" + os.urandom(800))
        check("photo from C (no right to create): refused", reply(C["chat"], "нет права создавать") is not None)

        print("== voice messages")
        sample = open(VOICE_SAMPLE, "rb").read()
        stt_url = (env_value("CRM_BOT_STT_URL") or "").strip().rstrip("/")
        if not stt_url:
            send_voice(A["chat"], sample, 3)
            check("voice without CRM_BOT_STT_URL: 'not configured', text works", reply(A["chat"], "не настроено") is not None
                  and ask(A["chat"], "привет") is not None)
        else:
            status, health = http("GET", stt_url + "/health")
            check("speech-to-text service answers /health", status == 200 and isinstance(health, dict) and health.get("ok"), (status, health))
            send_text(A["chat"], "/help")
            check("/help tells about voice messages", reply(A["chat"], "голосовым") is not None)
            file_id = send_voice(stranger, sample, 3)
            e = reply(stranger, "не подключён")
            time.sleep(1)
            check("voice from an unknown Telegram user: 'not linked', the file is not even downloaded", e is not None and not fetched(file_id), e)

            send_voice(A["chat"], sample, 3)
            heard = reply(A["chat"], "🎤", timeout=60)
            check("voice: the recognized text is shown as '🎤 …'", heard and "сделки" in heard["text"].lower(), heard)
            answer = reply(A["chat"], "FAKE ANSWER", timeout=60)
            check("voice: the text then goes to the assistant like a typed message", answer is not None and heard is not None and answer["seq"] > heard["seq"], answer)
            send_voice(A["chat"], sample, 3, kind="audio")
            heard = reply(A["chat"], "🎤", timeout=60)
            check("an audio file is recognized the same way", heard and "сделки" in heard["text"].lower() and reply(A["chat"], "FAKE ANSWER", timeout=60), heard)

            file_id = send_voice(A["chat"], sample, 600)
            e = reply(A["chat"], "длиннее")
            check("voice longer than 3 minutes: refused with a clear answer, not downloaded", e and "3 мин" in e["text"] and not fetched(file_id), e)
            file_id = send_voice(A["chat"], silence_wav(200), 5)
            e = reply(A["chat"], "длиннее", timeout=60)
            check("voice that is really longer than reported: the speech service measures it and refuses", e is not None and fetched(file_id), e)
            send_voice(A["chat"], silence_wav(3), 3)
            check("silent voice: 'no words heard', nothing sent to the assistant",
                  reply(A["chat"], "Не разобрал", timeout=60) is not None and not reply(A["chat"], "FAKE ANSWER", timeout=2))
            send_voice(A["chat"], b"this is not audio at all " * 20, 3)
            check("broken audio: clear answer", reply(A["chat"], "Не смог прочитать звук", timeout=30) is not None)

            status, _ = http("POST", stt_url + "/_test/outage", {"seconds": 60})
            check("the dev speech service can simulate an outage (STT_TEST_HOOKS=1 in crm-dev-stt)", status == 200, status)
            try:
                send_voice(A["chat"], sample, 3)
                e = reply(A["chat"], "недоступно", timeout=60)
                sent = [x["text"] for x in tg_entries(A["chat"]) if x["method"] == "sendMessage"]
                check("speech service down: clear answer, nothing shown or sent to the assistant",
                      e is not None and not any(t.startswith("🎤") or "FAKE ANSWER" in t for t in sent), sent)
                check("speech service down: typed messages still work", ask(A["chat"], "привет") is not None)
            finally:
                http("POST", stt_url + "/_test/outage", {"seconds": 0})
            send_voice(A["chat"], sample, 3)
            check("speech service back: voice works again", reply(A["chat"], "🎤", timeout=60) is not None and reply(A["chat"], "FAKE ANSWER", timeout=60))

        print("== MCP endpoint protection")
        status, _ = http("POST", EXTERNAL_BASE + "/bot/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, token="x")
        check("MCP not from 127.0.0.1 (through nginx / the server address) is refused", status == 403, status)
        probe = (f"fetch('http://127.0.0.1:{APP_PORT}/api/v1/bot/mcp',{{method:'POST',headers:{{'Content-Type':'application/json',"
                 "Authorization:'Bearer '+process.argv[1]},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})"
                 ".then(r=>console.log(r.status))")
        check("MCP with a made-up token is refused", in_app(f"node -e \"{probe}\" not-a-session-token") == "401")
        check("MCP with a CRM login token is refused", in_app(f"node -e \"{probe}\" {A['token']}") == "401")

        print("== unlink")
        send_text(B["chat"], "/unlink")
        check("/unlink disconnects", reply(B["chat"], "отключён") is not None and not api("GET", "/bot/link", token=B["token"])[1]["linked"])
        check("after /unlink the bot does not know B", ask(B["chat"], "/deals", contains="не подключён") is not None)
        status, st = api("DELETE", "/bot/link", token=A["token"])
        check("DELETE /bot/link from the profile unlinks", status == 200 and st["linked"] is False, st)
    finally:
        cleanup()

    passed = sum(results)
    print(f"\nRESULT: {passed} passed, {len(results) - passed} failed")
    return 1 if passed != len(results) else 0


def cleanup():
    print("== cleanup")
    users = f"select id from \"user\" where email like 'audit-bot-{RUN}-%@example.test'"
    companies = f"select id from company where name like '{TAG}%' or name = '{CARD_NAME}'"
    deals = f"select id from deal where label like '{TAG}%'"
    tasks = f"select id from task where label like '{TAG}%' or company_id in ({companies}) or deal_id in ({deals})"
    contacts = f"select id from \"user\" where company_id in ({companies})"
    psql(";".join([
        "begin",
        f"delete from event where deal_id in ({deals}) or task_id in ({tasks}) or user_id in ({users}) or user_id in ({contacts}) "
        f"or target_user_id in ({contacts}) or after_state::text like '%{TAG}%' or after_state::text like '%AUDIT Textile Test%'",
        f"delete from notification where company_id in ({companies})",
        f"delete from task where id in ({tasks})",
        f"delete from deal where id in ({deals})",
        f"delete from user_filler where user_id in ({contacts})",
        f"delete from \"user\" where id in ({contacts})",
        f"delete from bot_link_code where user_id in ({users})",
        f"delete from \"user\" where id in ({users})",
        f"delete from company where id in ({companies})",
        "commit",
    ]))
    left = psql(f"select (select count(*) from \"user\" where email like 'audit-bot-{RUN}-%') + (select count(*) from company where name like '{TAG}%' or name = '{CARD_NAME}')"
                f" + (select count(*) from deal where label like '{TAG}%') + (select count(*) from task where label like '{TAG}%')")
    check("test rows removed", left == "0", left)


if __name__ == "__main__":
    sys.exit(main())
