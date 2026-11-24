#!/usr/bin/env python3
"""
Regression checks for the authentication / authorization layer of the CRM API.

    py local/checks/auth_check.py            # summary line per check
    py local/checks/auth_check.py -v         # also one line per swept route

Python stdlib only. Talks to the LOCAL stack only: the docker stack (http://localhost:8080)
or, with the CRM_* variables from local/dev/env.sh, the dev copy on the server.
Exit code 0 = everything passed, 1 = at least one FAIL.

What it needs:
  - the local stack from docker-compose.local.yml running (or the dev copy: local/dev);
  - parisahon-api/.env (CRM_ENV_FILE) for ADMIN_PASSWORD (never printed);
  - optional: `docker` on PATH. It is used for two things only: giving a test
    ctr_agent row a password hash (to prove that a ctr_agent cannot log in even
    with a correct password) and hard-deleting the rows the script created.
    Without docker those checks are reported as SKIP and the rows are only
    soft-deleted through the API.
  - optional: JWT_SECRET (local/api.env, else parisahon-api/.env) to forge
    tokens for the "stale / forged token" checks. SKIP when it does not match
    the running API.

Everything the script creates is named AUDIT-auth-<run id> / audit-auth-<run id>
and removed at the end, also when a check fails.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get('CRM_API_URL', 'http://localhost:8080/api/v1').rstrip('/')
HOST = BASE[:-len('/api/v1')] if BASE.endswith('/api/v1') else BASE
# the same API reached from a non-loopback address (through nginx in docker, the server address on the dev copy)
EXTERNAL_BASE = os.environ.get('CRM_API_EXTERNAL_URL', BASE).rstrip('/')
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
API_SRC = os.path.join(ROOT, 'parisahon-api', 'src')
API_ENV = os.environ.get('CRM_ENV_FILE') or os.path.join(ROOT, 'parisahon-api', '.env')
LOCAL_ENV = os.path.join(ROOT, 'local', 'api.env')
COMPOSE = os.path.join(ROOT, 'docker-compose.local.yml')
# psql of the local database: CRM_PSQL (dev copy: local/dev/psql.js) or the docker container
PSQL = (shlex.split(os.environ['CRM_PSQL']) if os.environ.get('CRM_PSQL') else
        ['docker', 'compose', '-f', COMPOSE, 'exec', '-T', 'crm-db', 'psql', '-U', 'root', '-d', 'parisahon'])

VERBOSE = '-v' in sys.argv[1:]
RUN = secrets.token_hex(3)
TAG = 'AUDIT-auth-' + RUN
MISSING_ID = 999999999  # substituted for :params, so that nothing real is hit
SECRET_KEYS = ('password', 'tg_api_hash', 'tg_api_id', 'sign')

# The only routes that may answer without a token. /health tells only up/down (for the server watchdog);
# /telegram/remote-file/:token is a download link like the files in /uploads (128-bit token, attachment only).
# /files/link-check is asked by nginx before it serves /uploads/<name>: it only verifies the signature of the link (FileLink).
PUBLIC_ROUTES = {('GET', '/'), ('POST', '/auth/login'), ('GET', '/health'), ('GET', '/telegram/remote-file/:token'),
                 ('GET', '/files/link-check')}

# Skip the JWT guard but check access themselves: the MCP endpoint of the CRM bot
# answers only on 127.0.0.1 with a per-run session token (src/bot/bot-mcp.controller.ts).
# ... the receiver of parisahon-telegram-service (shared TELEGRAM_SERVICE_TOKEN) and the call recorder
# upload (a per-manager recorder token in X-Recorder-Token; GET /calls/recorder tells the FTP receiver whose token it is).
SELF_AUTH_ROUTES = {('GET', '/bot/mcp'), ('POST', '/bot/mcp'), ('DELETE', '/bot/mcp'), ('POST', '/telegram/incoming'), ('POST', '/whatsapp/incoming'), ('POST', '/calls/upload'),
                    ('GET', '/calls/recorder')}

# GET routes that are not called in the "admin is not locked out" sweep,
# because they talk to external services (IMAP, the telegram service).
SIDE_EFFECT_GETS = {'/emails/sync', '/emails/mailboxes', '/telegram/active-sessions'}

results = {'PASS': 0, 'FAIL': 0, 'SKIP': 0}


def report(status, name, detail=''):
    results[status] += 1
    print('%-4s %s%s' % (status, name, (' -- ' + str(detail)) if detail else ''))


def check(name, ok, detail=''):
    report('PASS' if ok else 'FAIL', name, '' if ok else detail)
    return ok


def skip(name, why):
    report('SKIP', name, why)


# --------------------------------------------------------------------------- env

def read_env(path, key):
    try:
        with open(path, encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if line.startswith(key + '='):
                    value = line.split('=', 1)[1].strip()
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
                        value = value[1:-1]
                    return value
    except OSError:
        pass
    return None


# -------------------------------------------------------------------------- http

def http(method, path, token=None, body=None, raw_token=None, timeout=60, extra_headers=None):
    """Returns (status, parsed json | text | None). Retries while the API restarts."""
    url = path if path.startswith('http') else BASE + path
    headers = {'Accept': 'application/json'}
    headers.update(extra_headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if raw_token is not None:
        headers['Authorization'] = raw_token

    deadline = time.time() + 150
    while True:
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                status, text = response.status, response.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as error:
            status, text = error.code, error.read().decode('utf-8', 'replace')
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as error:
            if time.time() > deadline:
                raise SystemExit('API is not reachable at %s: %s' % (BASE, error))
            time.sleep(3)
            continue
        # nest --watch restarts the API on every source change: nginx answers 502 meanwhile
        if status in (502, 503, 504) and time.time() < deadline:
            time.sleep(3)
            continue
        try:
            return status, json.loads(text) if text else None
        except ValueError:
            return status, text


def login(email, password):
    status, body = http('POST', '/auth/login', body={'email': email, 'password': password})
    token = body.get('access_token') if isinstance(body, dict) else None
    return status, token, body


def find_keys(value, wanted, path='$'):
    """Paths of every occurrence of one of the `wanted` keys, at any depth."""
    found = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key in wanted:
                found.append(path + '.' + key)
            found.extend(find_keys(child, wanted, path + '.' + key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(find_keys(child, wanted, '%s[%d]' % (path, index)))
    return found


# ------------------------------------------------------------------------ docker

def psql(sql):
    """Runs SQL in the local db container. Returns stdout, or None when unavailable."""
    command = PSQL + ['-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


# --------------------------------------------------------------------------- jwt

def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


def b64url_decode(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def sign_jwt(payload, secret):
    head = b64url(json.dumps({'alg': 'HS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    body = b64url(json.dumps(payload, separators=(',', ':')).encode())
    mac = hmac.new(secret.encode(), (head + '.' + body).encode(), hashlib.sha256).digest()
    return head + '.' + body + '.' + b64url(mac)


def jwt_payload(token):
    return json.loads(b64url_decode(token.split('.')[1]))


def secret_matches(token, secret):
    head, body, signature = token.split('.')
    mac = hmac.new(secret.encode(), (head + '.' + body).encode(), hashlib.sha256).digest()
    return hmac.compare_digest(b64url(mac), signature)


# ------------------------------------------------------------------------ routes

def required_fillers(target):
    """The CRM's own required custom fields of a target: the web form always sends them."""
    out = psql("select id from filler where target = '%s' and is_required and field not like 'AUDIT-%%'" % target) or ''
    return [{'filler_id': int(i), 'value': 'x'} for i in out.split() if i.strip().isdigit()]


def discover_routes():
    """Every (METHOD, path) declared in src/**/*.controller.ts, :params replaced."""
    routes, public_marks = [], 0
    for folder, _dirs, files in os.walk(API_SRC):
        for name in files:
            if not name.endswith('.controller.ts'):
                continue
            with open(os.path.join(folder, name), encoding='utf-8') as fh:
                lines = [line for line in fh.read().split('\n') if not line.strip().startswith('//')]
            source = '\n'.join(lines)
            public_marks += len(re.findall(r'@Public\(\)', source))
            controller = re.search(r'@Controller\(\s*(?:[\'"`]([^\'"`]*)[\'"`])?\s*\)', source)
            if not controller:
                continue
            prefix = controller.group(1) or ''
            for verb, sub in re.findall(
                    r'@(Get|Post|Patch|Put|Delete)\(\s*(?:[\'"`]([^\'"`]*)[\'"`])?\s*\)', source):
                parts = [p for p in (prefix + '/' + (sub or '')).split('/') if p]
                routes.append((verb.upper(), '/' + '/'.join(parts)))
    return sorted(set(routes)), public_marks


def concrete(path):
    return re.sub(r':[A-Za-z_]+', str(MISSING_ID), path)


def sweep(name, routes, expected, **request_kwargs):
    """Calls every route, expects one of `expected` statuses. One summary line."""
    bad = []
    for method, path in routes:
        body = {} if method in ('POST', 'PATCH', 'PUT') else None
        status, _ = http(method, concrete(path), body=body, **request_kwargs)
        ok = status in expected
        if VERBOSE:
            print('       %s %-6s %-45s -> %s' % ('ok ' if ok else 'BAD', method, path, status))
        if not ok:
            bad.append('%s %s -> %s' % (method, path, status))
    return check('%s (%d routes)' % (name, len(routes)), not bad, '; '.join(bad))


# --------------------------------------------------------------- socket.io client

class PollingSocket:
    """Minimal socket.io v4 client over HTTP long-polling: enough to authenticate
    and to receive events. A background thread keeps one long-poll open at a time
    (engine.io drops the session when a poll is aborted or doubled)."""

    def __init__(self, token=None, raw_auth=None):
        self.sid = None
        self.connected = False
        self.error = None
        self.events = []
        self.closed = False
        status, text = self._get()
        if status != 200 or not text.startswith('0'):
            self.error = 'handshake %s' % status
            return
        self.sid = json.loads(text[1:])['sid']
        auth = raw_auth if raw_auth is not None else ({'token': token} if token else {})
        self._post('40' + json.dumps(auth))
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()
        deadline = time.time() + 15
        while time.time() < deadline and not self.connected and not self.error:
            time.sleep(0.1)

    def _url(self):
        query = {'EIO': '4', 'transport': 'polling', 't': secrets.token_hex(4)}
        if self.sid:
            query['sid'] = self.sid
        return HOST + '/socket.io/?' + urllib.parse.urlencode(query)

    def _get(self):
        # longer than the server's pingInterval (25 s), so a poll is never aborted
        try:
            with urllib.request.urlopen(self._url(), timeout=45) as response:
                return response.status, response.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode('utf-8', 'replace')
        except (urllib.error.URLError, TimeoutError, OSError):
            return 0, ''

    def _post(self, packet):
        request = urllib.request.Request(self._url(), data=packet.encode(), method='POST',
                                         headers={'Content-Type': 'text/plain;charset=UTF-8'})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                response.read()
        except (urllib.error.URLError, TimeoutError, OSError):
            pass

    def _loop(self):
        while not self.closed:
            status, text = self._get()
            if status != 200:
                self.connected = False
                return
            for packet in text.split(''):
                if packet == '2':                       # engine.io ping
                    self._post('3')
                elif packet == '1':                     # engine.io close
                    self.connected = False
                    return
                elif packet.startswith('40'):           # socket.io CONNECT ack
                    self.connected = True
                elif packet.startswith('44'):           # socket.io CONNECT_ERROR
                    self.error = packet[2:]
                elif packet.startswith('41'):           # socket.io DISCONNECT
                    self.connected = False
                elif packet.startswith('42'):           # socket.io EVENT
                    self.events.append(json.loads(packet[2:]))

    def wait_for_event(self, name, seconds):
        deadline = time.time() + seconds
        while True:
            for event in list(self.events):
                if event and event[0] == name:
                    return event
            if time.time() >= deadline:
                return None
            time.sleep(0.2)

    def close(self):
        self.closed = True
        if self.sid:
            self._post('1')


# ============================================================================ run

def main():
    admin_password = read_env(API_ENV, 'ADMIN_PASSWORD')
    if not admin_password:
        raise SystemExit('ADMIN_PASSWORD not found in ' + API_ENV)

    created_user_ids, created_task_ids, created_company_ids, created_group_ids = [], [], [], []
    admin_token = None

    try:
        # ------------------------------------------------------------ 1. routes
        print('== 1. authentication is the default')
        routes, public_marks = discover_routes()
        protected = [r for r in routes if r not in PUBLIC_ROUTES and r not in SELF_AUTH_ROUTES]
        check('controllers parsed: %d routes found' % len(routes), len(routes) > 100,
              'only %d routes parsed from %s' % (len(routes), API_SRC))
        check('@Public() is used exactly 9 times in the controllers (login, hello, health, bot MCP, telegram and whatsapp incoming, calls upload, telegram remote file, file link check)',
              public_marks == 9 and PUBLIC_ROUTES <= set(routes) and SELF_AUTH_ROUTES <= set(routes),
              'found %d' % public_marks)
        answers = {r: http(r[0], EXTERNAL_BASE + r[1], body={'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'} if r[0] == 'POST' else None)[0]
                   for r in sorted(SELF_AUTH_ROUTES)}
        check('bot MCP endpoint from outside: POST 403, GET/DELETE 405; telegram / whatsapp receivers and calls upload without their tokens: 401',
              answers == {('DELETE', '/bot/mcp'): 405, ('GET', '/bot/mcp'): 405, ('POST', '/bot/mcp'): 403,
                          ('POST', '/telegram/incoming'): 401, ('POST', '/whatsapp/incoming'): 401, ('POST', '/calls/upload'): 401,
                          ('GET', '/calls/recorder'): 401}, answers)

        sweep('no token -> 401 on every route, every method', protected, {401})
        get_routes = [r for r in protected if r[0] == 'GET']
        sweep('garbage bearer token -> 401 on every GET route', get_routes, {401},
              token='not.a.token')
        sweep('token without "Bearer " prefix -> 401 on every GET route', get_routes, {401},
              raw_token='Basic abc')

        status, _ = http('GET', '/')
        check('GET /api/v1 (hello) is public -> 200', status == 200, 'got %s' % status)
        status, _ = http('POST', '/auth/login', body={})
        check('POST /auth/login is reachable without a token (empty body -> 400)', status == 400,
              'got %s' % status)

        status, admin_token, _ = login('admin@gmail.com', admin_password)
        if not check('admin login -> 200 + access_token', status == 200 and bool(admin_token),
                     'got %s' % status):
            raise SystemExit('cannot continue without an admin token')
        admin_id = jwt_payload(admin_token)['sub']

        tampered = admin_token[:-3] + ('AAA' if not admin_token.endswith('AAA') else 'BBB')
        status, _ = http('GET', '/users', token=tampered)
        check('token with a broken signature -> 401', status == 401, 'got %s' % status)

        groups_before = http('GET', '/groups', token=admin_token)[1]
        status, _ = http('POST', '/groups', body={'name': TAG + '-anon'})
        check('anonymous POST /groups -> 401', status == 401, 'got %s' % status)
        status, _ = http('POST', '/stages/1/triggers', body={})
        check('anonymous POST /stages/1/triggers -> 401', status == 401, 'got %s' % status)
        status, _ = http('DELETE', '/stages/1/triggers/%d' % MISSING_ID)
        check('anonymous DELETE /stages/1/triggers/:id -> 401', status == 401, 'got %s' % status)
        groups_after = http('GET', '/groups', token=admin_token)[1]
        check('anonymous POST /groups created nothing',
              isinstance(groups_before, list) and isinstance(groups_after, list)
              and len(groups_before) == len(groups_after))

        admin_gets = [r for r in get_routes if ':' not in r[1] and r[1] not in SIDE_EFFECT_GETS]
        bad = []
        for method, path in admin_gets:
            status, _ = http(method, path, token=admin_token)
            if VERBOSE:
                print('       admin GET %-45s -> %s' % (path, status))
            if status in (401, 403):
                bad.append('%s -> %s' % (path, status))
        check('admin is not locked out: no 401/403 on %d parameterless GET routes' % len(admin_gets),
              not bad, '; '.join(bad))

        # ------------------------------------------------------- 2. test users
        print('== 2. roles')
        permissions = {
            'deal': {'view': 3, 'create': 3, 'update': 3, 'delete': 3, 'export': 3},
            'contact': {'view': 3, 'create': 3, 'update': 3, 'delete': 3, 'export': 3},
            'company': {'view': 3, 'create': 3, 'update': 3, 'delete': 3, 'export': 3},
            'task': {'update': 3, 'delete': 3},
            'mail': True,
            'file': True,
        }
        group_ids = sorted(g['id'] for g in groups_before)
        people = {}
        # agent and agent2 are in different groups (needed for the socket check)
        for key, role, group_id in (('agent', 'agent', group_ids[0]),
                                    ('agent2', 'agent', group_ids[-1]),
                                    ('manager', 'manager', group_ids[0])):
            person = {
                'email': 'audit-auth-%s-%s@example.test' % (RUN, key),
                'password': secrets.token_urlsafe(12),
                'username': '%s-%s' % (TAG, key),
                'role': role,
                'group_id': group_id,
            }
            status, body = http('POST', '/users', token=admin_token, body={
                'email': person['email'], 'password': person['password'],
                'username': person['username'], 'role': role, 'group_id': group_id,
                'permissions': permissions,
            })
            if status != 201 or not isinstance(body, dict):
                raise SystemExit('cannot create test %s: %s %s' % (key, status, body))
            person['id'] = body['id']
            person['create_response'] = body
            created_user_ids.append(body['id'])
            status, token, _ = login(person['email'], person['password'])
            if status != 200:
                raise SystemExit('cannot log in as test %s: %s' % (key, status))
            person['token'] = token
            people[key] = person
        agent, agent2, manager = people['agent'], people['agent2'], people['manager']
        check('admin created test users (agent, agent2, manager) and they can log in', True)

        def staff_body(person, **overrides):
            body = {'email': person['email'], 'username': person['username'], 'role': person['role'],
                    'group_id': person['group_id'], 'permissions': permissions}
            body.update(overrides)
            return body

        def role_of(user_id):
            status, body = http('GET', '/users/%d' % user_id, token=admin_token)
            return body.get('role') if status == 200 and isinstance(body, dict) else 'HTTP %s' % status

        new_staff = {'email': 'audit-auth-%s-x@example.test' % RUN, 'password': secrets.token_urlsafe(12),
                     'username': TAG + '-x', 'role': 'agent', 'group_id': group_ids[0],
                     'permissions': permissions}

        # (method, path, body) -> admin only. Guard-level ones use ids that do not exist.
        admin_only = [
            ('POST', '/groups', {'name': TAG + '-g'}),
            ('PATCH', '/groups/%d' % MISSING_ID, {'name': TAG + '-g'}),
            ('DELETE', '/groups/%d' % MISSING_ID, None),
            ('GET', '/groups/%d/usage' % MISSING_ID, None),
            ('POST', '/auth/logout/%d' % MISSING_ID, None),
            ('POST', '/auth/standard-rights/%d' % MISSING_ID, None),
            ('POST', '/groups/%d/members/%d' % (MISSING_ID, MISSING_ID), None),
            ('DELETE', '/groups/%d/members/%d' % (MISSING_ID, MISSING_ID), None),
            ('PATCH', '/settings', {}),
            ('POST', '/fillers', {}),
            ('PATCH', '/fillers/%d' % MISSING_ID, {}),
            ('DELETE', '/fillers/%d' % MISSING_ID, None),
            ('POST', '/task-types', {}),
            ('PATCH', '/task-types/%d' % MISSING_ID, {}),
            ('DELETE', '/task-types/%d' % MISSING_ID, None),
            ('PATCH', '/analytics/objectives', {}),
            ('POST', '/users', new_staff),
            ('PATCH', '/users/%d' % agent2['id'], staff_body(agent2, username=TAG + '-hacked')),
            ('DELETE', '/users/%d' % agent2['id'], None),
        ]
        manager_only_gets = [
            '/analytics/deals', '/analytics/calls', '/analytics/users', '/analytics/managers',
            '/analytics/consolidated-report', '/analytics/objectives', '/analytics/control',
            '/analytics/objectives/results', '/logs', '/users/manager-statistics', '/companies/statistics',
            '/desktop?from_date=2026-01-01&till_date=2026-12-31&my_stats=false',
            '/desktop?from_date=2026-01-01&till_date=2026-12-31',
        ]
        declared_manager_gets = sorted(
            path for method, path in routes if method == 'GET'
            and (path.startswith('/analytics') or path == '/logs' or path == '/users/manager-statistics'))
        check('every /analytics/*, /logs, manager-statistics GET route is in the manager-only list',
              all(path in manager_only_gets for path in declared_manager_gets),
              str([p for p in declared_manager_gets if p not in manager_only_gets]))

        def expect_all(name, calls, token, expected):
            bad = []
            for method, path, body in calls:
                status, _ = http(method, path, token=token, body=body)
                if VERBOSE:
                    print('       %-6s %-60s -> %s' % (method, path, status))
                if status not in expected:
                    bad.append('%s %s -> %s' % (method, path, status))
            return check('%s (%d calls)' % (name, len(calls)), not bad, '; '.join(bad))

        expect_all('agent -> 403 on admin-only routes', admin_only, agent['token'], {403})
        expect_all('agent -> 403 on manager-only routes (class-level @Roles)',
                   [('GET', p, None) for p in manager_only_gets], agent['token'], {403})
        agent_ok = ['/deals', '/tasks', '/contacts', '/companies', '/products', '/users', '/groups',
                    '/settings', '/fillers', '/task-types', '/stages', '/stages/1/triggers',
                    '/files', '/linkables?name=a', '/emails/transporters',
                    '/users/%d' % agent['id']]
        expect_all('agent -> 200 on ordinary routes', [('GET', p, None) for p in agent_ok],
                   agent['token'], {200})
        own_stats = '/desktop?from_date=2026-01-01&till_date=2026-12-31&my_stats=true'
        agent_status, _ = http('GET', own_stats, token=agent['token'])
        admin_status, _ = http('GET', own_stats, token=admin_token)
        check('GET /desktop?my_stats=true with a token is no longer 401 (agent and admin)',
              401 not in (agent_status, admin_status) and 403 not in (agent_status, admin_status),
              'agent %s, admin %s' % (agent_status, admin_status))
        check('GET /desktop?my_stats=true with a token -> 200 (agent and admin)',
              agent_status == 200 and admin_status == 200,
              'agent %s, admin %s; 500 = SQL in src/desktop/desktop.service.ts fetchMyStats() '
              'uses task.created_by, the column is task."createdById"' % (agent_status, admin_status))

        expect_all('manager -> 403 on admin-only routes (handler-level @Roles overrides class-level)',
                   admin_only, manager['token'], {403})
        # the triggers of a stage (business processes): not an agent's, but the manager's too (TRG-13)
        trigger_routes = [
            ('POST', '/stages/1/triggers', {}),
            ('PATCH', '/stages/1/triggers/%d' % MISSING_ID, {}),
            ('DELETE', '/stages/1/triggers/%d' % MISSING_ID, None),
            ('PATCH', '/stages/%d/trigger-order' % MISSING_ID, {'ids': [MISSING_ID]}),
        ]
        expect_all('agent -> 403 on changing the triggers of a stage', trigger_routes, agent['token'], {403})
        bad = []
        for method, path, body in trigger_routes:
            status, _ = http(method, path, token=manager['token'], body=body)
            if status in (401, 403):
                bad.append('%s %s -> %s' % (method, path, status))
        check('manager may change the triggers of a stage (no 401/403)', not bad, '; '.join(bad))
        # some analytics queries need parameters: 400 still proves the role check let it through
        bad = []
        for path in manager_only_gets:
            status, _ = http('GET', path, token=manager['token'])
            if status in (401, 403):
                bad.append('%s -> %s' % (path, status))
        check('manager is allowed on manager-only routes (no 401/403)', not bad, '; '.join(bad))
        status, body = http('GET', '/users?limit=1000', token=manager['token'])
        check('manager: GET /users -> 200', status == 200, 'got %s' % status)
        status, _ = http('GET', '/desktop?from_date=2026-01-01&till_date=2026-12-31&my_stats=false',
                         token=manager['token'])
        check('manager: GET /desktop?my_stats=false -> 200', status == 200, 'got %s' % status)

        check('nothing leaked through the 403s: test agent2 is unchanged',
              role_of(agent2['id']) == 'agent'
              and http('GET', '/users/%d' % agent2['id'], token=admin_token)[1].get('username')
              == agent2['username'])
        status, body = http('GET', '/users?limit=1000', token=admin_token)
        check('nothing leaked through the 403s: no extra staff account was created',
              status == 200 and not [u for u in body['data'] if u.get('email') == new_staff['email']])

        # --------------------------------------------------- 3. escalation
        print('== 3. privilege escalation')
        status, _ = http('PATCH', '/users/%d' % agent['id'], token=manager['token'],
                         body=staff_body(agent, role='admin'))
        check('manager cannot turn an agent into admin -> 403, role stays agent',
              status == 403 and role_of(agent['id']) == 'agent',
              'status %s, role %s' % (status, role_of(agent['id'])))
        status, _ = http('PATCH', '/users/%d' % manager['id'], token=manager['token'],
                         body=staff_body(manager, role='admin'))
        check('manager cannot turn themselves into admin -> 403, role stays manager',
              status == 403 and role_of(manager['id']) == 'manager',
              'status %s, role %s' % (status, role_of(manager['id'])))
        status, _ = http('PATCH', '/users/%d' % agent['id'], token=agent['token'],
                         body=staff_body(agent, role='admin'))
        check('agent cannot turn themselves into admin -> 403', status == 403
              and role_of(agent['id']) == 'agent', 'status %s' % status)
        wider = json.loads(json.dumps(permissions))
        status, _ = http('PATCH', '/users/%d' % agent['id'], token=agent['token'],
                         body=staff_body(agent, group_id=group_ids[-1], permissions=wider))
        check('agent cannot edit own account (role / permissions / group) -> 403', status == 403,
              'status %s' % status)
        status, _ = http('POST', '/users', token=manager['token'], body=dict(new_staff, role='admin'))
        check('manager cannot create an admin -> 403', status == 403, 'status %s' % status)
        status, _ = http('DELETE', '/users/%d' % admin_id, token=manager['token'])
        check('manager cannot delete the admin -> 403', status == 403, 'status %s' % status)
        status, _ = http('DELETE', '/users/%d' % admin_id, token=admin_token)
        check('admin cannot delete their own account -> 400', status == 400, 'status %s' % status)

        # admin still can
        status, _ = http('PATCH', '/users/%d' % agent2['id'], token=admin_token,
                         body=staff_body(agent2, role='manager'))
        ok = status == 200 and role_of(agent2['id']) == 'manager'
        status2, _ = http('GET', '/logs', token=agent2['token'])
        check('admin can change a role, and it applies to the already issued token at once',
              ok and status2 == 200, 'patch %s, role %s, /logs with old token %s'
              % (status, role_of(agent2['id']), status2))
        status, _ = http('PATCH', '/users/%d' % agent2['id'], token=admin_token,
                         body=staff_body(agent2, role='agent'))
        status2, _ = http('GET', '/logs', token=agent2['token'])
        check('demotion applies to the already issued token at once (-> 403)',
              status == 200 and status2 == 403, 'patch %s, /logs %s' % (status, status2))
        status, _ = http('PATCH', '/users/%d' % agent2['id'], token=admin_token,
                         body=staff_body(agent2, role='ctr_agent', company_id=1, fillers=[],
                                         fillers_create=[]))
        check('a staff account cannot be turned into ctr_agent -> 400', status == 400,
              'status %s' % status)

        # ----------------------------------------- 4. contacts (ctr_agent rows)
        print('== 4. contacts (ctr_agent) stay manageable by staff, and cannot log in')
        status, body = http('POST', '/companies', token=manager['token'],
                            body={'name': TAG + '-co', 'is_old': False, 'fillers': required_fillers('company'), 'users': []})
        # POST /companies answers 201 with an empty body, so the id is looked up by name
        company_id = None
        found_status, found = http('GET', '/companies?name=' + urllib.parse.quote(TAG + '-co'),
                                   token=manager['token'])
        for row in (found.get('data') or []) if isinstance(found, dict) else []:
            if row.get('name') == TAG + '-co':
                company_id = row['id']
        if company_id:
            created_company_ids.append(company_id)
        check('manager can create a company -> 201', status == 201 and bool(company_id),
              'POST %s, lookup %s' % (status, found_status))

        contact_email = 'audit-auth-%s-contact@example.test' % RUN
        status, body = http('POST', '/users', token=agent['token'], body={
            'email': contact_email, 'username': TAG + '-contact', 'role': 'ctr_agent',
            'company_id': company_id, 'fillers': required_fillers('user')})
        contact_id = body.get('id') if isinstance(body, dict) else None
        if contact_id:
            created_user_ids.append(contact_id)
        check('agent can create a contact (POST /users role=ctr_agent) -> 201',
              status == 201 and bool(contact_id), 'status %s %s' % (status, body))
        check('create responses contain no secrets',
              not find_keys([body] + [p['create_response'] for p in people.values()], SECRET_KEYS),
              str(find_keys([body] + [p['create_response'] for p in people.values()], SECRET_KEYS)))

        if contact_id:
            status, _ = http('PATCH', '/users/%d' % contact_id, token=agent['token'], body={
                'email': contact_email, 'username': TAG + '-contact2', 'role': 'ctr_agent',
                'company_id': company_id, 'fillers': [], 'fillers_create': []})
            check('agent can edit a contact -> 200', status == 200, 'status %s' % status)
            status, _ = http('PATCH', '/users/%d' % contact_id, token=agent['token'], body={
                'email': contact_email, 'username': TAG + '-contact2', 'role': 'admin',
                'password': 'Escalate-12345', 'group_id': group_ids[0], 'permissions': permissions,
                'company_id': company_id, 'fillers': [], 'fillers_create': []})
            check('a contact cannot be promoted to a staff role through PATCH (role stays ctr_agent)',
                  role_of(contact_id) == 'ctr_agent', 'status %s, role %s' % (status, role_of(contact_id)))
            status, _, _ = login(contact_email, 'Escalate-12345')
            check('... and got no usable password from that PATCH (login -> 401)', status == 401,
                  'status %s' % status)

            status, _, body = login(contact_email, 'whatever-password')
            check('ctr_agent login -> 401, not 500', status == 401, 'status %s' % status)
            status, _ = http('POST', '/auth/login', body={'email': contact_email, 'role': 'ctr_agent'})
            check('ctr_agent login without a password -> 400/401, not 500', status in (400, 401),
                  'status %s' % status)

            copied = psql('update "user" set password = (select password from "user" where id = %d) '
                          'where id = %d returning id' % (agent['id'], contact_id))
            if copied and copied.strip().startswith(str(contact_id)):
                status, _, _ = login(contact_email, agent['password'])
                check('ctr_agent with a valid password hash in the db still cannot log in -> 401',
                      status == 401, 'status %s' % status)
            else:
                skip('ctr_agent with a valid password hash in the db still cannot log in',
                     'docker/psql not available')

        # ----------------------------------------------------- 5. login errors
        print('== 5. login does not reveal which emails exist')
        status_unknown, _, body_unknown = login('audit-auth-%s-nobody@example.test' % RUN, 'whatever-password')
        check('unknown email -> 401 (not 404)', status_unknown == 401, 'status %s' % status_unknown)
        status_wrong, _, body_wrong = login(agent['email'], 'wrong-' + secrets.token_hex(4))
        check('wrong password -> 401', status_wrong == 401, 'status %s' % status_wrong)
        check('unknown email and wrong password give the same response body',
              body_unknown == body_wrong, '%s vs %s' % (body_unknown, body_wrong))
        status, _ = http('POST', '/auth/login', body={'email': agent['email']})
        check('login without password -> 400, not 500', status == 400, 'status %s' % status)

        # ------------------------------------------------- 6. own password
        print('== 6. own password')
        new_password = secrets.token_urlsafe(12)
        status, _ = http('PATCH', '/users/me/password', body={
            'old_password': agent['password'], 'new_password': new_password})
        check('PATCH /users/me/password without a token -> 401', status == 401, 'status %s' % status)
        status, _ = http('PATCH', '/users/me/password', token=agent['token'], body={
            'old_password': 'wrong-' + secrets.token_hex(4), 'new_password': new_password})
        check('wrong old password -> 400 (and not 401, which would log the user out)',
              status == 400, 'status %s' % status)
        status, _ = http('PATCH', '/users/me/password', token=agent['token'], body={
            'old_password': agent['password'], 'new_password': 'short'})
        check('too short new password -> 400', status == 400, 'status %s' % status)
        status, _, _ = login(agent['email'], agent['password'])
        check('failed attempts did not change the password', status == 200, 'status %s' % status)
        bot_linked = link_bot(agent['id'])
        status, _ = http('PATCH', '/users/me/password', token=agent['token'], body={
            'old_password': agent['password'], 'new_password': new_password,
            'role': 'admin', 'group_id': group_ids[-1], 'id': admin_id, 'user_id': admin_id})
        check('agent changes own password (old + new) -> 200', status == 200, 'status %s' % status)
        if bot_linked:
            check('a new password also unlinks the CRM bot of the account (bot_account row gone)',
                  bot_links(agent['id']) == '0', 'rows left: %s' % bot_links(agent['id']))
        else:
            skip('a new password also unlinks the CRM bot of the account', 'docker/psql not available')
        status, _, _ = login(agent['email'], agent['password'])
        check('old password stops working -> 401', status == 401, 'status %s' % status)
        status, token, _ = login(agent['email'], new_password)
        check('new password works -> 200', status == 200 and bool(token), 'status %s' % status)
        old_token = agent['token']
        status, _ = http('GET', '/deals?limit=1', token=old_token)
        check('a new password signs out the tokens issued before it -> 401', status == 401, 'status %s' % status)
        if token:
            agent['token'] = token
        status, me = http('GET', '/users/%d' % agent['id'], token=admin_token)
        check('extra fields in that request changed nothing else (role, group)',
              me.get('role') == 'agent' and (me.get('group') or {}).get('id') == agent['group_id'],
              'role %s group %s' % (me.get('role'), me.get('group')))
        status, _, _ = login('admin@gmail.com', admin_password)
        check('... and not somebody else\'s password (admin still logs in)', status == 200,
              'status %s' % status)
        status, _ = http('PATCH', '/users/%d' % manager['id'], token=admin_token,
                         body=staff_body(manager))
        status2, _, _ = login(manager['email'], manager['password'])
        check('admin PATCH /users/:id without "password" keeps the existing password',
              status == 200 and status2 == 200, 'patch %s, login %s' % (status, status2))

        # ------------------------------------------------------ 7. secrets
        print('== 7. secrets never leave the API')
        targets = ['/users?limit=1000', '/users/%d' % admin_id, '/users/%d' % agent['id'],
                   '/tasks?limit=1000', '/deals?limit=1000', '/companies?limit=1000',
                   '/contacts?limit=1000', '/logs?limit=1000', '/files?limit=1000',
                   '/emails/transporters', '/emails/templates']
        if contact_id:
            targets.append('/users/%d' % contact_id)
        status, deals = http('GET', '/deals?limit=5', token=admin_token)
        if status == 200 and deals.get('data'):
            targets.append('/deals/%d' % deals['data'][0]['id'])
            targets.append('/deals/%d/events' % deals['data'][0]['id'])
        status, tasks = http('GET', '/tasks?limit=5', token=admin_token)
        if status == 200 and tasks.get('data'):
            targets.append('/tasks/%d' % tasks['data'][0]['id'])
        for path in targets:
            status, body = http('GET', path, token=admin_token)
            leaks = find_keys(body, SECRET_KEYS)
            check('GET %s: no %s keys anywhere in the JSON' % (path, ' / '.join(SECRET_KEYS)),
                  status == 200 and not leaks, 'status %s, found %s' % (status, leaks[:5]))

        # user.sign is select:false now; it must still be writable and readable through /emails/signs
        sign_text = '<p>%s signature</p>' % TAG
        status, _ = http('PATCH', '/emails/signs', token=manager['token'],
                         body={'user_id': manager['id'], 'sign': sign_text})
        status2, body = http('GET', '/emails/signs/%d' % manager['id'], token=manager['token'])
        status3, user_body = http('GET', '/users/%d' % manager['id'], token=admin_token)
        check('email signature: saved and read back through /emails/signs, absent from /users/:id',
              status == 200 and status2 == 200 and isinstance(body, dict) and body.get('sign') == sign_text
              and status3 == 200 and 'sign' not in user_body,
              'patch %s, get %s %s' % (status, status2, str(body)[:120]))
        status, _ = http('DELETE', '/emails/signs/%d' % manager['id'], token=manager['token'])
        status2, _ = http('GET', '/emails/signs/%d' % manager['id'], token=manager['token'])
        check('email signature: delete works (-> 404 afterwards)', status == 200 and status2 == 404,
              'delete %s, get %s' % (status, status2))

        status, body = http('GET', '/users?limit=1000', token=agent['token'])
        others = [u for u in (body.get('data') or [])
                  if u.get('role') != 'ctr_agent' and u.get('id') != agent['id']]
        mine = [u for u in (body.get('data') or []) if u.get('id') == agent['id']]
        check('agent: GET /users hides permissions / objectives / tg_id of other staff accounts',
              status == 200 and others and not any(
                  k in u for u in others for k in ('permissions', 'objectives', 'tg_id')))
        check('agent: GET /users still returns own permissions (the frontend builds its menu from them)',
              bool(mine) and isinstance(mine[0].get('permissions'), dict))
        status, body = http('GET', '/users/%d' % manager['id'], token=agent['token'])
        check('agent: GET /users/:id of another staff account has no permissions',
              status == 200 and 'permissions' not in body, 'status %s' % status)

        # ------------------------------------------------- 8. forged tokens
        print('== 8. token is re-checked against the database')
        jwt_secret = None
        for candidate in (read_env(LOCAL_ENV, 'JWT_SECRET'), read_env(API_ENV, 'JWT_SECRET')):
            if candidate and secret_matches(admin_token, candidate):
                jwt_secret = candidate
        now = int(time.time())
        if not jwt_secret:
            for name in ('correctly signed token of a ctr_agent -> 401',
                         'token that still says role=admin for an agent gets agent rights',
                         'expired token -> 401', 'token of a user that does not exist -> 401'):
                skip(name, 'JWT_SECRET of the running API is not available to the script')
        else:
            def forged(**claims):
                payload = {'iat': now, 'exp': now + 600}
                sub_id = claims.get('sub')
                if isinstance(sub_id, int) and sub_id != MISSING_ID:
                    out = (psql('select coalesce(token_version, 0) from "user" where id = %d' % sub_id) or '').strip()
                    if out.isdigit():
                        payload['tv'] = int(out)
                payload.update(claims)
                return sign_jwt(payload, jwt_secret)

            if contact_id:
                status, _ = http('GET', '/deals', token=forged(
                    sub=contact_id, username='x', role='admin'))
                check('correctly signed token of a ctr_agent -> 401', status == 401, 'status %s' % status)
            status, _ = http('GET', '/logs', token=forged(sub=agent['id'], username='x', role='admin'))
            status2, _ = http('GET', '/deals', token=forged(sub=agent['id'], username='x', role='admin'))
            check('token that still says role=admin for an agent gets agent rights (403 on /logs)',
                  status == 403 and status2 == 200, '/logs %s, /deals %s' % (status, status2))
            status, _ = http('GET', '/deals', token=sign_jwt(
                {'sub': admin_id, 'role': 'admin', 'iat': now - 7200, 'exp': now - 3600}, jwt_secret))
            check('expired token -> 401', status == 401, 'status %s' % status)
            status, _ = http('GET', '/deals', token=forged(sub=MISSING_ID, username='x', role='admin'))
            check('token of a user that does not exist -> 401', status == 401, 'status %s' % status)
        unsigned = b64url(b'{"alg":"none","typ":"JWT"}') + '.' + b64url(json.dumps(
            {'sub': admin_id, 'role': 'admin', 'exp': now + 600}).encode()) + '.'
        status, _ = http('GET', '/deals', token=unsigned)
        check('unsigned token (alg=none) -> 401', status == 401, 'status %s' % status)

        # ------------------------------------------------------- 9. socket
        print('== 9. websocket (socket.io)')
        anonymous = PollingSocket()
        check('socket without a token is refused', not anonymous.connected and bool(anonymous.error),
              'connected=%s error=%s' % (anonymous.connected, anonymous.error))
        garbage = PollingSocket(token='not.a.token')
        check('socket with a garbage token is refused', not garbage.connected and bool(garbage.error))
        status, agent_token, _ = login(agent['email'], new_password)
        sockets = {
            'assignee (agent)': PollingSocket(token=agent_token),
            'other agent, other group': PollingSocket(token=agent2['token']),
            'manager': PollingSocket(raw_auth={'token': 'Bearer ' + manager['token']}),
        }
        check('socket with a valid token connects (plain token and "Bearer <token>")',
              all(s.connected for s in sockets.values()),
              str({k: (s.connected, s.error) for k, s in sockets.items()}))

        status, task_types = http('GET', '/task-types', token=manager['token'])
        task_body = {
            'label': TAG + '-task', 'type_id': task_types[0]['id'],
            'assign_to': {'target': 'agent', 'id': agent['id']},
            'link_to': {'target': 'company', 'id': company_id},
            'start_time': '2030-01-01T10:00:00.000Z', 'end_time': '2030-01-01T11:00:00.000Z',
            'allDay': False,
        }
        status, body = http('POST', '/tasks', token=manager['token'], body=task_body)
        if isinstance(body, dict) and body.get('id'):
            created_task_ids.append(body['id'])
        if check('manager creates a task assigned to the agent -> 201', status == 201,
                 'status %s %s' % (status, str(body)[:200])):
            check('POST /tasks response contains no secrets', not find_keys(body, SECRET_KEYS),
                  str(find_keys(body, SECRET_KEYS)))
            got = sockets['assignee (agent)'].wait_for_event('notification', 15)
            check('the assignee receives the notification', bool(got))
            check('a manager receives the notification', bool(
                sockets['manager'].wait_for_event('notification', 10)))
            check('an agent who is neither the assignee nor in the group does NOT receive it',
                  not sockets['other agent, other group'].wait_for_event('notification', 6))
            if got:
                payload = json.loads(got[1]) if isinstance(got[1], str) else got[1]
                users = [payload.get(k) for k in ('agent', 'created_by') if payload.get(k)]
                check('notification payload has no secrets and users are reduced to id + username',
                      not find_keys(payload, SECRET_KEYS + ('permissions', 'email', 'phone'))
                      and payload.get('id') == created_task_ids[-1]
                      and all(set(u) == {'id', 'username'} for u in users),
                      json.dumps(payload)[:300])
        for sock in list(sockets.values()) + [anonymous, garbage]:
            sock.close()

        # ----------------------------------------------- 10. deleted account
        print('== 10. deleted account')
        status, _ = http('DELETE', '/users/%d' % agent2['id'], token=admin_token)
        check('admin deletes a staff account -> 200', status == 200, 'status %s' % status)
        status, _ = http('GET', '/deals', token=agent2['token'])
        check('token of the deleted account stops working at once -> 401', status == 401,
              'status %s' % status)
        status, _, _ = login(agent2['email'], agent2['password'])
        check('deleted account cannot log in -> 401', status == 401, 'status %s' % status)
        if contact_id:
            status, _ = http('DELETE', '/users/%d' % contact_id, token=agent_token)
            check('agent can delete a contact -> 200', status == 200, 'status %s' % status)
            # user.email is unique among the accounts that exist (migration 1795240000000-user-email-active)
            status, body = http('POST', '/users', token=agent_token, body={
                'email': contact_email, 'username': TAG + '-contact3', 'role': 'ctr_agent',
                'company_id': company_id, 'fillers': required_fillers('user')})
            again = body.get('id') if isinstance(body, dict) else None
            if again:
                created_user_ids.append(again)
            check('the e-mail of a deleted contact can be used again -> 201 (not 500)',
                  status == 201 and bool(again), 'status %s %s' % (status, str(body)[:200]))

        access_checks(admin_token, group_ids, people, created_user_ids)

    finally:
        cleanup(admin_token or (login('admin@gmail.com', admin_password)[1]),
                created_user_ids, created_task_ids, created_company_ids, created_group_ids)

    print()
    print('RESULT: %d passed, %d failed, %d skipped' % (results['PASS'], results['FAIL'], results['SKIP']))
    return 1 if results['FAIL'] else 0


def link_bot(user_id):
    """A bot_account row for the user (a Telegram chat linked to the CRM bot); False without psql."""
    chat = 990000000000 + secrets.randbelow(10 ** 9)
    out = psql("insert into bot_account (user_id, chat_id, tg_username) values (%d, %d, '%s') "
               "on conflict (user_id) do update set chat_id = excluded.chat_id returning user_id" % (user_id, chat, TAG))
    return bool(out and out.strip().startswith(str(user_id)))


def bot_links(user_id):
    return (psql('select count(*) from bot_account where user_id = %d' % user_id) or '').strip()


def access_checks(admin_token, group_ids, people, created_user_ids):
    """GET /auth/access (the rights the web client builds its menu from), signing out everywhere
    (POST /auth/logout, POST /auth/logout/:id) with the CRM bot, the lock of failed logins, the e-mail index."""
    print('== 11. the rights of the web client come from the API (GET /auth/access)')
    zero = {'view': 0, 'create': 0, 'update': 0, 'delete': 0, 'export': 0}
    full = {'view': 3, 'create': 3, 'update': 3, 'delete': 3, 'export': 0}
    scoped_rights = {
        'deal': {'view': 1, 'create': 3, 'update': 2, 'delete': 0, 'export': 0},
        'contact': dict(zero),
        'company': {'view': 2, 'create': 3, 'update': 1, 'delete': 0, 'export': 0},
        'task': {'update': 1, 'delete': 0},
        'mail': False,
        'file': True,
    }
    no_rights = {'deal': dict(zero), 'contact': dict(zero), 'company': dict(zero),
                 'task': {'update': 0, 'delete': 0}, 'mail': False, 'file': False}
    full_rights = {'deal': dict(full), 'contact': dict(full), 'company': dict(full),
                   'task': {'update': 3, 'delete': 3}, 'mail': True, 'file': True}
    extra = {}
    for key, role, rights in (('scoped', 'agent', scoped_rights), ('mgr0', 'manager', no_rights),
                              ('locked', 'agent', full_rights), ('bare', 'agent', no_rights)):
        person = {'email': 'audit-auth-%s-%s@example.test' % (RUN, key), 'password': secrets.token_urlsafe(12),
                  'username': '%s-%s' % (TAG, key)}
        status, body = http('POST', '/users', token=admin_token, body={
            'email': person['email'], 'password': person['password'], 'username': person['username'],
            'role': role, 'group_id': group_ids[0], 'permissions': rights})
        if status != 201 or not isinstance(body, dict):
            check('admin creates test user %s' % key, False, 'status %s %s' % (status, str(body)[:200]))
            return
        person['id'] = body['id']
        created_user_ids.append(body['id'])
        status, person['token'], _ = login(person['email'], person['password'])
        if status != 200:
            check('test user %s logs in' % key, False, 'status %s' % status)
            return
        extra[key] = person
    scoped, mgr0, locked = extra['scoped'], extra['mgr0'], extra['locked']
    agent, manager = people['agent'], people['manager']

    status, body = http('GET', '/auth/access', token=scoped['token'])
    scopes = body.get('scopes', {}) if isinstance(body, dict) else {}
    check('agent with levels 1/2: GET /auth/access -> 200 with the scopes of every action',
          status == 200 and scopes.get('deal') == {'view': 'own', 'create': 'all', 'update': 'group', 'delete': 'none'}
          and scopes.get('company') == {'view': 'group', 'create': 'all', 'update': 'own', 'delete': 'none'}
          and scopes.get('contact') == {'view': 'none', 'create': 'none', 'update': 'none', 'delete': 'none'}
          and scopes.get('task') == {'view': 'all', 'create': 'all', 'update': 'own', 'delete': 'none'},
          'status %s %s' % (status, json.dumps(body)[:400]))
    check('... the mail / file switches, the role flags and the group of the user',
          isinstance(body, dict) and body.get('mail') is False and body.get('file') is True
          and body.get('admin') is False and body.get('manager') is False
          and body.get('user_id') == scoped['id'] and body.get('group_id') == group_ids[0],
          json.dumps(body)[:400])
    members = body.get('group_user_ids') if isinstance(body, dict) else None
    check('... group_user_ids: the staff of the group (the level "for the group"), the user included',
          isinstance(members, list) and {scoped['id'], agent['id'], manager['id']} <= set(members), members)
    status, body = http('GET', '/auth/access', token=mgr0['token'])
    scopes = body.get('scopes', {}) if isinstance(body, dict) else {}
    check('manager with every level 0 in the card: everything (the matrix does not apply to a manager)',
          status == 200 and isinstance(body, dict) and body.get('manager') is True and body.get('admin') is False
          and all(v == 'all' for entity in ('deal', 'company', 'contact', 'task') for v in scopes.get(entity, {}).values())
          and len(scopes.get('deal', {})) == 4 and body.get('mail') is True and body.get('file') is True,
          json.dumps(body)[:400])
    status, body = http('GET', '/auth/access', token=admin_token)
    check('admin: GET /auth/access -> admin and manager', status == 200 and isinstance(body, dict)
          and body.get('admin') is True and body.get('manager') is True, 'status %s' % status)

    standard_rights_checks(admin_token, extra['bare'], mgr0, agent)

    # the product catalogue: everybody reads it, admin and manager change it (as the client shows it)
    status, _ = http('POST', '/products', token=scoped['token'], body={'name': TAG + '-product', 'fillers': []})
    status2, _ = http('PATCH', '/products/%d' % MISSING_ID, token=scoped['token'], body={'name': TAG + '-product'})
    status3, _ = http('GET', '/products?limit=1', token=scoped['token'])
    check('agent: POST / PATCH /products -> 403, GET /products -> 200', (status, status2, status3) == (403, 403, 200),
          (status, status2, status3))
    status, _ = http('PATCH', '/products/%d' % MISSING_ID, token=mgr0['token'], body={'name': TAG + '-product'})
    check('manager: PATCH /products/:id passes the role check (a missing product -> 404 / 400, not 403)',
          status in (400, 404), 'status %s' % status)

    print('== 12. signing out everywhere ends every session and unlinks the CRM bot')
    status, _ = http('POST', '/auth/logout/%d' % MISSING_ID, token=admin_token)
    check('admin: POST /auth/logout/:id of a missing account -> 404', status == 404, 'status %s' % status)
    linked = link_bot(scoped['id'])
    status, _ = http('POST', '/auth/logout/%d' % scoped['id'], token=admin_token)
    status2, _ = http('GET', '/deals?limit=1', token=scoped['token'])
    check('admin signs an employee out everywhere -> 204, the tokens issued before stop working (401)',
          status == 204 and status2 == 401, 'logout %s, old token %s' % (status, status2))
    if linked:
        check('... and the CRM bot of the employee is unlinked', bot_links(scoped['id']) == '0', bot_links(scoped['id']))
    else:
        skip('... and the CRM bot of the employee is unlinked', 'docker/psql not available')
    status, _, _ = login(scoped['email'], scoped['password'])
    check('... the password stays: the employee signs in again -> 200', status == 200, 'status %s' % status)
    linked = link_bot(mgr0['id'])
    status, _ = http('POST', '/auth/logout', token=mgr0['token'])
    status2, _ = http('GET', '/deals?limit=1', token=mgr0['token'])
    check('POST /auth/logout (sign out on every device) -> 204, the token stops working (401)',
          status == 204 and status2 == 401, 'logout %s, token %s' % (status, status2))
    if linked:
        check('... and the own CRM bot is unlinked', bot_links(mgr0['id']) == '0', bot_links(mgr0['id']))
    else:
        skip('... and the own CRM bot is unlinked', 'docker/psql not available')

    print('== 13. login: the e-mail in any case, failed attempts locked per e-mail and address')
    status, _, _ = login(locked['email'].upper(), locked['password'])
    check('the e-mail in other case signs in -> 200', status == 200, 'status %s' % status)
    statuses = [login(locked['email'], 'wrong-' + secrets.token_hex(4))[0] for _ in range(8)]
    check('8 wrong passwords -> 401 each', statuses == [401] * 8, statuses)
    status, _, body = login(locked['email'], locked['password'])
    message = body.get('message') if isinstance(body, dict) else body
    check('... then even the right password from the same address -> 429 with the wait in minutes',
          status == 429 and 'мин' in str(message), 'status %s %s' % (status, str(message)[:200]))
    status, body = http('POST', '/auth/login', body={'email': locked['email'], 'password': locked['password']},
                        extra_headers={'X-Real-IP': '203.0.113.%d' % (1 + secrets.randbelow(250))})
    if status == 200:
        check('... while from another address the right password works (the lock is not per e-mail alone)', True)
    elif status == 429:
        skip('... while from another address the right password works',
             'the API is reached through a proxy that sets X-Real-IP itself: another address cannot be simulated')
    else:
        check('... while from another address the right password works', False, 'status %s' % status)

    print('== 14. user.email is unique among the accounts that are not deleted')
    out = psql("select indexdef from pg_indexes where tablename = 'user' and indexname = 'IDX_user_email_active'")
    full_unique = psql("select count(*) from pg_indexes where tablename = 'user' "
                       "and indexdef like 'CREATE UNIQUE INDEX %' and indexdef like '%(email)'")
    if out is None or full_unique is None:
        skip('the e-mail index is partial (WHERE deleted_at IS NULL)', 'docker/psql not available')
    else:
        check('the e-mail index is unique and partial (WHERE deleted_at IS NULL), no index over every row is left',
              'UNIQUE' in out and 'deleted_at IS NULL' in out and full_unique.strip() == '0',
              '%s / full unique indexes: %s' % (out.strip(), full_unique.strip()))

    startup_checks()


def startup_checks():
    """HACK-4: the API made admin@gmail.com again at every start, looked up by e-mail; deleting that account
    (soft: the row keeps its e-mail) made the insert fail and the API restart in a loop, and changing its
    e-mail gave a second admin with the password of the server files. Now the admin of .env is made only for
    a CRM without a live admin, and no start-up step (seed*, fix* of main.ts) can stop the API: the steps log
    their error. The API cannot be restarted from here: the sources are checked."""
    print('== 14b. start-up: the admin of .env only without a live admin; no start-up step stops the API')
    try:
        with open(os.path.join(API_SRC, 'seed', 'seed.service.ts'), encoding='utf-8') as f:
            seed_src = f.read()
        with open(os.path.join(API_SRC, 'main.ts'), encoding='utf-8') as f:
            main_src = f.read()
    except OSError as error:
        skip('start-up steps', 'API sources not found: %s' % error)
        return
    after = seed_src.split('async seedAdminUser(', 1)[1] if 'async seedAdminUser(' in seed_src else ''
    admin_seed = re.split(r'\n  (?:/\*\*|async )', after, 1)[0]
    check('the admin of .env is made only when there is no live admin (counted by role, not looked up by e-mail)',
          'countBy({ role: RoleEnum.ADMIN })' in admin_seed and 'findOneBy({ email' not in admin_seed
          and 'withDeleted' not in admin_seed, admin_seed[:300])
    steps = re.findall(r'await seedService\.(\w+)\(', main_src)
    check('every start-up step of main.ts is a seed* / fix* step of SeedService, and the class logs their errors '
          '(@NonFatalSteps) instead of stopping the API',
          bool(steps) and all(re.match(r'(seed|fix)', s) for s in steps) and '@NonFatalSteps()' in seed_src
          and re.search(r'@NonFatalSteps\(\)\s*export class SeedService', seed_src) is not None, steps)
    live_admins = psql("select count(*) from \"user\" where role = 'admin' and deleted_at is null")
    if live_admins is None:
        skip('the CRM has a live admin', 'docker/psql not available')
    else:
        check('the CRM has a live admin (so the start does not make one from .env)', live_admins.strip() not in ('', '0'),
              live_admins)


def standard_rights_checks(admin_token, bare, mgr0, agent):
    """ACL-15: an agent whose card forbids everything saw nothing, not even the deals colleagues made them
    responsible for. Existing cards are not changed by themselves: the admin gives the standard rights
    (POST /auth/standard-rights/:id, the button «Выдать стандартные права» of the list «Пользователи»):
    own deals, companies and contacts to see, create and change, own tasks to change, nothing to delete;
    the mail / file switches stay as they are."""
    print('== 11b. «Выдать стандартные права»: an agent whose card forbids everything')
    status, body = http('GET', '/auth/access', token=bare['token'])
    scopes = body.get('scopes', {}) if isinstance(body, dict) else {}
    check('agent with every level 0: no deals, companies or contacts to see',
          status == 200 and all((scopes.get(e) or {}).get('view') == 'none' for e in ('deal', 'company', 'contact')),
          json.dumps(scopes)[:300])
    status, found = http('GET', '/linkables?name=' + urllib.parse.quote(TAG), token=bare['token'])
    check('... and the search of the task window offers them nothing (GET /linkables -> [])',
          status == 200 and found == [], 'status %s %s' % (status, str(found)[:300]))
    deal_id = None
    out = psql("insert into deal (label, display_id, budget, stage_id, agent_id, created_by) values ('%s-deal-bare', %d, 100, "
               "(select s.id from deal_stage s join collection c on c.id = s.collection_id where c.is_active "
               "order by s.\"order\", s.id limit 1), %d, %d) returning id"
               % (TAG, 900000000 + secrets.randbelow(90000000), bare['id'], agent['id']))
    first = (out or '').strip().split('\n')[0].strip()
    if first.isdigit():
        deal_id = int(first)
        status, _ = http('GET', '/deals/%d' % deal_id, token=bare['token'])
        check('... not even a deal a colleague made them responsible for (-> 404)', status == 404, 'status %s' % status)
    else:
        skip('... not even a deal a colleague made them responsible for', 'docker/psql not available')

    status, _ = http('POST', '/auth/standard-rights/%d' % bare['id'], token=bare['token'])
    check('the agent cannot give the rights to themselves (-> 403)', status == 403, 'status %s' % status)
    status, body = http('POST', '/auth/standard-rights/%d' % bare['id'], token=admin_token)
    stored = body.get('permissions', {}) if isinstance(body, dict) else {}
    check('admin: POST /auth/standard-rights/:id -> 200 with the stored levels',
          status == 200 and stored.get('deal', {}).get('view') == 1 and stored.get('deal', {}).get('delete') == 0
          and stored.get('task') == {'update': 1, 'delete': 0}, 'status %s %s' % (status, str(body)[:300]))
    status, body = http('GET', '/auth/access', token=bare['token'])
    scopes = body.get('scopes', {}) if isinstance(body, dict) else {}
    own = {'view': 'own', 'create': 'all', 'update': 'own', 'delete': 'none'}
    check('... at once, with the same token: own deals, companies and contacts (see, create, change), own tasks to change, '
          'nothing to delete',
          status == 200 and all(scopes.get(e) == own for e in ('deal', 'company', 'contact'))
          and scopes.get('task') == {'view': 'all', 'create': 'all', 'update': 'own', 'delete': 'none'},
          json.dumps(scopes)[:400])
    check('... the switches «Доступ к почте» / «Доступ к файлам» stay as they were (off)',
          isinstance(body, dict) and body.get('mail') is False and body.get('file') is False, json.dumps(body)[:300])
    if deal_id:
        status, _ = http('GET', '/deals/%d' % deal_id, token=bare['token'])
        check('... and the deal they are responsible for opens (-> 200)', status == 200, 'status %s' % status)
    status, _ = http('POST', '/auth/standard-rights/%d' % mgr0['id'], token=admin_token)
    check('... for a manager -> 400 (a manager sees everything, the levels of the card do not apply)',
          status == 400, 'status %s' % status)
    status, _ = http('POST', '/auth/standard-rights/%d' % MISSING_ID, token=admin_token)
    check('... for an account that does not exist -> 404', status == 404, 'status %s' % status)


def cleanup(admin_token, user_ids, task_ids, company_ids, group_ids):
    print('== cleanup')
    # 1) through the API (soft delete for users and companies)
    if admin_token:
        for task_id in task_ids:
            http('DELETE', '/tasks/%d' % task_id, token=admin_token)
        for user_id in user_ids:
            http('DELETE', '/users/%d' % user_id, token=admin_token)
        for company_id in company_ids:
            http('DELETE', '/companies/%d' % company_id, token=admin_token)
        status, groups = http('GET', '/groups', token=admin_token)
        for group in groups if isinstance(groups, list) else []:
            if str(group.get('name', '')).startswith('AUDIT-auth-'):
                http('DELETE', '/groups/%d' % group['id'], token=admin_token)

    # 2) hard delete of what is left (soft-deleted rows, events, notifications)
    users = "select id from \"user\" where email like 'audit-auth-%@example.test'"
    tasks = "select id from task where label like 'AUDIT-auth-%'"
    companies = "select id from company where name like 'AUDIT-auth-%'"
    sql = ';'.join([
        'begin',
        "delete from event where user_id in (%s) or target_user_id in (%s) or task_id in (%s) "
        "or before_state::text like '%%AUDIT-auth-%%' or after_state::text like '%%AUDIT-auth-%%'"
        % (users, users, tasks),
        'delete from notification where company_id in (%s)' % companies,
        'delete from task where id in (%s)' % tasks,
        # the deal of the agent without rights (standard_rights_checks)
        "delete from event where deal_id in (select id from deal where label like 'AUDIT-auth-%')",
        "delete from deal where label like 'AUDIT-auth-%'",
        'delete from "user" where id in (%s)' % users,
        'delete from company where id in (%s)' % companies,
        "delete from \"group\" where name like 'AUDIT-auth-%'",
        'commit',
    ])
    done = psql(sql)
    left = psql("select (select count(*) from \"user\" where email like 'audit-auth-%%@example.test') "
                "+ (select count(*) from task where label like 'AUDIT-auth-%%') "
                "+ (select count(*) from company where name like 'AUDIT-auth-%%') "
                "+ (select count(*) from deal where label like 'AUDIT-auth-%%') "
                "+ (select count(*) from \"group\" where name like 'AUDIT-auth-%%')".replace('%%', '%'))
    if done is None or left is None:
        skip('test rows hard-deleted from the database',
             'docker/psql not available: rows named AUDIT-auth-* were only soft-deleted through the API')
    else:
        check('test rows removed from the database (users, tasks, companies, groups, events)',
              left.strip() == '0', '%s rows left' % left.strip())


if __name__ == '__main__':
    sys.exit(main())
