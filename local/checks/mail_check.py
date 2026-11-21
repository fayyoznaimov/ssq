#!/usr/bin/env python3
"""
Regression checks for the mail module (block 6): access rights, outgoing emails in deal
history, batched sync, UIDVALIDITY changes.

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
CREATE TEMP TABLE _e AS SELECT id FROM email WHERE subject LIKE 'AUDITML-%' OR sent_by_id IN (SELECT id FROM _u);

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
SELECT 'email', count(*) FROM email WHERE subject LIKE 'AUDITML-%'
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

    status, body = http("DELETE", "/emails/%d" % in3, token=agent_b["token"])
    out = node("out.left = await byMessageId(F.inbox, %s);" % json.dumps(rows[s_in3][2]))
    check("agent B deletes their own email -> 200, removed from the server, soft-deleted locally",
          status in (200, 201) and email_row(s_in3)[8] == "t" and out["left"] == [], "%s %s %s" % (status, email_row(s_in3), out))

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
    check("… and not in the deal without contacts", events_for(deal_other, s_out1) == 0)

    s_out2 = P + "-out-with-deal"
    status, body = http("POST", "/emails", {"subject": s_out2, "body": "<p>from the deal card</p>", "to": [client_email], "deal_id": str(deal_other)})
    check("POST /emails with deal_id (the 'Привязать сделку' field) -> 201", status in (200, 201), "%s %s" % (status, message_of((status, body))))
    check("… history of the chosen deal AND of the recipient's deal, once each",
          events_for(deal_other, s_out2, wait=10) == 1 and events_for(deal_client, s_out2, wait=10) == 1, (events_for(deal_other, s_out2), events_for(deal_client, s_out2)))
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
    controller = read_file(API_SRC, os.path.join("email", "email.controller.ts"))
    check("API: the mail routes are behind MailAccessGuard and pass the user to open/delete/spam", "MailAccessGuard" in controller
          and controller.count("extractUserFromRequest(request)") >= 4)


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
