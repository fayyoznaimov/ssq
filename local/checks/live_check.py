#!/usr/bin/env python3
"""
Live updates (pages refresh themselves without "Обновить").

API: parisahon-api/src/gateway/live-updates.subscriber.ts sends the socket event
'changed' {topic: [ids] | '*'} after rows change. Client: composables/useLive.ts
and the pages that use it.

The check connects a socket like the web app (local/checks/live_socket.mjs),
changes AUDIT-live rows through the API and waits for the matching signals.
Env: CRM_API_URL, CRM_PSQL, CRM_ENV_FILE (see local/dev/env.sh).
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error, threading, queue

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
API = os.environ.get("CRM_API_URL", "http://127.0.0.1:3100/api/v1").rstrip("/")
SOCKET_URL = API.rsplit("/api/", 1)[0].replace("http", "ws", 1)
PSQL = os.environ.get("CRM_PSQL", "node %s/local/dev/psql.js" % ROOT)
ENV_FILE = os.environ.get("CRM_ENV_FILE", os.path.join(ROOT, "local/dev/api.env"))
CLIENT = os.path.join(ROOT, "parisahon-client/app")
RUN = str(int(time.time()))
P = "AUDIT-live-" + RUN

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else "  -> " + str(detail)[:300]))


def env(name):
    for line in open(ENV_FILE, encoding="utf-8"):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"')
    return ""


def sql(q):
    out = subprocess.run(PSQL.split() + ["-At", "-c", q], capture_output=True, text=True, check=True).stdout
    return [r.split("|") for r in out.splitlines() if r]


def http(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors="replace")


class Socket:
    def __init__(self, token, seconds=60):
        self.q = queue.Queue()
        env_ = dict(os.environ, LIVE_SECONDS=str(seconds))
        self.p = subprocess.Popen(["node", os.path.join(ROOT, "local/checks/live_socket.mjs"), SOCKET_URL, token or "-"],
                                  stdout=subprocess.PIPE, text=True, env=env_)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            try:
                self.q.put(json.loads(line))
            except ValueError:
                pass

    def wait(self, pred, timeout=8):
        end = time.time() + timeout
        seen = []
        while time.time() < end:
            try:
                msg = self.q.get(timeout=max(0.05, end - time.time()))
            except queue.Empty:
                break
            seen.append(msg)
            if pred(msg):
                return msg, seen
        return None, seen

    def drain(self):
        while not self.q.empty():
            self.q.get_nowait()

    def close(self):
        self.p.kill()


def touches(msg, topic, id_=None):
    scope = (msg or {}).get("changed", {}).get(topic)
    if not scope:
        return False
    return scope == "*" or id_ is None or id_ in scope


CLEANUP_SQL = """
DELETE FROM event WHERE deal_id IN (SELECT id FROM deal WHERE label LIKE 'AUDIT-live-%%')
   OR task_id IN (SELECT id FROM task WHERE label LIKE 'AUDIT-live-%%');
DELETE FROM task WHERE label LIKE 'AUDIT-live-%%' OR deal_id IN (SELECT id FROM deal WHERE label LIKE 'AUDIT-live-%%');
DELETE FROM deal_stage_record WHERE deal_id IN (SELECT id FROM deal WHERE label LIKE 'AUDIT-live-%%');
DELETE FROM deal WHERE label LIKE 'AUDIT-live-%%';
""".replace("%%", "%")


def main():
    sql(CLEANUP_SQL)
    status, body = http("POST", "/auth/login", {"email": "admin@gmail.com", "password": env("ADMIN_PASSWORD")})
    if status not in (200, 201):
        raise SystemExit("login failed: HTTP %s" % status)
    token = body["access_token"]
    me = json.loads(__import__("base64").urlsafe_b64decode(token.split(".")[1] + "==="))["sub"]

    # ---------------------------------------------------------------- handshake
    anon = Socket(None, 10)
    msg, _ = anon.wait(lambda m: "connect_error" in m or "connected" in m)
    check("a socket without a token is refused", msg and msg.get("connect_error") == "Unauthorized", msg)
    anon.close()

    sock = Socket(token, 90)
    msg, _ = sock.wait(lambda m: "connected" in m or "connect_error" in m)
    check("a socket with the staff token connects", msg and msg.get("connected"), msg)

    try:
        # ------------------------------------------------------------ deal created
        status, deal = http("POST", "/deals", {"label": P + "-deal", "budget": 0, "agent_id": me, "ctr_agent_ids": [],
                                              "fillers": [], "products": []}, token)
        deal_id = int(deal["id"]) if isinstance(deal, dict) and deal.get("id") else None
        check("deal created for the check", status in (200, 201) and deal_id, (status, deal))
        msg, seen = sock.wait(lambda m: touches(m, "deals", deal_id))
        check("new deal -> 'changed' with deals: [its id]", msg, seen)
        check("new deal -> history event signalled for that deal", any(touches(m, "events", deal_id) for m in seen) or sock.wait(lambda m: touches(m, "events", deal_id), 3)[0], seen)

        # ------------------------------------------------------------ the payload carries ids only
        payloads = [m["changed"] for m in seen if "changed" in m]
        ok = all(isinstance(v, list) and all(isinstance(i, int) for i in v) or v == "*" for p in payloads for v in p.values())
        check("payload = topics with ids (or '*'), no row data", payloads and ok, payloads)

        # ------------------------------------------------------------ comment
        sock.drain()
        st, _ = http("POST", "/deals/%d/comments" % deal_id, {"comment": P + " comment"}, token)
        msg, seen = sock.wait(lambda m: touches(m, "events", deal_id))
        check("comment on the deal -> 'changed' events: [the deal]", st < 400 and msg, (st, seen))

        # ------------------------------------------------------------ task
        sock.drain()
        st, task = http("POST", "/tasks", {"label": P + "-task", "type_id": int(sql("SELECT id FROM task_type ORDER BY id LIMIT 1")[0][0]), "allDay": False, "link_to": {"target": "deal", "id": deal_id},
                                           "assign_to": {"target": "agent", "id": me},
                                           "start_time": time.strftime("%Y-%m-%dT%H:%M:%S"), "end_time": time.strftime("%Y-%m-%dT23:59:00")}, token)
        if st < 400:
            msg, seen = sock.wait(lambda m: touches(m, "tasks", deal_id))
            check("task on the deal -> 'changed' tasks: [the deal]", msg, seen)
        else:
            check("task on the deal -> 'changed' tasks: [the deal]", False, (st, task))

        # ------------------------------------------------------------ burst is coalesced
        sock.drain()
        for i in range(5):
            http("PATCH", "/deals/%d" % deal_id, {"label": "%s-deal-b%d" % (P, i)}, token)
        time.sleep(1.5)
        burst = []
        while not sock.q.empty():
            burst.append(sock.q.get_nowait())
        check("5 quick edits -> at most 5 signals, coalesced (%d)" % len(burst), 1 <= len(burst) <= 5, burst)

        # ------------------------------------------------------------ in a real browser
        tools = os.path.join(ROOT, "local/dev/tools")
        if os.path.isdir(os.path.join(tools, "node_modules/playwright-core")):
            import shutil
            shutil.copy(os.path.join(ROOT, "local/dev/live-browser.mjs"), os.path.join(tools, "live-browser.mjs"))
            proc = subprocess.run(["node", os.path.join(tools, "live-browser.mjs"), str(deal_id), P], capture_output=True, text=True, timeout=300)
            cases = [json.loads(l) for l in proc.stdout.splitlines() if l.startswith("{")]
            if not cases:
                check("browser: pages refresh themselves", False, proc.stderr[-600:])
            for c in cases:
                check("browser: %s without reload (%s, %d ms)" % (c["case"], c["path"], c["ms"]), c["ok"] and not c["errors"], c)
        else:
            check("browser: playwright-core in local/dev/tools (run local/dev/screens.sh once)", False)

        # ------------------------------------------------------------ delete
        sock.drain()
        st, _ = http("DELETE", "/deals/%d" % deal_id, None, token)
        msg, seen = sock.wait(lambda m: touches(m, "deals", deal_id))
        check("deleted deal -> 'changed' deals", st < 400 and msg, (st, seen))
    finally:
        sock.close()
        sql(CLEANUP_SQL)

    # ---------------------------------------------------------------- client wiring (static)
    def read(rel):
        try:
            return open(os.path.join(CLIENT, rel), encoding="utf-8").read()
        except OSError:
            return ""

    live = read("composables/useLive.ts")
    check("useLive listens to 'changed' and catches up after a reconnect", "'changed'" in live and "'reconnect'" in live)
    check("useLive waits while the tab is hidden", "document.hidden" in live)
    check("live reloads are silent (no spinners)", "silently(" in live and "silentDepth" in read("composables/useAsync.ts"))
    for rel in ["pages/tasks.vue", "pages/index.vue", "components/deal/single.vue", "components/company/CompanyFeed.vue",
                "pages/mails/index.vue", "pages/lists/companies/index.vue", "pages/lists/calls/index.vue", "pages/deals/index.vue"]:
        check("page refreshes itself: " + rel, "useLive(" in read(rel))

    left = sql("SELECT count(*) FROM deal WHERE label LIKE 'AUDIT-live-%'")[0][0]
    check("no AUDIT-live rows left", left == "0", left)

    failed = [n for n, ok in results if not ok]
    print("\n%d/%d passed" % (len(results) - len(failed), len(results)))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
