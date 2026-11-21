#!/usr/bin/env python3
"""Checks for the Telegram channel of the CRM (block 5): the receiver of parisahon-telegram-service
(POST /telegram/incoming) and the rights on /telegram/* for people.

Runs against the local stack: the docker stack (http://localhost:8080) or, with the CRM_*
variables from local/dev/env.sh, the dev copy on the server. Needs TELEGRAM_SERVICE_TOKEN in the
API env file (CRM_ENV_FILE / parisahon-api/.env). The Telegram service itself is not needed:
when it is not running, the checks that reach it accept 503.
Usage: py local/checks/telegram_check.py      (exit code 1 on any FAIL)
Everything it creates is named AUDIT-tg-<run> and removed at the end.
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
EXTERNAL_BASE = os.environ.get("CRM_API_EXTERNAL_URL", BASE).rstrip("/")
ENV_FILE = os.environ.get("CRM_ENV_FILE") or os.path.join(ROOT, "parisahon-api", ".env")
COMPOSE_FILE = os.path.join(ROOT, "docker-compose.local.yml")
PSQL = (shlex.split(os.environ["CRM_PSQL"]) if os.environ.get("CRM_PSQL") else
        ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])

RUN = secrets.token_hex(3)
TAG = f"AUDIT-tg-{RUN}"
results = {"PASS": 0, "FAIL": 0}

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def check(name, ok, detail=""):
    results["PASS" if ok else "FAIL"] += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {str(detail)[:400]}" if detail and not ok else ""), flush=True)
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


def http(method, url, body=None, token=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, method=method, data=data, headers={"Content-Type": "application/json", **(headers or {})})
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for attempt in range(40):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                text = r.read()
                return r.status, json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            text = e.read()
            if e.code in (502, 504) and attempt < 39 and "nginx" in text.decode(errors="replace").lower():
                time.sleep(3)
                continue
            try:
                return e.code, json.loads(text)
            except Exception:
                return e.code, text.decode(errors="replace")
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            if attempt == 39:
                raise SystemExit(f"API is not reachable at {url}")
            time.sleep(3)


def api(method, path, body=None, token=None, headers=None):
    return http(method, BASE + path, body, token, headers)


def message_of(answer):
    body = answer[1]
    if isinstance(body, dict):
        m = body.get("message")
        return " ".join(m) if isinstance(m, list) else str(m)
    return str(body)


def main():
    token = env_value("TELEGRAM_SERVICE_TOKEN")
    if not token or len(token) < 16:
        raise SystemExit(f"TELEGRAM_SERVICE_TOKEN (16+ characters) is not set in {ENV_FILE}")
    service_headers = {"X-Telegram-Service-Token": token}
    # where a deal from a channel lands: the stage chosen in settings, else "Неразобранное" of the active funnel
    default_stage = psql("select s.name from setting st join deal_stage s on s.id = st.default_stage_id order by st.id desc limit 1") \
        or env_value("DEAL_STAGE_UNKNOWN", "НЕРАЗОБРАННОЕ")

    status, body = api("POST", "/auth/login", {"email": "admin@gmail.com", "password": env_value("ADMIN_PASSWORD")})
    if status != 201 and status != 200:
        raise SystemExit(f"admin login failed: {status}")
    admin = body["access_token"]
    admin_id = int(psql("select id from \"user\" where email = 'admin@gmail.com' and role = 'admin' order by id limit 1"))
    groups = sorted(g["id"] for g in api("GET", "/groups", token=admin)[1])
    perms = {"deal": {"view": 1, "create": 3, "update": 1, "delete": 0, "export": 0},
             "contact": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
             "company": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
             "task": {"update": 1, "delete": 0}, "mail": True, "file": True}

    users = {}
    try:
        print("== setup")
        for key in ("a", "b"):
            person = {"email": f"audit-tg-{RUN}-{key}@example.test", "password": secrets.token_urlsafe(12),
                      "username": f"{TAG}-{key}", "role": "agent", "group_id": groups[0], "permissions": perms,
                      "phone": f"+99890{random.randint(1000000, 9999999)}"}
            status, created = api("POST", "/users", person, admin)
            if status != 201:
                raise SystemExit(f"cannot create user {key}: {status} {created}")
            person["id"] = created["id"]
            person["token"] = api("POST", "/auth/login", {"email": person["email"], "password": person["password"]})[1]["access_token"]
            person["tg"] = 6_000_000_000 + random.randint(1, 900_000_000)
            users[key] = person
        A, B = users["a"], users["b"]
        client_tg = 7_000_000_000 + random.randint(1, 900_000_000)
        client_phone_digits = f"99893{random.randint(1000000, 9999999)}"

        def incoming(agent, msg_id, text="", outgoing=False, chat=None, files=None, **extra):
            payload = {"agent_id": agent["id"], "agent_tg_id": agent["tg"],
                       "chat": chat or {"tg_id": client_tg, "phone": "+" + client_phone_digits, "first_name": TAG, "last_name": "Клиент", "username": "audit_client"},
                       "tg_message_id": msg_id, "text": text, "outgoing": outgoing,
                       "date": "2026-11-18T10:00:00+05:00", "files": files or []}
            payload.update(extra)
            return api("POST", "/telegram/incoming", payload, headers=service_headers)

        print("== receiver: token")
        status, _ = http("POST", EXTERNAL_BASE + "/telegram/incoming", {"agent_id": A["id"]})
        check("POST /telegram/incoming without the token -> 401", status == 401, status)
        status, _ = api("POST", "/telegram/incoming", {"agent_id": A["id"]}, headers={"X-Telegram-Service-Token": "x" * len(token)})
        check("POST /telegram/incoming with a wrong token -> 401", status == 401, status)
        status, _ = api("POST", "/telegram/incoming", {"agent_id": A["id"]}, token=admin)
        check("a CRM login token is not enough -> 401", status == 401, status)
        status, _ = api("POST", "/telegram/incoming", {"agent_id": A["id"]}, headers={"Authorization": "Bearer " + token})
        check("the token in Authorization: Bearer is accepted (then validation: 400)", status == 400, status)

        print("== receiver: first message of a new client")
        r = incoming(A, 1001, "Здравствуйте, нужен текстиль")
        check("new chat -> 201, saved, contact and deal created", r[0] == 201 and r[1].get("status") == "saved"
              and r[1].get("created_contact") is True and r[1].get("created_deal") is True, r)
        contact_id = r[1].get("contact_id") if r[0] == 201 else None
        deal_ids = r[1].get("deal_ids") if r[0] == 201 else []
        deal_id = deal_ids[0] if deal_ids else None
        row = psql(f"select username, role, tg_id, phone, created_by, company_id from \"user\" where id = {contact_id}") if contact_id else ""
        check("contact: ctr_agent with the name, Telegram id, normalized phone, created by the manager, no company",
              row == f"{TAG} Клиент|ctr_agent|{client_tg}|+{client_phone_digits}|{A['id']}|", row)
        row = psql(f"select d.agent_id, s.name, d.closed_at is null, d.label = '{TAG} Клиент · +{client_phone_digits}', (select count(*) from deal_user du where du.\"dealId\" = d.id and du.\"userId\" = {contact_id}), "
                   f"(select count(*) from deal_stage_record r where r.deal_id = d.id) from deal d join deal_stage s on s.id = d.stage_id where d.id = {deal_id}") if deal_id else ""
        check("deal: of the manager, in the default stage, open, named 'client · phone', linked to the contact, one stage record",
              row == f"{A['id']}|{default_stage}|t|t|1|1", row)
        row = psql(f"select outgoing, user_id, target_user_id, tg_message_id, after_state->>'message', after_state->>'from_user_id', after_state->>'to_user_id', to_char(created_at, 'YYYY-MM-DD HH24:MI') "
                   f"from event where deal_id = {deal_id} and type = 12") if deal_id else ""
        check("history: one Telegram event, incoming, from the contact to the manager, with the Telegram message id and date",
              row == f"f|{contact_id}|{A['id']}|1001|Здравствуйте, нужен текстиль|{contact_id}|{A['id']}|2026-11-18 10:00", row)
        n = psql(f"select count(*) from event where deal_id = {deal_id} and type in (0, 1)") if deal_id else "0"
        check("the CRM's own events of a new deal (NEW_DEAL, NEW_CTR_AGENT) are written too", n == "2", n)
        row = psql(f"select tg_id from \"user\" where id = {A['id']}")
        check("the manager's Telegram id is stored on the user", row == str(A["tg"]), row)

        print("== receiver: more messages")
        r = incoming(A, 1001, "Здравствуйте, нужен текстиль")
        n = psql(f"select count(*) from event where deal_id = {deal_id} and type = 12")
        check("the same Telegram message again -> duplicate, nothing added", r[1].get("status") == "duplicate" and n == "1", (r, n))
        r = incoming(A, 1002, "Ещё вопрос")
        check("second message -> the same deal, no new contact or deal", r[1].get("status") == "saved" and r[1].get("deal_ids") == [deal_id]
              and not r[1].get("created_contact") and not r[1].get("created_deal"), r)
        r = incoming(A, 1003, "Добрый день! Сейчас пришлю прайс", outgoing=True)
        row = psql(f"select outgoing, user_id, target_user_id from event where deal_id = {deal_id} and tg_message_id = 1003")
        check("a message the manager sent from the phone -> outgoing, from the manager to the contact", row == f"t|{A['id']}|{contact_id}", row)
        r = incoming(A, 1004, "", files=[{"name": "price.pdf", "path": f"document_{RUN}.pdf", "type": "document", "caption": "прайс"}])
        row = psql(f"select f.name, f.path, f.extension, f.\"from\", f.uploaded_by, (select count(*) from deal_file df where df.\"fileId\" = f.id and df.\"dealId\" = {deal_id}) "
                   f"from file f where f.path = 'document_{RUN}.pdf'")
        check("a file -> file row from messages, linked to the deal, uploaded by the contact", row == f"price.pdf|document_{RUN}.pdf|.pdf|from_messages|{contact_id}|1", row)
        row = psql(f"select after_state->'files'->0->>'name', after_state->'files'->0->>'type' from event where deal_id = {deal_id} and tg_message_id = 1004")
        check("the file is in the event too", row == "price.pdf|document", row)
        n = psql(f"select count(*) from event where deal_id = {deal_id} and type = 12")
        check("four Telegram events in the deal", n == "4", n)

        print("== receiver: matching and special cases")
        known_phone = f"99897{random.randint(1000000, 9999999)}"
        known_id = int(psql(f"insert into \"user\" (username, role, phone) values ('{TAG} известный', 'ctr_agent', '+998 {known_phone[3:5]} {known_phone[5:8]}-{known_phone[8:10]}-{known_phone[10:]}') returning id"))
        known_tg = 7_000_000_000 + random.randint(1, 900_000_000)
        r = incoming(A, 2001, "Это я", chat={"tg_id": known_tg, "phone": "+" + known_phone, "first_name": "Другой", "last_name": "Текст"})
        row = psql(f"select tg_id from \"user\" where id = {known_id}")
        check("a client known by phone (typed with spaces and dashes) is matched, not duplicated; Telegram id stored",
              r[1].get("contact_id") == known_id and not r[1].get("created_contact") and row == str(known_tg), (r, row))
        r = incoming(A, 2002, "Без телефона", chat={"tg_id": known_tg, "first_name": "Другой"})
        check("next time the same client is found by Telegram id alone", r[1].get("contact_id") == known_id, r)
        r = incoming(A, 3001, "себе", chat={"tg_id": A["tg"], "first_name": "Я"})
        check("a chat with the manager's own account is ignored", r[0] == 201 and r[1].get("status") == "ignored" and r[1].get("reason") == "self", r)
        r = incoming(B, 4001, "Пишу второму менеджеру")
        check("the same client writes to manager B -> no second deal: the client's open deal (A's) gets it", r[1].get("status") == "saved" and r[1].get("contact_id") == contact_id
              and not r[1].get("created_deal") and r[1].get("deal_ids") == [deal_id], r)
        psql(f"update deal set closed_at = now() where id = {deal_id}")
        r = incoming(A, 1005, "Новый заказ")
        check("after the deal is closed a new message opens a new deal", r[1].get("created_deal") is True and r[1].get("deal_ids") != [deal_id], r)
        new_deal = r[1]["deal_ids"][0]
        row = psql(f"select repeat_of_id from deal where id = {new_deal}")
        check("the new deal is a repeat request of the client's previous deal", row == str(deal_id), row)
        st, hist = api("GET", f"/deals/{new_deal}/client-history", token=admin)
        check("GET /deals/:id/client-history: the client, the repeat link and the previous deal",
              st == 200 and (hist.get("repeat_of") or {}).get("id") == deal_id and any(d.get("id") == deal_id for d in hist.get("deals", []))
              and hist.get("contacts", [{}])[0].get("id") == contact_id, (st, hist))
        r = incoming({"id": 999999999, "tg": 1}, 5001, "x")
        check("unknown manager -> 404", r[0] == 404, r)
        r = api("POST", "/telegram/incoming", {"agent_id": A["id"], "tg_message_id": 1, "outgoing": False}, headers=service_headers)
        check("payload without chat -> 400", r[0] == 400, r)
        r = incoming(A, 6001, "x", chat={"tg_id": "abc"})
        check("chat.tg_id must be a number -> 400", r[0] == 400, r)

        print("== the deal history through the API")
        status, events = api("GET", f"/deals/{deal_id}/events?page=1&limit=50", token=admin)
        items = events.get("data", events) if isinstance(events, dict) else events
        tg = [e for e in (items or []) if e.get("type") == 12] if isinstance(items, list) else []
        check("GET /deals/:id/events lists the Telegram messages (4 to A, 1 that the client wrote to B)", status == 200 and len(tg) == 5, (status, len(tg)))
        first = next((e for e in tg if e.get("tg_message_id") in (1001, "1001")), None) or (tg[-1] if tg else {})
        check("an incoming message shows the contact as its author and the manager as the target",
              first.get("originated_by", {}).get("id") == contact_id and (first.get("target_user") or {}).get("id") == A["id"], first)
        status, me_events = api("GET", f"/deals/{deal_id}/events?page=1&limit=50", token=A["token"])
        check("the manager sees the history of their own deal", status == 200, status)

        print("== moving a message to another deal (PATCH /deals/events/remap)")
        ev_file = int(psql(f"select id from event where deal_id = {deal_id} and tg_message_id = 1004"))
        ev_new_deal = int(psql(f"select id from event where deal_id = {deal_id} and type = 0 limit 1"))
        r = api("PATCH", "/deals/events/remap", {"event_id": ev_file, "replace_with_deal_id": new_deal}, token=B["token"])
        check("another agent (deal update = own deals) cannot move a message of someone else's deal -> 403", r[0] == 403, r)
        r = api("PATCH", "/deals/events/remap", {"event_id": ev_new_deal, "replace_with_deal_id": new_deal}, token=A["token"])
        check("only emails and Telegram messages can be moved -> 400", r[0] == 400, r)
        r = api("PATCH", "/deals/events/remap", {"event_id": ev_file, "replace_with_deal_id": 999999999}, token=A["token"])
        check("to a deal that does not exist -> 404", r[0] == 404, r)
        r = api("PATCH", "/deals/events/remap", {"event_id": ev_file, "replace_with_deal_id": new_deal}, token=A["token"])
        row = psql(f"select deal_id from event where id = {ev_file}")
        check("the manager moves a message with a file to their other deal -> 200, the event is in that deal", r[0] == 200 and row == str(new_deal), (r, row))
        row = psql(f"select string_agg(df.\"dealId\"::text, ',') from file f join deal_file df on df.\"fileId\" = f.id where f.path = 'document_{RUN}.pdf'")
        check("the file of the message moved with it (linked to the new deal only)", row == str(new_deal), row)
        status, events = api("GET", f"/deals/{new_deal}/events?page=1&limit=50", token=A["token"])
        items = events.get("data", []) if isinstance(events, dict) else []
        check("the moved message shows in the history of the new deal", any(e.get("id") == ev_file for e in items), status)
        r = api("PATCH", "/deals/events/remap", {"event_id": ev_file, "replace_with_deal_id": deal_id}, token=admin)
        row = psql(f"select deal_id from event where id = {ev_file}")
        check("admin moves it back -> 200", r[0] == 200 and row == str(deal_id), (r, row))

        print("== people: rights on /telegram/*")
        r = api("POST", "/telegram/send-code", {"user_id": A["id"]}, token=B["token"])
        check("send-code for another user's account as an agent -> 403", r[0] == 403, r)
        r = api("POST", "/telegram/send-code", {}, token=A["token"])
        check("send-code for the own account passes the rights check (503: keys / service not configured on this copy)", r[0] in (503, 200, 400), r)
        r = api("POST", "/telegram/send-code", {"user_id": A["id"]}, token=admin)
        check("admin may connect another user's account (passes the rights check)", r[0] in (503, 200, 400), r)
        r = api("POST", "/telegram/send-code", {"user_id": contact_id}, token=admin)
        check("a contact is not an account to connect -> 400/403", r[0] in (400, 403), r)
        r = api("POST", "/telegram/activate-auth", {"user_id": A["id"], "code": "12345"}, token=B["token"])
        check("activate-auth for another user's account -> 403", r[0] == 403, r)
        r = api("POST", "/telegram/activate-auth", {"user_id": A["id"]}, token=A["token"])
        check("activate-auth without a code -> 400", r[0] == 400, r)
        r = api("POST", "/telegram/send-message", {"from_user": str(A["id"]), "to_user": str(contact_id), "message": "x"}, token=B["token"])
        check("send-message as somebody else -> 403", r[0] == 403, r)
        r = api("POST", "/telegram/send-message", {"from_user": str(A["id"]), "to_user": str(B["id"]), "message": "x"}, token=A["token"])
        check("send-message to a staff user -> 400", r[0] == 400, r)
        r = api("POST", "/telegram/send-message", {"from_user": str(A["id"]), "to_user": str(known_id), "message": "x"}, token=B["token"])
        check("send-message to a client without a common open deal, as the wrong user -> 403 first", r[0] == 403, r)
        r = api("POST", "/telegram/send-message", {"from_user": str(B["id"]), "to_user": str(known_id), "message": "x"}, token=B["token"])
        check("send-message to a client without a common open deal -> 400", r[0] == 400 and "сделки" in message_of(r), r)
        r = api("POST", "/telegram/send-message", {"from_user": str(A["id"]), "to_user": str(contact_id), "message": "Привет"}, token=A["token"])
        check("send-message with an open deal reaches the Telegram service: 400 'нет подключённого Telegram' from the dev service or 503 without one",
              (r[0] == 400 and "Telegram" in message_of(r)) or r[0] == 503, r)
        n = psql(f"select count(*) from event where deal_id = {new_deal} and type = 12 and outgoing")
        check("a message Telegram did not accept is not written to the history", n == "0", n)
        r = api("GET", "/telegram/active-sessions", token=A["token"])
        check("GET /telegram/active-sessions answers (list, or 503 without the service)", (r[0] == 200 and isinstance(r[1], list)) or r[0] == 503, r)

    finally:
        print("== cleanup")
        ids = ",".join(str(u["id"]) for u in users.values()) or "0"
        contacts = f"select id from \"user\" where username like '{TAG}%' and role = 'ctr_agent'"
        deals = f"select id from deal where agent_id in ({ids}) or id in (select \"dealId\" from deal_user where \"userId\" in ({contacts}))"
        psql(";".join([
            "begin",
            f"delete from event where deal_id in ({deals}) or user_id in ({ids}) or user_id in ({contacts}) or target_user_id in ({contacts}) or target_user_id in ({ids})",
            f"delete from deal_file where \"dealId\" in ({deals})",
            f"delete from file where uploaded_by in ({contacts}) or uploaded_by in ({ids}) or path like 'document_{RUN}.pdf'",
            f"delete from deal_stage_record where deal_id in ({deals})",
            f"delete from deal_user where \"dealId\" in ({deals})",
            f"delete from deal where id in ({deals})",
            f"delete from \"user\" where id in ({contacts})",
            f"delete from \"user\" where id in ({ids})",
            "commit",
        ]))
        left = psql(f"select (select count(*) from \"user\" where username like '{TAG}%') + (select count(*) from deal where agent_id in ({ids}))")
        check("test rows removed", left == "0", left)

    print(f"\nRESULT: {results['PASS']} passed, {results['FAIL']} failed")
    return 1 if results["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
