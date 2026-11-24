#!/usr/bin/env python3
"""Checks for the FTP receiver of call recordings (parisahon-ftp, unit crm-dev-ftp) together with the
API behind it (src/calls): login with the manager's recorder token, the home folder, and that what a
phone's sync app uploads reaches the queue of that manager (POST /calls/upload, source "ftp").

    local/dev/check.sh ftp      (or: source local/dev/env.sh; python3 local/checks/ftp_check.py)
The FTP address is CALLS_FTP_ADDRESS of the API's env file (or CRM_FTP_ADDRESS); with CRM_FTP_ENV_FILE
(the service's env file, dev copy) its scan timings are read and the test homes are removed from the disk.
Everything it creates is named AUDIT-ftp-<run> (users, files) and removed at the end (rows and files).
Standard library only (ftplib).
"""
import ftplib
import io
import json
import math
import os
import secrets
import shlex
import shutil
import ssl
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASE = os.environ.get("CRM_API_URL", "http://localhost:8080/api/v1").rstrip("/")
ENV_FILE = os.environ.get("CRM_ENV_FILE") or os.path.join(ROOT, "parisahon-api", ".env")
FTP_ENV_FILE = os.environ.get("CRM_FTP_ENV_FILE") or ""
COMPOSE_FILE = os.path.join(ROOT, "docker-compose.local.yml")
PSQL = (shlex.split(os.environ["CRM_PSQL"]) if os.environ.get("CRM_PSQL") else
        ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])
# where the API keeps its files, when it is on this machine (dev copy); None = not cleaned
UPLOADS_DIR = os.path.join(os.environ["CRM_APP_DIR"], "public", "uploads") if os.environ.get("CRM_APP_DIR") else None

RUN = secrets.token_hex(3)
TAG = f"AUDIT-ftp-{RUN}"
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


def env_value(key, default=None, path=None):
    try:
        for line in open(path or ENV_FILE, encoding="utf-8"):
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return default


def psql(sql):
    done = subprocess.run(PSQL + ["-At", "-c", sql], capture_output=True, text=True, encoding="utf-8")
    if done.returncode != 0:
        raise RuntimeError(f"psql failed: {done.stderr.strip()}\n{sql}")
    return done.stdout.strip()


def http(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data, headers={"Content-Type": "application/json"} if body is not None else {})
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for attempt in range(40):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
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


def wav_bytes(freq, seconds=1.0, rate=8000):
    """A short tone: a valid audio file ffmpeg can convert; another frequency is another content."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * freq * i / rate))) for i in range(int(rate * seconds))))
    return buf.getvalue()


def wait_for(fn, timeout, step=0.5):
    deadline = time.time() + timeout
    value = fn()
    while not value and time.time() < deadline:
        time.sleep(step)
        value = fn()
    return value


class Ftp:
    """ftplib with the answers the checks need."""

    def __init__(self, host, port):
        self.host, self.port = host, port

    def connect(self, tls=False):
        client = ftplib.FTP_TLS(context=ssl._create_unverified_context()) if tls else ftplib.FTP()  # the dev certificate is self-signed
        client.encoding = "utf-8"
        client.connect(self.host, self.port, timeout=20)
        return client

    def login(self, user, password, tls=False):
        """-> (client, None) or (None, the server's refusal)."""
        client = self.connect(tls)
        try:
            client.login(user, password)
            if tls:
                client.prot_p()
            return client, None
        except ftplib.all_errors as error:
            try:
                client.close()
            except Exception:
                pass
            return None, str(error)


def refused(client, command):
    """The server's 5xx answer to a command, or None when it was accepted."""
    try:
        if command.startswith("RETR "):
            client.retrbinary(command, lambda chunk: None)
        else:
            client.sendcmd(command)
        return None
    except ftplib.error_perm as error:
        return str(error)


def main():
    address = os.environ.get("CRM_FTP_ADDRESS") or env_value("CALLS_FTP_ADDRESS") or ""
    host, _, port = address.rpartition(":")
    if not host or not port.isdigit():
        raise SystemExit(f"CALLS_FTP_ADDRESS (host:port of the FTP receiver) is not set in {ENV_FILE}: run local/dev/ftp-env.sh")
    ftp = Ftp(host, int(port))
    ftp_root = env_value("FTP_ROOT", path=FTP_ENV_FILE) if FTP_ENV_FILE else None
    settle = float(env_value("FTP_SETTLE_SEC", "5", path=FTP_ENV_FILE) or 5) if FTP_ENV_FILE else 5.0
    scan = float(env_value("FTP_SCAN_SEC", "10", path=FTP_ENV_FILE) or 10) if FTP_ENV_FILE else 10.0
    forward_wait = settle + scan + 20  # a file is sent a settle time after its last change, at the next look
    banner = None
    for attempt in range(15):  # it may have been restarted a moment ago
        try:
            banner = ftp.connect().getwelcome()
            break
        except (OSError, EOFError) as error:
            if attempt == 14:
                raise SystemExit(f"the FTP receiver does not answer at {address}: {error} (local/dev/units.sh status)")
            time.sleep(2)

    status, body = http("POST", "/auth/login", {"email": "admin@gmail.com", "password": env_value("ADMIN_PASSWORD")})
    if status not in (200, 201):
        raise SystemExit(f"admin login failed: {status}")
    admin = body["access_token"]
    groups = sorted(g["id"] for g in http("GET", "/groups", token=admin)[1])
    perms = {"deal": {"view": 3, "create": 3, "update": 3, "delete": 0, "export": 0},
             "contact": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
             "company": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
             "task": {"update": 1, "delete": 0}, "mail": True, "file": True}

    users, clients = {}, []

    def rows(user_id):
        """The manager's rows in the API's queue: [(id, source, file name)]."""
        out = psql(f"select id, source, file_name from call_upload where user_id = {user_id} order by id")
        return [tuple(line.split("|", 2)) for line in out.split("\n") if line]

    def names(user_id):
        return [name for _id, _source, name in rows(user_id)]

    def store(client, name, data):
        client.storbinary("STOR " + name, io.BytesIO(data))

    try:
        print("== setup")
        for key in ("a", "b"):
            person = {"email": f"audit-ftp-{RUN}-{key}@example.test", "password": secrets.token_urlsafe(12),
                      "username": f"{TAG}-{key}", "role": "agent", "group_id": groups[0], "permissions": perms}
            status, created = http("POST", "/users", person, admin)
            if status != 201:
                raise SystemExit(f"cannot create user {key}: {status} {created}")
            person["id"] = created["id"]
            status, issued = http("POST", "/calls/tokens", {"user_id": person["id"]}, token=admin)
            if status != 201 or not issued.get("token"):
                raise SystemExit(f"cannot issue a recorder token: {status} {issued}")
            person["token"] = issued["token"]
            users[key] = person
        A, B = users["a"], users["b"]

        print("== login")
        check("the receiver answers with its banner", banner.startswith("220"), banner)
        client, why = ftp.login("crm", "rec_" + secrets.token_hex(24))
        check("an unknown recorder token is refused -> 530", client is None and why.startswith("530"), why)
        client, why = ftp.login(A["email"], A["password"])
        check("the CRM login and password are not an FTP login -> 530", client is None and why.startswith("530"), why)
        client, why = ftp.login("anonymous", "guest@example.test")
        check("anonymous is refused -> 530", client is None and why.startswith("530"), why)
        a, why = ftp.login("crm", A["token"])
        check("the manager's recorder token as the password logs in", a is not None, why)
        if a is None:
            raise SystemExit("no FTP login with a fresh recorder token: is the receiver talking to this API? (CRM_API_URL in its env)")
        clients.append(a)
        other, why = ftp.login(f"любое имя {RUN}", A["token"])
        check("any user name works with the token", other is not None, why)
        if other:
            other.quit()
        b, why = ftp.login("crm", B["token"])
        check("a second manager logs in with the same user name and her own token", b is not None, why)
        clients.append(b)
        features = a.sendcmd("FEAT")
        check("the server offers UTF8 names and MFMT (sync apps set the recording's time)", "UTF8" in features and "MFMT" in features, features)

        print("== home")
        check("the session starts in / and the folder is empty", a.pwd() == "/" and a.nlst() == [], (a.pwd(),))
        a.cwd("..")
        a.cwd("/../..")
        check("cd .. does not leave the home", a.pwd() == "/", a.pwd())
        hidden = f"{TAG} только А.wav"
        store(a, hidden, wav_bytes(300, 0.2))
        check("B does not see A's file", hidden in a.nlst() and b.nlst() == [], b.nlst())
        tries = [f"SIZE /../{A['id']}/{hidden}", f"RETR ../{A['id']}/{hidden}", f"CWD /../{A['id']}", f"DELE ../{A['id']}/{hidden}", f"RNFR ../{A['id']}/{hidden}"]
        if ftp_root:
            tries += [f"CWD {ftp_root}/{A['id']}", f"SIZE {ftp_root}/{A['id']}/{hidden}"]
        answers = {command: refused(b, command) for command in tries}
        check("B cannot reach A's folder by any path -> 550", all(answer and answer.startswith("550") for answer in answers.values()), answers)
        a.voidcmd("TYPE I")
        check("A's file is untouched", a.size(hidden) == len(wav_bytes(300, 0.2)))
        a.delete(hidden)

        print("== upload")
        cube = f"2026-11-21 14-03-12 (phone) {TAG} Client (+998 90 000-00-00) ↗.wav"
        wav_cube = wav_bytes(440)
        store(a, cube, wav_cube)
        got = wait_for(lambda: [r for r in rows(A["id"]) if r[2] == cube], forward_wait)
        check("a Cube ACR file reaches the API queue of that manager: source ftp, the same file name (Cyrillic, arrow)",
              len(got) == 1 and got[0][1] == "ftp", (got, rows(A["id"])))
        r = http("GET", f"/calls/queue?status=all&user_id={A['id']}", token=admin)
        item = next((u for u in r[1] if u["file_name"] == cube), None) if r[0] == 200 else None
        check("GET /calls/queue shows it with the manager", bool(item) and item["source"] == "ftp" and item["user"]["id"] == A["id"], r)
        a.voidcmd("TYPE A")
        listed = a.nlst()
        a.voidcmd("TYPE I")
        check("the file is still listed after it was forwarded (a sync app would upload a missing one again)", cube in listed and a.size(cube) == len(wav_cube), listed)

        # what sync apps do: a temporary name, then rename, then the recording's own time
        final = f"{TAG} запись ↙.wav"
        wav_final = wav_bytes(520)
        when = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=3)
        store(a, final + ".tmp", wav_final)
        a.rename(final + ".tmp", final)
        mfmt = a.sendcmd(f"MFMT {when:%Y%m%d%H%M%S} {final}")
        # the same recording once more under another name, something that is not audio, a subfolder
        store(a, f"{TAG} копия.wav", wav_cube)
        store(a, f"{TAG} notes.txt", b"not a call")
        a.mkd(f"{TAG} папка")
        nested = f"{TAG} вложенный.wav"
        store(a, f"{TAG} папка/{nested}", wav_bytes(600))
        store(b, cube, wav_cube)  # B's phone recorded the same bytes: her own call
        wait_for(lambda: nested in names(A["id"]) and final in names(A["id"]) and names(B["id"]), forward_wait)
        time.sleep(min(scan, 3))  # anything else the receiver wanted to send in that look is out by now
        got = names(A["id"])
        check("upload under a temporary name + rename is forwarded once, under the final name",
              got.count(final) == 1 and not any(name.endswith(".tmp") for name in got), got)
        check("MFMT is accepted", mfmt.startswith("213"), mfmt)
        # a moment as it is (timestamptz, migration 1795729000000-timestamptz), a local time of the CRM's zone before it
        epoch = psql("select extract(epoch from case when pg_typeof(recorded_at) = 'timestamptz'::regtype then recorded_at::timestamptz "
                     f"else recorded_at at time zone 'Asia/Tashkent' end)::bigint from call_upload where user_id = {A['id']} and file_name = '{final}'")
        check("the file's time (set by the phone with MFMT) is the call's time in the queue", epoch == str(int(when.timestamp())), (epoch, int(when.timestamp())))
        check("a file in a subfolder is forwarded under its own name", got.count(nested) == 1, got)
        check("the same bytes again under another name: no second upload", f"{TAG} копия.wav" not in got and len(got) == 3, got)
        check("a file that is not audio is ignored", not any("notes" in name for name in got), got)
        got_b = rows(B["id"])
        check("the same bytes from another manager's phone are her own upload", len(got_b) == 1 and got_b[0][1:] == ("ftp", cube), got_b)
        a.voidcmd("TYPE A")
        listed = sorted(a.nlst())
        check("everything uploaded stays in the folder", listed == sorted([cube, final, f"{TAG} копия.wav", f"{TAG} notes.txt", f"{TAG} папка"]), listed)

        if "AUTH TLS" in features:
            secure, why = ftp.login("crm", A["token"], tls=True)
            check("FTPS (AUTH TLS) login works too", secure is not None, why)
            if secure:
                clients.append(secure)
                over_tls = f"{TAG} через TLS.wav"
                store(secure, over_tls, wav_bytes(700))
                got = wait_for(lambda: over_tls in names(A["id"]), forward_wait)
                check("a file uploaded over FTPS is forwarded", bool(got), names(A["id"]))
        else:
            print("SKIP  FTPS: the receiver has no certificate (FTP_TLS_CERT / FTP_TLS_KEY)")

        print("== after")
        r = http("DELETE", f"/calls/tokens/{B['id']}", token=admin)
        b.voidcmd("NOOP")
        check("a session that is already open goes on after the token is revoked (a new login is refused once the receiver's cache of ~5 min is over)", r[0] == 200, r)

    finally:
        print("== cleanup")
        for client in clients:
            try:
                client.close()
            except Exception:
                pass
        ids = ",".join(str(u["id"]) for u in users.values() if u.get("id")) or "0"
        try:
            http("POST", "/calls/process", {}, token=admin)  # nothing of ours is left for the scheduler to pick up
        except BaseException:
            pass
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
            f"delete from event where user_id in ({ids}) or target_user_id in ({ids})",
            f"delete from call_upload where user_id in ({ids})",
            f"delete from recording where user_id in ({ids})",
            f"delete from recorder_token where user_id in ({ids})",
            f"delete from \"user\" where username like '{TAG}%'",
            "commit",
        ]))
        homes_left = 0
        if ftp_root:
            # the receiver forgets a manager whose folder is gone
            for user in users.values():
                home = os.path.join(ftp_root, str(user.get("id") or "x"))
                if user.get("id") and os.path.isdir(home):
                    shutil.rmtree(home, ignore_errors=True)
                homes_left += os.path.exists(home)
        left = psql(f"select (select count(*) from \"user\" where username like '{TAG}%') + (select count(*) from call_upload where user_id in ({ids})) + (select count(*) from recording where user_id in ({ids}))")
        check("test rows and folders removed", left == "0" and homes_left == 0, (left, homes_left))

    print(f"\nRESULT: {results['PASS']} passed, {results['FAIL']} failed")
    return 1 if results["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
