#!/usr/bin/env python3
"""WhatsApp of the managers (parisahon-api/src/whatsapp, parisahon-whatsapp-service).
    local/dev/check.sh whatsapp      (or: source local/dev/env.sh; python3 local/checks/whatsapp_check.py)
Every row it creates is named AUDIT-wa-<run> (contacts, users, deals by its agents) and removed at the end.
"""
import json
import os
import random
import re
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
TAG = f"AUDIT-wa-{RUN}"
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


def multipart(path, fields, files, token):
    boundary = "----audit" + secrets.token_hex(8)
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    for name, content in files:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{name}"\r\nContent-Type: text/plain\r\n\r\n'.encode() + content + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(BASE + path, method="POST", data=b"".join(parts),
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read()
            return r.status, json.loads(t) if t else None
    except urllib.error.HTTPError as e:
        t = e.read()
        try:
            return e.code, json.loads(t)
        except Exception:
            return e.code, t.decode(errors="replace")


def main():
    """WhatsApp of the managers: POST /whatsapp/incoming (service token), connect / status / send (people)."""
    token = env_value("WHATSAPP_SERVICE_TOKEN")
    if not token or len(token) < 16:
        raise SystemExit(f"WHATSAPP_SERVICE_TOKEN (16+ characters) is not set in {ENV_FILE}")
    headers = {"X-WhatsApp-Service-Token": token}
    status, body = api("POST", "/auth/login", {"email": "admin@gmail.com", "password": env_value("ADMIN_PASSWORD")})
    if status not in (200, 201):
        raise SystemExit(f"admin login failed: {status}")
    admin = body["access_token"]
    groups = sorted(g["id"] for g in api("GET", "/groups", token=admin)[1])
    perms = {"deal": {"view": 1, "create": 3, "update": 1, "delete": 0, "export": 0},
             "contact": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
             "company": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
             "task": {"update": 1, "delete": 0}, "mail": True, "file": True}
    users = {}
    try:
        print("== setup")
        for key in ("a", "b", "c"):
            person = {"email": f"audit-wa-{RUN}-{key}@example.test", "password": secrets.token_urlsafe(12),
                      "username": f"{TAG}-{key}", "role": "agent", "group_id": groups[0], "permissions": perms,
                      "phone": f"+99890{random.randint(1000000, 9999999)}"}
            status, created = api("POST", "/users", person, admin)
            if status != 201:
                raise SystemExit(f"cannot create user {key}: {status} {created}")
            person["id"] = created["id"]
            person["token"] = api("POST", "/auth/login", {"email": person["email"], "password": person["password"]})[1]["access_token"]
            users[key] = person
        A, B, C = users["a"], users["b"], users["c"]
        digits = f"99893{random.randint(1000000, 9999999)}"
        lid = f"{random.randint(10**13, 10**14)}@lid"

        def incoming(agent, msg_id, text="", outgoing=False, chat=None, files=None, **extra):
            payload = {"agent_id": agent["id"], "agent_phone": agent["phone"],
                       "chat": chat or {"wa_id": f"{digits}@s.whatsapp.net", "phone": "+" + digits, "name": f"{TAG} Клиент"},
                       "wa_message_id": msg_id, "text": text, "outgoing": outgoing,
                       "date": "2026-11-19T10:00:00+05:00", "files": files or []}
            payload.update(extra)
            return api("POST", "/whatsapp/incoming", payload, headers=headers)

        print("== receiver: token")
        st, _ = http("POST", EXTERNAL_BASE + "/whatsapp/incoming", {"agent_id": A["id"]})
        check("POST /whatsapp/incoming without the token -> 401", st == 401, st)
        st, _ = api("POST", "/whatsapp/incoming", {"agent_id": A["id"]}, headers={"X-WhatsApp-Service-Token": "x" * len(token)})
        check("with a wrong token -> 401", st == 401, st)
        st, _ = api("POST", "/whatsapp/incoming", {"agent_id": A["id"]}, token=admin)
        check("a CRM login is not enough -> 401", st == 401, st)
        st, _ = api("POST", "/whatsapp/incoming", {"agent_id": A["id"]}, headers=headers)
        check("token accepted, then validation -> 400", st == 400, st)

        print("== receiver: first message of a new client")
        r = incoming(A, f"WA{RUN}1", "Assalomu alaykum, narx qancha?")
        ok = r[0] == 201 and r[1].get("status") == "saved" and r[1].get("created_contact") and r[1].get("created_deal")
        check("new chat -> 201, saved, contact and deal created", ok, r)
        contact_id = r[1].get("contact_id") if ok else None
        deal_id = (r[1].get("deal_ids") or [None])[0] if ok else None
        row = psql(f"select username, role, phone, wa_id, created_by from \"user\" where id = {contact_id}") if contact_id else ""
        check("contact: name from WhatsApp, ctr_agent, phone, chat id, created by the manager",
              row == f"{TAG} Клиент|ctr_agent|+{digits}|{digits}@s.whatsapp.net|{A['id']}", row)
        row = psql(f"select d.agent_id, d.label from deal d where d.id = {deal_id}") if deal_id else ""
        check("deal of the manager, named 'client · phone'", row == f"{A['id']}|{TAG} Клиент · +{digits}", row)
        row = psql(f"select outgoing, user_id, target_user_id, external_id, after_state->>'message', to_char(created_at, 'YYYY-MM-DD HH24:MI') from event where deal_id = {deal_id} and type = 16") if deal_id else ""
        check("history: one WhatsApp event from the client to the manager, with the message id and the date",
              row == f"f|{contact_id}|{A['id']}|WA{RUN}1|Assalomu alaykum, narx qancha?|2026-11-19 10:00", row)

        print("== receiver: the client's photo")
        r = incoming(A, f"WA{RUN}p1", "rasm", chat={"wa_id": f"{digits}@s.whatsapp.net", "phone": "+" + digits, "name": "x", "photo": f"wa_{RUN}_photo.jpg"})
        row = psql(f"select avatar from \"user\" where id = {contact_id}") if contact_id else ""
        check("a photo from WhatsApp becomes the contact's avatar", row == f"wa_{RUN}_photo.jpg", (r, row))
        r = incoming(A, f"WA{RUN}p2", "yana", chat={"wa_id": f"{digits}@s.whatsapp.net", "phone": "+" + digits, "name": "x", "photo": None})
        row = psql(f"select avatar from \"user\" where id = {contact_id}") if contact_id else ""
        check("photo null = no news: the avatar stays", row == f"wa_{RUN}_photo.jpg", (r, row))
        st, ev = api("GET", f"/deals/{deal_id}/events?limit=5", token=A["token"])
        items = ev.get("data", []) if isinstance(ev, dict) else []
        # the API gives every file name (also `avatar`) as a signed, expiring link: <name>?e=<expiry>&s=<hmac> (FileLink)
        avatars = [str((e.get("originated_by") or {}).get("avatar") or "") for e in items]
        check("the history shows the author's avatar (a signed link to the photo)",
              any(re.fullmatch(rf"wa_{RUN}_photo\.jpg\?e=\d{{1,12}}&s=[0-9a-f]{{64}}", a) for a in avatars), (st, avatars))

        print("== receiver: more messages")
        r = incoming(A, f"WA{RUN}1", "Assalomu alaykum, narx qancha?")
        n = psql(f"select count(*) from event where deal_id = {deal_id} and type = 16")
        check("the same message again -> duplicate, nothing added", r[1].get("status") == "duplicate" and n == "3", (r, n))
        r = incoming(A, f"WA{RUN}2", "Narxlar ilova qilindi", outgoing=True,
                     files=[{"name": "narx.pdf", "path": f"wa_{RUN}.pdf", "type": "document", "caption": None}])
        row = psql(f"select outgoing, user_id, target_user_id from event where deal_id = {deal_id} and external_id = 'WA{RUN}2'")
        check("a message sent from the phone -> outgoing, from the manager to the client", row == f"t|{A['id']}|{contact_id}", row)
        row = psql(f"select f.name, f.\"from\", (select count(*) from deal_file df where df.\"fileId\" = f.id and df.\"dealId\" = {deal_id}) from file f where f.path = 'wa_{RUN}.pdf'")
        check("its file -> a file from messages linked to the deal", row == "narx.pdf|from_messages|1", row)
        r = incoming(A, f"WA{RUN}3", "Men", chat={"wa_id": lid, "phone": None, "name": "x"})
        check("a hidden-number chat (LID) of an unknown person -> new contact without phone", r[1].get("created_contact") is True, r)
        lid_contact = r[1].get("contact_id")
        r = incoming(A, f"WA{RUN}4", "Yana", chat={"wa_id": lid, "phone": None, "name": "x"})
        check("the same LID chat again -> the same contact (matched by chat id)", r[1].get("contact_id") == lid_contact and not r[1].get("created_contact"), r)
        r = incoming(A, f"WA{RUN}5", "o'zim", chat={"wa_id": "x@s.whatsapp.net", "phone": A["phone"], "name": "me"})
        check("the manager's own number -> ignored", r[1].get("status") == "ignored" and r[1].get("reason") == "self", r)
        r = incoming({"id": 999999999, "phone": "+1"}, f"WA{RUN}6", "x")
        check("unknown manager -> 404", r[0] == 404, r)

        print("== the deal history")
        st, ev = api("GET", f"/deals/{deal_id}/events?limit=50", token=A["token"])
        items = ev.get("data", []) if isinstance(ev, dict) else []
        check("GET /deals/:id/events lists the WhatsApp messages", st == 200 and len([e for e in items if e.get("type") == 16]) == 4, st)
        st, ev = api("GET", f"/deals/{deal_id}/events?limit=50&exclude_chats[]=with_clients", token=A["token"])
        items = ev.get("data", []) if isinstance(ev, dict) else []
        check("the filter 'без переписки с клиентами' hides them", st == 200 and not [e for e in items if e.get("type") == 16], (st, len(items)))
        other = r2 = incoming(A, f"WA{RUN}7", "x", chat={"wa_id": f"99894{RUN}@s.whatsapp.net", "phone": f"+99894{random.randint(1000000, 9999999)}", "name": f"{TAG} другой"})
        other_deal = (other[1].get("deal_ids") or [None])[0]
        ev_id = int(psql(f"select id from event where deal_id = {deal_id} and external_id = 'WA{RUN}2'"))
        st, _ = api("PATCH", "/deals/events/remap", {"event_id": ev_id, "replace_with_deal_id": other_deal}, token=A["token"])
        row = psql(f"select deal_id from event where id = {ev_id}")
        check("a WhatsApp message (with its file) can be moved to another deal", st == 200 and row == str(other_deal), (st, row))
        row = psql(f"select string_agg(df.\"dealId\"::text, ',') from file f join deal_file df on df.\"fileId\" = f.id where f.path = 'wa_{RUN}.pdf'")
        check("the file moved with it", row == str(other_deal), row)

        print("== another manager gets the same client")
        # OMNI-7: B's deal view is «own»: A's deal is not B's to open, so the message never goes there silently
        r = incoming(B, f"WA{RUN}b1", "B ga yozdim", chat={"wa_id": f"{digits}@s.whatsapp.net", "phone": "+" + digits, "name": "x"})
        b_deal = (r[1].get("deal_ids") or [None])[0]
        check("B cannot open A's deal -> B's own new deal gets the message, not A's", r[1].get("created_deal") is True and b_deal not in (None, deal_id), r)
        row = psql(f"select agent_id from deal where id = {b_deal}") if b_deal else ""
        check("... the new deal is B's", row == str(B["id"]), row)
        st, b = multipart("/whatsapp/send-message", {"to_user": str(contact_id), "message": "Salom", "deal_id": str(b_deal)}, [], B["token"])
        check("B, whose WhatsApp the client wrote to, may answer from that deal (reaches the service: not connected / 503)",
              (st == 400 and "подключ" in message_of((st, b))) or st == 503, (st, b))
        # B's deal out of the way: B is in the same group, so C («group») could open it too, and as the most
        # recently active deal it would win; the step is about A's deal (cleanup removes it by agent_id)
        if b_deal:
            psql(f"update deal set deleted_at = now() where id = {b_deal}")
        psql(f"update \"user\" set permissions = jsonb_set(permissions, '{{deal,view}}', '2') where id = {C['id']}")
        r = incoming(C, f"WA{RUN}c0", "C ga yozdim", chat={"wa_id": f"{digits}@s.whatsapp.net", "phone": "+" + digits, "name": "x"})
        check("manager C of A's group with deal view «group» -> A's deal, no new deal", r[1].get("deal_ids") == [deal_id] and not r[1].get("created_deal"), r)
        r = incoming(B, f"WA{RUN}1", "Assalomu alaykum, narx qancha?")
        check("the same WhatsApp message id in another manager's chat is another message (not a duplicate)", r[1].get("status") == "saved", r)

        print("== one deal per message, numbers typed in a local form (WA-4, WA-6, WA-7)")
        psql(f"update deal set closed_at = null where id = {other_deal}")
        local = f"99895{random.randint(1000000, 9999999)}"
        local_id = int(psql(f"insert into \"user\" (username, role, phone, created_by) values ('{TAG} местный', 'ctr_agent', '{local[3:5]} {local[5:8]} {local[8:10]} {local[10:]}', {A['id']}) returning id"))
        r = incoming(A, f"WA{RUN}L1", "Salom", chat={"wa_id": f"{local}@s.whatsapp.net", "phone": "+" + local, "name": "x"})
        check("a contact whose phone was typed without the country code is found (the last 9 digits), no duplicate contact",
              r[1].get("contact_id") == local_id and not r[1].get("created_contact"), r)
        local_deal = (r[1].get("deal_ids") or [None])[0]
        psql(f"insert into deal_user (\"dealId\", \"userId\") values ({other_deal}, {local_id})")  # a second open deal of A with this client
        r = incoming(A, f"WA{RUN}L2", "Yana", chat={"wa_id": f"{local}@s.whatsapp.net", "phone": "+" + local, "name": "x"})
        n = psql(f"select count(*) from event where type = 16 and external_id = 'WA{RUN}L2'")
        check("with two open deals a message is saved once (not copied into every deal)", len(r[1].get("deal_ids") or []) == 1 and n == "1", (r, n))
        r = incoming(A, f"WA{RUN}L3", "Javob", outgoing=True, deal_id=other_deal, chat={"wa_id": f"{local}@s.whatsapp.net", "phone": "+" + local, "name": "x"})
        check("a message written from a deal (deal_id) is recorded in that deal", r[1].get("deal_ids") == [other_deal], r)
        st, b = multipart("/whatsapp/send-message", {"to_user": str(local_id), "message": "x", "deal_id": "999999999"}, [], A["token"])
        check("send from a deal the user cannot write from -> 400", st == 400, (st, b))
        st, b = multipart("/whatsapp/send-message", {"to_user": str(local_id), "message": " "}, [], A["token"])
        check("send with neither text nor files -> 400", st == 400, (st, b))

        print("== not for the CRM: colleagues, «Не клиент», messages from the phone (WA-2)")
        r = incoming(A, f"WA{RUN}s1", "Salom", chat={"wa_id": "x@s.whatsapp.net", "phone": B["phone"], "name": "Коллега"})
        check("a colleague's number -> ignored (staff), no contact", r[1].get("status") == "ignored" and r[1].get("reason") == "staff", r)
        friend = f"99891{random.randint(1000000, 9999999)}"
        friend_chat = {"wa_id": f"{friend}@s.whatsapp.net", "phone": "+" + friend, "name": f"{TAG} друг"}
        r = incoming(A, f"WA{RUN}s2", "Tug'ilgan kuning bilan!", outgoing=True, chat=friend_chat)
        n = psql(f"select count(*) from \"user\" where wa_id = '{friend}@s.whatsapp.net'")
        check("a message from the phone to somebody not in the CRM -> ignored, no contact", r[1].get("reason") == "outgoing_unknown" and n == "0", (r, n))
        st, item = api("POST", "/messenger/ignored", {"phone": "+" + friend, "channel": "whatsapp"}, A["token"])
        check("«Не клиент» for WhatsApp only -> 201", st == 201 and item.get("channel") == "whatsapp", (st, item))
        r = incoming(A, f"WA{RUN}s3", "Salom", chat=friend_chat)
        n = psql(f"select count(*) from \"user\" where wa_id = '{friend}@s.whatsapp.net'")
        check("the person writes -> ignored (not_client), no contact, no deal", r[1].get("reason") == "not_client" and n == "0", (r, n))
        api("DELETE", f"/messenger/ignored/{item.get('id', 0)}", token=A["token"])
        st, _ = api("POST", "/messenger/ignored", {"phone": "12"}, A["token"])
        check("«Не клиент» with a number shorter than 9 digits -> 400", st == 400, st)

        print("== a manager who is not a staff user any more (WA-10)")
        st, _ = api("DELETE", f"/users/{C['id']}", token=admin)
        r = incoming(C, f"WA{RUN}c1", "Salom")
        check("a message for a deleted staff user -> 410 (the service keeps it aside)", st == 200 and r[0] == 410, (st, r))
        st, b = api("DELETE", f"/whatsapp/session?user_id={C['id']}", token=admin)
        check("admin may disconnect a deleted user's WhatsApp (200, or 503 without the service)", st in (200, 503), (st, b))

        print("== people: connect, state, send")
        st, _ = api("GET", f"/whatsapp/status?user_id={A['id']}", token=B["token"])
        check("the state of someone else's WhatsApp as an agent -> 403", st == 403, st)
        st, _ = api("POST", "/whatsapp/connect", {"user_id": A["id"]}, token=B["token"])
        check("connect someone else's WhatsApp as an agent -> 403", st == 403, st)
        st, _ = api("DELETE", f"/whatsapp/session?user_id={A['id']}", token=B["token"])
        check("disconnect someone else's WhatsApp as an agent -> 403", st == 403, st)
        st, _ = api("GET", "/whatsapp/sessions", token=A["token"])
        check("the list of sessions is for the admin -> 403 for an agent", st == 403, st)
        st, b = api("POST", "/whatsapp/connect", {"phone": "12-34"}, token=A["token"])
        check("connect by phone with a broken number -> 400", st == 400, (st, b))
        st, s = api("GET", "/whatsapp/status", token=A["token"])
        check("own state answers (none without a session; 503 without the service)", (st == 200 and s.get("status") in ("none", "logged_out")) or st == 503, (st, s))
        st, s = api("GET", "/whatsapp/sessions", token=admin)
        check("admin sees the sessions (list; 503 without the service)", (st == 200 and isinstance(s, list)) or st == 503, (st, s))
        if st == 200:
            row = next((x for x in s if x.get("user_id") == A["id"]), None)
            check("... every staff user with the state in words (also those who never connected)", bool(row and row.get("text") and row.get("status")), row)
        st, b = multipart("/whatsapp/send-message", {"to_user": str(lid_contact), "message": "Salom"}, [], B["token"])
        check("write to another manager's client who never wrote to you -> 400", st == 400 and "сделки" in message_of((st, b)), (st, b))
        st, b = multipart("/whatsapp/send-message", {"to_user": str(B["id"]), "message": "Salom"}, [], A["token"])
        check("write to a staff user -> 400", st == 400, (st, b))
        st, b = multipart("/whatsapp/send-message", {"to_user": str(contact_id), "message": "Salom"}, [], A["token"])
        check("write with an open deal reaches the service: 400 'не подключён' (dev service without a session) or 503 without one",
              (st == 400 and "подключ" in message_of((st, b))) or st == 503, (st, b))
        n = psql(f"select count(*) from event where deal_id = {deal_id} and type = 16 and outgoing and after_state->>'message' = 'Salom'")
        check("a message WhatsApp did not accept is not written to the history", n == "0", n)
    finally:
        print("== cleanup")
        ids = ",".join(str(u["id"]) for u in users.values()) or "0"
        contacts = f"select id from \"user\" where (username like '{TAG}%' or wa_id like '%@lid' and created_by in ({ids})) and role = 'ctr_agent'"
        deals = f"select id from deal where agent_id in ({ids})"
        tasks = f"select id from task where deal_id in ({deals})"
        psql(";".join([
            "begin",
            f"create temp table _c as {contacts}",
            f"delete from event where deal_id in ({deals}) or user_id in ({ids}) or user_id in (select id from _c) or target_user_id in (select id from _c) or target_user_id in ({ids}) or task_id in ({tasks})",
            f"delete from task where id in ({tasks})",
            f"delete from deal_file where \"dealId\" in ({deals})",
            f"delete from file where path = 'wa_{RUN}.pdf' or uploaded_by in (select id from _c) or uploaded_by in ({ids})",
            f"delete from deal_stage_record where deal_id in ({deals})",
            f"delete from deal_user where \"dealId\" in ({deals})",
            f"delete from deal where id in ({deals})",
            "delete from \"user\" where id in (select id from _c)",
            f"delete from \"user\" where id in ({ids})",
            "commit",
        ]))
        left = psql(f"select (select count(*) from \"user\" where username like '{TAG}%') + (select count(*) from deal where agent_id in ({ids}))")
        check("test rows removed", left == "0", left)

    print(f"\nRESULT: {results['PASS']} passed, {results['FAIL']} failed")
    return 1 if results["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
