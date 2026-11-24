#!/usr/bin/env python3
"""CRM watchdog (cron, every 5 minutes): checks the services, repairs what it can, tells the admins.

Repairs: starts a stopped CRM container; restarts the API after 3 failed checks in a row (at most
once in 30 minutes). Tells: a Telegram message from the CRM bot to every admin/manager who linked
the bot, when something breaks (after 2 failed checks), once a day while it stays broken, and when it
is fine again. Always: /root/crm2/ops/state/status.json (current state) and watchdog.log.

Recipients (HACK-9): the chats read from the database, remembered in the state after every successful
read, plus WATCHDOG_CHAT_IDS (comma separated Telegram chat ids, in the environment or in the API .env).
So when the database is down the last known admins and the fixed ones are still told.
WATCHDOG_OFFSITE_OPTIONAL=1: no alarm while no storage outside the server is connected.
"""
import json, os, re, ssl, socket, subprocess, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

STATE_DIR = "/root/crm2/ops/state"
STATE = f"{STATE_DIR}/watchdog-state.json"
STATUS = f"{STATE_DIR}/status.json"
LOG = f"{STATE_DIR}/watchdog.log"
ENV = "/root/crm2/parisahon-api/.env"
SITE = "https://crm.parisahome.com"
HOST = "crm.parisahome.com"
CONTAINERS = ["crm-db", "crm-nginx", "crm2-app", "crm2-telegram", "crm2-whatsapp", "crm2-ftp", "crm2-stt"]
WA_HEALTH = (
    "fetch('http://localhost:'+(process.env.PORT||3040)+'/health',{signal:AbortSignal.timeout(5000)})"
    ".then(r=>r.text()).then(t=>console.log(t)).catch(e=>{console.log('ERR '+e.message);process.exit(1)})"
)
# GET /health of parisahon-telegram-service inside its container (no token needed); a 503 has a JSON body too
TG_HEALTH = (
    "import os, urllib.request, urllib.error\n"
    "try:\n"
    "    print(urllib.request.urlopen('http://localhost:%s/health' % (os.environ.get('PORT') or 3030), timeout=5).read().decode())\n"
    "except urllib.error.HTTPError as e:\n"
    "    print(e.read().decode())\n"
    "except Exception as e:\n"
    "    print('ERR', e)\n"
    "    raise SystemExit(1)\n"
)
# a number / account that reconnects by itself is a problem only when it lasts
DOWN_LONG_SEC = 600
# messages for the CRM waiting longer than this in a service's outbox: the API does not take them
OUTBOX_OLD_SEC = 900
CHATS_SQL = (
    'SELECT ba.chat_id FROM bot_account ba JOIN "user" u ON u.id = ba.user_id '
    "WHERE u.deleted_at IS NULL AND u.role IN ('admin', 'manager')"
)
now = time.time()


def run(args, timeout=30, stdin=None):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, input=stdin)
        return r.returncode, (r.stdout + r.stderr).strip()
    except subprocess.TimeoutExpired:
        return 124, "timeout"
    except OSError as e:
        return 127, str(e)


def http(url, timeout=10):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "crm-watchdog"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(2000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return 0, str(e)


def log(text):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {text}\n")
    if os.path.getsize(LOG) > 2_000_000:
        os.replace(LOG, LOG + ".1")


def psql(sql):
    code, out = run(["docker", "exec", "-i", "crm-db", "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], stdin=sql)
    return out if code == 0 else ""


def staff_names(ids):
    """user id -> name, for the messages (ids only digits: they come from the services' /health)."""
    ids = sorted({int(i) for i in ids if str(i).isdigit()})
    if not ids:
        return {}
    out = psql('SELECT id, username FROM "user" WHERE id IN (%s)' % ", ".join(str(i) for i in ids))
    names = {}
    for line in out.splitlines():
        uid, _, name = line.partition("|")
        if uid.isdigit():
            names[int(uid)] = name.strip()
    return names


def since_sec(value):
    """Seconds since `since` of a /health problem: epoch seconds (Telegram) or an ISO time (WhatsApp)."""
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (int, float)):
            t = float(value) / (1000 if value > 1e12 else 1)
        else:
            t = datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
        return max(0, now - t)
    except (TypeError, ValueError):
        return None


def health_json(out):
    try:
        data = json.loads(out.strip().splitlines()[-1]) if out.strip() else None
        return data if isinstance(data, dict) else None
    except (ValueError, IndexError):
        return None


def outbox_checks(key, name, data):
    """Messages waiting for the CRM API too long, and messages the API refused (kept aside by the service)."""
    oldest = int(data.get("outbox_oldest_sec") or 0)
    size = int(data.get("outbox") or 0)
    checks[f"{key}_outbox"] = (
        not (size and oldest >= OUTBOX_OLD_SEC),
        f"{name}: {size} сообщ. клиентов ждут CRM уже {oldest // 60} мин — API их не принимает (токен, ошибка API)",
    )
    rejected = int(data.get("rejected") or 0)
    seen = state.setdefault("rejected", {})
    previous = seen.get(key)
    if previous is None or rejected < previous.get("count", 0):
        seen[key] = {"count": rejected, "grew_at": 0}
    elif rejected > previous.get("count", 0):
        seen[key] = {"count": rejected, "grew_at": now}
    grew_at = seen[key].get("grew_at", 0)
    checks[f"{key}_rejected"] = (
        not grew_at or now - grew_at > 86400,
        f"{name}: CRM отказалась принять сообщения клиентов (всего отложено {rejected}); они сохранены в сервисе, подробности в его журнале",
    )


def env(key):
    try:
        for line in open(ENV, encoding="utf-8"):
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def setting(key):
    """The watchdog's own switches: the process environment first, then the API .env."""
    return (os.environ.get(key) or env(key) or "").strip()


def recipients():
    """Chat ids to tell: the database (remembered in the state), else the last known ones; plus WATCHDOG_CHAT_IDS."""
    fixed = [c for c in re.split(r"[\s,;]+", setting("WATCHDOG_CHAT_IDS")) if re.fullmatch(r"-?\d+", c)]
    code, out = run(["docker", "exec", "-i", "crm-db", "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], stdin=CHATS_SQL)
    if code == 0:
        from_db = [c for c in out.split() if re.fullmatch(r"-?\d+", c)]
        state["chats"] = from_db
    else:
        from_db = [c for c in state.get("chats") or [] if re.fullmatch(r"-?\d+", str(c))]
        log(f"database not readable for the recipients: the last known {len(from_db)} chat(s) and WATCHDOG_CHAT_IDS")
    return list(dict.fromkeys([str(c) for c in from_db] + fixed))


os.makedirs(STATE_DIR, exist_ok=True)
try:
    state = json.load(open(STATE))
except Exception:
    state = {}
checks = {}  # key -> (ok, text for people)
repairs = []

# 1. containers
for name in CONTAINERS:
    code, out = run(["docker", "inspect", "-f", "{{.State.Running}}", name])
    running = code == 0 and out == "true"
    if not running:
        c2, _ = run(["docker", "start", name], 60)
        repairs.append(f"служба {name} была остановлена, запущена заново" if c2 == 0 else f"не удалось запустить {name}")
    checks[f"container:{name}"] = (running, f"служба {name} остановлена")

# 2. database
code, _ = run(["docker", "exec", "crm-db", "pg_isready", "-q"])
checks["db"] = (code == 0, "база данных не отвечает")

# 3. site and API
code, _ = http(SITE + "/")
checks["site"] = (code == 200, f"сайт CRM не открывается (код {code})")
code, body = http(SITE + "/api/v1/health")
# alive = /health answers 200 and reaches the database (a 4xx from nginx or the API is not "alive")
api_ok = code == 200 and '"db":false' not in body.replace(" ", "")
checks["api"] = (api_ok, f"API не отвечает (код {code})" if code != 200 else "API не достаёт до базы данных")
fails = 0 if api_ok else state.get("api_fails", 0) + 1
state["api_fails"] = fails
# a restart does not help while the database itself is down (that has its own alarm)
if fails >= 3 and checks["db"][0] and now - state.get("api_restarted", 0) > 1800:
    c2, _ = run(["docker", "restart", "crm2-app"], 120)
    state["api_restarted"] = now
    state["api_fails"] = 0
    repairs.append("API перезапущен после 3 неудачных проверок" if c2 == 0 else "перезапуск API не удался")

# 4. WhatsApp: the state of every linked number (GET /health of the service: states + problems).
#    A number unlinked on the phone, or reconnecting for 10 minutes and more, is a problem of its own
#    (one alarm per number); messages waiting for the CRM or refused by it are alarms too.
code, out = run(["docker", "exec", "crm2-whatsapp", "node", "-e", WA_HEALTH])
wa = health_json(out) if code == 0 else None
checks["whatsapp"] = (wa is not None, "служба WhatsApp не отвечает")
if wa is not None:
    problems = [p for p in wa.get("problems") or [] if p.get("status") == "logged_out"
                or (since_sec(p.get("since")) or 0) >= DOWN_LONG_SEC]
    names = staff_names([p.get("user_id") for p in problems])
    for p in problems:
        uid = int(p.get("user_id") or 0)
        who = names.get(uid) or f"№{uid}"
        if p.get("status") == "logged_out":
            text = f"WhatsApp сотрудника {who} отвязан на телефоне: сообщения его клиентов не приходят в CRM (подключить: CRM → WhatsApp)"
        else:
            text = (f"WhatsApp сотрудника {who} не на связи {int((since_sec(p.get('since')) or 0) // 60)} мин"
                    f"{' (' + str(p.get('error')) + ')' if p.get('error') else ''}: сообщения клиентов не приходят (CRM → WhatsApp → Переподключить)")
        checks[f"whatsapp:{uid}"] = (False, text)
    # a number that was a problem and is fine now: its check is ok again (so the "fixed" message goes out)
    for key in list(state.get("items", {})):
        if key.startswith("whatsapp:") and key not in checks:
            checks[key] = (True, "")
    outbox_checks("whatsapp", "WhatsApp", wa)
    if "ffmpeg" in wa:
        checks["whatsapp_ffmpeg"] = (wa.get("ffmpeg") is not False,
                                     "служба WhatsApp не нашла ffmpeg: голосовые клиентов сохраняются в .ogg (FFMPEG_BIN в whatsapp.env)")

# 5. Telegram: the state of every connected account (GET /health of the service: revoked = ended in
#    Telegram itself, error = no connection); an older service without it: its start-failure log line
code, out = run(["docker", "exec", "crm2-telegram", "python", "-c", TG_HEALTH])
tg = health_json(out)
if tg is not None and "problems" in tg:
    checks["telegram"] = (bool(tg.get("ok")), "служба Telegram не работает: сообщения клиентов не приходят в CRM")
    problems = [p for p in tg.get("problems") or [] if p.get("status") == "revoked"
                or (since_sec(p.get("since")) or 0) >= DOWN_LONG_SEC]
    names = staff_names([p.get("user_id") for p in problems])
    for p in problems:
        uid = int(p.get("user_id") or 0)
        who = names.get(uid) or f"№{uid}"
        if p.get("status") == "revoked":
            text = f"Telegram сотрудника {who} отключён в самом Telegram (сеанс завершён): сообщения его клиентов не приходят в CRM (подключить: CRM → Телеграм → Подключить заново)"
        else:
            text = (f"Telegram сотрудника {who} не на связи {int((since_sec(p.get('since')) or 0) // 60)} мин"
                    f"{' (' + str(p.get('error')) + ')' if p.get('error') else ''}: сервис пробует сам")
        checks[f"telegram:{uid}"] = (False, text)
    for key in list(state.get("items", {})):
        if key.startswith("telegram:") and key not in checks:
            checks[key] = (True, "")
    outbox_checks("telegram", "Telegram", tg)
    if "ffmpeg" in tg:
        checks["telegram_ffmpeg"] = (tg.get("ffmpeg") is not False,
                                     "служба Telegram не нашла ffmpeg: голосовые клиентов сохраняются в .ogg (FFMPEG_BIN в telegram.env)")
else:
    # an older service without the states in /health: its start-failure log lines (every kind of ended session)
    code, out = run(["docker", "logs", "--since", "11m", "crm2-telegram"])
    dead = sorted(set(re.findall(r"\(user (\d+)\)[^\n]*(?:AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AuthKeyUnregistered|SessionRevoked|UserDeactivated)", out)), key=int)
    checks["telegram"] = (
        not dead,
        "Telegram отключён у пользователей CRM № " + ", ".join(dead) + ": нужно войти заново (CRM → Телеграм → Подключить)",
    )

# 6. disk, memory
st = os.statvfs("/")
used = 100 - st.f_bavail * 100 // st.f_blocks
iused = 100 - st.f_favail * 100 // st.f_files if st.f_files else 0
checks["disk"] = (used < 85 and iused < 85, f"диск заполнен на {used}% (по числу файлов {iused}%)")
mem = dict(re.findall(r"(\w+):\s+(\d+)", open("/proc/meminfo").read()))
avail = int(mem.get("MemAvailable", 0)) // 1024
checks["memory"] = (avail > 200, f"мало свободной памяти: {avail} МБ")

# 7. backup of last night
try:
    b = json.load(open(f"{STATE_DIR}/backup.json"))
    made = datetime.fromisoformat(b["at"].replace("Z", "+00:00"))
    age = (datetime.now(timezone.utc) - made).total_seconds() / 3600
    why = f" ({b.get('error')})" if b.get("error") else f" (последняя {age:.0f} ч назад)"
    checks["backup"] = (bool(b.get("ok")) and age < 26, "ночная копия базы не сделана" + why)
    # a storage that did not take last night's copy; "not connected" too (every copy is on this same disk),
    # unless WATCHDOG_OFFSITE_OPTIONAL=1
    offsite = b.get("offsite")
    if offsite == "failed":
        checks["offsite"] = (False, "копия бэкапа вне сервера не удалась (подробности в backup.log)")
    elif offsite in (None, "", "not connected", "none") and setting("WATCHDOG_OFFSITE_OPTIONAL") != "1":
        checks["offsite"] = (False, "внешнее хранилище для бэкапов не подключено: все копии базы лежат на этом же сервере (ops/offsite.sh)")
    else:
        checks["offsite"] = (True, "")
except Exception:
    checks["backup"] = (False, "ночная копия базы ещё ни разу не сделана")

# 7b. files: the nightly integrity check (integrity.py)
try:
    r = json.load(open(f"{STATE_DIR}/integrity.json"))
    made = datetime.fromisoformat(r["at"].replace("Z", "+00:00"))
    age = (datetime.now(timezone.utc) - made).total_seconds() / 3600
    if age >= 26:
        checks["files"] = (False, f"проверка целостности файлов не запускалась {age:.0f} ч")
    else:
        text = (f"файлы CRM: потеряно {len(r.get('lost', []))}, повреждено {len(r.get('damaged', []))}, "
                f"записей без файла {len(r.get('missing_new', []))} (подробности в integrity.log)")
        checks["files"] = (bool(r.get("ok")), text)
except Exception:
    checks["files"] = (False, "проверка целостности файлов ещё не запускалась")

# 8. certificate
try:
    ctx = ssl.create_default_context()
    with socket.create_connection((HOST, 443), timeout=10) as sock, ctx.wrap_socket(sock, server_hostname=HOST) as s:
        days = int((ssl.cert_time_to_seconds(s.getpeercert()["notAfter"]) - now) / 86400)
    checks["cert"] = (days > 14, f"сертификат сайта истекает через {days} дн.")
except Exception as e:
    checks["cert"] = (False, f"сертификат сайта не проверяется: {type(e).__name__}")

# 9. errors in the API log
code, out = run(["docker", "logs", "--since", "6m", "crm2-app"])
errors = out.count(" ERROR ")
checks["api_errors"] = (errors < 20, f"много ошибок в API: {errors} за 5 минут")

# --- what changed, whom to tell ---
items = state.setdefault("items", {})
messages = []
for key, (ok, text) in checks.items():
    it = items.setdefault(key, {"ok": True, "fails": 0, "alerted": 0})
    if ok:
        if it.get("alerted"):
            messages.append("✅ Исправлено: " + it.get("text", key))
        it.update(ok=True, fails=0, alerted=0)
    else:
        it["fails"] = it.get("fails", 0) + 1
        it["ok"] = False
        it["text"] = text
        if it["fails"] >= 2 and now - it.get("alerted", 0) > 86400:
            messages.append("⚠️ " + text)
            it["alerted"] = now
for r in repairs:
    messages.append("🔧 " + r)
# per-number checks (whatsapp:<id>, telegram:<id>) that are fine again are forgotten
for key in [k for k, it in items.items() if ":" in k and k.split(":", 1)[0] in ("whatsapp", "telegram") and it.get("ok")]:
    items.pop(key, None)

bad = {k: v[1] for k, v in checks.items() if not v[0]}
with open(STATUS, "w", encoding="utf-8") as f:
    json.dump(
        {"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "ok": not bad, "problems": bad, "checks": len(checks)},
        f,
        ensure_ascii=False,
        indent=1,
    )

# read every run, so the list kept in the state is fresh when the database goes down
chats = recipients()
if messages:
    text = "CRM, сторож сервера:\n" + "\n".join(messages)
    log(text.replace("\n", " | "))
    token = env("CRM_BOT_TOKEN")
    if not token or not chats:
        log("nobody to tell: no admin has linked the CRM bot and WATCHDOG_CHAT_IDS is empty")
    for chat in chats:
        data = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
        try:
            urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data=data, timeout=15).read()
        except Exception as e:
            log(f"telegram send failed: {type(e).__name__}")

with open(STATE, "w") as f:
    json.dump(state, f)
