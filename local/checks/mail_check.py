#!/usr/bin/env python3
"""
Regression checks for the mail module (block 6): access rights, outgoing emails in deal
history, batched sync, UIDVALIDITY changes; the findings of the review of 2026-11 (review_wave:
threads and names, signature, mailboxes only one's own and checked, a broken letter, a returning
client, the company address, deals and contacts made from letters, Trash instead of EXPUNGE) and of
fix wave 1b (wave_1b: one deal per letter, per-user «прочитано», «Неразобранные» / «Привязать»).

    py local/checks/mail_check.py

* Python stdlib only.
* Talks to the LOCAL stack only: API http://localhost:8080/api/v1, database through
  `docker compose -f docker-compose.local.yml exec crm-db psql`, and the stand's test mail
  server (GreenMail) through small node scripts run inside the crm-app container (the API's
  own imapflow/nodemailer, with the API's mail credentials from its environment).
  With the CRM_* variables from local/dev/env.sh it talks to the dev copy on the server instead
  (CRM_API_URL, CRM_PSQL, CRM_APP_EXEC, CRM_APP_DIR, CRM_ENV_FILE); the mail server there is the
  stand-in local/dev/mail/server.py (pymap + aiosmtpd).
* Admin password is read from the API env file and never printed.
* Everything it creates is prefixed with AUDITML- (database rows and messages on the mail
  server) and is removed at the end, also when the run is interrupted. A run starts with the
  same cleanup. Nothing with the AUDIT- prefix of the other check sets is touched.
* Prints PASS/FAIL per check, exits 1 if anything failed.
"""
import base64
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
ENV_FILES = ([os.environ["CRM_ENV_FILE"]] if os.environ.get("CRM_ENV_FILE") else []) + [os.path.join(ROOT, "parisahon-api", ".env"), os.path.join(ROOT, "local", "api.env")]
COMPOSE_FILE = os.path.join(ROOT, "docker-compose.local.yml")
CLIENT = os.path.join(ROOT, "parisahon-client", "app")
API_SRC = os.path.join(ROOT, "parisahon-api", "src")
BASE = os.environ.get("CRM_API_URL", "http://localhost:8080/api/v1").rstrip("/")


def _cmd(var, default):
    """A command prefix from the environment (dev copy on the server), else the docker stack's."""
    value = os.environ.get(var)
    return shlex.split(value) if value else default


PSQL = _cmd("CRM_PSQL", ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])
APP_EXEC = _cmd("CRM_APP_EXEC", ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-app"])
APP_DIR = os.environ.get("CRM_APP_DIR", "/app")  # where the API (its node_modules) lives for APP_EXEC

RUN = str(int(time.time()))[-6:]
P = "AUDITML-" + RUN  # prefix of everything this run creates
DOMAIN = "example.test"

EVENT_NEW_EMAIL = 9
BULK = 120  # more than two sync batches of 50

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


def section(title):
    print("\n== " + title, flush=True)


def env(key):
    for path in ENV_FILES:
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                m = re.match(r"\s*%s\s*=\s*(.*)" % re.escape(key), line)
                if m:
                    return m.group(1).strip().strip('"').strip("'")
    raise SystemExit("%s is not set in %s" % (key, " / ".join(ENV_FILES)))


def compose(*args, **kwargs):
    return subprocess.run(["docker", "compose", "-f", COMPOSE_FILE] + list(args),
                          capture_output=True, text=True, encoding="utf-8", **kwargs)


def sql(query):
    """Runs SQL in the local database, returns rows as lists of strings."""
    proc = subprocess.run(PSQL + ["-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"],
                          input=query, capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise RuntimeError("psql failed: %s\n%s" % (proc.stderr.strip(), query))
    return [line.split("|") for line in proc.stdout.splitlines() if line != ""]


def scalar(query):
    rows = sql(query)
    return rows[0][0] if rows else None


def count(query):
    return int(scalar(query) or 0)


def q(value):
    """SQL string literal."""
    return "'" + str(value).replace("'", "''") + "'"


# The mail server of the stand is only reachable inside the docker network: node scripts
# run in the API container with the API's own libraries and EMAIL_* environment.
NODE_PRELUDE = r"""
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
const host = process.env.EMAIL_HOST;
const auth = { user: process.env.EMAIL_DEFAULT_USER, pass: process.env.EMAIL_DEFAULT_PASSWORD };
const tls = { rejectUnauthorized: false };
const F = {
  inbox: process.env.EMAIL_MAIN_MAILBOX, sent: process.env.EMAIL_SENT_MAILBOX,
  spam: process.env.EMAIL_SPAM_MAILBOX, trash: process.env.EMAIL_TRASH_MAILBOX,
};
const out = {};
// A hung IMAP command would otherwise end the script silently (exit 13, unfinished top-level await)
let step = 'connect';
const watchdog = setTimeout(() => { console.error('WATCHDOG: no answer from the mail server, last step: ' + step); process.exit(3); }, 180000);
const c = new ImapFlow({ host, port: Number(process.env.EMAIL_IMAP_PORT || 993), secure: true, auth, logger: false, tls });
await c.connect();
async function ensureFolders() {
  step = 'ensureFolders';
  const have = new Set((await c.list()).map((m) => m.path));
  for (const f of Object.values(F)) if (!have.has(f)) await c.mailboxCreate(f);
}
const t = nodemailer.createTransport({ host, port: Number(process.env.EMAIL_SMTP_PORT || 465), secure: true, auth, tls });
async function smtp(msg) {
  step = 'smtp ' + msg.subject;
  // The envelope recipient is the stand's mailbox; the headers say whom the email is for.
  const r = await t.sendMail({ envelope: { from: msg.envelopeFrom || 'auditml@example.test', to: [auth.user] }, ...msg });
  return r.messageId;
}
function raw(m) {
  return [`From: ${m.from}`, `To: ${m.to}`, `Subject: ${m.subject}`, `Date: ${m.date}`, `Message-ID: ${m.messageId}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', m.text || 'AUDITML'].join('\r\n');
}
async function append(folder, m) {
  step = 'append ' + folder;
  const r = await c.append(folder, raw(m), []);
  return { uid: r.uid, uidValidity: String(r.uidValidity ?? await uidValidity(folder)) };
}
async function uidValidity(folder) {
  step = 'uidValidity ' + folder;
  const lock = await c.getMailboxLock(folder);
  try { return String(c.mailbox.uidValidity); } finally { lock.release(); }
}
async function byMessageId(folder, messageId) {
  step = 'byMessageId ' + folder;
  const lock = await c.getMailboxLock(folder);
  try {
    const uids = (await c.search({ header: { 'message-id': messageId } }, { uid: true })) || [];
    const found = [];
    for (const uid of uids) {
      const m = await c.fetchOne(String(uid), { flags: true, uid: true }, { uid: true });
      found.push({ uid, flags: [...(m.flags || [])] });
    }
    return found;
  } finally { lock.release(); }
}
async function headersOf(folder, messageId) {
  step = 'headersOf ' + folder;
  const lock = await c.getMailboxLock(folder);
  try {
    const uids = (await c.search({ header: { 'message-id': messageId } }, { uid: true })) || [];
    if (!uids.length) return null;
    const m = await c.fetchOne(String(uids[0]), { headers: ['from', 'in-reply-to', 'references', 'reply-to'] }, { uid: true });
    return m && m.headers ? m.headers.toString() : '';
  } finally { lock.release(); }
}
async function moveTo(from, to, messageId) {
  step = 'moveTo ' + to;
  const lock = await c.getMailboxLock(from);
  try {
    const uids = (await c.search({ header: { 'message-id': messageId } }, { uid: true })) || [];
    if (uids.length) await c.messageMove(uids, to, { uid: true });
    return uids.length;
  } finally { lock.release(); }
}
async function acceptsLogin(user, pass) {
  step = 'acceptsLogin';
  const probe = nodemailer.createTransport({ host, port: Number(process.env.EMAIL_SMTP_PORT || 465), secure: true, auth: { user, pass }, tls });
  try { await probe.verify(); return true; } catch (e) { return false; } finally { probe.close(); }
}
async function purge() {
  step = 'purge';
  const have = new Set((await c.list()).map((m) => m.path));
  for (const f of Object.values(F)) {
    if (!have.has(f)) continue;
    const lock = await c.getMailboxLock(f);
    try {
      const uids = await c.search({ subject: 'AUDITML-' }, { uid: true });
      if (uids && uids.length) await c.messageDelete(uids, { uid: true });
    } finally { lock.release(); }
  }
}
"""

NODE_EPILOGUE = r"""
step = 'logout';
await c.logout().catch(() => {});
clearTimeout(watchdog);
console.log('@@' + JSON.stringify(out));
"""


def node(body, timeout=240):
    """Runs a mail-server script in the API container; returns the `out` object."""
    script = NODE_PRELUDE + body + NODE_EPILOGUE
    deadline = time.time() + timeout
    while True:
        proc = subprocess.run(APP_EXEC + ["sh", "-c", "cd %s && node --input-type=module -" % shlex.quote(APP_DIR)],
                              input=script, capture_output=True, text=True, encoding="utf-8", timeout=timeout)
        if proc.returncode == 0:
            break
        stderr = "\n".join(line for line in proc.stderr.splitlines()
                           if "Warning" not in line and "trace-warnings" not in line).strip()
        # The API container restarts while another session edits src/ (nest --watch): docker exec
        # then fails before node prints anything; the mail server may also refuse a connection.
        if time.time() < deadline and "@@" not in proc.stdout and (
                not stderr or "container" in stderr.lower() or "ECONNREFUSED" in stderr or "ECONNRESET" in stderr):
            time.sleep(5)
            continue
        raise RuntimeError("node script failed (exit %s):\n%s\n%s" % (proc.returncode, stderr[-1500:], proc.stdout.strip()[-500:]))
    for line in proc.stdout.splitlines():
        if line.startswith("@@"):
            return json.loads(line[2:])
    raise RuntimeError("node script printed no result:\n%s" % proc.stdout[-500:])


TOKEN = None


def http(method, path, body=None, token=None, auth=True):
    """Returns (status, parsed json | text | None). Retries while the API restarts (nest --watch)."""
    url = BASE + urllib.parse.quote(path, safe="/?=&[]%:,+-_.~@")
    hdrs = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    bearer = token or (TOKEN if auth else None)
    if bearer:
        hdrs["Authorization"] = "Bearer " + bearer

    deadline = time.time() + 180
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


def message_of(response):
    body = response[1]
    if isinstance(body, dict):
        message = body.get("message")
        return " ".join(message) if isinstance(message, list) else str(message)
    return str(body)


def login(email, password):
    status, body = http("POST", "/auth/login", {"email": email, "password": password}, auth=False)
    if status not in (200, 201) or not isinstance(body, dict) or "access_token" not in body:
        raise SystemExit("login failed for %s: HTTP %s" % (email, status))
    return body["access_token"]


def user_id_of(token):
    payload = token.split(".")[1]
    return int(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["sub"])


def read_file(root, relative):
    with open(os.path.join(root, relative), encoding="utf-8") as fh:
        return fh.read()


def sync(token=None, query="limit=5"):
    """GET /emails/sync: pulls the four mailboxes of the stand into the database."""
    status, body = http("GET", "/emails/sync?" + query, token=token)
    return status, body


def email_row(subject):
    """(id, email_id, message_id, uidvalidity, from_mailbox, outgoing, is_spam, read, deleted?, sent_by_id) or None."""
    rows = sql("SELECT id, coalesce(email_id::text, ''), coalesce(message_id, ''), coalesce(uidvalidity::text, ''), from_mailbox, "
               "outgoing, is_spam, read, (deleted_at IS NOT NULL), coalesce(sent_by_id::text, '') "
               "FROM email WHERE subject = %s ORDER BY id" % q(subject))
    return rows[0] if rows else None


def ids_of(body):
    return {e["id"] for e in (body or {}).get("data", [])} if isinstance(body, dict) else set()


# --------------------------------------------------------------------------- cleanup

CLEANUP_SQL = r"""
CREATE TEMP TABLE _u AS SELECT id FROM "user" WHERE username LIKE 'AUDITML-%' OR email LIKE 'auditml-%@example.test';
CREATE TEMP TABLE _c AS SELECT id FROM company WHERE name LIKE 'AUDITML-%';
CREATE TEMP TABLE _d AS SELECT id FROM deal WHERE label LIKE 'AUDITML-%';
CREATE TEMP TABLE _e AS SELECT id FROM email WHERE subject LIKE '%AUDITML-%' OR sent_by_id IN (SELECT id FROM _u)
   OR user_id IN (SELECT id FROM _u);

DELETE FROM event WHERE deal_id IN (SELECT id FROM _d) OR user_id IN (SELECT id FROM _u)
   OR target_user_id IN (SELECT id FROM _u) OR after_state::text LIKE '%AUDITML-%';
DELETE FROM deal_file WHERE "fileId" IN (SELECT id FROM file WHERE email_id IN (SELECT id FROM _e));
DELETE FROM file WHERE email_id IN (SELECT id FROM _e);
DELETE FROM email_to WHERE email_id IN (SELECT id FROM _e);
DELETE FROM email_cc WHERE email_id IN (SELECT id FROM _e);
DELETE FROM email WHERE id IN (SELECT id FROM _e);
DELETE FROM email_transporter WHERE user_id IN (SELECT id FROM _u);
DELETE FROM email_template WHERE created_by IN (SELECT id FROM _u);
DELETE FROM notification WHERE company_id IN (SELECT id FROM _c);
DELETE FROM bot_reminder WHERE task_id IN (SELECT id FROM task WHERE deal_id IN (SELECT id FROM _d) OR label LIKE 'AUDITML-%');
DELETE FROM task WHERE deal_id IN (SELECT id FROM _d) OR label LIKE 'AUDITML-%';
DELETE FROM deal_stage_record WHERE deal_id IN (SELECT id FROM _d);
DELETE FROM deal_user WHERE "dealId" IN (SELECT id FROM _d) OR "userId" IN (SELECT id FROM _u);
DELETE FROM deal_product WHERE deal_id IN (SELECT id FROM _d);
DELETE FROM deal_filler WHERE deal_id IN (SELECT id FROM _d);
UPDATE deal SET repeat_of_id = NULL WHERE repeat_of_id IN (SELECT id FROM _d);
DELETE FROM deal_file WHERE "dealId" IN (SELECT id FROM _d);
DELETE FROM deal WHERE id IN (SELECT id FROM _d);
DELETE FROM user_filler WHERE user_id IN (SELECT id FROM _u);
DELETE FROM bot_account WHERE user_id IN (SELECT id FROM _u);
DELETE FROM bot_link_code WHERE user_id IN (SELECT id FROM _u);
DELETE FROM "user" WHERE id IN (SELECT id FROM _u);
DELETE FROM company_filler WHERE company_id IN (SELECT id FROM _c);
DELETE FROM company WHERE id IN (SELECT id FROM _c);
"""

LEFTOVERS_SQL = r"""
SELECT 'email', count(*) FROM email WHERE subject LIKE '%AUDITML-%'
UNION ALL SELECT 'deal', count(*) FROM deal WHERE label LIKE 'AUDITML-%'
UNION ALL SELECT 'company', count(*) FROM company WHERE name LIKE 'AUDITML-%'
UNION ALL SELECT 'user', count(*) FROM "user" WHERE username LIKE 'AUDITML-%' OR email LIKE 'auditml-%@example.test'
UNION ALL SELECT 'event', count(*) FROM event WHERE after_state::text LIKE '%AUDITML-%'
"""


def cleanup():
    sql(CLEANUP_SQL)


def leftovers():
    return {name: int(n) for name, n in sql(LEFTOVERS_SQL) if int(n) > 0}


# --------------------------------------------------------------------------- the run

def main():
    global TOKEN

    section("Fixtures")
    out = node("await ensureFolders(); await purge(); out.folders = (await c.list()).map((m) => m.path);")
    check("mail server: the four mailboxes of the stand exist and hold no AUDITML- messages",
          all(f in out["folders"] for f in ("INBOX", "INBOX.Sent", "INBOX.spam", "INBOX.Trash")), out)
    cleanup()
    TOKEN = login("admin@gmail.com", env("ADMIN_PASSWORD"))
    admin_id = user_id_of(TOKEN)
    shared = env("EMAIL_DEFAULT_USER")

    stage_id = int(scalar("SELECT s.id FROM deal_stage s JOIN collection c ON c.id = s.collection_id WHERE c.is_active = true ORDER BY s.\"order\", s.id LIMIT 1"))
    group_id = int(scalar('SELECT id FROM "group" ORDER BY id LIMIT 1'))

    permissions = {
        "deal": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
        "contact": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
        "company": {"view": 3, "create": 3, "update": 3, "delete": 3, "export": 3},
        "task": {"update": 3, "delete": 3},
        "mail": True,
        "file": True,
    }

    def staff(key, role, mail=True):
        person = {"email": "auditml-%s-%s@%s" % (key, RUN, DOMAIN), "password": secrets.token_urlsafe(12)}
        perms = dict(permissions, mail=mail)
        status, body = http("POST", "/users", {
            "email": person["email"], "password": person["password"], "username": "%s-%s" % (P, key),
            "role": role, "group_id": group_id, "permissions": perms,
        })
        if status != 201 or not isinstance(body, dict):
            raise SystemExit("cannot create %s: %s %s" % (key, status, body))
        person["id"] = body["id"]
        person["token"] = login(person["email"], person["password"])
        return person

    agent_a = staff("a", "agent")
    agent_b = staff("b", "agent")
    manager = staff("m", "manager")
    no_mail = staff("nomail", "agent", mail=False)

    company_id = int(scalar("INSERT INTO company (name, is_old, created_by) VALUES (%s, false, %d) RETURNING id" % (q(P + "-co"), admin_id)))
    client_email = "auditml-client-%s@%s" % (RUN, DOMAIN)
    contact_id = int(scalar("INSERT INTO \"user\" (username, email, role, company_id) VALUES (%s, %s, 'ctr_agent', %d) RETURNING id"
                            % (q(P + "-client"), q(client_email), company_id)))

    def new_deal(label, agent=admin_id):
        return int(scalar(
            "INSERT INTO deal (label, display_id, budget, stage_id, agent_id, created_by, company_id) "
            "VALUES (%s, %d, 100, %d, %d, %d, %d) RETURNING id"
            % (q(label), 900000000 + secrets.randbelow(90000000), stage_id, agent, admin_id, company_id)))

    deal_client = new_deal(P + "-deal-client")   # the client is its contact: emails from/to the client land here
    deal_other = new_deal(P + "-deal-other")     # no contacts: only an explicit deal_id links an email to it
    sql('INSERT INTO deal_user ("dealId", "userId") VALUES (%d, %d)' % (deal_client, contact_id))

    def events_for(deal, subject, wait=0):
        """Events are written by a listener after the request has been answered: optionally wait for them."""
        deadline = time.time() + wait
        while True:
            n = count("SELECT count(*) FROM event WHERE type = %d AND deal_id = %d AND after_state->'data'->>'subject' = %s"
                      % (EVENT_NEW_EMAIL, deal, q(subject)))
            if n or time.time() >= deadline:
                return n
            time.sleep(1)

    # ================================================================= incoming
    section("Incoming mail: sync, no duplicates, deal history")
    s_in1, s_in2, s_in3 = P + "-in-client", P + "-in-agent-a", P + "-in-agent-b"
    out = node("""
      out.in1 = await smtp({ envelopeFrom: %(client)s, from: 'Client <%(client_addr)s>', to: %(shared)s, subject: %(s1)s, text: 'from the client' });
      out.in2 = await smtp({ from: 'Someone <auditml-ext1@example.test>', to: '"Agent A" <%(a)s>', subject: %(s2)s, text: 'for agent a' });
      out.in3 = await smtp({ from: 'Someone <auditml-ext2@example.test>', to: %(b)s, cc: 'auditml-ext3@example.test', subject: %(s3)s, text: 'for agent b' });
      out.inboxValidity = await uidValidity(F.inbox);
    """ % {"client": json.dumps(client_email), "client_addr": client_email, "shared": json.dumps(shared), "a": agent_a["email"], "b": json.dumps(agent_b["email"]),
           "s1": json.dumps(s_in1), "s2": json.dumps(s_in2), "s3": json.dumps(s_in3)})

    status, body = sync()
    check("GET /emails/sync (admin) -> 200", status == 200, "%s %s" % (status, message_of((status, body))))
    rows = {s: email_row(s) for s in (s_in1, s_in2, s_in3)}
    check("the three emails are saved once each", all(rows[s] for s in rows) and
          all(count("SELECT count(*) FROM email WHERE subject = %s" % q(s)) == 1 for s in rows), rows)
    check("each row keeps the IMAP uid, the Message-ID and the UIDVALIDITY of INBOX",
          all(rows[s] and rows[s][1] and rows[s][2] == out[k] and rows[s][3] == out["inboxValidity"] and rows[s][4] == "INBOX"
              for s, k in ((s_in1, "in1"), (s_in2, "in2"), (s_in3, "in3"))), (rows, out))
    check("the email from the client is in the history of the client's deal (type %d)" % EVENT_NEW_EMAIL,
          events_for(deal_client, s_in1, wait=10) == 1,
          (events_for(deal_client, s_in1), sql("SELECT id, user_id FROM email WHERE subject = %s" % q(s_in1)), sql("SELECT id, type FROM event WHERE deal_id = %d" % deal_client)))
    check("… and not in the deal without contacts", events_for(deal_other, s_in1) == 0)
    # the column the control of answers, «клиент ждёт ответа» and the autopilot read (it kept the default true, MAIL-2)
    check("… stored as incoming (event.outgoing = false), the person in it by name only",
          sql("SELECT outgoing::text, (after_state->'data'->'from_user'->'permissions') IS NULL FROM event WHERE type = %d AND deal_id = %d AND after_state->'data'->>'subject' = %s"
              % (EVENT_NEW_EMAIL, deal_client, q(s_in1))) == [["false", "t"]],
          sql("SELECT outgoing, after_state->'data'->'from_user' FROM event WHERE type = %d AND deal_id = %d AND after_state->'data'->>'subject' = %s"
              % (EVENT_NEW_EMAIL, deal_client, q(s_in1))))
    status, _ = sync()
    check("second sync: still one row per email and one history entry",
          status == 200 and all(count("SELECT count(*) FROM email WHERE subject = %s" % q(s)) == 1 for s in rows)
          and events_for(deal_client, s_in1) == 1)
    in1, in2, in3 = (int(rows[s][0]) for s in (s_in1, s_in2, s_in3))

    # ================================================================= rights
    section("Rights: an agent sees only the emails of their own mailbox")
    status, body = http("GET", "/emails?limit=200&sort[id]=-1", token=agent_a["token"])
    seen = ids_of(body)
    check("agent A: GET /emails lists the email addressed to A", status == 200 and in2 in seen, "%s %s" % (status, sorted(seen)))
    check("agent A: does not list the email to the shared mailbox nor the one to B", in1 not in seen and in3 not in seen, sorted(seen))
    status, body = http("GET", "/emails?limit=200&sort[id]=-1", token=agent_b["token"])
    seen = ids_of(body)
    check("agent B: lists the email addressed to B only", status == 200 and in3 in seen and in2 not in seen and in1 not in seen, sorted(seen))
    status, body = http("GET", "/emails?limit=200&sort[id]=-1", token=manager["token"])
    seen = ids_of(body)
    check("manager: lists all three", status == 200 and {in1, in2, in3} <= seen, "%s %s" % (status, sorted(seen)))
    status, body = sync(token=agent_a["token"], query="limit=200&sort[id]=-1")
    seen = ids_of(body)
    check("agent A: GET /emails/sync answers with A's emails only", status == 200 and in2 in seen and in1 not in seen and in3 not in seen, sorted(seen))

    status, body = http("GET", "/emails/%d" % in2, token=agent_a["token"])
    check("agent A opens their email -> 200", status == 200 and isinstance(body, dict) and body.get("id") == in2, "%s %s" % (status, message_of((status, body))))
    check("… the response does not carry the staff record (sent_by)", status == 200 and "sent_by" not in body)
    out = node("out.flags = await byMessageId(F.inbox, %s);" % json.dumps(rows[s_in2][2]))
    check("… it is marked read locally and \\Seen on the server",
          email_row(s_in2)[7] == "t" and out["flags"] and "\\Seen" in out["flags"][0]["flags"], (email_row(s_in2), out))
    status, body = http("GET", "/emails/%d" % in3, token=agent_a["token"])
    check("agent A opens B's email -> 403 (was: any user could open any email)", status == 403, "%s %s" % (status, message_of((status, body))))
    status, body = http("GET", "/emails/%d" % in1, token=agent_a["token"])
    check("agent A opens an email of the shared mailbox -> 403", status == 403, status)
    check("… B's email stays unread", email_row(s_in3)[7] == "f", email_row(s_in3))
    status, _ = http("GET", "/emails/%d" % in3, token=agent_b["token"])
    status2, _ = http("GET", "/emails/%d" % in1, token=manager["token"])
    status3, _ = http("GET", "/emails/%d" % in1)
    check("owner, manager and admin open it -> 200", status == 200 and status2 == 200 and status3 == 200, (status, status2, status3))

    status, body = http("DELETE", "/emails/%d" % in3, token=agent_a["token"])
    check("agent A deletes B's email -> 403 (was: deleted on the server for good)", status == 403, "%s %s" % (status, message_of((status, body))))
    check("… the row is not deleted", email_row(s_in3)[8] == "f")
    status, body = http("PATCH", "/emails/%d/mark-as-spam" % in3, {}, token=agent_a["token"])
    check("agent A marks B's email as spam -> 403", status == 403 and email_row(s_in3)[6] == "f", status)

    status, body = http("PATCH", "/emails/%d/mark-as-spam" % in2, {}, token=agent_a["token"])
    row = email_row(s_in2)
    out = node("out.spam = await byMessageId(F.spam, %s); out.spamValidity = await uidValidity(F.spam);" % json.dumps(row[2]))
    check("agent A marks their own email as spam -> 200", status in (200, 201), "%s %s" % (status, message_of((status, body))))
    check("… the row moved to the spam mailbox with the new uid and that mailbox's UIDVALIDITY",
          row[6] == "t" and row[4] == "INBOX.spam" and out["spam"] and str(out["spam"][0]["uid"]) == row[1] and row[3] == out["spamValidity"], (row, out))
    status, body = http("GET", "/emails?is_spam=true&limit=200&sort[id]=-1", token=agent_a["token"])
    check("agent A: the spam list shows it", status == 200 and in2 in ids_of(body), "%s %s" % (status, sorted(ids_of(body))))

    # MAIL-10 (audit 2026-11): not a no-op on the server any more but no EXPUNGE either: moved to Trash
    status, body = http("PATCH", "/emails/%d/not-spam" % in2, {}, token=agent_a["token"])
    row = email_row(s_in2)
    out = node("out.inbox = await byMessageId(F.inbox, %s); out.spam = await byMessageId(F.spam, %s);" % (json.dumps(row[2]), json.dumps(row[2])))
    check("MAIL-10: agent A takes it out of spam («Не спам») -> 200, back in INBOX on the server and in the list",
          status in (200, 201) and row[6] == "f" and row[4] == "INBOX" and out["inbox"] and not out["spam"], "%s %s %s" % (status, row, out))

    status, body = http("DELETE", "/emails/%d" % in3, token=agent_b["token"])
    out = node("out.left = await byMessageId(F.inbox, %s); out.trash = await byMessageId(F.trash, %s);" % (json.dumps(rows[s_in3][2]), json.dumps(rows[s_in3][2])))
    check("agent B deletes their own email -> 200, gone from INBOX, soft-deleted locally",
          status in (200, 201) and email_row(s_in3)[8] == "t" and out["left"] == [], "%s %s %s" % (status, email_row(s_in3), out))
    check("MAIL-10: … moved to the Trash mailbox (was: erased on the server for good), the row records who deleted it",
          # two columns, not 'a' || '|' || 'b': sql() splits the rows of psql at '|'
          out["trash"] and sql("SELECT coalesce(deleted_by_id::text, ''), from_mailbox FROM email WHERE id = %d" % in3) == [[str(agent_b["id"]), "INBOX.Trash"]],
          (out, sql("SELECT deleted_by_id, from_mailbox, email_id FROM email WHERE id = %d" % in3)))
    status, body = http("GET", "/emails?deleted=true&limit=200&sort[id]=-1", token=agent_b["token"])
    check("MAIL-10: «Удалённые» lists it for B", status == 200 and in3 in ids_of(body), "%s %s" % (status, sorted(ids_of(body))))
    status, body = http("PATCH", "/emails/%d/restore" % in3, {}, token=agent_b["token"])
    out = node("out.inbox = await byMessageId(F.inbox, %s);" % json.dumps(rows[s_in3][2]))
    check("MAIL-10: «Восстановить» -> 200, back in INBOX on the server and shown again",
          status in (200, 201) and email_row(s_in3)[8] == "f" and email_row(s_in3)[4] == "INBOX" and out["inbox"],
          "%s %s %s %s" % (status, message_of((status, body)), email_row(s_in3), out))
    status, _ = sync()
    check("MAIL-10: … the next sync does not save it a second time", status == 200 and count("SELECT count(*) FROM email WHERE subject = %s" % q(s_in3)) == 1,
          sql("SELECT id, from_mailbox, email_id, deleted_at FROM email WHERE subject = %s" % q(s_in3)))

    status, body = http("GET", "/emails?limit=5", token=no_mail["token"])
    status2, _ = sync(token=no_mail["token"])
    check("agent with the 'mail' switch off -> 403 on the mail routes (the client only hid the menu)",
          status == 403 and status2 == 403, "%s %s" % (status, status2))
    status, _ = http("GET", "/emails?limit=5", token=agent_a["token"])
    check("agent with mail on -> 200", status == 200, status)

    section("Signatures: only the owner (and the admin) may change one")
    sign = "<p>%s signature</p>" % P
    status, body = http("PATCH", "/emails/signs", {"user_id": agent_b["id"], "sign": sign}, token=agent_a["token"])
    status2, _ = http("GET", "/emails/signs/%d" % agent_b["id"], token=agent_a["token"])
    check("agent A sets B's signature -> 403, B still has none (was: any staff could)", status == 403 and status2 == 404, (status, status2))
    status, body = http("PATCH", "/emails/signs", {"user_id": agent_a["id"], "sign": sign}, token=agent_a["token"])
    status2, body2 = http("GET", "/emails/signs/%d" % agent_a["id"], token=agent_a["token"])
    check("agent A sets their own -> 200 and reads it back", status in (200, 201) and status2 == 200 and body2.get("sign") == sign, (status, status2, body2))
    status, body = http("PATCH", "/emails/signs", {"user_id": agent_a["id"], "sign": sign + "<i>admin</i>"})
    status2, body2 = http("GET", "/emails/signs/%d" % agent_a["id"], token=manager["token"])
    check("admin changes A's signature -> 200 (manager may read it)", status in (200, 201) and status2 == 200 and body2.get("sign") == sign + "<i>admin</i>", (status, status2, body2))
    status, _ = http("PATCH", "/emails/signs", {"user_id": agent_a["id"], "sign": "x"}, token=manager["token"])
    check("manager changes A's signature -> 403", status == 403, status)
    status, _ = http("DELETE", "/emails/signs/%d" % agent_a["id"], token=agent_b["token"])
    status2, _ = http("GET", "/emails/signs/%d" % agent_a["id"], token=agent_a["token"])
    check("agent B deletes A's signature -> 403, it is still there", status == 403 and status2 == 200, (status, status2))
    status, _ = http("DELETE", "/emails/signs/%d" % agent_a["id"])
    status2, _ = http("GET", "/emails/signs/%d" % agent_a["id"], token=agent_a["token"])
    check("admin deletes A's signature -> 200, then 404", status in (200, 201) and status2 == 404, (status, status2))

    # ================================================================= outgoing
    section("Outgoing mail: saved, copied to Sent, in deal history")
    s_out1 = P + "-out-client"
    status, body = http("POST", "/emails", {"subject": s_out1, "body": "<p>reply to the client</p>", "to": [client_email]})
    check("admin POST /emails to the client -> 201", status in (200, 201), "%s %s" % (status, message_of((status, body))))
    row = email_row(s_out1)
    out = node("out.sent = await byMessageId(F.sent, %s); out.sentValidity = await uidValidity(F.sent);" % json.dumps(row[2] if row else "<none>"))
    check("the row: outgoing, sent by the admin, in the Sent mailbox with uid, Message-ID and UIDVALIDITY",
          row and row[5] == "t" and row[9] == str(admin_id) and row[4] == "INBOX.Sent" and row[1] and row[2] and row[3] == out["sentValidity"], (row, out))
    check("the copy on the server has the same uid and Message-ID",
          row and out["sent"] and str(out["sent"][0]["uid"]) == row[1], (row, out))
    check("the outgoing email is in the history of the client's deal (was: the history listener crashed on outgoing emails)",
          events_for(deal_client, s_out1, wait=10) == 1, events_for(deal_client, s_out1))
    check("… marked outgoing there", scalar("SELECT after_state->'data'->>'outgoing' FROM event WHERE type = %d AND deal_id = %d AND after_state->'data'->>'subject' = %s"
                                             % (EVENT_NEW_EMAIL, deal_client, q(s_out1))) == "true")
    check("… and in the column event.outgoing", scalar("SELECT outgoing::text FROM event WHERE type = %d AND deal_id = %d AND after_state->'data'->>'subject' = %s"
                                                     % (EVENT_NEW_EMAIL, deal_client, q(s_out1))) == "true")
    check("… and not in the deal without contacts", events_for(deal_other, s_out1) == 0)

    s_out2 = P + "-out-with-deal"
    status, body = http("POST", "/emails", {"subject": s_out2, "body": "<p>from the deal card</p>", "to": [client_email], "deal_id": str(deal_other)})
    check("POST /emails with deal_id (the 'Привязать сделку' field) -> 201", status in (200, 201), "%s %s" % (status, message_of((status, body))))
    check("… history of the chosen deal only, once (wave 1b: a letter goes into one deal, not also the recipient's)",
          events_for(deal_other, s_out2, wait=10) == 1 and events_for(deal_client, s_out2) == 0, (events_for(deal_other, s_out2), events_for(deal_client, s_out2)))
    status, body = http("POST", "/emails", {"subject": P + "-out-bad-deal", "body": "x", "to": [client_email], "deal_id": "999999999"})
    check("unknown deal_id -> 404, nothing sent", status == 404 and email_row(P + "-out-bad-deal") is None, "%s %s" % (status, message_of((status, body))))

    s_out3 = P + "-out-agent-a"
    status, body = http("POST", "/emails", {"subject": s_out3, "body": "<p>hello</p>", "to": ["auditml-ext9@example.test"]}, token=agent_a["token"])
    row = email_row(s_out3)
    check("agent A sends an email -> 201, sent_by = A", status in (200, 201) and row and row[9] == str(agent_a["id"]), "%s %s" % (status, row))
    out_id = int(row[0]) if row else 0
    status, body = http("GET", "/emails?outgoing=true&limit=200&sort[id]=-1", token=agent_a["token"])
    check("agent A: the 'Отправленные' list shows it", status == 200 and out_id in ids_of(body), "%s %s" % (status, sorted(ids_of(body))))
    status, body = http("GET", "/emails?outgoing=true&limit=200&sort[id]=-1", token=agent_b["token"])
    check("agent B: does not see it", status == 200 and out_id not in ids_of(body))
    status, _ = http("GET", "/emails/%d" % out_id, token=agent_a["token"])
    status2, _ = http("GET", "/emails/%d" % out_id, token=agent_b["token"])
    status3, _ = http("GET", "/emails/%d" % out_id, token=manager["token"])
    check("open it: A 200, B 403, manager 200", status == 200 and status2 == 403 and status3 == 200, (status, status2, status3))

    status, _ = sync()
    check("sync after sending: the Sent copies are not saved a second time",
          status == 200 and all(count("SELECT count(*) FROM email WHERE subject = %s" % q(s)) == 1 for s in (s_out1, s_out2, s_out3)))

    # ================================================================= batches
    section("First sync of a big mailbox goes in batches (EMAIL_SYNC_BATCH, 50 by default)")
    out = node("""
      out.ids = [];
      for (let i = 1; i <= %(n)d; i++) out.ids.push(await smtp({ from: 'Bulk <auditml-bulk@example.test>', to: %(shared)s, subject: %(p)s + i, text: 'bulk ' + i }));
    """ % {"n": BULK, "shared": json.dumps(shared), "p": json.dumps(P + "-bulk-")})
    check("%d messages delivered to the mail server" % BULK, len(out["ids"]) == BULK)
    started = time.time()
    status, _ = sync()
    took = time.time() - started
    like = q(P + "-bulk-%")
    check("GET /emails/sync -> 200 (%.0f s)" % took, status == 200, status)
    check("all %d emails saved, each once, each with its Message-ID and uid" % BULK,
          count("SELECT count(*) FROM email WHERE subject LIKE %s" % like) == BULK
          and count("SELECT count(DISTINCT message_id) FROM email WHERE subject LIKE %s AND message_id IS NOT NULL" % like) == BULK
          and count("SELECT count(DISTINCT email_id) FROM email WHERE subject LIKE %s AND email_id IS NOT NULL" % like) == BULK,
          count("SELECT count(*) FROM email WHERE subject LIKE %s" % like))
    check("their Message-IDs are the ones the mail server received",
          set(r[0] for r in sql("SELECT message_id FROM email WHERE subject LIKE %s" % like)) == set(out["ids"]))
    status, _ = sync()
    check("second sync adds nothing", status == 200 and count("SELECT count(*) FROM email WHERE subject LIKE %s" % like) == BULK)
    service = read_file(API_SRC, os.path.join("email", "mail-sync.service.ts"))
    check("code: messages are fetched and saved per batch (syncBatch / EMAIL_SYNC_BATCH), not the whole mailbox at once",
          "EMAIL_SYNC_BATCH" in service and "syncBatch(" in service and "chunks(uids, 1000)" in service)

    # ================================================================= uidvalidity
    section("UIDVALIDITY of a mailbox changes: local copies are re-matched, no duplicates")
    trash = "INBOX.Trash"
    mids = {k: "<auditml-uv-%s-%s@%s>" % (k, RUN, DOMAIN) for k in ("m0", "m1", "m2", "m3")}
    subj = {k: "%s-uv-%s" % (P, k) for k in mids}
    date = time.strftime("%a, %d %b %Y %H:%M:%S +0000", time.gmtime())

    def msg(k):
        return json.dumps({"from": "UV <auditml-uv@example.test>", "to": shared, "subject": subj[k], "date": date, "messageId": mids[k], "text": "uv " + k})

    out = node("""
      const lock = await c.getMailboxLock(F.trash);
      try { await c.messageDelete('1:*'); } finally { lock.release(); }
      out.m0 = await append(F.trash, %s); out.m1 = await append(F.trash, %s); out.m2 = await append(F.trash, %s);
      out.v1 = await uidValidity(F.trash);
    """ % (msg("m0"), msg("m1"), msg("m2")))
    v1 = out["v1"]
    status, _ = sync()
    rows = {k: email_row(subj[k]) for k in ("m0", "m1", "m2")}
    check("three messages in the Trash mailbox are synced with their uids and UIDVALIDITY V1 (soft-deleted, as Trash should be)",
          status == 200 and all(rows[k] and rows[k][1] == str(out[k]["uid"]) and rows[k][3] == v1 and rows[k][8] == "t" for k in rows), (rows, out))
    # a copy saved before Message-IDs were stored: matched by sender, subject and date
    sql("UPDATE email SET message_id = NULL WHERE subject = %s" % q(subj["m2"]))

    # A real re-creation of the folder would change UIDVALIDITY on the server, but GreenMail hangs
    # on DELETE of a folder another connection (the API's) has read. So the server side is imitated:
    # the messages are renumbered (deleted and appended again, m2 and m1 swapped, m0 gone, m3 new) and
    # the stored UIDVALIDITY is made stale, which is exactly what the API sees after a real change.
    out = node("""
      const lock = await c.getMailboxLock(F.trash);
      try { await c.messageDelete('1:*'); } finally { lock.release(); }
      out.m2 = await append(F.trash, %s); out.m1 = await append(F.trash, %s); out.m3 = await append(F.trash, %s);
      out.v2 = await uidValidity(F.trash);
    """ % (msg("m2"), msg("m1"), msg("m3")))
    v2 = out["v2"]
    sql("UPDATE email SET uidvalidity = uidvalidity - 1 WHERE from_mailbox = %s" % q(trash))
    check("the server renumbered the messages and the stored UIDVALIDITY differs from the server's (%s)" % v2,
          str(out["m1"]["uid"]) != rows["m1"][1] and count("SELECT count(*) FROM email WHERE from_mailbox = %s AND uidvalidity::text = %s" % (q(trash), q(v2))) == 0, out)
    status, body = sync()
    check("sync after the change -> 200", status == 200, "%s %s" % (status, message_of((status, body))))
    rows = {k: email_row(subj[k]) for k in mids}
    check("m1 (matched by Message-ID): the same row now carries the new uid and V2",
          rows["m1"] and rows["m1"][1] == str(out["m1"]["uid"]) and rows["m1"][3] == v2, (rows["m1"], out["m1"]))
    check("m2 (no Message-ID stored, matched by sender/subject/date): new uid and V2",
          rows["m2"] and rows["m2"][1] == str(out["m2"]["uid"]) and rows["m2"][3] == v2, (rows["m2"], out["m2"]))
    check("m0 (no longer on the server): kept locally without a uid, V2",
          rows["m0"] and rows["m0"][1] == "" and rows["m0"][3] == v2, rows["m0"])
    check("m3 (new on the server): saved once with its uid", rows["m3"] and rows["m3"][1] == str(out["m3"]["uid"]) and rows["m3"][3] == v2, (rows["m3"], out["m3"]))
    check("no duplicates: one row per message", all(count("SELECT count(*) FROM email WHERE subject = %s" % q(subj[k])) == 1 for k in mids),
          {k: count("SELECT count(*) FROM email WHERE subject = %s" % q(subj[k])) for k in mids})
    check("no row of the mailbox is left with the old UIDVALIDITY",
          count("SELECT count(*) FROM email WHERE from_mailbox = %s AND (uidvalidity IS NULL OR uidvalidity::text <> %s)" % (q(trash), q(v2))) == 0)
    status, _ = sync()
    check("a further sync changes nothing", status == 200 and all(count("SELECT count(*) FROM email WHERE subject = %s" % q(subj[k])) == 1 for k in mids))

    review_wave({
        "admin_id": admin_id, "shared": shared, "stage_id": stage_id, "agent_a": agent_a, "agent_b": agent_b,
        "no_mail": no_mail, "client_email": client_email, "contact_id": contact_id, "company_id": company_id,
        "deal_client": deal_client, "in1": in1, "s_in1": s_in1, "s_out3": s_out3, "events_for": events_for,
    })

    wave_1b({
        "admin_id": admin_id, "shared": shared, "stage_id": stage_id, "agent_a": agent_a, "agent_b": agent_b,
        "manager": manager, "company_id": company_id, "events_for": events_for,
    })

    # ================================================================= client
    section("Client")
    modal = read_file(CLIENT, os.path.join("components", "mail", "AddContactModal.vue"))
    check("AddContactModal: shows the contact's custom fields, required ones marked, and sends them (fillers) with company_id",
          "fillersService.find()" in modal and 'required="filler.is_required"' in modal and "company_id: companyId" in modal
          and "toFillerPayload(draft.fillers)" in modal)
    check("AddContactModal: a new company is created with its required fields", "toFillerPayload(draft.companyFillers)" in modal and "is_old: false" in modal)
    check("AddContactModal: the placeholder name and the unused 'Ответственный' field are gone",
          "Need email name contact" not in modal and "Ответственный" not in modal)
    single = read_file(CLIENT, os.path.join("pages", "mails", "index", "[id].vue"))
    check("reply form: the deal picked in 'Привязать сделку' is sent as deal_id", "formData.append('deal_id'" in single and 'v-model="selectedDeal"' in single)
    reply_form = read_file(CLIENT, os.path.join("components", "mail", "EmailReplyForm.vue"))
    check("MAIL-1: the reply form of the deal card sends the deal (deal_id): the letter is in its history whatever the address",
          "formData.append('deal_id'" in reply_form)
    new_form = read_file(CLIENT, os.path.join("pages", "mails", "new.vue"))
    check("MAIL-15: the three mail forms let the server add the signature (with_signature), none puts it into the editor",
          all("with_signature" in text and "SignaturePreview" in text for text in (reply_form, single, new_form))
          and "+ sign" not in reply_form and "+ sign" not in single)
    check("MAIL-11 / MAIL-12: the letter page replies in the thread (reply_to_email_id), shows HTML only cleaned (letterView) and folds the quote",
          "reply_to_email_id" in single and "letterView(" in single and "Показать цитату" in single)
    check("MAIL-13: the assistant is in the mail forms and translates to Russian and Uzbek",
          "MailAssistant" in single and "MailAssistant" in new_form
          and "'russian'" in read_file(CLIENT, os.path.join("components", "mail", "MailAssistant.vue")))
    assist = read_file(API_SRC, os.path.join("email", "mail-assist.service.ts"))
    check("MAIL-13: the assistant reads the e-mails of the deal (after_state.data: body and direction)",
          "after_state->'data'->>'body'" in assist and "after_state->'data'->>'outgoing'" in assist)
    deal_modal = read_file(CLIENT, os.path.join("components", "mail", "AddDealModal.vue"))
    check("MAIL-16 / DEAL-8: «доб.сделку» goes through POST /emails/deals (the client and the letters), not an empty POST /deals",
          "mailService.post('deals'" in deal_modal and "dealService" not in deal_modal)
    check("MAIL-16: «доб.контакты» links the stored letters to the new contacts", "post('contacts'" in modal)
    controller = read_file(API_SRC, os.path.join("email", "email.controller.ts"))
    check("API: the mail routes are behind MailAccessGuard and pass the user to open/delete/spam", "MailAccessGuard" in controller
          and controller.count("extractUserFromRequest(request)") >= 4)


def review_wave(x):
    """The mail findings of the review of 2026-11 (MAIL-1 … MAIL-18, DEAL-8), against the API and the mail server."""
    admin_id, shared, agent_a, agent_b = x["admin_id"], x["shared"], x["agent_a"], x["agent_b"]
    client_email, contact_id, deal_client, in1, s_in1 = x["client_email"], x["contact_id"], x["deal_client"], x["in1"], x["s_in1"]
    events_for = x["events_for"]

    def new_deal(label, agent, company, closed=False):
        return int(scalar(
            "INSERT INTO deal (label, display_id, budget, stage_id, agent_id, created_by, company_id, closed_at) "
            "VALUES (%s, %d, 100, %d, %d, %d, %s, %s) RETURNING id"
            % (q(label), 900000000 + secrets.randbelow(90000000), x["stage_id"], agent, admin_id,
               "NULL" if company is None else int(company), "now() - interval '1 day'" if closed else "NULL")))

    def wait_for(fn, wait=15):
        deadline = time.time() + wait
        while True:
            value = fn()
            if value or time.time() >= deadline:
                return value
            time.sleep(1)

    # ----------------------------------------------------------------- list and letter
    section("Review 2026-11: the client and the deals of a letter (MAIL-12)")
    status, body = http("GET", "/emails/%d" % in1)
    deals = [d.get("id") for d in (body or {}).get("deals", [])] if isinstance(body, dict) else []
    check("GET /emails/:id: the deals whose history the letter is in, its contact and whom to reply",
          status == 200 and deal_client in deals and ((body.get("client") or {}).get("contact") or {}).get("id") == contact_id
          and client_email in ((body.get("reply") or {}).get("to") or []), "%s %s" % (status, {k: body.get(k) for k in ("deals", "client", "reply")} if isinstance(body, dict) else body))
    status, body = http("GET", "/emails?limit=200&sort[id]=-1")
    item = next((e for e in (body or {}).get("data", []) if e.get("id") == in1), None) if isinstance(body, dict) else None
    check("GET /emails: the list row carries the deals and the client too",
          item is not None and deal_client in [d.get("id") for d in item.get("deals", [])] and (item.get("client") or {}).get("contact"), item)

    # ----------------------------------------------------------------- reply in the thread
    section("Review 2026-11: a reply keeps the thread, has a name and a quote (MAIL-11)")
    s_re = "Re: %s-reply" % P
    status, body = http("POST", "/emails", {"subject": s_re, "body": "<p>our answer</p>", "to": [client_email], "reply_to_email_id": str(in1)})
    row = email_row(s_re)
    in1_mid = scalar("SELECT message_id FROM email WHERE id = %d" % in1)
    check("POST /emails with reply_to_email_id -> 201, the row answers the letter (In-Reply-To)",
          status in (200, 201) and row and scalar("SELECT in_reply_to FROM email WHERE id = %s" % row[0]) == in1_mid,
          "%s %s %s" % (status, message_of((status, body)), row))
    out = node("""
      out.h = await headersOf(F.sent, %s);
      const { simpleParser } = await import('mailparser');
      const parsed = await simpleParser((out.h || '') + '\\r\\n');
      out.name = parsed.from?.value?.[0]?.name || '';
      out.inReplyTo = parsed.inReplyTo || '';
      out.references = [].concat(parsed.references || []).join(' ');
    """ % json.dumps(row[2] if row else "<none>"))
    check("… the copy on the server: In-Reply-To / References of the letter answered, From with a name",
          in1_mid and out.get("inReplyTo") == in1_mid and in1_mid in out.get("references", "") and "Parisa Home" in out.get("name", ""), out)
    check("… the letter quotes the original, the deal history keeps only the answer",
          row and "crm-quote" in (scalar("SELECT body FROM email WHERE id = %s" % row[0]) or "")
          and events_for(deal_client, s_re, wait=10) == 1
          and "crm-quote" not in (scalar("SELECT after_state->'data'->>'body' FROM event WHERE type = %d AND deal_id = %d AND after_state->'data'->>'subject' = %s"
                                         % (EVENT_NEW_EMAIL, deal_client, q(s_re))) or "x crm-quote"),
          events_for(deal_client, s_re))

    # ----------------------------------------------------------------- signature
    section("Review 2026-11: the signature is added by the server with its formatting (MAIL-15)")
    sign = '<table><tr><td style="color:#0a7">%s sign</td></tr></table>' % P
    status, _ = http("PATCH", "/emails/signs", {"user_id": agent_a["id"], "sign": sign}, token=agent_a["token"])
    s_sig, s_nosig = P + "-signed", P + "-unsigned"
    http("POST", "/emails", {"subject": s_sig, "body": "<p>text</p>", "to": ["auditml-ext9@example.test"], "with_signature": "true"}, token=agent_a["token"])
    http("POST", "/emails", {"subject": s_nosig, "body": "<p>text</p>", "to": ["auditml-ext9@example.test"]}, token=agent_a["token"])
    signed = scalar("SELECT body FROM email WHERE subject = %s" % q(s_sig)) or ""
    unsigned = scalar("SELECT body FROM email WHERE subject = %s" % q(s_nosig)) or ""
    check("with_signature=true: the signature under the text with its table and colours; without it (the old web client) none",
          status in (200, 201) and "crm-signature" in signed and "<table" in signed and "color:#0a7" in signed and "crm-signature" not in unsigned,
          (status, signed[:300], unsigned[:200]))
    http("DELETE", "/emails/signs/%d" % agent_a["id"])

    # ----------------------------------------------------------------- addresses, errors
    section("Review 2026-11: addresses and errors of sending (MAIL-14)")
    status, body = http("POST", "/emails", {"subject": P + "-bad-address", "body": "x", "to": ["not-an-address"]})
    check("a wrong address -> 400 in words (the field and the address), nothing saved",
          status == 400 and "Кому" in message_of((status, body)) and email_row(P + "-bad-address") is None, "%s %s" % (status, message_of((status, body))))
    s_two = P + "-two"
    status, body = http("POST", "/emails", {"subject": s_two, "body": "x", "to": "auditml-ext7@example.test, auditml-ext8@example.test"})
    row = email_row(s_two)
    check("several addresses in one field are split -> 201 with two recipients",
          status in (200, 201) and row and count("SELECT count(*) FROM email_to WHERE email_id = %s" % row[0]) == 2, "%s %s" % (status, message_of((status, body))))

    # ----------------------------------------------------------------- MAIL-6 mailboxes
    section("Review 2026-11: a mailbox only for one's own address, only with a password the server accepts (MAIL-6)")
    pw = secrets.token_urlsafe(10)
    status, body = http("POST", "/emails/transporters", {"email": agent_b["email"], "password": pw}, token=agent_a["token"])
    status2, _ = http("POST", "/emails/transporters", {"email": shared, "password": pw}, token=agent_a["token"])
    check("agent A adds B's address or the shared mailbox -> 403, nothing saved (was: read and deleted their mail)",
          status == 403 and status2 == 403 and count("SELECT count(*) FROM email_transporter WHERE user_id = %d" % agent_a["id"]) == 0,
          "%s %s %s" % (status, status2, message_of((status, body))))
    probe = node("out.any = await acceptsLogin(%s, %s); out.own = await acceptsLogin(%s, %s);"
                 % (json.dumps(agent_a["email"]), json.dumps("wrong-" + pw), json.dumps(agent_a["email"]), json.dumps(pw)))
    if not probe.get("any"):
        status, body = http("POST", "/emails/transporters", {"email": agent_a["email"], "password": "wrong-" + pw}, token=agent_a["token"])
        check("agent A adds their own address with a wrong password -> 400, nothing saved",
              status == 400 and count("SELECT count(*) FROM email_transporter WHERE user_id = %d" % agent_a["id"]) == 0, "%s %s" % (status, message_of((status, body))))
    else:
        print("SKIP  wrong password -> 400: the stand's mail server accepts any password", flush=True)
    if probe.get("own"):
        status, body = http("POST", "/emails/transporters", {"email": agent_a["email"], "password": pw}, token=agent_a["token"])
        check("agent A adds their own address, the server accepts it -> 201, checked (verified_at), no password in the answer",
              status in (200, 201) and isinstance(body, dict) and "password" not in body
              and count("SELECT count(*) FROM email_transporter WHERE user_id = %d AND verified_at IS NOT NULL" % agent_a["id"]) == 1,
              "%s %s" % (status, message_of((status, body))))
        status, body = http("GET", "/emails/transporters?all=true")
        mine = [t for t in body if (t.get("created_by") or {}).get("id") == agent_a["id"]] if isinstance(body, list) else []
        status2, body2 = http("GET", "/emails/transporters?all=true", token=agent_b["token"])
        check("the admin sees every employee's mailbox with its owner; agent B only their own (none)",
              status == 200 and len(mine) == 1 and status2 == 200 and body2 == [], (status, mine, status2, body2))
    else:
        print("SKIP  own mailbox -> 201: the stand's mail server does not know agent A's mailbox", flush=True)

    # ----------------------------------------------------------------- MAIL-18
    section("Review 2026-11: the agent sees the client's answer to their letter (MAIL-18)")
    s_ans = P + "-answer-to-a"
    a_mid = scalar("SELECT message_id FROM email WHERE subject = %s" % q(x["s_out3"]))
    node("await smtp({ from: 'Ext <auditml-ext9@example.test>', to: %s, subject: %s, text: 'answer', inReplyTo: %s, references: %s });"
         % (json.dumps(shared), json.dumps(s_ans), json.dumps(a_mid), json.dumps(a_mid)))
    sync()
    row = email_row(s_ans)
    status, body = http("GET", "/emails?limit=200&sort[id]=-1", token=agent_a["token"])
    status2, _ = http("GET", "/emails/%s" % (row[0] if row else 0), token=agent_a["token"])
    status3, _ = http("GET", "/emails/%s" % (row[0] if row else 0), token=agent_b["token"])
    check("an answer (In-Reply-To) to A's letter, sent to the shared mailbox: A lists and opens it, B does not",
          row and status == 200 and int(row[0]) in ids_of(body) and status2 == 200 and status3 == 403, (row, status, status2, status3))

    # ----------------------------------------------------------------- MAIL-5
    section("Review 2026-11: a letter sent from a mail program (the Sent mailbox) goes into the deal (MAIL-5)")
    s_ext = P + "-sent-elsewhere"
    node("await append(F.sent, %s);" % json.dumps({"from": "Parisa <%s>" % shared, "to": client_email, "subject": s_ext,
                                                    "date": time.strftime("%a, %d %b %Y %H:%M:%S +0000", time.gmtime()),
                                                    "messageId": "<auditml-ext-%s@%s>" % (RUN, DOMAIN), "text": "answer from Outlook"}))
    sync()
    row = email_row(s_ext)
    check("saved as outgoing from the Sent mailbox and put into the client's deal (marked outgoing)",
          row and row[5] == "t" and row[4] == "INBOX.Sent" and events_for(deal_client, s_ext, wait=10) == 1
          and scalar("SELECT outgoing::text FROM event WHERE type = %d AND deal_id = %d AND after_state->'data'->>'subject' = %s"
                     % (EVENT_NEW_EMAIL, deal_client, q(s_ext))) == "true", (row, events_for(deal_client, s_ext)))

    # ----------------------------------------------------------------- MAIL-4
    section("Review 2026-11: a returning client, the company address (MAIL-4)")
    back_email = "auditml-back-%s@%s" % (RUN, DOMAIN)
    back_id = int(scalar("INSERT INTO \"user\" (username, email, role, company_id) VALUES (%s, %s, 'ctr_agent', %d) RETURNING id"
                         % (q(P + "-back"), q(back_email), x["company_id"])))
    closed = new_deal(P + "-closed", agent_a["id"], x["company_id"], closed=True)
    sql('INSERT INTO deal_user ("dealId", "userId") VALUES (%d, %d)' % (closed, back_id))
    co2_email = "auditml-co2-%s@%s" % (RUN, DOMAIN)
    co2 = int(scalar("INSERT INTO company (name, email, is_old, created_by) VALUES (%s, %s, false, %d) RETURNING id" % (q(P + "-co2"), q(co2_email), admin_id)))
    co2_deal = new_deal(P + "-co2-deal", admin_id, co2)
    s_back, s_co2 = P + "-returning", P + "-company-address"
    node("await smtp({ from: %s, to: %s, subject: %s, text: 'again' }); await smtp({ from: %s, to: %s, subject: %s, text: 'from the office' });"
         % (json.dumps(back_email), json.dumps(shared), json.dumps(s_back), json.dumps(co2_email), json.dumps(shared), json.dumps(s_co2)))
    sync()
    check("a contact whose deals are all closed is still recognised (was: the letter had no client)",
          scalar("SELECT user_id FROM email WHERE subject = %s" % q(s_back)) == str(back_id), sql("SELECT id, user_id FROM email WHERE subject = %s" % q(s_back)))
    repeat = wait_for(lambda: scalar("SELECT id FROM deal WHERE repeat_of_id = %d AND deleted_at IS NULL" % closed))
    check("… a repeat deal is opened for them (as for Telegram / WhatsApp), with the letter in its history",
          repeat and events_for(int(repeat), s_back, wait=10) == 1,
          (repeat, sql("SELECT id, label, agent_id FROM deal WHERE repeat_of_id = %d" % closed)))
    check("a letter from the company's general address goes into the company's open deal",
          events_for(co2_deal, s_co2, wait=10) == 1, events_for(co2_deal, s_co2))

    # ----------------------------------------------------------------- MAIL-3
    section("Review 2026-11: one broken letter does not stop the mail (MAIL-3)")
    s_bad, s_after = P + "-long-name", P + "-after-long-name"
    out = node("""
      const longName = 'AUDITML-' + 'x'.repeat(300) + '.txt';
      const letter = ['From: Long <auditml-long@example.test>', 'To: ' + %(shared)s, 'Subject: ' + %(bad)s,
        'Date: ' + new Date().toUTCString(), 'Message-ID: <auditml-long-%(run)s@example.test>', 'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: quoted-printable', '', 'before=00after', '--b1',
        'Content-Type: text/plain; name="' + longName + '"', 'Content-Disposition: attachment; filename="' + longName + '"',
        'Content-Transfer-Encoding: base64', '', Buffer.from('AUDITML attachment').toString('base64'), '--b1--', ''].join('\\r\\n');
      await c.append(F.inbox, letter, []);  // not `raw`: the prelude declares function raw()
      await smtp({ from: 'After <auditml-after@example.test>', to: %(shared)s, subject: %(after)s, text: 'after' });
    """ % {"shared": json.dumps(shared), "bad": json.dumps(s_bad), "after": json.dumps(s_after), "run": RUN})
    status, body = sync(query="limit=1")
    check("a letter with a NUL character and a 300-character attachment name: saved (name cut to 255, NUL gone), the next letter too",
          status == 200 and email_row(s_bad) and email_row(s_after)
          and count("SELECT count(*) FROM file f JOIN email e ON e.id = f.email_id WHERE e.subject = %s AND length(f.name) <= 255 AND f.name LIKE '%%.txt'" % q(s_bad)) == 1
          and "\x00" not in (scalar("SELECT body FROM email WHERE subject = %s" % q(s_bad)) or "\x00"),
          (status, email_row(s_bad), email_row(s_after), sql("SELECT length(name) FROM file f JOIN email e ON e.id = f.email_id WHERE e.subject = %s" % q(s_bad))))
    status, body = http("GET", "/emails/sync-status")
    check("GET /emails/sync-status -> 200: last successful run, failing mailboxes and letters; GET /emails/sync carries it as `sync`",
          status == 200 and isinstance(body, dict) and {"ok", "last_success_at", "errors", "failing", "skipped"} <= set(body), (status, body))

    # ----------------------------------------------------------------- MAIL-16 / DEAL-8 / MAIL-17
    section("Review 2026-11: «доб.сделку» makes a deal with the client and the letter (MAIL-16, DEAL-8, MAIL-17)")
    s_new, new_addr = P + "-new-client", "auditml-new-%s@%s" % (RUN, DOMAIN)
    node("""await smtp({ from: { name: %s, address: %s }, to: %s, subject: %s, text: 'please quote',
                       attachments: [{ filename: 'spec.txt', content: 'AUDITML spec' }] });"""
         % (json.dumps(P + " Newbie"), json.dumps(new_addr), json.dumps(shared), json.dumps(s_new)))
    sync()
    row = email_row(s_new)
    letter = int(row[0]) if row else 0
    status, _ = http("POST", "/emails/deals", {"email_ids": [letter], "agent_id": agent_a["id"]}, token=agent_b["token"])
    status2, _ = http("POST", "/emails/deals", {"email_ids": [letter], "agent_id": agent_a["id"]}, token=x["no_mail"]["token"])
    check("B (the letter is not theirs) and an agent without mail -> 403", status == 403 and status2 == 403, (status, status2))
    status, body = http("POST", "/emails/deals", {"email_ids": [letter], "agent_id": agent_a["id"]})
    made = body[0] if isinstance(body, list) and body else {}
    deal_id = (made.get("deal") or {}).get("id")
    contact = (made.get("contact") or {}).get("id")
    check("admin POST /emails/deals -> the deal named after the subject, A responsible, a new contact named from the letter",
          status in (200, 201) and deal_id and made.get("created_contact") and (made.get("contact") or {}).get("username") == P + " Newbie"
          and sql("SELECT label, agent_id FROM deal WHERE id = %d" % deal_id) == [[s_new, str(agent_a["id"])]]
          and count('SELECT count(*) FROM deal_user WHERE "dealId" = %d AND "userId" = %d' % (deal_id, contact or 0)) == 1,
          "%s %s" % (status, body))
    check("… the letter is in its history and points to the contact (was: an empty deal «#N»)",
          deal_id and events_for(deal_id, s_new, wait=10) == 1 and scalar("SELECT user_id FROM email WHERE id = %d" % letter) == str(contact),
          (deal_id and events_for(deal_id, s_new), scalar("SELECT user_id FROM email WHERE id = %d" % letter)))
    check("MAIL-17: … its attachment is in the deal's files",
          deal_id and wait_for(lambda: count('SELECT count(*) FROM deal_file df JOIN file f ON f.id = df."fileId" WHERE df."dealId" = %d AND f.email_id = %d' % (deal_id, letter))) == 1,
          sql('SELECT "fileId" FROM deal_file WHERE "dealId" = %d' % (deal_id or 0)))

    section("Review 2026-11: «доб.контакты» — the stored letters point to the new contact (MAIL-16)")
    s_later, later_addr = P + "-later", "auditml-later-%s@%s" % (RUN, DOMAIN)
    node("await smtp({ from: %s, to: %s, subject: %s, text: 'hello' });" % (json.dumps(later_addr), json.dumps(shared), json.dumps(s_later)))
    sync()
    later_id = int(scalar("INSERT INTO \"user\" (username, email, role, company_id) VALUES (%s, %s, 'ctr_agent', %d) RETURNING id"
                          % (q(P + "-later"), q(later_addr), x["company_id"])))
    status, body = http("POST", "/emails/contacts", {"user_ids": [later_id]})
    check("POST /emails/contacts -> 200, the letter points to the contact",
          status == 200 and scalar("SELECT user_id FROM email WHERE subject = %s" % q(s_later)) == str(later_id), "%s %s" % (status, body))

    # ----------------------------------------------------------------- MAIL-10 webmail
    section("Review 2026-11: a letter moved to Trash in webmail is no duplicate (MAIL-10)")
    in1_mid = scalar("SELECT message_id FROM email WHERE id = %d" % in1)
    out = node("out.moved = await moveTo(F.inbox, F.trash, %s);" % json.dumps(in1_mid))
    sync()
    check("after the move: the letter is shown nowhere (both copies deleted), still once in the deal history",
          out.get("moved") and count("SELECT count(*) FROM email WHERE subject = %s AND deleted_at IS NULL" % q(s_in1)) == 0
          and count("SELECT count(*) FROM email WHERE subject = %s" % q(s_in1)) == 2 and events_for(deal_client, s_in1) == 1,
          (out, sql("SELECT id, from_mailbox, deleted_at IS NOT NULL FROM email WHERE subject = %s" % q(s_in1)), events_for(deal_client, s_in1)))


def wave_1b(x):
    """Fix wave 1b of the mail (live findings of 2026-11-23): one deal per letter, the thread, the deal
    written from, per-user «прочитано», who deletes, «Неразобранные» and «Привязать», colleagues' letters."""
    admin_id, shared, agent_a, agent_b, manager = x["admin_id"], x["shared"], x["agent_a"], x["agent_b"], x["manager"]
    company_id, events_for = x["company_id"], x["events_for"]

    def new_deal(label, agent, closed=False):
        return int(scalar(
            "INSERT INTO deal (label, display_id, budget, stage_id, agent_id, created_by, company_id, closed_at) "
            "VALUES (%s, %d, 100, %d, %d, %d, %d, %s) RETURNING id"
            % (q(label), 900000000 + secrets.randbelow(90000000), x["stage_id"], agent, admin_id, company_id,
               "now() - interval '1 day'" if closed else "NULL")))

    def wait_for(fn, wait=15):
        deadline = time.time() + wait
        while True:
            value = fn()
            if value or time.time() >= deadline:
                return value
            time.sleep(1)

    # ----------------------------------------------------------------- one deal
    section("Wave 1b: a letter goes into ONE deal — the deal written from, the thread, else the newest (MAIL-3, MAIL-5, MAIL-7)")
    two_email = "auditml-two-%s@%s" % (RUN, DOMAIN)
    two_id = int(scalar("INSERT INTO \"user\" (username, email, role, company_id) VALUES (%s, %s, 'ctr_agent', %d) RETURNING id"
                        % (q(P + "-two"), q(two_email), company_id)))
    older = new_deal(P + "-two-older", agent_a["id"])
    newer = new_deal(P + "-two-newer", agent_a["id"])
    closed = new_deal(P + "-two-closed", agent_a["id"], closed=True)
    for deal in (older, newer, closed):
        sql('INSERT INTO deal_user ("dealId", "userId") VALUES (%d, %d)' % (deal, two_id))

    s_two = P + "-two-deals"
    node("await smtp({ from: %s, to: %s, subject: %s, text: 'which deal?' });" % (json.dumps(two_email), json.dumps(shared), json.dumps(s_two)))
    sync()
    check("an incoming letter of a contact with two open deals goes into the newest open deal only (was: into every open deal)",
          events_for(newer, s_two, wait=10) == 1 and events_for(older, s_two) == 0 and events_for(closed, s_two) == 0,
          (events_for(newer, s_two), events_for(older, s_two), events_for(closed, s_two)))

    s_from_older = P + "-from-older"
    status, body = http("POST", "/emails", {"subject": s_from_older, "body": "<p>offer</p>", "to": [two_email], "deal_id": str(older)})
    check("POST /emails with deal_id -> 201, the letter is in that deal only (was: also in every open deal of the recipient)",
          status in (200, 201) and events_for(older, s_from_older, wait=10) == 1 and events_for(newer, s_from_older) == 0,
          "%s %s %s" % (status, message_of((status, body)), (events_for(older, s_from_older), events_for(newer, s_from_older))))
    status, body = http("POST", "/emails", {"subject": P + "-to-closed", "body": "x", "to": [two_email], "deal_id": str(closed)})
    check("POST /emails with a closed deal -> 400 in Russian, nothing sent",
          status == 400 and email_row(P + "-to-closed") is None and re.search("[а-яА-Я]", message_of((status, body)) or ""),
          "%s %s" % (status, message_of((status, body))))

    mid = scalar("SELECT message_id FROM email WHERE subject = %s" % q(s_from_older))
    s_reply = "Re: " + s_from_older
    node("await smtp({ from: %s, to: %s, subject: %s, text: 'agreed', inReplyTo: %s, references: [%s] });"
         % (json.dumps(two_email), json.dumps(shared), json.dumps(s_reply), json.dumps(mid), json.dumps(mid)))
    sync()
    check("the client's reply (In-Reply-To) goes into the deal the letter was written from, not into the newest one",
          events_for(older, s_reply, wait=10) == 1 and events_for(newer, s_reply) == 0, (mid, events_for(older, s_reply), events_for(newer, s_reply)))

    # ----------------------------------------------------------------- MAIL-17
    section("Wave 1b: validation in Russian, 400 not 500 (MAIL-17)")
    status, body = http("POST", "/emails", {"subject": P + "-no-to", "body": "x", "to": []})
    check("POST /emails without recipients -> 400 «Укажите адрес получателя» (was: 500, SQL error)",
          status == 400 and "получател" in (message_of((status, body)) or ""), "%s %s" % (status, message_of((status, body))))

    # ----------------------------------------------------------------- MAIL-10 / MAIL-11
    section("Wave 1b: «прочитано» per user, who deletes a letter of the shared mailbox (MAIL-10, MAIL-11)")
    s_read = P + "-read-per-user"
    node("await smtp({ from: 'Someone <auditml-ext5@example.test>', to: %s, cc: %s, subject: %s, text: 'for both' });"
         % (json.dumps(agent_a["email"]), json.dumps(agent_b["email"]), json.dumps(s_read)))
    sync()
    row = email_row(s_read)
    letter = int(row[0]) if row else 0
    status, _ = http("GET", "/emails/%d" % letter, token=agent_a["token"])
    status_a, body_a = http("GET", "/emails?read=false&limit=200&sort[id]=-1", token=agent_a["token"])
    status_b, body_b = http("GET", "/emails?read=false&limit=200&sort[id]=-1", token=agent_b["token"])
    check("A opens the letter: it is read for A, still unread for B in Cc (was: read for everybody)",
          status == 200 and letter not in ids_of(body_a) and letter in ids_of(body_b), (status, status_a, status_b))
    status, body = http("PATCH", "/emails/read", {"ids": [letter]}, token=agent_b["token"])
    status_b, body_b = http("GET", "/emails?read=false&limit=200&sort[id]=-1", token=agent_b["token"])
    check("PATCH /emails/read (B) -> 200, now read for B too",
          status == 200 and letter not in ids_of(body_b), "%s %s" % (status, message_of((status, body))))
    status, body = http("DELETE", "/emails/%d" % letter, token=agent_b["token"])
    check("B in Cc deletes the letter of A and B -> 403, the letter stays (was: erased for everybody)",
          status == 403 and count("SELECT count(*) FROM email WHERE id = %d AND deleted_at IS NULL" % letter) == 1,
          "%s %s" % (status, message_of((status, body))))
    status, body = http("DELETE", "/emails/%d" % letter, token=manager["token"])
    check("the manager deletes it -> 200, softly, recorded (deleted_by)",
          status == 200 and scalar("SELECT deleted_by_id FROM email WHERE id = %d" % letter) == str(manager["id"]),
          "%s %s" % (status, message_of((status, body))))

    # ----------------------------------------------------------------- OMNI-5
    section("Wave 1b: «Неразобранные» and «Привязать» (OMNI-5, MAIL-8)")
    unknown = "auditml-unknown-%s@%s" % (RUN, DOMAIN)
    s_unknown = P + "-unknown-sender"
    node("await smtp({ from: %s, to: %s, subject: %s, text: 'first letter of a new client' });" % (json.dumps(unknown), json.dumps(shared), json.dumps(s_unknown)))
    sync()
    row = email_row(s_unknown)
    letter = int(row[0]) if row else 0
    status, unsorted = http("GET", "/emails?of_client=false&outgoing=false&limit=200&sort[id]=-1")
    status2, sorted_ = http("GET", "/emails?of_client=true&outgoing=false&limit=200&sort[id]=-1")
    check("the first letter of an unknown sender is in «Неразобранные» (of_client=false), not in «От клиентов»",
          status == 200 and status2 == 200 and letter in ids_of(unsorted) and letter not in ids_of(sorted_), (status, status2, letter))
    status, body = http("POST", "/emails/%d/link" % letter, {"deal_id": closed})
    check("«Привязать» to a closed deal -> 400", status == 400, "%s %s" % (status, message_of((status, body))))
    status, body = http("POST", "/emails/%d/link" % letter, {"deal_id": newer, "contact_id": two_id})
    check("«Привязать» to a deal and a contact -> 200: the letter is in the deal's history and points to the contact",
          status == 200 and events_for(newer, s_unknown, wait=10) == 1 and scalar("SELECT user_id FROM email WHERE id = %d" % letter) == str(two_id),
          "%s %s" % (status, body))
    status, body = http("POST", "/emails/%d/link" % letter, {})
    check("«Привязать» with nothing chosen -> 400", status == 400, status)

    late = "auditml-late-%s@%s" % (RUN, DOMAIN)
    s_late = P + "-late-contact"
    node("await smtp({ from: %s, to: %s, subject: %s, text: 'before the card had my e-mail' });" % (json.dumps(late), json.dumps(shared), json.dumps(s_late)))
    sync()
    late_id = int(scalar("INSERT INTO \"user\" (username, email, role, company_id) VALUES (%s, %s, 'ctr_agent', %d) RETURNING id"
                         % (q(P + "-late"), q(late), company_id)))
    late_deal = new_deal(P + "-late-deal", agent_a["id"])
    sql('INSERT INTO deal_user ("dealId", "userId") VALUES (%d, %d)' % (late_deal, late_id))
    sync()
    check("a letter stored before its sender's e-mail was in a card: the next sync links it to the contact and the contact's deal",
          wait_for(lambda: scalar("SELECT user_id FROM email WHERE subject = %s" % q(s_late)) == str(late_id))
          and events_for(late_deal, s_late, wait=10) == 1,
          (scalar("SELECT user_id FROM email WHERE subject = %s" % q(s_late)), events_for(late_deal, s_late)))

    # ----------------------------------------------------------------- MAIL-18
    section("Wave 1b: colleagues' letters are incoming, one To row per address (MAIL-18)")
    domain = shared.split("@")[-1] if "@" in shared else "parisahome.com"
    colleague = "auditml-colleague-%s@%s" % (RUN, domain)
    s_colleague = P + "-colleague"
    node("await smtp({ from: %s, to: %s, subject: %s, text: 'a forwarded request' });" % (json.dumps(colleague), json.dumps(shared), json.dumps(s_colleague)))
    s_many = P + "-two-recipients"
    node("await smtp({ from: 'Someone <auditml-ext6@example.test>', to: [%s, '\"Agent B\" <%s>'], subject: %s, text: 'to two' });"
         % (json.dumps(shared), agent_b["email"], json.dumps(s_many)))
    sync()
    check("a colleague's letter to the shared mailbox is incoming (was: in «Отправленные»)",
          scalar("SELECT outgoing::text FROM email WHERE subject = %s" % q(s_colleague)) == "false",
          sql("SELECT id, outgoing, from_mailbox FROM email WHERE subject = %s" % q(s_colleague)))
    check("To with two addresses: two rows, the filter by an address finds the letter",
          count("SELECT count(*) FROM email_to t JOIN email e ON e.id = t.email_id WHERE e.subject = %s" % q(s_many)) == 2,
          sql("SELECT t.value FROM email_to t JOIN email e ON e.id = t.email_id WHERE e.subject = %s" % q(s_many)))

    # ----------------------------------------------------------------- client
    section("Wave 1b: the mail page")
    page = read_file(CLIENT, os.path.join("pages", "mails", "index.vue"))
    letter_page = read_file(CLIENT, os.path.join("pages", "mails", "index", "[id].vue"))
    check("SCR4-1: no fixed column widths (w-96, w-[60rem]) and no column resizing; the date is a column of its own",
          "w-[60rem]" not in page and "ResizeObserver" not in page and "mail-cols" in page and "shortDate" in page)
    check("SCR4-3 / OMNI-5: «От клиентов / Неразобранные / Все» (of_client), «Синхронизировать», «Писем нет», «(без темы)»",
          "of_client" in page and "Неразобранные" in page and "Синхронизировать" in page and "Писем нет" in page and "(без темы)" in page)
    check("MAIL-10: «Прочитано» goes through PATCH /emails/read (per user), not by opening every letter",
          'patch("read"' in page)
    check("OMNI-5: the letter has «Привязать» (POST /emails/:id/link) for a deal and a contact",
          "/link`" in letter_page and "selectedContact" in letter_page)


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
            check("no AUDITML- rows are left in the database", not left, left)
        except Exception as error:
            check("cleanup (database)", False, error)
        try:
            out = node("await purge(); out.ok = true;")
            check("no AUDITML- messages are left on the mail server", out.get("ok"), out)
        except Exception as error:
            check("cleanup (mail server)", False, error)

    if failed_hard:
        check("run completed", False, failed_hard)

    failed = [name for name, ok in results if not ok]
    print("\n%d checks: %d passed, %d failed" % (len(results), len(results) - len(failed), len(failed)))
    for name in failed:
        print("  FAILED: " + name)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    run()
