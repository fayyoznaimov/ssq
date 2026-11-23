#!/usr/bin/env python3
"""Checks for call recordings through the API (src/calls): recorder tokens, POST /calls/upload,
the queue, processing (ffmpeg -> mp3, `recording`, NEW_CALL_RECORDING in the deal of the client
with that number), retry / discard, rights.

Runs against the local stack (docker) or, with the CRM_* variables from local/dev/env.sh, the dev
copy on the server. Needs ffmpeg for the API (FFMPEG_BIN) and TELEGRAM_SERVICE_TOKEN in the API
env file (the folder scanner's way of uploading). The processor is driven by POST /calls/process;
one check waits for the scheduler (CALLS_SCHEDULER_SEC) too.
Usage: py local/checks/calls_check.py      (exit code 1 on any FAIL)
Everything it creates is named AUDIT-call-<run> and removed at the end (rows and files).
"""
import io
import json
import os
import random
import secrets
import shlex
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASE = os.environ.get("CRM_API_URL", "http://localhost:8080/api/v1").rstrip("/")
ENV_FILE = os.environ.get("CRM_ENV_FILE") or os.path.join(ROOT, "parisahon-api", ".env")
COMPOSE_FILE = os.path.join(ROOT, "docker-compose.local.yml")
PSQL = (shlex.split(os.environ["CRM_PSQL"]) if os.environ.get("CRM_PSQL") else
        ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])
# where the API keeps its files, when it is on this machine (dev copy); None = not checked
UPLOADS_DIR = os.path.join(os.environ["CRM_APP_DIR"], "public", "uploads") if os.environ.get("CRM_APP_DIR") else None

RUN = secrets.token_hex(3)
TAG = f"AUDIT-call-{RUN}"
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


def http(method, path, body=None, token=None, headers=None, raw=None, timeout=120):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    hdrs = dict(headers or {})
    if raw is None and body is not None:
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, method=method, data=data, headers=hdrs)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for attempt in range(40):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
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


def multipart(fields, files):
    """(content-type, body) of a multipart form; files = [(field, filename, bytes, content type)]."""
    boundary = "----audit-call-" + uuid.uuid4().hex
    out = bytearray()
    for name, value in fields.items():
        out += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
    for name, filename, data, ctype in files:
        out += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n".encode()
        out += data + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return f"multipart/form-data; boundary={boundary}", bytes(out)


def wav_bytes(seconds=1.0, rate=8000):
    """A short 440 Hz tone: a valid audio file ffmpeg can convert."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        import math
        frames = b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / rate))) for i in range(int(rate * seconds)))
        w.writeframes(frames)
    return buf.getvalue()


def upload(fields, files, headers):
    ctype, body = multipart(fields, files)
    return http("POST", "/calls/upload", raw=body, headers={"Content-Type": ctype, **headers})


def wait_for(fn, expected, timeout=40, step=1.0):
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
    service_token = env_value("TELEGRAM_SERVICE_TOKEN") or ""
    groups = sorted(g["id"] for g in http("GET", "/groups", token=admin)[1])
    task_type = int(psql("select id from task_type order by id limit 1"))
    collection = int(psql("select id from collection where is_active order by id desc limit 1"))
    perms = {"deal": {"view": 3, "create": 3, "update": 3, "delete": 0, "export": 0},
             "contact": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
             "company": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
             "task": {"update": 1, "delete": 0}, "mail": True, "file": True}

    users, stage_id, deal_ids, extra_contacts = {}, None, [], []
    try:
        print("== setup")
        for key in ("a", "b"):
            person = {"email": f"audit-call-{RUN}-{key}@example.test", "password": secrets.token_urlsafe(12),
                      "username": f"{TAG}-{key}", "role": "agent", "group_id": groups[0], "permissions": perms}
            status, created = http("POST", "/users", person, admin)
            if status != 201:
                raise SystemExit(f"cannot create user {key}: {status} {created}")
            person["id"] = created["id"]
            person["token"] = http("POST", "/auth/login", {"email": person["email"], "password": person["password"]})[1]["access_token"]
            users[key] = person
        A, B = users["a"], users["b"]
        digits = f"99890{random.randint(1000000, 9999999)}"
        contact = int(psql(f"insert into \"user\" (username, role, phone) values ('{TAG} клиент', 'ctr_agent', '+998 {digits[3:5]} {digits[5:8]}-{digits[8:10]}-{digits[10:]}') returning id"))
        status, d = http("POST", "/deals", {"label": f"{TAG} сделка", "budget": 1, "agent_id": A["id"], "ctr_agent_ids": [contact], "fillers": [], "products": []}, admin)
        if status != 201:
            raise SystemExit(f"cannot create deal: {status} {d}")
        deal = d["id"]
        deal_ids.append(deal)
        status, st = http("POST", "/stages", {"name": f"{TAG}-stage", "color": "#D5D8DB", "collection_id": collection}, admin)
        stage_id = st["id"] if status == 201 else None
        if stage_id:
            http("POST", f"/stages/{stage_id}/triggers", {"type": 0, "deal_filters": [], "apply_when": {"when": "call_recorded"},
                  "create_task_data": {"label": f"{TAG} перезвонить", "type_id": task_type, "responsible": {"user": "currently_assigned"}, "end_time_in_minutes": 60, "all_day": False}}, admin)
            http("PATCH", f"/deals/{deal}/stage", {"stage_id": stage_id}, admin)

        print("== tokens")
        r = http("POST", "/calls/tokens", {"user_id": A["id"]}, token=A["token"])
        check("an agent cannot issue tokens -> 403", r[0] == 403, r)
        r = http("GET", "/calls/tokens", token=B["token"])
        check("an agent cannot list tokens -> 403", r[0] == 403, r)
        r = http("POST", "/calls/tokens", {"user_id": A["id"]}, token=admin)
        check("admin issues a token for A -> 201 with the token value", r[0] == 201 and str(r[1].get("token", "")).startswith("rec_") and len(r[1]["token"]) > 30, r)
        token_a = r[1]["token"]
        n = psql(f"select count(*) from recorder_token where user_id = {A['id']} and revoked_at is null and token_hash <> '{token_a}'")
        check("only a hash is stored, one active token", n == "1", n)
        r = http("GET", "/calls/tokens", token=admin)
        row = next((t for t in r[1] if t["user_id"] == A["id"]), None) if r[0] == 200 else None
        check("GET /calls/tokens lists A with has_token, no token value", r[0] == 200 and row and row["has_token"] is True and "token" not in row, (r[0], row))
        r = http("POST", "/calls/tokens", {"user_id": contact}, token=admin)
        check("a token for a contact -> 404", r[0] == 404, r)

        print("== upload")
        wav = wav_bytes()
        r = upload({"duration": "1000"}, [("file", "call.wav", wav, "audio/wav")], {})
        check("upload without a token -> 401", r[0] == 401, r)
        r = upload({"duration": "1000"}, [("file", "call.wav", wav, "audio/wav")], {"X-Recorder-Token": "rec_" + "0" * 48})
        check("upload with an unknown token -> 401", r[0] == 401, r)
        r = upload({"duration": "1000"}, [("file", "call.wav", wav, "audio/wav")], {"Authorization": "Bearer " + A["token"]})
        check("a CRM login token is not a recorder token -> 401", r[0] == 401, r)
        r = upload({"duration": "1000", "number": "+" + digits, "direction": "Incoming"}, [], {"X-Recorder-Token": token_a})
        check("upload without a file -> 400", r[0] == 400, r)
        r = upload({"duration": "1000"}, [("file", "notes.txt", b"hello", "text/plain")], {"X-Recorder-Token": token_a})
        check("upload of a non-audio file -> 400", r[0] == 400, r)
        r = upload({"duration": "61825", "number": "+" + digits, "direction": "Incoming"}, [("file", f"{TAG}-1.wav", wav, "audio/wav")], {"X-Recorder-Token": token_a})
        check("upload with fields (duration, number, direction) -> 201 pending for A", r[0] == 201 and r[1].get("status") == "pending" and r[1].get("user_id") == A["id"], r)
        up1 = r[1]["id"]
        meta = json.dumps({"duration": "30000", "callee": "+" + digits, "direction": "Outgoing"}).encode()
        r = upload({"user_id": str(A["id"])}, [("file", f"{TAG}-2.wav", wav_bytes(1.1), "audio/wav"), ("meta", f"{TAG}-2.json", meta, "application/json")],
                   {"X-Telegram-Service-Token": service_token})
        check("the folder scanner: service token + user_id + the recorder's json -> 201, source folder", r[0] == 201 and r[1].get("user_id") == A["id"], r)
        up2 = r[1]["id"] if r[0] == 201 else None
        r = upload({"user_id": str(A["id"])}, [("file", "x.wav", wav, "audio/wav")], {"X-Telegram-Service-Token": "x" * len(service_token or "xxxxxxxxxxxxxxxx")})
        check("a wrong service token -> 401", r[0] == 401, r)
        r = upload({"duration": "5000", "number": "+998000000000", "direction": "Incoming"}, [("file", f"{TAG}-broken.amr", os.urandom(300), "audio/amr")], {"X-Recorder-Token": token_a})
        check("a broken .amr is accepted into the queue (the processor decides)", r[0] == 201, r)
        up3 = r[1]["id"]
        row = psql(f"select last_upload_at is not null from recorder_token where user_id = {A['id']} and revoked_at is null")
        check("last_upload_at of the token is set", row == "t", row)
        r = http("GET", "/calls/queue?status=all", token=admin)
        ids = sorted(u["id"] for u in r[1]) if r[0] == 200 else None
        check("GET /calls/queue lists the three files", r[0] == 200 and all(i in ids for i in (up1, up2, up3)), (r[0], ids))
        r = http("GET", "/calls/queue", token=A["token"])
        check("an agent cannot see the queue -> 403", r[0] == 403, r)

        print("== processing")
        r = http("POST", "/calls/process", {}, token=A["token"])
        check("an agent cannot run the processor -> 403", r[0] == 403, r)
        r = http("POST", "/calls/process", {}, token=admin)
        check("POST /calls/process answers with counters (the scheduler may have been first)", r[0] == 201 and "done" in r[1] and "failed" in r[1], r)
        statuses = lambda: psql(f"select string_agg(status, ',' order by id) from call_upload where id in ({up1}, {up2}, {up3})")
        check("the three files are processed: done, done, failed", wait_for(statuses, "done,done,failed", timeout=30) == "done,done,failed", statuses())
        rows = {int(x.split("|")[0]): x.split("|")[1:] for x in psql(f"select id, status, coalesce(error, ''), recording_id is not null from call_upload where id in ({up1}, {up2}, {up3})").split("\n") if x}
        check("the good files are done with a recording, the broken one failed with the ffmpeg error",
              rows[up1][0] == "done" and rows[up1][2] == "t" and rows[up2][0] == "done" and rows[up3][0] == "failed" and "ffmpeg" in rows[up3][1].lower(), rows)
        rec = psql(f"select r.path, r.duration, r.outgoing, r.from_number, r.user_id from recording r join call_upload u on u.recording_id = r.id where u.id = {up1}")
        check("recording row: mp3 path, duration from the fields (ms), incoming, number, manager A", rec.startswith("recording_") and rec.endswith(f"|61825|f|+{digits}|{A['id']}") and ".mp3|" in rec, rec)
        path1 = rec.split("|")[0]
        rec2 = psql(f"select r.duration, r.outgoing from recording r join call_upload u on u.recording_id = r.id where u.id = {up2}")
        check("recording from the json: duration 30000, outgoing", rec2 == "30000|t", rec2)
        if UPLOADS_DIR:
            check("the mp3 exists in public/uploads and is not empty", os.path.exists(os.path.join(UPLOADS_DIR, path1)) and os.path.getsize(os.path.join(UPLOADS_DIR, path1)) > 500, path1)
            raw1 = psql(f"select raw_path from call_upload where id = {up1}")
            check("the raw file of a processed upload is removed", not os.path.exists(os.path.join(UPLOADS_DIR, raw1)), raw1)
        ev = psql(f"select outgoing, user_id, target_user_id, duration, after_state->>'path' from event where deal_id = {deal} and type = 10 and after_state->>'path' = '{path1}'")
        check("NEW_CALL_RECORDING event in the deal of the client with that number: from the contact to A, with duration and path",
              ev == f"f|{contact}|{A['id']}|61825|{path1}", ev)
        n = psql(f"select count(*) from event where deal_id = {deal} and type = 10")
        check("both recordings of the number are in the deal history", n == "2", n)
        # the outgoing call is from the manager to the client, and every call is dated by the call, not by its processing
        ev2 = psql(f"select e.outgoing, e.user_id, e.target_user_id from event e join recording r on e.after_state->>'path' = r.path "
                   f"join call_upload u on u.recording_id = r.id where e.deal_id = {deal} and e.type = 10 and u.id = {up2}")
        check("the outgoing call in the history: from A to the contact", ev2 == f"t|{A['id']}|{contact}", ev2)
        n = psql(f"select count(*) from event e join recording r on e.after_state->>'path' = r.path "
                 f"where e.deal_id = {deal} and e.type = 10 and abs(extract(epoch from e.created_at - r.created_at)) < 1")
        check("the calls in the history are dated by the time of the call (recording.created_at)", n == "2", n)
        if stage_id:
            # TRG-11: «Создать задачу» does not add the same task while the earlier one is open
            tasks = psql(f"select count(*) || '|' || count(*) filter (where closed_at is null) from task where deal_id = {deal} and label = '{TAG} перезвонить'")
            check("the trigger 'записан звонок' fired: one open task for the two recordings, no copy while it is open", tasks == "1|1", tasks)
        r = http("GET", f"/calls/recordings?user_id={A['id']}&number={digits[-7:]}", token=admin)
        item = next((x for x in r[1]["data"] if x["path"] == path1), None) if r[0] == 200 else None
        check("GET /calls/recordings with filters: the recording with its deal link", r[0] == 200 and r[1]["count"] == 2 and item and item["deal"] and item["deal"]["id"] == deal, (r[0], item))
        r = http("GET", "/calls/recordings", token=B["token"])
        check("an agent cannot list all recordings -> 403", r[0] == 403, r)
        r = http("GET", "/calls/queue?status=failed", token=admin)
        failed = [u for u in r[1] if u["id"] == up3] if r[0] == 200 else []
        check("the failed file is in the queue with its error", bool(failed) and failed[0]["error"], r)

        print("== the name of the file, duplicates, the FTP receiver")
        r = http("GET", "/calls/recorder", headers={"X-Recorder-Token": token_a})
        check("GET /calls/recorder with A's token -> A", r[0] == 200 and r[1].get("user_id") == A["id"] and r[1].get("username") == A["username"], r)
        r = http("GET", "/calls/recorder", headers={"X-Recorder-Token": "rec_" + "0" * 48})
        check("GET /calls/recorder with an unknown token -> 401", r[0] == 401, r)
        r = http("GET", "/calls/ftp", token=admin)
        check("GET /calls/ftp: the FTP address for the settings page (admin)", r[0] == 200 and "address" in r[1], r)
        r = http("GET", "/calls/ftp", token=B["token"])
        check("an agent cannot read the FTP address -> 403", r[0] == 403, r)
        pretty = f"+{digits[:3]} {digits[3:5]} {digits[5:8]}-{digits[8:10]}-{digits[10:]}"
        cube = f"2026-11-20 14-03-12 (phone) {TAG} клиент ({pretty}) ↙.wav"
        wav5 = wav_bytes(1.3)
        r = upload({}, [("file", cube, wav5, "audio/wav")], {"X-Recorder-Token": token_a})
        check("a Cube ACR file with nothing but its name -> 201", r[0] == 201 and not r[1].get("duplicate"), r)
        up5 = r[1]["id"]
        row = psql(f"select file_name, from_number, outgoing, to_char(recorded_at, 'YYYY-MM-DD HH24:MI:SS'), caller_name is null, source from call_upload where id = {up5}")
        check("number, direction (↙ incoming) and the time of the call are read from the name; the name stays UTF-8",
              row == f"{cube}|+{digits}|f|2026-11-20 14:03:12|t|recorder", row)
        r = upload({}, [("file", "the same again.wav", wav5, "audio/wav")], {"X-Recorder-Token": token_a})
        n = psql(f"select count(*) from call_upload where user_id = {A['id']} and file_hash = (select file_hash from call_upload where id = {up5})")
        check("the same file again -> the first upload with duplicate: true, no second row", r[0] == 201 and r[1].get("id") == up5 and r[1].get("duplicate") is True and n == "1", (r, n))
        messenger = f"2026-11-20 15-00-00 (whatsapp) {TAG} клиент.wav"
        r = upload({}, [("file", messenger, wav_bytes(1.4), "audio/wav")], {"X-Recorder-Token": token_a})
        up6 = r[1]["id"] if r[0] == 201 else 0
        r = upload({"recorded_at": "1795064400000"}, [("file", "audio.wav", wav_bytes(1.5), "audio/wav")], {"X-Recorder-Token": token_a})
        up7 = r[1]["id"] if r[0] == 201 else 0
        row = psql(f"select to_char(recorded_at, 'YYYY-MM-DD HH24:MI:SS'), from_number is null, caller_name is null from call_upload where id = {up7}")
        check("a name without a date: the time of the file on the phone (recorded_at, epoch ms) is kept", row == "2026-11-19 10:00:00|t|t", row)
        # Cube ACR through its FTP backup, as a real phone sent it: the app first, the name unreadable, the json knows it
        backup = f"phone_20261120-140040__{digits}.wav"
        r = upload({}, [("file", backup, wav_bytes(1.6), "audio/wav")], {"X-Recorder-Token": token_a})
        row = psql(f"select from_number, to_char(recorded_at, 'YYYY-MM-DD HH24:MI:SS'), caller_name is null from call_upload where id = {r[1].get('id', 0)}") if r[0] == 201 else None
        check("Cube ACR backup name without its json: phone_<date>-<time>__<number>", row == f"{digits}|2026-11-20 14:00:40|t", (r, row))
        up8 = r[1].get("id", 0)
        named_json = json.dumps({"duration": "42349", "loc": "39.68;67.05", "callee": f"{TAG} клиент"}).encode()
        r = upload({}, [("file", "whatsapp_20261120-154203_????? ??????.wav", wav_bytes(1.7), "audio/wav"), ("meta", "whatsapp_20261120-154203_????? ??????.json", named_json, "application/json")],
                   {"X-Recorder-Token": token_a})
        up9 = r[1].get("id", 0) if r[0] == 201 else 0
        row = psql(f"select from_number is null, caller_name, duration from call_upload where id = {up9}")
        check("a messenger call with the name in the json (callee is not a number): it is the caller's name, not a number", row == f"t|{TAG} клиент|42349", (r, row))
        calls_token = env_value("CALLS_SERVICE_TOKEN") or ""
        r = upload({"user_id": str(B["id"])}, [("file", cube, wav5, "audio/wav")], {"X-Calls-Service-Token": "x" * max(len(calls_token), 16)})
        check("the FTP receiver with a wrong service token -> 401", r[0] == 401, r)
        if calls_token:
            r = upload({"user_id": str(B["id"])}, [("file", cube, wav5, "audio/wav")], {"X-Calls-Service-Token": calls_token})
            src = psql(f"select source || '|' || user_id from call_upload where id = {r[1].get('id', 0)}") if r[0] == 201 else None
            check("the FTP receiver: service token + user_id -> 201 for that manager, source ftp; the same bytes of another manager are not a duplicate",
                  r[0] == 201 and not r[1].get("duplicate") and src == f"ftp|{B['id']}", (r, src))
        else:
            check("CALLS_SERVICE_TOKEN is set for the dev API (local/dev/ftp-env.sh)", False, "not in the env file")
        http("POST", "/calls/process", {}, token=admin)
        done = lambda: psql(f"select string_agg(status, ',' order by id) from call_upload where id in ({up5}, {up6}, {up7}, {up8}, {up9})")
        check("the five files are processed", wait_for(done, "done,done,done,done,done", timeout=60) == "done,done,done,done,done", done())
        n = psql(f"select count(*) from event e join recording r on e.after_state->>'path' = r.path join call_upload u on u.recording_id = r.id where e.deal_id = {deal} and e.type = 10 and u.id in ({up8}, {up9})")
        check("both Cube ACR backup calls are in the deal of that client (by number; by the name from the json)", n == "2", n)
        rec = psql(f"select r.from_number, r.outgoing, to_char(r.created_at, 'YYYY-MM-DD HH24:MI:SS') from recording r join call_upload u on u.recording_id = r.id where u.id = {up5}")
        check("the recording carries the time of the call, not of the upload", rec == f"+{digits}|f|2026-11-20 14:03:12", rec)
        row = psql(f"select u.caller_name, r.from_number, (select count(*) from event e where e.deal_id = {deal} and e.type = 10 and e.after_state->>'path' = r.path) "
                   f"from call_upload u join recording r on r.id = u.recording_id where u.id = {up6}")
        check("a messenger call (no number in the name): the one client with that name is found, the call is in their deal",
              row == f"{TAG} клиент|{pretty}|1", row)

        print("== a deal from a recording (the button «Создать сделку»)")
        stranger = f"99877{random.randint(1000000, 9999999)}"
        ups = []
        for name, seconds in ((f"phone_20261118-100000__{stranger}.wav", 1.8), (f"phone_20261119-110000__{stranger}.wav", 1.9)):
            r = upload({}, [("file", name, wav_bytes(seconds), "audio/wav")], {"X-Recorder-Token": token_a})
            ups.append(r[1].get("id", 0) if r[0] == 201 else 0)
        named_json = json.dumps({"duration": "5000", "callee": f"{TAG} незнакомец"}).encode()
        r = upload({}, [("file", "whatsapp_20261119-120000_x.wav", wav_bytes(2.0), "audio/wav"), ("meta", "whatsapp_20261119-120000_x.json", named_json, "application/json")],
                   {"X-Recorder-Token": token_a})
        ups.append(r[1].get("id", 0) if r[0] == 201 else 0)
        http("POST", "/calls/process", {}, token=admin)
        in_list = ", ".join(str(u) for u in ups)
        wait_for(lambda: psql(f"select count(*) from call_upload where id in ({in_list}) and status = 'done'"), "3", timeout=60)
        recs = [int(x) for x in psql(f"select string_agg(coalesce(recording_id, 0)::text, ',' order by id) from call_upload where id in ({in_list})").split(",")]
        rec_old, rec_new, rec_name = recs
        n = psql(f"select count(*) from event e join recording r on e.after_state->>'path' = r.path where e.type = 10 and r.id in ({rec_old}, {rec_new}, {rec_name})")
        check("calls from a number and from a name the CRM does not know are processed and are in no deal", all(recs) and n == "0", (recs, n))
        r = http("POST", f"/calls/recordings/{rec_new}/deal", {}, token=A["token"])
        check("an agent cannot open a deal from the admin's list -> 403", r[0] == 403, r)
        r = http("POST", "/calls/recordings/999999999/deal", {}, token=admin)
        check("an unknown recording -> 404", r[0] == 404, r)
        r = http("POST", f"/calls/recordings/{rec_new}/deal", {}, token=admin)
        check("«Создать сделку»: a new client, a new deal, both calls of the number in it",
              r[0] == 201 and r[1].get("created_contact") is True and r[1].get("created_deal") is True and r[1].get("linked") == 2, r)
        new_deal = r[1]["deal"]["id"] if r[0] == 201 else 0
        new_contact = r[1].get("contact_id", 0) if r[0] == 201 else 0
        deal_ids.append(new_deal)
        extra_contacts.append(new_contact)
        row = psql(f"select d.label, d.agent_id, (select u.phone || ' ' || u.username || ' ' || u.role from \"user\" u where u.id = {new_contact}), "
                   f"(select count(*) from event e where e.deal_id = d.id and e.type = 10), (select count(*) from deal_user du where du.\"dealId\" = d.id and du.\"userId\" = {new_contact}) from deal d where d.id = {new_deal}")
        check("the deal is the manager's and is named by the number; the client has the phone; two calls in its history",
              row == f"+{stranger}|{A['id']}|+{stranger} +{stranger} ctr_agent|2|1", row)
        r = http("POST", f"/calls/recordings/{rec_old}/deal", {}, token=admin)
        check("pressed again on the other call of the number: the same deal, nothing new",
              r[0] == 201 and r[1]["deal"]["id"] == new_deal and r[1].get("created_deal") is False and r[1].get("created_contact") is False and r[1].get("linked") == 0, r)
        r = http("GET", f"/calls/recordings?user_id={A['id']}&number={stranger[-7:]}", token=admin)
        shown = [x for x in r[1]["data"] if x.get("deal") and x["deal"]["id"] == new_deal] if r[0] == 200 else []
        check("the list of recordings shows the deal on both calls", len(shown) == 2, r)
        r = http("POST", f"/calls/recordings/{rec_name}/deal", {}, token=admin)
        name_deal = r[1]["deal"]["id"] if r[0] == 201 else 0
        deal_ids.append(name_deal)
        row = psql(f"select d.label, (select u.username || '|' || coalesce(u.phone, 'no phone') from \"user\" u where u.id = {r[1].get('contact_id', 0) if r[0] == 201 else 0}) from deal d where d.id = {name_deal}")
        check("a messenger call (a name, no number): the client is created by the name, the deal is named after them",
              r[0] == 201 and r[1].get("created_contact") is True and row == f"{TAG} незнакомец|{TAG} незнакомец|no phone", (r, row))

        print("== one deal per call, the client's card, the office line (CALL-2, CALL-9)")
        tasks_in = lambda d: psql(f"select count(*) from task where deal_id = {d} and label = '{TAG} перезвонить'")
        events_of = lambda upload_id: psql(
            f"select coalesce(string_agg(coalesce(e.deal_id::text, 'card:' || e.user_id::text), ',' order by e.id), '') "
            f"from event e join recording r on e.after_state->>'path' = r.path join call_upload u on u.recording_id = r.id "
            f"where e.type = 10 and u.id = {upload_id}")

        def process(upload_ids, expected="done"):
            http("POST", "/calls/process", {}, token=admin)
            ids_sql = ",".join(str(u) for u in upload_ids)
            want = ",".join([expected] * len(upload_ids))
            return wait_for(lambda: psql(f"select string_agg(status, ',' order by id) from call_upload where id in ({ids_sql})"), want, timeout=60)

        status, d = http("POST", "/deals", {"label": f"{TAG} сделка Б", "budget": 1, "agent_id": B["id"], "ctr_agent_ids": [contact], "fillers": [], "products": []}, admin)
        deal_b = d["id"] if status == 201 else 0
        deal_ids.append(deal_b)
        if stage_id:
            http("PATCH", f"/deals/{deal_b}/stage", {"stage_id": stage_id}, admin)
        close_tasks = lambda d: psql(f"update task set closed_at = now() where deal_id = {d} and label = '{TAG} перезвонить' and closed_at is null")
        r = upload({}, [("file", f"2026-11-21 09-00-00 (phone) {TAG} клиент ({pretty}) ↙.wav", wav_bytes(1.05), "audio/wav")], {"X-Recorder-Token": token_a})
        up_a = r[1].get("id", 0) if r[0] == 201 else 0
        tasks_b = tasks_in(deal_b)
        process([up_a])
        check("a client with deals of two managers: A's call goes into A's deal only", events_of(up_a) == str(deal), events_of(up_a))
        if stage_id:
            check("... so the «записан звонок» trigger of B's deal does not fire for A's call", tasks_in(deal_b) == tasks_b, (tasks_b, tasks_in(deal_b)))
        token_b = http("POST", "/calls/tokens", {"user_id": B["id"]}, token=admin)[1].get("token", "")
        r = upload({}, [("file", f"2026-11-21 09-05-00 (phone) {TAG} клиент ({pretty}) ↙.wav", wav_bytes(1.06), "audio/wav")], {"X-Recorder-Token": token_b})
        up_b = r[1].get("id", 0) if r[0] == 201 else 0
        process([up_b])
        check("... B's call into B's deal only (no more one event per open deal of every manager)", events_of(up_b) == str(deal_b), events_of(up_b))

        # a regular client whose deals are closed; a call from the company's office phone; both of one company
        closed_digits = f"99893{random.randint(1000000, 9999999)}"
        office_digits = f"99871{random.randint(1000000, 9999999)}"
        company = int(psql(f"insert into company (name, phone, is_old) values ('{TAG} Текстиль', '+{office_digits}', false) returning id").split("\n")[0])
        closed_client = int(psql(f"insert into \"user\" (username, role, phone, company_id) values ('{TAG} постоянный', 'ctr_agent', '+{closed_digits}', {company}) returning id"))
        office_contact = int(psql(f"insert into \"user\" (username, role, phone, company_id) values ('{TAG} бухгалтер', 'ctr_agent', '+99890{random.randint(1000000, 9999999)}', {company}) returning id"))
        psql(f"update company set primary_contact_id = {office_contact} where id = {company}")
        status, d = http("POST", "/deals", {"label": f"{TAG} закрытая", "budget": 1, "agent_id": A["id"], "ctr_agent_ids": [closed_client], "fillers": [], "products": []}, admin)
        closed_deal = d["id"] if status == 201 else 0
        deal_ids.append(closed_deal)
        psql(f"update deal set closed_at = now() where id = {closed_deal}")
        status, d = http("POST", "/deals", {"label": f"{TAG} офис", "budget": 1, "agent_id": A["id"], "ctr_agent_ids": [office_contact], "company_id": company, "fillers": [], "products": []}, admin)
        office_deal = d["id"] if status == 201 else 0
        deal_ids.append(office_deal)
        psql(f"update deal set company_id = {company} where id = {office_deal}")
        r = upload({}, [("file", f"phone_20261121-093000__{closed_digits}.wav", wav_bytes(1.07), "audio/wav")], {"X-Recorder-Token": token_a})
        up_closed = r[1].get("id", 0) if r[0] == 201 else 0
        r = upload({}, [("file", f"phone_20261121-094000__{office_digits}.wav", wav_bytes(1.08), "audio/wav")], {"X-Recorder-Token": token_a})
        up_office = r[1].get("id", 0) if r[0] == 201 else 0
        process([up_closed, up_office])
        row = psql(f"select e.deal_id is null, e.user_id, e.target_user_id from event e join recording r on e.after_state->>'path' = r.path "
                   f"join call_upload u on u.recording_id = r.id where e.type = 10 and u.id = {up_closed}")
        # incoming: from the client to A; outgoing: from A to the client (the name gives no direction)
        check("a known client with only closed deals: the call is on the client's card (an event without a deal), not lost",
              row in (f"t|{closed_client}|{A['id']}", f"t|{A['id']}|{closed_client}"), row)
        check("... and not in the closed deal", psql(f"select count(*) from event where deal_id = {closed_deal} and type = 10") == "0")
        check("a call from the company's own phone (no contact has it): into the company's deal", events_of(up_office) == str(office_deal), events_of(up_office))

        print("== the calls of a company, the calls of a staff member (CALL-3, CALL-2)")
        person = {"email": f"audit-call-{RUN}-c@example.test", "password": secrets.token_urlsafe(12), "username": f"{TAG}-c",
                  "role": "agent", "group_id": groups[0], "permissions": dict(perms, deal=dict(perms["deal"], view=1, update=1))}
        status, created = http("POST", "/users", person, admin)
        if status == 201:
            person["id"] = created["id"]
            person["token"] = http("POST", "/auth/login", {"email": person["email"], "password": person["password"]})[1]["access_token"]
            users["c"] = person
        C = users.get("c")
        path_of = lambda upload_id: psql(f"select r.path from recording r join call_upload u on u.recording_id = r.id where u.id = {upload_id}")
        r = http("GET", f"/calls/companies/{company}", token=admin)
        paths = {x["path"]: x for x in r[1]["data"]} if r[0] == 200 else {}
        office_row = paths.get(path_of(up_office)) or {}
        check("GET /calls/companies/:id: the office-line call and the call on a contact's card, newest first",
              r[0] == 200 and r[1]["count"] == 2 and [x["path"] for x in r[1]["data"]] == [path_of(up_office), path_of(up_closed)], r)
        check("... each with the manager, the direction, the duration, the contact and the deal",
              office_row.get("user", {}).get("id") == A["id"] and office_row.get("outgoing") in (True, False) and office_row.get("duration", 0) > 0
              and (office_row.get("deal") or {}).get("id") == office_deal and (office_row.get("contact") or {}).get("id") == office_contact, office_row)
        if C:
            r = http("GET", f"/calls/companies/{company}", token=C["token"])
            seen = [x["path"] for x in r[1]["data"]] if r[0] == 200 else None
            check("an agent with 'own deals': the calls of another manager's deal stay out, the card's call stays",
                  r[0] == 200 and seen == [path_of(up_closed)], (r[0], seen))
        r = http("GET", "/calls/companies/999999999", token=admin)
        check("an unknown company -> 404", r[0] == 404, r)
        r = http("GET", f"/calls/staff/{A['id']}?limit=200", token=A["token"])
        mine = {x["path"]: x for x in r[1]["data"]} if r[0] == 200 else {}
        row_a = mine.get(path_of(up_a)) or {}
        check("GET /calls/staff/:id: an agent's own recordings with the client and the deal",
              r[0] == 200 and (row_a.get("contact") or {}).get("id") == contact and (row_a.get("deal") or {}).get("id") == deal and r[1]["limit"] == 200, (r[0], row_a))
        n_a = psql(f"select count(*) from recording where user_id = {A['id']}")
        check("... all of them, paged (count of every recording of A)", r[0] == 200 and str(r[1]["count"]) == n_a, (r[1].get("count") if r[0] == 200 else r, n_a))
        r = http("GET", f"/calls/staff/{A['id']}", token=B["token"])
        check("another agent's recordings -> 403", r[0] == 403, r)
        r = http("GET", f"/calls/staff/{A['id']}", token=admin)
        check("admin sees anyone's -> 200", r[0] == 200 and str(r[1]["count"]) == n_a, r[0])
        rec_b = psql(f"select recording_id from call_upload where id = {up_b}")
        r = http("POST", f"/calls/staff/{A['id']}/recordings/{rec_b}/deal", {}, token=A["token"])
        check("«Создать сделку» on a recording that is not one's own -> 404", r[0] == 404, r)

        print("== a call sent twice: cut off, then whole (CALL-9); a .json that is not JSON (CALL-11)")
        # an open task of the trigger stops it from adding the same task: closed after each copy, so every firing shows
        close_tasks(deal)
        before_tasks = tasks_in(deal)
        name_at = lambda t: f"2026-11-21 10-00-0{t} (phone) {TAG} клиент ({pretty}) ↗.wav"
        # every file of a manager has its own bytes: the same bytes are the same upload (file_hash), not a copy of the call
        r = upload({}, [("file", name_at(0), wav_bytes(1.01), "audio/wav")], {"X-Recorder-Token": token_a})
        cut = r[1].get("id", 0) if r[0] == 201 else 0
        process([cut])
        close_tasks(deal)
        cut_path = path_of(cut)
        r = upload({}, [("file", name_at(3), wav_bytes(3.0), "audio/wav")], {"X-Recorder-Token": token_a})
        whole = r[1].get("id", 0) if r[0] == 201 else 0
        http("POST", "/calls/process", {}, token=admin)
        wait_for(lambda: psql(f"select status from call_upload where id = {whole}"), "done", timeout=60)
        close_tasks(deal)
        rows = psql(f"select string_agg(status || ':' || coalesce(recording_id::text, '-'), ',' order by id) from call_upload where id in ({cut}, {whole})")
        rec_whole = psql(f"select recording_id from call_upload where id = {whole}")
        check("the whole copy is kept; the cut-off one is marked duplicate and points to it", rows == f"duplicate:{rec_whole},done:{rec_whole}", rows)
        n = psql(f"select count(*) from event where type = 10 and after_state->>'path' = '{cut_path}'")
        check("... the history plays the whole file: the cut-off file is in no event, its recording is gone",
              n == "0" and psql(f"select count(*) from recording where path = '{cut_path}'") == "0" and events_of(whole) == str(deal), (n, events_of(whole)))
        r = upload({}, [("file", name_at(1), wav_bytes(0.5), "audio/wav")], {"X-Recorder-Token": token_a})
        short = r[1].get("id", 0) if r[0] == 201 else 0
        http("POST", "/calls/process", {}, token=admin)
        status_short = wait_for(lambda: psql(f"select status || ':' || coalesce(recording_id::text, '-') from call_upload where id = {short}"), f"duplicate:{rec_whole}", timeout=60)
        check("a shorter copy after the whole one -> duplicate of it, no second history entry",
              status_short == f"duplicate:{rec_whole}" and events_of(whole) == str(deal), (status_short, events_of(whole)))
        n = psql(f"select count(*) from recording r join call_upload u on u.recording_id = r.id where u.id in ({cut}, {whole}, {short})")
        check("... one recording for the three copies (the statistics count the call once)", psql(f"select count(distinct recording_id) from call_upload where id in ({cut}, {whole}, {short})") == "1", n)
        if stage_id:
            check("... and the «записан звонок» trigger fired once for the call", int(tasks_in(deal)) - int(before_tasks) == 1, (before_tasks, tasks_in(deal)))
        r = http("GET", "/calls/queue?status=duplicate", token=admin)
        check("GET /calls/queue?status=duplicate lists the copies with the reason",
              r[0] == 200 and {cut, short} <= {u["id"] for u in r[1]} and all(u["error"] for u in r[1] if u["id"] in (cut, short)), r[0])

        stranger2 = f"99878{random.randint(1000000, 9999999)}"
        r = upload({}, [("file", f"phone_20261121-120000__{stranger2}.wav", wav_bytes(1.11), "audio/wav"),
                        ("meta", f"phone_20261121-120000__{stranger2}.json", b"{not json", "application/json")], {"X-Recorder-Token": token_a})
        check("a .json that is not JSON: the recording is still accepted (it used to be refused and lost) -> 201",
              r[0] == 201 and r[1].get("status") == "pending", r)
        bad_meta = r[1].get("id", 0) if r[0] == 201 else 0
        row = psql(f"select from_number, to_char(recorded_at, 'YYYY-MM-DD HH24:MI:SS') from call_upload where id = {bad_meta}")
        check("... the number and the time come from the name of the file", row == f"{stranger2}|2026-11-21 12:00:00", row)
        process([bad_meta])
        rec_bad = psql(f"select recording_id from call_upload where id = {bad_meta}")
        r = http("POST", f"/calls/staff/{A['id']}/recordings/{rec_bad}/deal", {}, token=A["token"])
        check("«Создать сделку» by the agent on their own recording (from /lists/calls/:id) -> 201, a new client and deal",
              r[0] == 201 and r[1].get("created_contact") is True and r[1].get("created_deal") is True, r)
        if r[0] == 201:
            deal_ids.append(r[1]["deal"]["id"])
            extra_contacts.append(r[1].get("contact_id", 0))
            check("... the deal is the agent's", psql(f"select agent_id from deal where id = {r[1]['deal']['id']}") == str(A["id"]))

        print("== retry, discard, revoke")
        r = http("POST", f"/calls/queue/{up3}/retry", {}, token=admin)
        check("retry -> pending again", r[0] == 201 and r[1].get("status") == "pending", r)
        http("POST", "/calls/process", {}, token=admin)
        row = wait_for(lambda: psql(f"select status from call_upload where id = {up3}"), "failed", timeout=30)
        check("it fails again (same broken file)", row == "failed", row)
        r = http("POST", f"/calls/queue/{up1}/retry", {}, token=admin)
        check("a processed file cannot be retried -> 400", r[0] == 400, r)
        raw3 = psql(f"select raw_path from call_upload where id = {up3}")
        r = http("DELETE", f"/calls/queue/{up3}", token=admin)
        row = psql(f"select status from call_upload where id = {up3}")
        check("discard -> discarded" + (", the raw file deleted" if UPLOADS_DIR else ""), r[0] == 200 and row == "discarded" and (not UPLOADS_DIR or not os.path.exists(os.path.join(UPLOADS_DIR, raw3))), (r, row))
        r = http("DELETE", f"/calls/queue/{up3}", token=B["token"])
        check("an agent cannot discard -> 403", r[0] == 403, r)
        # the scheduler on its own
        r = upload({"duration": "2000", "number": "+" + digits, "direction": "Outgoing"}, [("file", f"{TAG}-4.wav", wav_bytes(1.2), "audio/wav")], {"X-Recorder-Token": token_a})
        up4 = r[1]["id"]
        status4 = wait_for(lambda: psql(f"select status from call_upload where id = {up4}"), "done", timeout=45)
        check("the scheduler processes a new upload by itself (CALLS_SCHEDULER_SEC)", status4 == "done", status4)
        r = http("DELETE", f"/calls/tokens/{A['id']}", token=admin)
        check("revoke -> 200", r[0] == 200 and r[1].get("revoked") == 1, r)
        r = upload({"duration": "1000"}, [("file", "x.wav", wav, "audio/wav")], {"X-Recorder-Token": token_a})
        check("the revoked token -> 401", r[0] == 401, r)
        r = http("GET", "/calls/tokens", token=admin)
        row = next((t for t in r[1] if t["user_id"] == A["id"]), None)
        check("the token list shows A without a token", row and row["has_token"] is False, row)
        r = http("POST", "/calls/tokens", {"user_id": A["id"]}, token=admin)
        r2 = http("POST", "/calls/tokens", {"user_id": A["id"]}, token=admin)
        check("reissuing replaces the token: the first one stops working", r[0] == 201 and r2[0] == 201 and
              upload({"duration": "1000"}, [("file", "x.wav", wav, "audio/wav")], {"X-Recorder-Token": r[1]["token"]})[0] == 401, (r[0], r2[0]))

    finally:
        print("== cleanup")
        ids = ",".join(str(u["id"]) for u in users.values()) or "0"
        deals = ",".join(str(d) for d in deal_ids) or "0"
        if UPLOADS_DIR:
            for path in psql(f"select coalesce(r.path, '') || '|' || coalesce(u.raw_path, '') from call_upload u left join recording r on r.id = u.recording_id where u.user_id in ({ids})").split("\n"):
                for name in path.split("|"):
                    if name:
                        try:
                            os.remove(os.path.join(UPLOADS_DIR, name))
                        except OSError:
                            pass
        psql(";".join([
            "begin",
            f"delete from event where deal_id in ({deals}) or user_id in ({ids}) or target_user_id in ({ids}) or user_id in (select id from \"user\" where username like '{TAG}%')",
            f"delete from task where deal_id in ({deals})",
            f"delete from trigger_run where deal_id in ({deals}) or trigger_id in (select id from trigger where deal_stage_id = {stage_id or 0})",
            f"delete from trigger where deal_stage_id = {stage_id or 0}",
            f"delete from call_upload where user_id in ({ids})",
            f"delete from recording where user_id in ({ids})",
            f"delete from recorder_token where user_id in ({ids})",
            f"delete from deal_stage_record where deal_id in ({deals})",
            f"delete from deal_user where \"dealId\" in ({deals})",
            f"delete from deal where id in ({deals})",
            f"delete from deal_stage where id = {stage_id or 0}",
            f"update company set primary_contact_id = null where name like '{TAG}%'",
            f"delete from \"user\" where username like '{TAG}%' or id in ({','.join(str(c) for c in extra_contacts if c) or '0'})",
            f"delete from company where name like '{TAG}%'",
            "commit",
        ]))
        left = psql(f"select (select count(*) from \"user\" where username like '{TAG}%') + (select count(*) from deal where id in ({deals})) + (select count(*) from recording where user_id in ({ids}))"
                    f" + (select count(*) from company where name like '{TAG}%')")
        check("test rows removed", left == "0", left)

    print(f"\nRESULT: {results['PASS']} passed, {results['FAIL']} failed")
    return 1 if results["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
