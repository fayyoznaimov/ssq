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
import math
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
        # A's deal also has a WhatsApp message with a file and a client's e-mail (the bot's history used to skip
        # WhatsApp, and told the e-mail text to people without the "mail" right)
        psql(f"""insert into event (type, outgoing, deal_id, after_state) values (16, false, {deal_a}, '{{"message": "{TAG} wa-A", "outgoing": false, "files": [{{"name": "price.pdf", "type": "document"}}]}}')""")
        psql(f"""insert into event (type, outgoing, deal_id, after_state) values (9, false, {deal_a}, '{{"data": {{"subject": "{TAG} mail-subject", "body": "{TAG} mail-secret-body"}}}}')""")

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
                                                  "start_time": iso(start), "end_time": iso(end), "allDay": False,
                                                  "allow_past": True}, A["token"])  # the overdue one on purpose (TASK_IN_PAST)
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
        check("morning digest to A lists the overdue task with a button that opens it (time and task on the button)",
              digest is not None and f"{TAG} overdue" in digest["text"] and button(digest, "tk:")
              and any(f"{TAG} overdue"[:20] in b["text"] for row in digest["keyboard"] for b in row), digest)
        reminder = tg_wait(lambda e: e["method"] == "sendMessage" and e["chat_id"] == str(A["chat"]) and e["text"].startswith("⏰"), 20)
        check("reminder ~5 minutes before the task, to A", reminder is not None and f"{TAG} soon" in reminder["text"], reminder)
        time.sleep(8)
        sent_a = [e for e in tg_entries(A["chat"]) if e["method"] == "sendMessage"]
        check("digest and reminder are sent once", sum("Доброе утро" in e["text"] for e in sent_a) == 1 and sum(e["text"].startswith("⏰") for e in sent_a) == 1,
              [e["text"][:40] for e in sent_a])
        check("B has no tasks: no digest", not any("Доброе утро" in e["text"] for e in tg_entries(B["chat"])))
        check("digest date is stored", psql(f"select digest_on is not null from bot_account where user_id = {A['id']}") == "t")

        check("the reminder has the task's buttons: done, move, edit (no delete without the right)",
              reminder is not None and button(reminder, f"dn:{task_ids['soon']}") and button(reminder, "mv:") and button(reminder, "ed:")
              and not button(reminder, "dl:"), reminder)
        press(A["chat"], f"dn:{task_ids['soon']}", reminder["message_id"])
        asked = reply(A["chat"], "Напишите итог")
        check("'Выполнено' does not close the task at once: it asks for the outcome (or 'Закрыть без итога')",
              asked is not None and button(asked, f"dc:{task_ids['soon']}") and button(asked, "ax:")
              and psql(f"select closed_at is null from task where id = {task_ids['soon']}") == "t", asked)
        send_text(A["chat"], f"{TAG} договорились об отгрузке")
        done = reply(A["chat"], "Задача закрыта")
        check("the next message is the outcome: the task is closed with it (not sent to the assistant)",
              done is not None and psql(f"select result from task where id = {task_ids['soon']}") == f"{TAG} договорились об отгрузке"
              and not reply(A["chat"], "FAKE ANSWER", timeout=2), done)
        time.sleep(1)
        ev = psql(f"select task_id, after_state->'data'->>'via' from event where type = 7 and task_id = {task_ids['soon']} order by id desc limit 1")
        check("the history entry of the closing names the task and that it was done in the bot (BOT-5)", ev == f"{task_ids['soon']}|bot", ev)
        press(B["chat"], f"dn:{task_ids['overdue']}", 1)
        ans = tg_wait(lambda e: e["method"] == "answerCallbackQuery", 15)
        check("B cannot close A's task", ans and ("нет прав" in (ans["text"] or "").lower() or "нет доступа" in (ans["text"] or ""))
              and psql(f"select closed_at is null from task where id = {task_ids['overdue']}") == "t", ans)

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
        # 11 CRM tools, and deal_summary of the AI (src/ai) while AI_FEATURES and AI_SUMMARY are on
        tool_count = 11 + ("mcp__crm__deal_summary" in (rec.get("allowedTools") or []))
        check("Claude CLI: allowed tools are only the CRM tools",
              rec.get("allowedTools") and all(t.startswith("mcp__crm__") for t in rec["allowedTools"]) and len(rec["allowedTools"]) == tool_count, rec.get("allowedTools"))
        check("MCP config is a private file (0600), removed after the run",
              rec.get("mcpFileMode") == "600" and in_app("ls /tmp | grep -c crm-mcp- || true") == "0", rec.get("mcpFileMode"))
        check(f"MCP endpoint is on 127.0.0.1 and lists {tool_count} tools with plain JSON schemas",
              rec.get("mcpUrl", "").startswith("http://127.0.0.1:") and len(rec.get("toolsListed", [])) == tool_count and rec.get("schemasOk") and rec.get("notifyStatus") == 202, rec)
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
        check("client history has the WhatsApp message with its direction and file (was left out)",
              f"WhatsApp, входящее: {TAG} wa-A" in hist and "price.pdf" in hist, hist)
        check("A (with the mail right) sees the e-mail subject and text", "mail-secret-body" in hist, hist)
        # without the "mail" switch the web hides e-mail texts in the history; so does the bot (it reads the rights from the database)
        psql(f"""update "user" set permissions = permissions || '{{"mail": false}}'::jsonb where id = {A['id']}""")
        try:
            e = ask(A["chat"], f'[[tool client_history {{"company_id": {company_id}}}]]')
            hist = json.dumps(tool_result(e, "client_history"), ensure_ascii=False)
            check("without the mail right the bot says 'Письмо (текст скрыт…)': no subject, no text",
                  "текст скрыт" in hist and "mail-secret-body" not in hist and "mail-subject" not in hist and "wa-A" in hist, hist)
        finally:
            psql(f"""update "user" set permissions = permissions || '{{"mail": true}}'::jsonb where id = {A['id']}""")
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
        weekday = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"][datetime.strptime(day, "%Y-%m-%d").weekday()]
        check("the confirmation has the weekday, the start and the end: 'вт 24.11.2026 15:00–15:30' (BOT-13)",
              prepared and f"{weekday} {datetime.strptime(day, '%Y-%m-%d').strftime('%d.%m.%Y')} 15:00–15:30" in prepared["text"], prepared)
        ok_data = button(prepared, "ok:")
        press(B["chat"], ok_data, prepared["message_id"])
        ans = tg_wait(lambda e: e["method"] == "answerCallbackQuery", 15)
        check("B cannot confirm A's action", ans and ans["text"] == "Это действие устарело" and psql(f"select count(*) from task where label = '{label}'") == "0", ans)
        press(A["chat"], ok_data, prepared["message_id"])
        edit = tg_wait(lambda e: e["method"] == "editMessageText" and "Задача создана" in e["text"], 15)
        row = psql(f"select agent_id, deal_id, to_char(start_time, 'HH24:MI') from task where label = '{label}'")
        check("confirm creates the task for A at 15:00 local, on the client's only open deal A sees (not on the company alone)",
              edit is not None and row == f"{A['id']}|{deal_a}|15:00", row)
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

        # two open deals of the client: the bot asks which one instead of putting the task on the company
        deal_a2 = int(psql(f"insert into deal (label, display_id, budget, stage_id, agent_id, company_id) values ('{TAG} сделка A2', {random.randint(10**8, 2 * 10**9)}, 1000, {stage}, {A['id']}, {company_id}) returning id").split("\n")[0])
        e = ask(A["chat"], f'[[tool prepare_task {{"title": "{label} 4", "date": "{day}", "company_id": {company_id}}}]]')
        res = tool_result(e, "prepare_task")
        check("several open deals: prepare_task answers choose_deal with A's deals and saves nothing",
              isinstance(res, dict) and res.get("status") == "choose_deal" and sorted(d["id"] for d in res.get("deals", [])) == sorted([deal_a, deal_a2])
              and psql(f"select count(*) from task where label = '{label} 4'") == "0", res)
        e = ask(A["chat"], f'[[tool prepare_task {{"title": "{label} 5", "date": "{day}", "company_id": {company_id}, "company_only": true}}]]')
        prepared = confirm_message(A["chat"])
        check("company_only: true prepares a task of the company itself", prepared is not None and "клиент" in prepared["text"], prepared)
        if prepared:
            press(A["chat"], button(prepared, "no:"), prepared["message_id"])
            tg_wait(lambda e: e["method"] == "editMessageText" and "Отменено" in e["text"], 15)
        psql(f"update deal set closed_at = now() where id = {deal_a2}")

        print("== reminders: a task of a group, a task moved after its reminder")
        # A may change the tasks of the group (task level "group"); C (banned) may not: only A is reminded
        psql(f"""update "user" set permissions = jsonb_set(permissions, '{{task,update}}', '2') where id = {A['id']}""")
        tg_mark()
        soon = datetime.now(timezone.utc) + timedelta(minutes=5)
        status, gtask = api("POST", "/tasks", {"label": f"{TAG} group-task", "type_id": type_id,
                                               "assign_to": {"target": "group", "id": groups[0]},
                                               "link_to": {"target": "deal", "id": deal_a},
                                               "start_time": iso(soon), "end_time": iso(soon + timedelta(minutes=30)), "allDay": False}, admin)
        status2, mtask = api("POST", "/tasks", {"label": f"{TAG} moved-task", "type_id": type_id,
                                                "assign_to": {"target": "agent", "id": A["id"]},
                                                "link_to": {"target": "deal", "id": deal_a},
                                                "start_time": iso(soon), "end_time": iso(soon + timedelta(minutes=30)), "allDay": False,
                                                "allow_duplicate": True}, A["token"])  # same deal, same time on purpose (TASK_DUPLICATE)
        check("tasks for the reminders created", status == 201 and status2 == 201, (status, gtask, status2, mtask))
        r = tg_wait(lambda e: e["method"] == "sendMessage" and e["chat_id"] == str(A["chat"]) and f"{TAG} group-task" in e["text"], 40)
        check("a task of A's group is reminded to A, who may close it (it used to be reminded to nobody)",
              r is not None and r["text"].startswith("⏰") and "задача группы" in r["text"].lower() and button(r, "tk:"), r)
        check("two tasks of the same minute come in one message with a button per task (BOT-15)",
              r is not None and f"{TAG} moved-task" in r["text"] and "Скоро 2 задачи" in r["text"]
              and len([b for row in r["keyboard"] for b in row if b["callback_data"].startswith("tk:")]) == 2, r)
        time.sleep(3)
        check("C of the same group may not close the group's tasks: no reminder to C (BOT-6)",
              not any(f"{TAG} group-task" in e.get("text", "") for e in tg_entries(C["chat"])), tg_entries(C["chat"]))
        if isinstance(gtask, dict) and gtask.get("id"):
            send_text(C["chat"], "/tasks")
            e = reply(C["chat"])
            check("... and C's /tasks does not list it", e is not None and f"{TAG} group-task" not in e["text"], e)
            send_text(A["chat"], "/tasks")
            e = reply(A["chat"])
            check("A's /tasks lists the group's task", e is not None and f"{TAG} group-task" in e["text"], e)
        stored = psql(f"select r.start_time = t.start_time from bot_reminder r join task t on t.id = r.task_id where r.task_id = {mtask.get('id') if isinstance(mtask, dict) else 0}")
        check("bot_reminder keeps the start time it reminded for", stored == "t", stored)
        if isinstance(mtask, dict) and mtask.get("id"):
            later = datetime.now(timezone.utc) + timedelta(minutes=8)
            tg_mark()
            # moved with the times only, as a drag in the calendar sends it
            status, _ = api("PATCH", f"/tasks/{mtask['id']}", {"start_time": iso(later), "end_time": iso(later + timedelta(minutes=30)), "allDay": False,
                                                               "allow_duplicate": True}, A["token"])
            r = tg_wait(lambda e: e["method"] == "sendMessage" and e["chat_id"] == str(A["chat"]) and f"{TAG} moved-task" in e["text"], 40)
            check("moved to a new time -> reminded again before the new time (the 'reminded' mark stayed for good)",
                  status == 200 and r is not None, (status, r))
            check("... and the moved task is still on its deal", psql(f"select deal_id from task where id = {mtask['id']}") == str(deal_a))
            # moved not through the task service (a trigger, SQL): the reminder is keyed by the start time too (BOT-2)
            tg_mark()
            psql(f"update task set start_time = now() + interval '6 minutes', end_time = now() + interval '36 minutes' where id = {mtask['id']}")
            r = tg_wait(lambda e: e["method"] == "sendMessage" and e["chat_id"] == str(A["chat"]) and f"{TAG} moved-task" in e["text"], 40)
            check("moved by SQL to a new time -> reminded again before the new time (BOT-2)", r is not None, r)
        # a task that started minutes ago is not reminded with «сейчас» (BOT-15)
        tg_mark()
        started = datetime.now(timezone.utc) - timedelta(minutes=5)
        api("POST", "/tasks", {"label": f"{TAG} started-task", "type_id": type_id, "assign_to": {"target": "agent", "id": A["id"]},
                               "link_to": {"target": "company", "id": company_id}, "start_time": iso(started),
                               "end_time": iso(started + timedelta(minutes=30)), "allDay": False, "allow_past": True}, A["token"])
        time.sleep(15)
        check("a task that started 5 minutes ago gets no '⏰ сейчас' reminder (BOT-15)",
              not any(f"{TAG} started-task" in e.get("text", "") for e in tg_entries(A["chat"])), tg_entries(A["chat"]))
        psql(f"""update "user" set permissions = jsonb_set(permissions, '{{task,update}}', '1') where id = {A['id']}""")
        e = ask(C["chat"], f'[[tool prepare_company {{"name": "{TAG} Новая"}}]]')
        check("C (no right to create companies) cannot prepare one", e and "нет права создавать" in e["text"], e)

        task_buttons(A, B, C, admin, type_id, company_id, deal_a, deal_b, groups)

        print("== card photo")
        psql(f"delete from \"user\" where company_id in (select id from company where name = '{CARD_NAME}'); delete from company where name = '{CARD_NAME}'")
        # the card gets an ИНН of its own (local/fake-claude reads "AUDIT-INN:<digits>" from the file): a stand
        # with real data may already have a company with the canned ИНН 305123456, and the bot then rightly
        # answers "already in the CRM" instead of offering a new company
        card_inn = next(inn for inn in (f"39{random.randint(0, 10**7 - 1):07d}" for _ in range(50))
                        if psql(f"select count(*) from company where inn = '{inn}'") == "0")
        card = lambda: b"\xff\xd8\xff\xe0" + os.urandom(400) + f"AUDIT-INN:{card_inn}".encode() + os.urandom(400)
        send_photo(A["chat"], card())
        card_msg = reply(A["chat"], "Прочитал карточку", timeout=40)
        check("photo: bot shows the recognized company with buttons",
              card_msg and f"ИНН: {card_inn}" in card_msg["text"] and "Аудитова Анна" in card_msg["text"] and button(card_msg, "ok:"), card_msg)
        check("photo: warnings are shown (unclear ОКЭД)", card_msg and "⚠️" in card_msg["text"], card_msg)
        # the CRM has required custom fields a card cannot fill ("Страна", "Код Клиента"): the bot
        # warns about them and still creates the company (the web form would insist on them)
        required_fields = psql("select string_agg(field, ',') from filler where target = 'company' and is_required")
        check("photo: the required CRM fields that are missing are named in the warning",
              not required_fields or (card_msg and "Обязательные поля не заполнены" in card_msg["text"]
                                      and all(f in card_msg["text"] for f in required_fields.split(","))), (required_fields, card_msg))
        edit = None
        if card_msg and button(card_msg, "ok:"):  # without the card message the next checks fail instead of a crash
            press(A["chat"], button(card_msg, "ok:"), card_msg["message_id"])
            edit = tg_wait(lambda e: e["method"] == "editMessageText" and "Компания создана" in e["text"], 20)
        row = psql(f"select c.inn, c.created_by, u.username, u.email from company c join \"user\" u on u.company_id = c.id where c.name = '{CARD_NAME}'")
        check("confirm creates the company with requisites and the contact, created by A",
              edit is not None and row.startswith(f"{card_inn}|{A['id']}|Аудитова Анна|"), row)
        send_photo(A["chat"], card())
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
            if status == 404:
                # the speech service of this stand has no test hooks (STT_TEST_HOOKS is off: the production service,
                # shared by the QA stand, must never have them): the outage cannot be simulated here, only on the dev copy
                print("SKIP  speech service outage (STT_TEST_HOOKS=1 only in crm-dev-stt; this stand's service answers 404)")
            else:
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

        print("== linked again in another chat: the previous chat is told (it used to be dropped silently)")
        other = 7_950_000_000 + random.randint(1, 10**6)
        psql(f"update bot_account set digest_on = (now())::date where user_id = {C['id']}")
        status, link = api("POST", "/bot/link", token=C["token"])
        e = ask(other, "/start " + link["url"].split("start=")[1], contains="вы вошли как") if status == 201 else None
        told = reply(C["chat"], "подключил бота CRM в другом чате")
        check("C links the bot in another chat: the new chat is linked, the previous one is told and unlinked",
              e is not None and told is not None and psql(f"select chat_id from bot_account where user_id = {C['id']}") == str(other),
              (status, e, told))
        check("... the previous chat is told the new Telegram account (BOT-14)", told is not None and "@tester" in told["text"], told)
        check("... and today's digest is not sent again: the digest date stays (BOT-14)",
              psql(f"select digest_on = (now())::date from bot_account where user_id = {C['id']}") == "t")
        status, link = api("POST", "/bot/link", token=C["token"])
        e = ask(C["chat"], "/start " + link["url"].split("start=")[1], contains="вы вошли как") if status == 201 else None
        check("... and back in the first chat", e is not None and psql(f"select chat_id from bot_account where user_id = {C['id']}") == str(C["chat"]), e)

        print("== signed out everywhere: the bot goes too (src/auth/sign-out.ts)")
        tg_mark()
        status, _ = api("POST", f"/auth/logout/{C['id']}", {}, admin)
        told = reply(C["chat"], "выход на всех устройствах")
        check("the admin ends every session of C -> 204, the chat is told why and unlinked",
              status == 204 and told is not None and psql(f"select count(*) from bot_account where user_id = {C['id']}") == "0",
              (status, told))
        check("after it the bot does not know C", ask(C["chat"], "/deals", contains="не подключён") is not None)
    finally:
        cleanup()

    passed = sum(results)
    print(f"\nRESULT: {passed} passed, {len(results) - passed} failed")
    return 1 if passed != len(results) else 0


KAR = timezone(timedelta(hours=5))  # the CRM's zone (Asia/Karachi, like Tashkent)


def set_perm(user, path, value):
    psql(f"""update "user" set permissions = jsonb_set(permissions, '{{{path}}}', '{value}') where id = {user['id']}""")


def buttons_of(entry):
    return [b for row in (entry or {}).get("keyboard") or [] for b in row]


def task_row(task_id):
    return psql(f"select to_char(start_time, 'YYYY-MM-DD HH24:MI'), \"allDay\", label, closed_at is null from task where id = {task_id}")


def task_buttons(A, B, C, admin, type_id, company_id, deal_a, deal_b, groups):
    """The bot as a full way to work with tasks: the card and its buttons, the list, assigning, personal and contact tasks."""
    print("== task buttons: /tasks, the card, move, edit, delete")
    now = datetime.now(timezone.utc)

    def make(label, start, minutes=30, user=A, link=None):
        status, task = api("POST", "/tasks", {"label": label, "type_id": type_id, "assign_to": {"target": "agent", "id": user["id"]},
                                              "link_to": link or {"target": "company", "id": company_id},
                                              "start_time": iso(start), "end_time": iso(start + timedelta(minutes=minutes)), "allDay": False,
                                              "allow_past": True, "allow_duplicate": True}, user["token"])
        return task.get("id") if isinstance(task, dict) else None

    # two tasks whose names differ only at the end, and enough overdue ones for a second page (BOT-9)
    twin1 = make(f"{TAG} Позвонить клиенту по оплате счёта №101 и уточнить сроки", now - timedelta(hours=40))
    twin2 = make(f"{TAG} Позвонить клиенту по оплате счёта №102 и уточнить сроки", now - timedelta(hours=39))
    extra = [make(f"{TAG} list-{i}", now - timedelta(hours=30 + i)) for i in range(8)]
    check("tasks for the list created", twin1 and twin2 and all(extra), (twin1, twin2, extra))
    send_text(A["chat"], "/tasks")
    lst = reply(A["chat"], "Просрочено")
    labels = [b["text"] for b in buttons_of(lst) if b["callback_data"].startswith("tk:")]
    check("/tasks: numbered task buttons with the time, at most 60 characters, all different (BOT-9)",
          lst is not None and len(labels) == 8 and all(len(t) <= 60 for t in labels) and len(set(labels)) == len(labels)
          and labels[0].startswith("1. ") and any(":" in t for t in labels), labels)
    more = button(lst, "tp:")
    check("/tasks: more than a page -> 'Ещё' button", more == "tp:1", buttons_of(lst))
    if more:
        press(A["chat"], more, lst["message_id"])
        page = tg_wait(lambda e: e["method"] == "editMessageReplyMarkup" and e["message_id"] == lst["message_id"], 15)
        nums = [b["text"].split(".")[0] for b in buttons_of(page) if b["callback_data"].startswith("tk:")]
        check("'Ещё' shows the next tasks (9., 10., …) and 'Назад'", page is not None and nums and nums[0] == "9" and button(page, "tp:0"), page)

    # the card
    press(A["chat"], f"tk:{twin1}", lst["message_id"] if lst else 1)
    card = reply(A["chat"], "Позвонить клиенту по оплате счёта №101")
    check("a task button opens its card: client, time with the weekday, buttons done / move / edit, no delete without the right",
          card is not None and "клиент" in card["text"] and button(card, f"dn:{twin1}") and button(card, f"mv:{twin1}")
          and button(card, f"ed:{twin1}") and not button(card, "dl:"), card)
    unmoved = task_row(twin1)
    press(B["chat"], f"mh:{twin1}", 1)
    ans = tg_wait(lambda e: e["method"] == "answerCallbackQuery", 15)
    check("B cannot move A's task", ans is not None and "Нет прав" in (ans["text"] or "") and task_row(twin1) == unmoved, (ans, unmoved))

    # «Перенести» -> +1 час, then «Вернуть как было» (BOT-1)
    before = task_row(twin1).split("|")[0]
    press(A["chat"], f"mv:{twin1}", card["message_id"])
    menu = tg_wait(lambda e: e["method"] == "editMessageReplyMarkup" and e["message_id"] == card["message_id"], 15)
    check("'Перенести': +1 час, завтра 10:00, своя дата", menu is not None and button(menu, "mh:") and button(menu, "mt:") and button(menu, "mc:"), menu)
    press(A["chat"], f"mh:{twin1}", card["message_id"])
    moved = reply(A["chat"], "Задача перенесена")
    after = task_row(twin1).split("|")[0]
    expected = datetime.fromtimestamp(math.ceil((time.time() + 3600) / 300) * 300, KAR)
    check("+1 час: a task whose time has passed goes to an hour from now; the answer has the old and the new time and 'Вернуть'",
          moved is not None and button(moved, "ub:") and after != before
          and abs((datetime.strptime(after, "%Y-%m-%d %H:%M").replace(tzinfo=KAR) - expected).total_seconds()) <= 600, (moved, before, after))
    if moved and button(moved, "ub:"):
        press(A["chat"], button(moved, "ub:"), moved["message_id"])
        tg_wait(lambda e: e["method"] == "editMessageText" and "Вернул" in (e.get("text") or ""), 15)
        check("'Вернуть как было' puts the old time back", task_row(twin1).split("|")[0] == before, (before, task_row(twin1)))
    press(A["chat"], f"mt:{twin1}", card["message_id"])
    reply(A["chat"], "Задача перенесена")
    tomorrow = (datetime.now(KAR) + timedelta(days=1)).strftime("%Y-%m-%d")
    check("'Завтра 10:00' moves the task to tomorrow 10:00", task_row(twin1).split("|")[0] == f"{tomorrow} 10:00", task_row(twin1))
    ev = psql(f"select count(*) from event where type = 17 and task_id = {twin1} and after_state->'data'->>'via' = 'bot'")
    check("the moves are in the task's history as made in the bot", ev not in ("", "0"), ev)

    # «Своя дата»: typed date, confirmation with the weekday (BOT-1, BOT-13)
    press(A["chat"], f"mc:{twin1}", card["message_id"])
    check("'Своя дата' asks for the date", reply(A["chat"], "Новые дата и время") is not None)
    send_text(A["chat"], "послезавтра 15:30")
    conf = confirm_message(A["chat"])
    day2 = datetime.now(KAR) + timedelta(days=2)
    weekday = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"][day2.weekday()]
    check("the typed date becomes a confirmation 'было → стало' with the weekday",
          conf is not None and f"{weekday} {day2.strftime('%d.%m.%Y')} 15:30" in conf["text"] and "→" in conf["text"], conf)
    if conf:
        press(A["chat"], button(conf, "ok:"), conf["message_id"])
        tg_wait(lambda e: e["method"] == "editMessageText" and "Задача изменена" in (e.get("text") or ""), 15)
    check("confirmed: the task is on the new date", task_row(twin1).split("|")[0] == f"{day2.strftime('%Y-%m-%d')} 15:30", task_row(twin1))
    press(A["chat"], f"mc:{twin1}", card["message_id"])
    reply(A["chat"], "Новые дата и время")
    send_text(A["chat"], "когда-нибудь потом")
    check("a text that is not a date: the bot says so and waits", reply(A["chat"], "Не понял дату") is not None)
    press(A["chat"], f"ax:{twin1}", 1)
    tg_wait(lambda e: e["method"] == "answerCallbackQuery", 15)
    check("'Не переносить' ends it: the next text goes to the assistant", ask(A["chat"], "привет") is not None)

    # «Изменить» -> «Текст» (BOT-1)
    press(A["chat"], f"ed:{twin1}", card["message_id"])
    menu = tg_wait(lambda e: e["method"] == "editMessageReplyMarkup" and e["message_id"] == card["message_id"], 15)
    check("'Изменить': text, date and time, back", menu is not None and button(menu, "et:") and button(menu, "mc:") and button(menu, "bk:"), menu)
    press(A["chat"], f"et:{twin1}", card["message_id"])
    reply(A["chat"], "новый текст")
    send_text(A["chat"], f"{TAG} Позвонить по оплате, новый текст")
    conf = confirm_message(A["chat"])
    if conf:
        press(A["chat"], button(conf, "ok:"), conf["message_id"])
        tg_wait(lambda e: e["method"] == "editMessageText" and "Задача изменена" in (e.get("text") or ""), 15)
    check("the new text is saved after the confirmation", task_row(twin1).split("|")[2] == f"{TAG} Позвонить по оплате, новый текст", task_row(twin1))

    # «Удалить» with a confirmation, only with the right (BOT-1)
    press(A["chat"], f"dl:{twin2}", 1)
    ans = tg_wait(lambda e: e["method"] == "answerCallbackQuery", 15)
    check("without the right to delete tasks: 'Удалить' is refused", ans is not None and "Нет прав" in (ans["text"] or "") and task_row(twin2), ans)
    set_perm(A, "task,delete", 1)
    try:
        press(A["chat"], f"tk:{twin2}", 1)
        card2 = reply(A["chat"], "№102")
        check("with the right the card has 'Удалить'", card2 is not None and button(card2, f"dl:{twin2}"), card2)
        press(A["chat"], f"dl:{twin2}", card2["message_id"] if card2 else 1)
        conf = confirm_message(A["chat"])
        check("'Удалить' asks first and saves nothing yet", conf is not None and "Удалить задачу" in conf["text"] and task_row(twin2), conf)
        if conf:
            press(A["chat"], button(conf, "ok:"), conf["message_id"])
            tg_wait(lambda e: e["method"] == "editMessageText" and "удалена" in (e.get("text") or ""), 15)
        check("confirmed: the task is deleted", psql(f"select count(*) from task where id = {twin2}") == "0")
    finally:
        set_perm(A, "task,delete", 0)

    # «Выполнено» -> «Закрыть без итога» (BOT-3)
    press(A["chat"], f"dn:{extra[0]}", 1)
    asked = reply(A["chat"], "Напишите итог")
    press(A["chat"], f"ax:{extra[0]}", asked["message_id"] if asked else 1)
    tg_wait(lambda e: e["method"] == "answerCallbackQuery", 15)
    check("'Не закрывать' leaves the task open", task_row(extra[0]).endswith("|t"), task_row(extra[0]))
    press(A["chat"], f"dn:{extra[0]}", 1)
    asked = reply(A["chat"], "Напишите итог")
    press(A["chat"], f"dc:{extra[0]}", asked["message_id"] if asked else 1)
    tg_wait(lambda e: e["method"] == "answerCallbackQuery", 15)
    check("'Закрыть без итога' closes it with 'Выполнено (отмечено в Telegram)'",
          psql(f"select result from task where id = {extra[0]}") == "Выполнено (отмечено в Telegram)")

    print("== tasks through the assistant: personal, on a contact, to a colleague, on a colleague's deal")
    day = (datetime.now(KAR) + timedelta(days=4)).strftime("%Y-%m-%d")
    e = ask(A["chat"], f'[[tool prepare_task {{"title": "{TAG} личный отчёт", "date": "{day}", "time": "09:30"}}]]')
    conf = confirm_message(A["chat"])
    check("a personal task without a client is prepared (BOT-12)", conf is not None and "личная задача" in conf["text"], (e, conf))
    if conf:
        press(A["chat"], button(conf, "ok:"), conf["message_id"])
        tg_wait(lambda e: e["method"] == "editMessageText" and "Задача создана" in (e.get("text") or ""), 15)
    row = psql(f"select agent_id, deal_id is null and company_id is null and ctr_agent_id is null from task where label = '{TAG} личный отчёт'")
    check("... and created for A, linked to nothing", row == f"{A['id']}|t", row)
    contact = psql(f"insert into \"user\" (username, role, company_id) values ('{TAG} контакт', 'ctr_agent', {company_id}) returning id").split("\n")[0]
    e = ask(A["chat"], f'[[tool prepare_task {{"title": "{TAG} контакт-задача", "date": "{day}", "time": "10:00", "contact_id": {contact}}}]]')
    conf = confirm_message(A["chat"])
    if conf:
        press(A["chat"], button(conf, "ok:"), conf["message_id"])
        tg_wait(lambda e: e["method"] == "editMessageText" and "Задача создана" in (e.get("text") or ""), 15)
    check("a task on a contact person (BOT-12)", psql(f"select ctr_agent_id from task where label = '{TAG} контакт-задача'") == contact, (e, conf))

    e = ask(A["chat"], f'[[tool prepare_task {{"title": "{TAG} коллеге", "date": "{day}", "time": "11:00", "assignee_user_id": {B["id"]}}}]]')
    check("A (tasks: own) cannot give a task to B: the web's rule (BOT-11)", e is not None and "Задачу можно поставить только" in e["text"], e)
    set_perm(A, "task,update", 3)
    set_perm(A, "deal,update", 3)
    set_perm(A, "deal,view", 3)
    try:
        e = ask(A["chat"], f'[[tool prepare_task {{"title": "{TAG} коллеге", "date": "{day}", "time": "11:00", "assignee_user_id": {B["id"]}}}]]')
        conf = confirm_message(A["chat"])
        check("with the right: the confirmation names the colleague (BOT-11)", conf is not None and f"Исполнитель: {B['username']}" in conf["text"], (e, conf))
        if conf:
            press(A["chat"], button(conf, "ok:"), conf["message_id"])
            told = reply(B["chat"], "поручил(а) вам задачу")
            check("B gets the task in the bot with its buttons", told is not None and f"{TAG} коллеге" in told["text"] and button(told, "dn:"), told)
        check("... saved for B", psql(f"select agent_id from task where label = '{TAG} коллеге'") == str(B["id"]))
        # a task on B's deal: the confirmation names B as the responsible, one press gives it to B (BOT-10)
        e = ask(A["chat"], f'[[tool prepare_task {{"title": "{TAG} по сделке B", "date": "{day}", "time": "12:00", "deal_id": {deal_b}}}]]')
        conf = confirm_message(A["chat"])
        check("a task on a colleague's deal shows its responsible and 'Поручить ответственному'",
              conf is not None and f"Ответственный по сделке: {B['username']}" in conf["text"] and button(conf, "rs:"), (e, conf))
        if conf:
            press(A["chat"], button(conf, "rs:"), conf["message_id"])
            edited = tg_wait(lambda e: e["method"] == "editMessageText" and e["message_id"] == conf["message_id"], 15)
            check("'Поручить ответственному' makes B the assignee", edited is not None and f"Исполнитель: {B['username']}" in edited["text"], edited)
            press(A["chat"], button(conf, "no:"), conf["message_id"])
            tg_wait(lambda e: e["method"] == "answerCallbackQuery", 15)
    finally:
        set_perm(A, "task,update", 1)
        set_perm(A, "deal,update", 1)
        set_perm(A, "deal,view", 1)

    # limit 2: the fake assistant cuts a tool result at 1500 characters (local/fake-claude/claude), and A's
    # overdue list (the list-N tasks above) is longer than that, so the cut JSON would not parse
    e = ask(A["chat"], f'[[tool list_tasks {{"period": "overdue", "limit": 2}}]]')
    tasks = tool_result(e, "list_tasks")
    target = extra[1]
    e = ask(A["chat"], f'[[tool prepare_update_task {{"task_id": {target}, "time": "16:45"}}]]')
    conf = confirm_message(A["chat"])
    check("prepare_update_task: a new time for confirmation (it was 'Нет такого инструмента')",
          isinstance(tasks, dict) and len(tasks.get("tasks") or []) == 2 and all(t.get("overdue") for t in tasks["tasks"])
          and conf is not None and "16:45" in conf["text"] and "→" in conf["text"], (tasks if not isinstance(tasks, dict) else "", e, conf))
    e = ask(A["chat"], f'[[tool prepare_close_task {{"task_id": {target}, "result": "сделано"}}]]')
    conf = confirm_message(A["chat"])
    check("the close confirmation names the client and the time (BOT-13)", conf is not None and "клиент" in conf["text"] and "Итог: сделано" in conf["text"], conf)


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
