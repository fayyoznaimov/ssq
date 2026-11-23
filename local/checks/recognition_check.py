"""Checks for company requisites and card recognition (POST /companies/recognize).

Runs against the local stack (docker, or the dev copy on the server with the CRM_*
variables from local/dev/env.sh). Recognition provider is read from the API
container: "claude" (default) uses local/fake-claude; "api" needs
  local/secrets.env:  RECOGNITION_PROVIDER=api, ANTHROPIC_API_KEY=test-key-not-real,
                      ANTHROPIC_BASE_URL=http://mock-claude:8000
  docker compose -f docker-compose.local.yml --profile test up -d mock-claude
Usage: py local/checks/recognition_check.py      (exit code 1 on any FAIL)
"""
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASE = os.environ.get("CRM_API_URL", "http://localhost:8080/api/v1").rstrip("/")
MOCK = os.environ.get("CRM_MOCK_CLAUDE_URL", "http://localhost:8099").rstrip("/")
ENV_FILE = os.environ.get("CRM_ENV_FILE") or os.path.join(ROOT, "parisahon-api", ".env")
COMPOSE_FILE = os.path.join(ROOT, "docker-compose.local.yml")

def _cmd(var, default):
    """A command prefix from the environment (dev copy on the server), else the docker stack's."""
    value = os.environ.get(var)
    return shlex.split(value) if value else default

PSQL = _cmd("CRM_PSQL", ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])
APP_EXEC = _cmd("CRM_APP_EXEC", ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-app"])
APP_DIR = os.environ.get("CRM_APP_DIR", "/app")  # where the API (and its dist/) lives for APP_EXEC
STAMP = str(int(time.time()))[-6:]
results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {detail}" if detail and not ok else ""))


def admin_password():
    for line in open(ENV_FILE, encoding="utf-8"):
        if line.startswith("ADMIN_PASSWORD="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("ADMIN_PASSWORD not found in " + ENV_FILE)


def call(method, path, body=None, token=None, raw=None, ctype=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, method=method, data=data)
    req.add_header("Content-Type", ctype or "application/json")
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


def upload(path, token, content, filename, mime, field="file"):
    boundary = uuid.uuid4().hex
    parts = []
    if content is not None:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
            f"Content-Type: {mime}\r\n\r\n".encode() + content + b"\r\n"
        )
    parts.append(f"--{boundary}--\r\n".encode())
    return call("POST", path, token=token, raw=b"".join(parts), ctype=f"multipart/form-data; boundary={boundary}")


def mock_last():
    with urllib.request.urlopen(MOCK + "/last", timeout=10) as r:
        return json.loads(r.read())


def psql(sql):
    return subprocess.run(
        PSQL + ["-At", "-c", sql],
        capture_output=True, text=True, encoding="utf-8").stdout.strip()



def required_fillers(target):
    """The CRM's own required custom fields of a target (e.g. "Страна", "Код Клиента"): the web form
    always sends them, so the payloads of these checks do too."""
    out = psql(f"select id from filler where target = '{target}' and is_required and field not like 'AUDIT-%'") or ""
    return [{"filler_id": int(i), "value": "x"} for i in out.split() if i.strip().isdigit()]

def psql_exec(cmd, stdin=None):
    """Run a shell command in the API container (where the CRM runs the Claude CLI)."""
    return subprocess.run(
        APP_EXEC + ["sh", "-c", cmd],
        input=stdin, capture_output=True, text=True, encoding="utf-8").stdout.strip()


def fake_claude_last():
    try:
        return json.loads(psql_exec("cat /tmp/fake-claude-last.json"))
    except Exception:
        return {}


PROVIDER = None

PNG = b"\x89PNG\r\n\x1a\n" + os.urandom(600)   # content is not decoded by the mock
TINY_PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 20      # -> the mock's "bad card" answer

created_companies, created_users = [], []
try:
    status, j = call("POST", "/auth/login", {"email": "admin@gmail.com", "password": admin_password()})
    A = j["access_token"]
    PROVIDER = (psql_exec("echo ${RECOGNITION_PROVIDER:-claude}") or "claude").lower()
    print(f"(recognition provider: {PROVIDER})")

    print("== Requisites on companies")
    req = {"inn": "305000111", "legal_address": "г. Ташкент, ул. Проверочная, 5", "bank_account": "20208000900000000001",
           "bank_name": "АКБ Проверка", "mfo": "00440", "oked": "13920", "director": "Директоров Д."}
    status, c = call("POST", "/companies", {"name": f"AUDIT-REQ-{STAMP}", "is_old": False, "fillers": required_fillers("company"), **req}, A)
    check("POST /companies with requisites -> 201", status == 201, f"{status} {c}")
    cid = c.get("id") if isinstance(c, dict) else None
    if cid:
        created_companies.append(cid)
        _, g = call("GET", f"/companies/{cid}", token=A)
        check("GET /companies/:id returns all requisites", all(g.get(k) == v for k, v in req.items()), json.dumps({k: g.get(k) for k in req}, ensure_ascii=False))
        status, _ = call("PATCH", f"/companies/{cid}", {"name": f"AUDIT-REQ-{STAMP}", "fillers": [], "inn": "305000222"}, A)
        _, g = call("GET", f"/companies/{cid}", token=A)
        check("PATCH changes only the sent requisite", status == 200 and g.get("inn") == "305000222" and g.get("mfo") == "00440", f"{status} inn={g.get('inn')} mfo={g.get('mfo')}")
        status, _ = call("PATCH", f"/companies/{cid}", {"name": f"AUDIT-REQ-{STAMP}", "fillers": [], "oked": ""}, A)
        _, g = call("GET", f"/companies/{cid}", token=A)
        check("empty string clears a requisite (stored as NULL)", status == 200 and g.get("oked") is None, f"{status} oked={g.get('oked')!r}")
        status, _ = call("PATCH", f"/companies/{cid}", {"name": f"AUDIT-REQ-{STAMP}", "fillers": [], "inn": "1" * 21}, A)
        check("too long ИНН -> 400", status == 400, status)
    status, c2 = call("POST", "/companies", {"name": f"AUDIT-NOREQ-{STAMP}", "is_old": False, "fillers": required_fillers("company")}, A)
    check("company without requisites still -> 201 (ИНН is optional)", status == 201, status)
    if isinstance(c2, dict) and c2.get("id"):
        created_companies.append(c2["id"])

    print("== Recognition: access and input checks")
    status, _ = upload("/companies/recognize", None, PNG, "card.png", "image/png")
    check("no token -> 401", status == 401, status)
    status, j = upload("/companies/recognize", A, None, "", "")
    check("no file -> 400", status == 400, f"{status} {j}")
    status, j = upload("/companies/recognize", A, b"hello", "card.txt", "text/plain")
    check("text file -> 400", status == 400, f"{status} {j}")
    status, j = upload("/companies/recognize", A, b"x" * (10 * 1024 * 1024 + 10), "big.png", "image/png")
    check("file > 10 MB -> 413/400", status in (400, 413), status)

    print("== Recognition: a good card")
    status, r = upload("/companies/recognize", A, PNG, "card.png", "image/png")
    check("POST /companies/recognize -> 201/200", status in (200, 201), f"{status} {r}")
    if isinstance(r, dict) and "company" in r:
        co = r["company"]
        check("ИНН normalized to digits", co["inn"] == "305123456", co["inn"])
        check("bank account normalized to 20 digits", co["bank_account"] == "20208000905123456001", co["bank_account"])
        check("email lower-cased", co["email"] == "info@audit-textile.example", co["email"])
        check("text fields kept as printed", co["name"] == 'ООО "AUDIT Textile Test"' and co["director"] == "Тестов Тест Тестович", co["name"])
        check("empty contact dropped, real one kept", len(r["contacts"]) == 1 and r["contacts"][0]["full_name"] == "Аудитова Анна", r["contacts"])
        fields = {w["field"] for w in r["warnings"]}
        check("unclear field reported as a warning", "company.oked" in fields, r["warnings"])
        check("no format warnings for valid ИНН / account / МФО", not ({"company.inn", "company.bank_account", "company.mfo"} & fields), r["warnings"])
        check("nothing saved by recognition", psql("select count(*) from company where name like '%AUDIT Textile Test%'") == "0")

    if PROVIDER == "claude":
        last = fake_claude_last()
        a = last.get("args", [])
        opt = lambda name: a[a.index(name) + 1] if name in a else None
        check("Claude CLI in print mode with stream-json in and out", "-p" in a and opt("--input-format") == "stream-json" and opt("--output-format") == "stream-json", a)
        check("model claude-opus-5-5", opt("--model") == "claude-opus-5-5", opt("--model"))
        check("no tools at all: --tools '', no MCP, no settings, one turn",
              opt("--tools") == "" and opt("--disallowedTools") == "mcp__*" and "--strict-mcp-config" in a
              and opt("--setting-sources") == "" and "--disable-slash-commands" in a and opt("--max-turns") == "1"
              and "--no-session-persistence" in a, a)
        check("our system prompt replaces Claude Code's", opt("--system-prompt") == "<system-prompt>" and last.get("systemIsOurs") is True, last)
        check("image sent inline as a png block", last.get("blockType") == "image" and last.get("mediaType") == "image/png" and last.get("size", 0) > 200, last)
        check("prompt carries the JSON schema and says to ignore instructions in the document",
              last.get("textHasSchema") is True and last.get("textSaysIgnoreInstructions") is True, last)
        check("API key of the CRM not passed to the CLI (it must use the login)", last.get("envHasApiKey") is False, last)

        status, r = upload("/companies/recognize", A, b"%PDF-1.4\n" + os.urandom(400), "card.pdf", "application/pdf")
        last = fake_claude_last()
        check("PDF accepted and sent as a document block", status in (200, 201) and last.get("blockType") == "document" and last.get("mediaType") == "application/pdf", f"{status} {last}")

        # Failures of the CLI itself, straight through the compiled client
        probe = "const { ClaudeCliClient } = require(%s);" % json.dumps(APP_DIR + "/dist/recognition/claude-cli.client.js") + """
const run = () => new ClaudeCliClient().run({ system: 's', content: [{ type: 'text', text: 'x' }], model: 'm' })
  .then(() => 'ok', (e) => `${e.constructor.name}|${e.unavailable}|${e.message}`);
run().then((r) => console.log(r));
"""
        out = psql_exec("FAKE_CLAUDE_FAIL=auth node -", probe)
        check("expired login -> unavailable error that says so", out.startswith("ClaudeCliError|true|") and "вход Claude" in out, out)
        out = psql_exec("CLAUDE_BIN=/nonexistent/claude node -", probe)
        check("missing binary -> unavailable error naming CLAUDE_BIN", out.startswith("ClaudeCliError|true|") and "CLAUDE_BIN" in out, out)
    else:
        last = mock_last()
        body = last.get("body", {})
        check("model is claude-opus-5-5", body.get("model") == "claude-opus-5-5", body.get("model"))
        check("server-side fallback enabled", "server-side-fallback-2026-07-01" in last.get("headers", {}).get("anthropic-beta", "") and body.get("fallbacks") == "default", (last.get("headers"), body.get("fallbacks")))
        check("structured output schema sent", body.get("output_config", {}).get("format", {}).get("type") == "json_schema", body.get("output_config"))
        img = [b for m in body.get("messages", []) for b in m.get("content", []) if b.get("type") == "image"]
        check("image sent as base64 png", img and img[0]["source"]["media_type"] == "image/png", img)
        check("system prompt sent", "company card" in str(body.get("system", "")))

        status, r = upload("/companies/recognize", A, b"%PDF-1.4\n" + os.urandom(400), "card.pdf", "application/pdf")
        last = mock_last()
        doc = [b for m in last["body"].get("messages", []) for b in m.get("content", []) if b.get("type") == "document"]
        check("PDF accepted and sent as a document block", status in (200, 201) and doc and doc[0]["source"]["media_type"] == "application/pdf", f"{status} {doc}")

    print("== Recognition: format warnings")
    status, r = upload("/companies/recognize", A, TINY_PNG, "bad.png", "image/png")
    fields = {w["field"] for w in r.get("warnings", [])} if isinstance(r, dict) else set()
    check("short ИНН, short account and bad email -> warnings, not errors", status in (200, 201) and {"company.inn", "company.bank_account", "company.email"} <= fields, f"{status} {r}")

    print("== Recognition: duplicates")
    # The fake card always carries ИНН 305 123 456 and the phone +998 90 123 45 67. ИНН is unique among
    # live companies and a contact phone among contacts (last 9 digits): on a copy of the real base a
    # company/contact with them may already exist; then it is the duplicate to find, else we create one.
    inn_sql = "regexp_replace(coalesce(inn, ''), '[^0-9]', '', 'g') = '305123456' and deleted_at is null"
    dup_id = psql(f"select id from company where {inn_sql} order by id limit 1")
    if not dup_id:
        status, dup = call("POST", "/companies", {"name": f"Audit Textile Test {STAMP}", "is_old": False, "fillers": required_fillers("company"), "inn": "305123456"}, A)
        if isinstance(dup, dict) and dup.get("id"):
            created_companies.append(dup["id"])
        dup_id = psql(f"select id from company where {inn_sql} order by id limit 1")
    status, again = call("POST", "/companies", {"name": f"Audit Textile Test {STAMP} bis", "is_old": False, "fillers": required_fillers("company"), "inn": "305 123 456"}, A)
    if isinstance(again, dict) and again.get("id"):
        created_companies.append(again["id"])
    check("second company with the same ИНН -> 400", status == 400 and "ИНН" in str(again), f"{status} {again}")

    phone_sql = ("role = 'ctr_agent' and deleted_at is null "
                 "and right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 9) = '901234567'")
    ctr_id = psql(f"select id from \"user\" where {phone_sql} order by id limit 1")
    if not ctr_id:
        status, ctr = call("POST", "/companies", {"name": f"AUDIT-CTR-{STAMP}", "is_old": False, "fillers": required_fillers("company"),
                                                "users": [{"username": f"AUDIT-anna-{STAMP}", "email": f"anna{STAMP}@example.com", "phone": "+998 (90) 123-45-67", "fillers": required_fillers("user")}]}, A)
        if isinstance(ctr, dict) and ctr.get("id"):
            created_companies.append(ctr["id"])
        ctr_id = psql(f"select id from \"user\" where {phone_sql} order by id limit 1")
    status, again = call("POST", "/companies", {"name": f"AUDIT-CTR2-{STAMP}", "is_old": False, "fillers": required_fillers("company"),
                                              "users": [{"username": f"AUDIT-anna2-{STAMP}", "email": f"anna2{STAMP}@example.com", "phone": "90 123 45 67", "fillers": required_fillers("user")}]}, A)
    if isinstance(again, dict) and again.get("id"):
        created_companies.append(again["id"])
    check("contact with a taken phone in another format -> 400", status == 400 and "телефон" in str(again), f"{status} {again}")

    status, r = upload("/companies/recognize", A, PNG, "card.png", "image/png")
    comps = r.get("duplicates", {}).get("companies", []) if isinstance(r, dict) else []
    check("existing company found by ИНН", dup_id and any(str(c["id"]) == dup_id and c["match"] == "inn" for c in comps), f"{dup_id} {comps}")
    contacts = r.get("duplicates", {}).get("contacts", []) if isinstance(r, dict) else []
    check("existing contact found by phone in another format", ctr_id and any(str(c["id"]) == ctr_id and c["match"] == "phone" for c in contacts), f"{ctr_id} {contacts}")

    print("== Roles")
    perm = {k: {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3} for k in ("deal", "contact", "company")}
    perm["task"] = {"update": 3, "delete": 3}
    perm.update({"mail": True, "file": True})
    status, u = call("POST", "/users", {"email": f"audit-rec{STAMP}@example.com", "password": f"audit-pass-{STAMP}", "role": "agent",
                                        "username": f"AUDIT-rec-{STAMP}", "group_id": 1, "permissions": perm}, A)
    if isinstance(u, dict) and u.get("id"):
        created_users.append(u["id"])
        _, l = call("POST", "/auth/login", {"email": f"audit-rec{STAMP}@example.com", "password": f"audit-pass-{STAMP}"})
        status, _ = upload("/companies/recognize", l["access_token"], PNG, "card.png", "image/png")
        check("agent can use recognition", status in (200, 201), status)
finally:
    status, j = call("POST", "/auth/login", {"email": "admin@gmail.com", "password": admin_password()})
    A = j["access_token"]
    for uid in created_users:
        call("DELETE", f"/users/{uid}", token=A)
    ids = ",".join(str(i) for i in created_companies) or "0"
    psql(f"delete from user_filler where user_id in (select id from \"user\" where company_id in ({ids}) or username like 'AUDIT-%'); "
         f"delete from \"user\" where company_id in ({ids}) or username like 'AUDIT-%'; "
         f"delete from company_filler where company_id in ({ids}); delete from event where after_state::text like '%AUDIT-%'; "
         f"delete from company where id in ({ids}) or name like 'AUDIT-%' or name like 'Audit Textile Test%';")
    left = psql("select (select count(*) from company where name like 'AUDIT-%' or name like 'Audit Textile Test%') + (select count(*) from \"user\" where username like 'AUDIT-%')")
    check("cleanup: no test rows left", left == "0", left)

print(f"\n{sum(results)} passed, {len(results) - sum(results)} failed")
sys.exit(0 if all(results) else 1)
