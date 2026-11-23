#!/usr/bin/env python3
"""
Regression checks for the files module: upload to a deal -> list -> download -> delete.

    py local/checks/files_check.py

* Python stdlib only.
* Talks to the LOCAL stack only: API http://localhost:8080/api/v1, database through
  `docker compose -f docker-compose.local.yml exec crm-db psql` (fixtures, assertions on rows, cleanup).
  With the CRM_* variables from local/dev/env.sh it talks to the dev copy on the server instead
  (CRM_API_URL, CRM_PSQL, CRM_ENV_FILE).
* Admin password is read from parisahon-api/.env and never printed.
* Everything it creates is named AUDIT-files-<run> and is removed at the end, the files in
  parisahon-api/public/uploads included, also when the run is interrupted. A run starts with the
  same cleanup, so a crashed run does not poison the next one.
* Prints PASS/FAIL per check, exits 1 if anything failed.

Covered: upload limits (size, count, file names, page-like files), the list with its filters,
pagination and rights (admin / agent / agent without the "files" switch / no login; an agent with
"own deals" sees the files of their deals and their own uploads, e-mail attachments only with the
mail switch and of their own address), download
(no login, no path traversal), deleting from a deal (the row and the file on disk go only when
nothing else refers to the file: another deal, a deal in the trash, an e-mail, a Telegram
message), the file in the comment history, no files left on disk by failed requests.
"""
import base64
import datetime
import http.client as httpclient
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
ENV_FILE = os.environ.get("CRM_ENV_FILE") or os.path.join(ROOT, "parisahon-api", ".env")
COMPOSE_FILE = os.path.join(ROOT, "docker-compose.local.yml")
UPLOADS_DIR = os.path.join(ROOT, "parisahon-api", "public", "uploads")
CLIENT_SERVICE = os.path.join(ROOT, "parisahon-client", "app", "composables", "useService.ts")
BASE = os.environ.get("CRM_API_URL", "http://localhost:8080/api/v1").rstrip("/")


def _cmd(var, default):
    value = os.environ.get(var)
    return shlex.split(value) if value else default


PSQL = _cmd("CRM_PSQL", ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])

RUN = str(int(time.time()))[-6:]
P = "AUDIT-files-" + RUN  # prefix of everything this run creates
MB = 1024 * 1024
MAX_FILE = 10 * MB  # FileService.MAX_FILE_SIZE
HEX_NAME = re.compile(r"^[0-9a-f]{64}(\.[a-z0-9]{1,16})?$")

EVENT_NEW_COMMENT = 5
EVENT_NEW_TELEGRAM_MESSAGE = 12

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


def note(text):
    print("NOTE  " + text, flush=True)


def section(title):
    print("\n== " + title, flush=True)


def env(key):
    with open(ENV_FILE, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"\s*%s\s*=\s*(.*)" % re.escape(key), line)
            if not m:
                continue
            value = m.group(1).strip()
            if value[:1] in ("'", '"'):
                return value[1:value.index(value[0], 1)]
            return value.split(" #")[0].strip()
    raise SystemExit("%s is not set in %s" % (key, ENV_FILE))


def sql(query):
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


def q(text):
    return "'" + str(text).replace("'", "''") + "'"


def http(method, path, body=None, raw=None, headers=None, token=None):
    """
    Returns (status, parsed json | text | None).
    The API restarts on every source change (nest --watch) and answers 502 / refuses meanwhile: retry.
    """
    url = BASE + urllib.parse.quote(path, safe="/?=&[]%:,+-_.~")
    hdrs = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    if raw is not None:
        data = raw
    if headers:
        hdrs.update(headers)
    if token:
        hdrs["Authorization"] = "Bearer " + token

    deadline = time.time() + 120
    while True:
        request = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
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


def fetch_raw(url):
    """GET exactly this URL (no quoting, no normalisation): (status, headers, bytes)."""
    parts = urllib.parse.urlsplit(url)
    target = parts.path + ("?" + parts.query if parts.query else "")
    deadline = time.time() + 120
    while True:
        conn = httpclient.HTTPConnection(parts.hostname, parts.port or 80, timeout=60)
        try:
            conn.request("GET", target)
            response = conn.getresponse()
            result = response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
        except (ConnectionError, OSError) as error:
            if time.time() > deadline:
                raise SystemExit("API is not reachable: %s" % error)
            time.sleep(3)
            continue
        finally:
            conn.close()
        if result[0] in (502, 503, 504) and time.time() < deadline:
            time.sleep(3)
            continue
        return result


def message_of(response):
    body = response[1]
    if isinstance(body, dict):
        message = body.get("message")
        return " ".join(message) if isinstance(message, list) else str(message)
    return str(body)


def multipart(fields, files=()):
    """files: (field, filename, bytes[, content type])"""
    boundary = "----auditfiles" + secrets.token_hex(8)
    body = b""
    for name, value in fields.items():
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n" % (boundary, name, value)).encode("utf-8")
    for item in files:
        name, filename, content = item[:3]
        ctype = item[3] if len(item) > 3 else "application/octet-stream"
        # raw UTF-8 in filename="...", as browsers send it
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
                 "Content-Type: %s\r\n\r\n" % (boundary, name, filename, ctype)).encode("utf-8")
        body += content + b"\r\n"
    body += ("--%s--\r\n" % boundary).encode("utf-8")
    return body, {"Content-Type": "multipart/form-data; boundary=" + boundary}


def login(email, password):
    status, body = http("POST", "/auth/login", {"email": email, "password": password})
    if status not in (200, 201) or not isinstance(body, dict) or "access_token" not in body:
        raise SystemExit("login failed for %s: HTTP %s" % (email, status))
    return body["access_token"]


def user_id_of(token):
    payload = token.split(".")[1]
    return int(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["sub"])


def client_query_string(query):
    """The client's own queryToString() (composables/useService.ts), run with node."""
    with open(CLIENT_SERVICE, encoding="utf-8") as fh:
        text = fh.read()
    source = text[text.index("function subQueryToString"):text.index("// --- Service Response Wrapper")]
    source = source.replace("export function", "function")
    js = ("let input='';process.stdin.on('data',(c)=>input+=c);process.stdin.on('end',()=>{"
          "const {source,query}=JSON.parse(input);const ts=require('typescript');"
          "const out=ts.transpileModule(source,{compilerOptions:{target:'ES2021',module:'commonjs'}}).outputText;"
          "const queryToString=new Function(out+'; return queryToString;')();"
          "console.log(JSON.stringify(queryToString(query)));});")
    proc = subprocess.run(["node", "-e", js], input=json.dumps({"source": source, "query": query}),
                          capture_output=True, text=True, encoding="utf-8",
                          cwd=os.path.join(ROOT, "parisahon-api"))
    if proc.returncode != 0:
        return None
    return json.loads(proc.stdout.strip().splitlines()[-1])


def disk_names():
    try:
        return set(os.listdir(UPLOADS_DIR))
    except FileNotFoundError:
        return set()


def unreferenced(names):
    """Names on disk that no row refers to (file, call recording, call upload)."""
    names = sorted(names)
    if not names:
        return []
    listed = ",".join(q(n) for n in names)
    used = {r[0] for r in sql(
        "SELECT path FROM file WHERE path IN (%s) UNION SELECT path FROM recording WHERE path IN (%s) "
        "UNION SELECT raw_path FROM call_upload WHERE raw_path IN (%s)" % (listed, listed, listed))}
    return [n for n in names if n not in used]


def on_disk(path):
    return os.path.isfile(os.path.join(UPLOADS_DIR, os.path.basename(path)))


# --------------------------------------------------------------------------- cleanup

CLEANUP_SQL = r"""
CREATE TEMP TABLE _d AS SELECT id FROM deal WHERE label LIKE 'AUDIT-files-%';
CREATE TEMP TABLE _u AS SELECT id FROM "user" WHERE username LIKE 'AUDIT-files-%';
CREATE TEMP TABLE _f AS SELECT id FROM file WHERE name LIKE 'AUDIT-files-%'
   OR email_id IN (SELECT id FROM email WHERE subject LIKE 'AUDIT-files-%');
DELETE FROM event WHERE deal_id IN (SELECT id FROM _d) OR user_id IN (SELECT id FROM _u)
   OR target_user_id IN (SELECT id FROM _u);
DELETE FROM deal_file WHERE "dealId" IN (SELECT id FROM _d) OR "fileId" IN (SELECT id FROM _f);
DELETE FROM file WHERE id IN (SELECT id FROM _f) OR uploaded_by IN (SELECT id FROM _u);
DELETE FROM email WHERE subject LIKE 'AUDIT-files-%';
DELETE FROM deal_stage_record WHERE deal_id IN (SELECT id FROM _d);
DELETE FROM deal WHERE id IN (SELECT id FROM _d);
DELETE FROM bot_account WHERE user_id IN (SELECT id FROM _u);
DELETE FROM bot_link_code WHERE user_id IN (SELECT id FROM _u);
DELETE FROM "user" WHERE id IN (SELECT id FROM _u);
"""

LEFTOVERS_SQL = r"""
SELECT 'deal', count(*) FROM deal WHERE label LIKE 'AUDIT-files-%'
UNION ALL SELECT 'user', count(*) FROM "user" WHERE username LIKE 'AUDIT-files-%'
UNION ALL SELECT 'file', count(*) FROM file WHERE name LIKE 'AUDIT-files-%'
UNION ALL SELECT 'email', count(*) FROM email WHERE subject LIKE 'AUDIT-files-%'
UNION ALL SELECT 'event', count(*) FROM event WHERE after_state::text LIKE '%AUDIT-files-%'
"""

CREATED_ON_DISK = set()  # names this run wrote to the uploads folder


def cleanup():
    paths = {r[0] for r in sql(
        "SELECT path FROM file WHERE name LIKE 'AUDIT-files-%' "
        "OR email_id IN (SELECT id FROM email WHERE subject LIKE 'AUDIT-files-%')")}
    for name in {os.path.basename(p) for p in paths} | CREATED_ON_DISK:
        target = os.path.join(UPLOADS_DIR, name)
        if name and os.path.isfile(target):
            try:
                os.remove(target)
            except OSError:
                pass
    sql(CLEANUP_SQL)


def leftovers():
    left = {name: int(n) for name, n in sql(LEFTOVERS_SQL) if int(n) > 0}
    on_disk_left = sorted(n for n in CREATED_ON_DISK if os.path.isfile(os.path.join(UPLOADS_DIR, n)))
    if on_disk_left:
        left["files on disk"] = len(on_disk_left)
    return left


# --------------------------------------------------------------------------- the run

def main():
    cleanup()
    admin = login("admin@gmail.com", env("ADMIN_PASSWORD"))
    admin_id = user_id_of(admin)
    group_id = int(scalar('SELECT id FROM "group" ORDER BY id LIMIT 1'))
    stage_id = int(scalar("SELECT s.id FROM deal_stage s JOIN collection c ON c.id = s.collection_id "
                          "WHERE c.is_active = true ORDER BY s.\"order\", s.id LIMIT 1"))
    api_root = BASE[:-len("/api/v1")] if BASE.endswith("/api/v1") else BASE

    # ----------------------------------------------------------------- fixtures
    def new_deal(suffix, deleted=False):
        return int(scalar(
            "INSERT INTO deal (label, display_id, budget, stage_id, agent_id, created_by, deleted_at) "
            "VALUES (%s, %d, 100, %d, %d, %d, %s) RETURNING id"
            % (q("%s-deal-%s" % (P, suffix)), 900000000 + secrets.randbelow(90000000), stage_id,
               admin_id, admin_id, "now()" if deleted else "NULL")))

    deal1, deal2 = new_deal("1"), new_deal("2")
    trashed = new_deal("trash", deleted=True)

    permissions = {
        "deal": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
        "contact": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
        "company": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
        "task": {"update": 3, "delete": 3},
        "mail": True,
        "file": True,
    }

    def new_agent(suffix, file_switch):
        person = {"email": "audit-files-%s-%s@example.test" % (suffix, RUN), "password": secrets.token_urlsafe(12)}
        perms = dict(permissions, file=file_switch)
        status, body = http("POST", "/users", {
            "email": person["email"], "password": person["password"], "username": "%s-%s" % (P, suffix),
            "role": "agent", "group_id": group_id, "permissions": perms,
        }, token=admin)
        if status != 201 or not isinstance(body, dict):
            raise SystemExit("cannot create the test agent: %s %s" % (status, message_of((status, body))))
        person["id"] = body["id"]
        person["token"] = login(person["email"], person["password"])
        return person

    agent = new_agent("agent", True)
    agent_nofiles = new_agent("agent-nofiles", False)

    def upload(deal_id, files, token=admin, route="files", fields=None):
        raw, hdr = multipart(fields or {}, files)
        before = disk_names()
        response = http("POST", "/deals/%d/%s" % (deal_id, route), raw=raw, headers=hdr, token=token)
        CREATED_ON_DISK.update(disk_names() - before)
        return response, disk_names() - before

    def file_row(file_id):
        rows = sql("SELECT name, path, size, extension, \"from\", uploaded_by FROM file WHERE id = %d" % file_id)
        if not rows:
            return None
        name, path, size, ext, src, by = rows[0]
        return {"name": name, "path": path, "size": int(size), "extension": ext, "from": src,
                "uploaded_by": int(by) if by else None}

    def links(file_id):
        return sorted(int(r[0]) for r in sql('SELECT "dealId" FROM deal_file WHERE "fileId" = %d' % file_id))

    # ================================================================= upload
    section("Upload to a deal (POST /deals/:id/files)")
    content = b"audit file " + RUN.encode()
    r, new = upload(deal1, [("files", P + "-note.txt", content, "text/plain")])
    ok = check("one small file -> 201 with one row", r[0] == 201 and isinstance(r[1], list) and len(r[1]) == 1, r)
    note_file = r[1][0] if ok else {}
    row = file_row(note_file.get("id", 0)) if ok else None
    check("row: name, size, extension .txt, source 'uploaded_from_files_tab', uploader = admin",
          row and row["name"] == P + "-note.txt" and row["size"] == len(content) and row["extension"] == ".txt"
          and row["from"] == "uploaded_from_files_tab" and row["uploaded_by"] == admin_id, row)
    check("the file is linked to the deal", ok and links(note_file["id"]) == [deal1], ok and links(note_file["id"]))
    check("name on disk: 64 random hex characters + .txt", row and HEX_NAME.match(row["path"]) and row["path"].endswith(".txt"), row)
    check("the file is on disk with the same bytes",
          row and on_disk(row["path"]) and open(os.path.join(UPLOADS_DIR, row["path"]), "rb").read() == content, row)
    check("response: uploader is {id, username} only (no permissions / phone / email)",
          ok and set((note_file.get("uploaded_by") or {}).keys()) == {"id", "username"}, ok and note_file.get("uploaded_by"))
    check("response: no deal list", ok and "deals" not in note_file, ok and list(note_file))

    r, _ = upload(deal1, [("files", P + "-Договор поставки.pdf", b"%PDF-1.4 audit", "application/pdf")])
    cyr = r[1][0] if r[0] == 201 else {}
    check("Cyrillic file name is kept as sent (was read as latin1: mojibake)",
          r[0] == 201 and cyr.get("name") == P + "-Договор поставки.pdf"
          and scalar("SELECT name FROM file WHERE id = %d" % cyr["id"]) == P + "-Договор поставки.pdf", r)
    check("extension of the Cyrillic file -> .pdf", cyr.get("extension") == ".pdf", cyr)

    r, _ = upload(deal1, [("files", P + "-PHOTO.JPG", b"\xff\xd8\xff audit jpeg", "image/jpeg")])
    jpg = r[1][0] if r[0] == 201 else {}
    check("upper-case extension is stored lower-case (.jpg)", jpg.get("extension") == ".jpg" and jpg.get("path", "").endswith(".jpg"), r)

    r, _ = upload(deal1, [("files", P + "-page.html", b"<script>alert(1)</script>", "text/html")])
    page = r[1][0] if r[0] == 201 else {}
    check("a page-like file (.html) is stored on disk as .bin, the row keeps .html",
          r[0] == 201 and page.get("path", "").endswith(".bin") and page.get("extension") == ".html", r)

    r, _ = upload(deal1, [("files", P + "-a.txt", b"a", "text/plain"), ("files", P + "-b.txt", b"b", "text/plain")])
    check("two files in one request -> 201, two rows", r[0] == 201 and len(r[1]) == 2, r)

    big = b"x" * (3 * MB)
    r, _ = upload(deal1, [("files", P + "-3mb.bin", big)])
    check("3 MB file (over the old 2 MB limit) -> 201", r[0] == 201, (r[0], message_of(r)))
    three_mb = r[1][0] if r[0] == 201 else {}

    r, new = upload(deal1, [("files", P + "-too-big.bin", b"x" * (MAX_FILE + 1))])
    check("file over 10 MB -> 413", r[0] == 413, (r[0], message_of(r)))
    check("... no row and nothing left on disk",
          count("SELECT count(*) FROM file WHERE name = %s" % q(P + "-too-big.bin")) == 0 and not unreferenced(new), new)

    r, new = upload(deal1, [("files", "%s-many-%d.txt" % (P, i), b"m") for i in range(11)])
    check("11 files in one request -> refused (413 / 400)", r[0] in (400, 413), (r[0], message_of(r)))
    check("... no rows and nothing left on disk",
          count("SELECT count(*) FROM file WHERE name LIKE %s" % q(P + "-many-%")) == 0 and not unreferenced(new), new)

    r, new = upload(99999999, [("files", P + "-lost.txt", b"lost")])
    check("upload to a missing deal -> 404", r[0] == 404, r)
    check("... the written file is removed from disk (was left as an orphan)", not unreferenced(new), unreferenced(new))

    r, new = upload(trashed, [("files", P + "-trash.txt", b"trash")])
    check("upload to a deal in the trash -> 404", r[0] == 404, r)
    check("... nothing left on disk", not unreferenced(new), unreferenced(new))

    r, new = upload(deal1, [("files", P + "-bad-comment.txt", b"bad")], route="comments", fields={"comment": "x"})
    check("comment that fails validation (1 char) with a file -> 400", r[0] == 400, r)
    check("... nothing left on disk (multer wrote it before validation)", not unreferenced(new), unreferenced(new))

    raw, hdr = multipart({}, [("files", P + "-anon.txt", b"anon")])
    before = disk_names()
    status, _ = http("POST", "/deals/%d/files" % deal1, raw=raw, headers=hdr)
    new = disk_names() - before
    CREATED_ON_DISK.update(new)
    check("upload without login -> 401, nothing written", status == 401 and not unreferenced(new), (status, new))

    r, _ = upload(deal1, [("files", P + "-by-agent.txt", b"agent file", "text/plain")], token=agent["token"])
    by_agent = r[1][0] if r[0] == 201 else {}
    check("agent uploads to a deal -> 201, uploader = the agent",
          r[0] == 201 and (file_row(by_agent["id"]) or {}).get("uploaded_by") == agent["id"], r)
    r, _ = upload(deal2, [("files", P + "-by-nofiles.txt", b"x", "text/plain")], token=agent_nofiles["token"])
    check("agent without the 'files' switch still uploads in the deal's files tab -> 201", r[0] == 201, r)

    # ================================================================= list
    section("List of files (GET /files)")
    mine = "name=" + urllib.parse.quote(P)
    status, body = http("GET", "/files?%s&limit=100" % mine, token=admin)
    ok = check("admin -> 200", status == 200, (status, message_of((status, body))))
    data = body.get("data", []) if ok else []
    ids = [f["id"] for f in data]
    check("all files of this run are listed (count = rows)",
          ok and body.get("count") == len(data) == count("SELECT count(*) FROM file WHERE name LIKE %s" % q(P + "%")),
          (body.get("count") if ok else None, len(data)))
    check("newest first without a sort", ids == sorted(ids, reverse=True), ids[:5])
    check("uploader: {id, username} only", data and all(set((f.get("uploaded_by") or {}).keys()) <= {"id", "username"} for f in data),
          [f.get("uploaded_by") for f in data[:2]])
    check("deals: the linked deal is listed (id, label)",
          any(f["id"] == note_file.get("id") and [d["id"] for d in f.get("deals", [])] == [deal1] for f in data))
    check("no e-mail body / subject in the list (behind the mail switch)",
          all(f.get("email") is None or set(f["email"].keys()) <= {"id"} for f in data))

    status, page1 = http("GET", "/files?%s&limit=3&skip=0" % mine, token=admin)
    status2, page2 = http("GET", "/files?%s&limit=3&skip=3" % mine, token=admin)
    check("pagination: limit=3 pages do not overlap, last_page = ceil(count / 3)",
          status == status2 == 200 and len(page1["data"]) == 3 and page1["last_page"] == -(-page1["count"] // 3)
          and not {f["id"] for f in page1["data"]} & {f["id"] for f in page2["data"]}, (status, status2))
    status, body = http("GET", "/files?%s&limit=100&sort[size]=1" % mine, token=admin)
    sizes = [int(f["size"]) for f in body.get("data", [])] if status == 200 else []
    check("sort[size]=1 -> ascending sizes", status == 200 and sizes == sorted(sizes), sizes[:6])

    def names_for(query):
        s, b = http("GET", "/files?%s&limit=100&%s" % (mine, query), token=admin)
        return s, sorted(f["name"] for f in (b or {}).get("data", [])) if s == 200 else b

    s, names = names_for("with_extensions[]=.pdf")
    check("with_extensions[]=.pdf -> the pdf only", s == 200 and names == [P + "-Договор поставки.pdf"], (s, names))
    s, names2 = names_for("with_extensions[]=PDF")
    s3, names3 = names_for("with_extensions=pdf%20jpg")
    check("extension filter ignores case and the dot ('PDF', one value 'pdf jpg')",
          s == s3 == 200 and names2 == names and names3 == sorted([P + "-Договор поставки.pdf", P + "-PHOTO.JPG"]), (names2, names3))
    qs = client_query_string({"with_extensions": [".PDF"], "name": P})
    if qs:
        s, b = http("GET", "/files?" + qs, token=admin)
        check("the client's own query string (with_extensions[]=) works",
              s == 200 and [f["name"] for f in b.get("data", [])] == [P + "-Договор поставки.pdf"], (qs, s))
    s, names = names_for("uploaded_by=%d" % agent["id"])
    check("uploaded_by=<agent> -> the agent's file only", s == 200 and names == [P + "-by-agent.txt"], (s, names))
    s, names = names_for("uploaded_from=from_comments")
    check("uploaded_from=from_comments -> none yet", s == 200 and names == [], (s, names))
    s, names = names_for("from_bytes=%d&till_bytes=%d" % (3 * MB, 3 * MB))
    check("from_bytes / till_bytes include the bounds (exactly 3 MB)", s == 200 and names == [P + "-3mb.bin"], (s, names))
    today = datetime.date.today()
    s, names = names_for("created_at_from=%s&created_at_till=%s" % (today, today + datetime.timedelta(days=1)))
    s2, names2 = names_for("created_at_till=%s" % today)
    check("created_at_from / created_at_till: today's files, none before today",
          s == s2 == 200 and len(names) >= 9 and names2 == [], (len(names) if isinstance(names, list) else names, names2))
    s, b = http("GET", "/files?uploaded_from=nonsense", token=admin)
    check("unknown source -> 400", s == 400, s)

    section("Rights")
    check("no login -> 401", http("GET", "/files")[0] == 401)
    check("agent with the 'files' switch -> 200", http("GET", "/files?" + mine, token=agent["token"])[0] == 200)
    s, b = http("GET", "/files?" + mine, token=agent_nofiles["token"])
    check("agent without the 'files' switch -> 403 (the client only hid the menu)", s == 403, (s, message_of((s, b))))
    s, b = http("GET", "/deals/%d/files" % deal1, token=agent_nofiles["token"])
    check("... the files tab of a deal still works for them -> 200", s == 200, s)

    # CALL-4 / ACL-3: the list follows the deal rights and the mail switch, like the deal pages
    def scoped_agent(suffix, mail):
        person = {"email": "audit-files-%s-%s@example.test" % (suffix, RUN), "password": secrets.token_urlsafe(12)}
        perms = dict(permissions, deal=dict(permissions["deal"], view=1, update=1, delete=1), mail=mail, file=True)
        status, body = http("POST", "/users", {
            "email": person["email"], "password": person["password"], "username": "%s-%s" % (P, suffix),
            "role": "agent", "group_id": group_id, "permissions": perms,
        }, token=admin)
        if status != 201 or not isinstance(body, dict):
            raise SystemExit("cannot create the test agent: %s %s" % (status, message_of((status, body))))
        person["id"] = body["id"]
        person["token"] = login(person["email"], person["password"])
        return person

    own = scoped_agent("own", False)
    own_mail = scoped_agent("own-mail", True)
    deal_own = int(scalar(
        "INSERT INTO deal (label, display_id, budget, stage_id, agent_id, created_by) VALUES (%s, %d, 100, %d, %d, %d) RETURNING id"
        % (q(P + "-deal-own"), 900000000 + secrets.randbelow(90000000), stage_id, own["id"], admin_id)))
    r, _ = upload(deal_own, [("files", P + "-in-own-deal.txt", b"own deal", "text/plain")])
    in_own_deal = r[1][0]["id"] if r[0] == 201 else 0
    # uploaded by the agent into a deal that is not theirs (any more: it was handed over to admin)
    r, _ = upload(deal1, [("files", P + "-own-upload.txt", b"own upload", "text/plain")])
    own_upload = r[1][0]["id"] if r[0] == 201 else 0
    sql("UPDATE file SET uploaded_by = %d WHERE id = %d" % (own["id"], own_upload))
    mail_id = int(scalar("INSERT INTO email (subject, \"from\") VALUES (%s, %s) RETURNING id" % (q(P + "-scoped-mail"), q("client@example.test"))))
    own_mail_id = int(scalar("INSERT INTO email (subject, \"from\") VALUES (%s, %s) RETURNING id" % (q(P + "-own-mail"), q(own_mail["email"]))))

    def mail_file(name, email):
        return int(scalar(
            "INSERT INTO file (name, path, size, \"from\", extension, email_id) VALUES (%s, %s, 1, 'from_emails', '.txt', %d) RETURNING id"
            % (q(name), q(secrets.token_hex(32) + ".txt"), email)))

    foreign_attachment = mail_file(P + "-attachment.txt", mail_id)
    own_attachment = mail_file(P + "-own-attachment.txt", own_mail_id)

    def listed(token):
        s, b = http("GET", "/files?%s&limit=100" % mine, token=token)
        return s, {f["id"]: f for f in (b or {}).get("data", [])} if s == 200 else {}

    s, rows = listed(own["token"])
    check("agent with 'own deals': the files of their deal and their own upload are listed",
          s == 200 and in_own_deal in rows and own_upload in rows, (s, sorted(rows)))
    check("... not the files of another manager's deal (deal1 of admin)",
          s == 200 and note_file.get("id") not in rows and by_agent.get("id") not in rows, sorted(rows))
    check("... their upload into a deal they may not see does not name that deal",
          s == 200 and (rows.get(own_upload) or {}).get("deals") == [], rows.get(own_upload))
    check("... no e-mail attachments without the mail switch",
          s == 200 and foreign_attachment not in rows and own_attachment not in rows, sorted(rows))
    check("... the count is the agent's, not of all files",
          s == 200 and http("GET", "/files?%s&limit=100" % mine, token=own["token"])[1].get("count") == len(rows), len(rows))
    s, rows = listed(own_mail["token"])
    check("agent with the mail switch: the attachment of a letter of their own address, not of other letters",
          s == 200 and own_attachment in rows and foreign_attachment not in rows, (s, sorted(rows)))
    s, rows = listed(admin)
    check("admin still sees every file, the attachments too",
          s == 200 and {in_own_deal, own_upload, foreign_attachment, own_attachment, note_file.get("id")} <= set(rows), sorted(rows))
    check("... and the deals of a file with their label",
          s == 200 and [d.get("label") for d in (rows.get(own_upload) or {}).get("deals", [])] == [P + "-deal-1"], rows.get(own_upload))
    # the two attachment rows have no file on disk: gone before the orphan checks below
    sql("DELETE FROM file WHERE id IN (%d, %d)" % (foreign_attachment, own_attachment))

    section("Files tab (GET /deals/:id/files, /deals/:id/files/:file_id)")
    s, b = http("GET", "/deals/%d/files?limit=100" % deal1, token=admin)
    tab = b.get("data", []) if s == 200 else []
    tab_ids = [f["id"] for f in tab]
    check("-> 200, the deal's files, oldest first (new uploads are appended)",
          s == 200 and tab_ids == sorted(tab_ids) and note_file.get("id") in tab_ids
          and all(f["name"].startswith(P) for f in tab), (s, tab_ids[:5]))
    check("each file has uploaded_by.username (the tab shows it)",
          tab and all((f.get("uploaded_by") or {}).get("username") for f in tab))
    s, b = http("GET", "/deals/%d/files/%d" % (deal1, note_file.get("id", 0)), token=admin)
    check("single file of the deal -> 200", s == 200 and isinstance(b, dict) and b.get("id") == note_file.get("id"), s)
    s, _ = http("GET", "/deals/%d/files/%d" % (deal2, note_file.get("id", 0)), token=admin)
    check("a file of another deal -> 404", s == 404, s)
    check("no login -> 401", http("GET", "/deals/%d/files" % deal1)[0] == 401)

    # ================================================================= download
    section("Download (/api/v1/uploads/<path>, /uploads/<path>)")
    s, headers, data = fetch_raw("%s/uploads/%s" % (BASE, note_file.get("path", "")))
    check("<apiUrl>/uploads/<path> (what the client asks for) -> 200, same bytes", s == 200 and data == content, s)
    note("downloads need no login: <a href>, <img>, <audio> cannot send the token; names are 64 random hex chars")
    check("nosniff header", headers.get("x-content-type-options") == "nosniff", headers.get("x-content-type-options"))
    s, headers, _ = fetch_raw("%s/uploads/%s" % (api_root, note_file.get("path", "")))
    check("/uploads/<path> (old address) -> 200", s == 200, s)
    s, headers, _ = fetch_raw("%s/uploads/%s" % (BASE, page.get("path", "")))
    check("the uploaded .html comes as a download, not a page",
          s == 200 and "text/html" not in headers.get("content-type", ""), (s, headers.get("content-type")))
    s, _, _ = fetch_raw("%s/uploads/%s" % (BASE, "0" * 64 + ".txt"))
    check("unknown name -> 404", s == 404, s)
    leaked = []
    for probe in ("/uploads/../../package.json", "/uploads/..%2F..%2Fpackage.json", "/uploads/%2e%2e/%2e%2e/package.json",
                  "/uploads/..%5C..%5Cpackage.json", "/uploads/../../.env", "/uploads/"):
        for prefix in (BASE, api_root):
            s, _, body = fetch_raw(prefix + probe)
            if s == 200 and (b'"name"' in body or b"=" in body or b"<" in body):
                leaked.append(prefix + probe)
    check("no path traversal and no folder listing", not leaked, leaked)

    # ================================================================= comments / history
    section("Files in the comment history")
    r, _ = upload(deal1, [("files", P + "-in-comment.txt", b"comment file", "text/plain")], route="comments",
                  fields={"comment": P + " comment with a file"})
    comment_file = None
    if check("comment with a file -> 201", r[0] == 201, r):
        comment_file = int(scalar("SELECT id FROM file WHERE name = %s" % q(P + "-in-comment.txt")))
    event_id = scalar("SELECT id FROM event WHERE deal_id = %d AND type = %d ORDER BY id DESC LIMIT 1" % (deal1, EVENT_NEW_COMMENT))
    state = json.loads(scalar("SELECT after_state::text FROM event WHERE id = %s" % event_id) or "{}") if event_id else {}
    files_in_event = (state.get("data") or {}).get("files") or []
    check("the comment event lists the file (id, name, path)",
          [f.get("id") for f in files_in_event] == [comment_file] and files_in_event[0].get("path"), files_in_event)
    check("... with the uploader as {id, username} only (no permissions in the history JSON)",
          files_in_event and set((files_in_event[0].get("uploaded_by") or {}).keys()) == {"id", "username"},
          files_in_event and files_in_event[0].get("uploaded_by"))
    check("source of the file: from_comments", comment_file and file_row(comment_file)["from"] == "from_comments")
    comment_path = file_row(comment_file)["path"] if comment_file else ""

    # ================================================================= delete
    section("Delete from a deal (DELETE /deals/:id/files/:file_id)")
    s, _ = http("DELETE", "/deals/%d/files/%d" % (deal1, comment_file or 0), token=admin)
    state = json.loads(scalar("SELECT after_state::text FROM event WHERE id = %s" % event_id) or "{}") if event_id else {}
    check("file of a comment -> 200, row and file on disk are gone",
          s == 200 and file_row(comment_file or 0) is None and not on_disk(comment_path), s)
    check("... the comment stays, without the file",
          (state.get("data") or {}).get("comment") == P + " comment with a file" and (state.get("data") or {}).get("files") == [], state)
    # the history is not silently rewritten: the entry says which file was taken off and when (AUDIT-12)
    removed = (state.get("data") or {}).get("removed_files") or []
    check("... and says the file was removed (its name and the time)",
          len(removed) == 1 and removed[0].get("id") == comment_file and removed[0].get("name") == P + "-in-comment.txt"
          and removed[0].get("removed_at"), removed)

    s, _ = http("DELETE", "/deals/%d/files/%d" % (deal1, note_file.get("id", 0)))
    check("no login -> 401", s == 401, s)
    # the controller looks the file up in the deal first (its name goes into the deal's history,
    # DEAL-17): a file of another deal is "not in this deal" -> 404, as GET of the same path
    events_before = count("SELECT count(*) FROM event WHERE deal_id = %d" % deal2)
    s, _ = http("DELETE", "/deals/%d/files/%d" % (deal2, note_file.get("id", 0)), token=admin)
    check("file of another deal -> 404, nothing changes, nothing in the other deal's history",
          s == 404 and links(note_file.get("id", 0)) == [deal1]
          and count("SELECT count(*) FROM event WHERE deal_id = %d" % deal2) == events_before,
          (s, links(note_file.get("id", 0))))
    s, _ = http("DELETE", "/deals/%d/files/99999999" % deal1, token=admin)
    check("missing file -> 404", s == 404, s)

    # shared with a second deal: stays until the last link goes
    shared = note_file.get("id", 0)
    shared_path = note_file.get("path", "")
    sql('INSERT INTO deal_file ("fileId", "dealId") VALUES (%d, %d)' % (shared, deal2))
    s, _ = http("DELETE", "/deals/%d/files/%d" % (deal1, shared), token=admin)
    check("file in two deals: removed from one -> 200, row, other link and file on disk stay",
          s == 200 and links(shared) == [deal2] and file_row(shared) is not None and on_disk(shared_path), (s, links(shared)))
    s, _ = http("DELETE", "/deals/%d/files/%d" % (deal2, shared), token=admin)
    check("... removed from the last deal -> row and file on disk are gone (were: row kept, file kept)",
          s == 200 and file_row(shared) is None and not on_disk(shared_path), (s, file_row(shared), on_disk(shared_path)))

    # a deal in the trash can be restored: its files stay
    kept = jpg.get("id", 0)
    sql('INSERT INTO deal_file ("fileId", "dealId") VALUES (%d, %d)' % (kept, trashed))
    s, _ = http("DELETE", "/deals/%d/files/%d" % (deal1, kept), token=admin)
    check("file also in a deal in the trash: removed from the live deal -> row and file on disk stay",
          s == 200 and links(kept) == [trashed] and file_row(kept) is not None and on_disk(jpg.get("path", "")), (s, links(kept)))

    # an e-mail attachment stays with the e-mail
    email_id = int(scalar("INSERT INTO email (subject) VALUES (%s) RETURNING id" % q(P + "-mail")))
    mailed = cyr.get("id", 0)
    sql("UPDATE file SET email_id = %d WHERE id = %d" % (email_id, mailed))
    s, _ = http("DELETE", "/deals/%d/files/%d" % (deal1, mailed), token=admin)
    check("e-mail attachment: removed from the deal -> row and file on disk stay with the e-mail",
          s == 200 and links(mailed) == [] and file_row(mailed) is not None and on_disk(cyr.get("path", "")), s)

    # a Telegram message in the history links the file by path
    tg = page.get("id", 0)
    tg_path = page.get("path", "")
    sql("INSERT INTO event (type, deal_id, user_id, after_state) VALUES (%d, %d, %d, %s::jsonb)"
        % (EVENT_NEW_TELEGRAM_MESSAGE, deal1, admin_id,
           q(json.dumps({"message": P + " tg", "files": [{"name": P + "-page.html", "path": tg_path, "type": "document"}]}))))
    s, _ = http("DELETE", "/deals/%d/files/%d" % (deal1, tg), token=admin)
    check("file of a Telegram message: removed from the deal -> row goes, the file on disk stays for the chat history",
          s == 200 and file_row(tg) is None and on_disk(tg_path), (s, file_row(tg), on_disk(tg_path)))
    CREATED_ON_DISK.add(os.path.basename(tg_path))

    s, _ = http("DELETE", "/deals/%d/files/%d" % (deal1, by_agent.get("id", 0)), token=agent["token"])
    check("agent removes a file in a deal -> 200, row and file on disk are gone",
          s == 200 and file_row(by_agent.get("id", 0)) is None and not on_disk(by_agent.get("path", "")), s)
    s, _ = http("DELETE", "/deals/%d/files/%d" % (deal1, three_mb.get("id", 0)), token=agent["token"])
    check("agent removes a file uploaded by the admin -> 200 (no per-file rights on the server)", s == 200, s)

    # ================================================================= orphans
    section("Orphans")
    run_rows = sql("SELECT id, path FROM file WHERE name LIKE %s" % q(P + "%"))
    orphan_rows = [r for r in run_rows if not links(int(r[0])) and not scalar("SELECT email_id FROM file WHERE id = %s" % r[0])]
    check("no row of this run is left without a deal or an e-mail", not orphan_rows, orphan_rows)
    missing = [r for r in run_rows if not on_disk(r[1])]
    check("every row of this run has its file on disk", not missing, missing)
    stray = [n for n in unreferenced(CREATED_ON_DISK) if os.path.isfile(os.path.join(UPLOADS_DIR, n)) and n != os.path.basename(tg_path)]
    check("every file this run wrote to disk belongs to a row (the Telegram one aside)", not stray, stray)

    # the whole table / folder: informational (the dev copy has rows of production without the files)
    all_rows = sql("SELECT path FROM file")
    gone = sum(1 for r in all_rows if not on_disk(r[0]))
    names = disk_names() - CREATED_ON_DISK
    loose = [n for n in unreferenced(names) if not count(
        "SELECT count(*) FROM event WHERE after_state::text LIKE %s" % q("%" + n + "%"))]
    note("whole database: %d file rows, %d of them without the file on disk; %d files on disk that nothing refers to"
         % (len(all_rows), gone, len(loose)))


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
            check("no AUDIT-files rows and no files of this run are left", not left, left)
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
