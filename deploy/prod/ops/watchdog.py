#!/usr/bin/env python3
"""CRM watchdog (cron, every 5 minutes): checks the services, repairs what it can, tells the admins.

Repairs: starts a stopped CRM container; restarts the API after 3 failed checks in a row (at most
once in 30 minutes). Tells: a Telegram message from the CRM bot to every admin/manager who linked
the bot, when something breaks (after 2 failed checks), once a day while it stays broken, and when it
is fine again. Always: /root/crm2/ops/state/status.json (current state) and watchdog.log.
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


def env(key):
    try:
        for line in open(ENV, encoding="utf-8"):
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


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
api_ok = 200 <= code < 500 and not (code == 200 and '"db":false' in body.replace(" ", ""))
checks["api"] = (api_ok, f"API не отвечает (код {code})")
fails = 0 if api_ok else state.get("api_fails", 0) + 1
state["api_fails"] = fails
if fails >= 3 and now - state.get("api_restarted", 0) > 1800:
    c2, _ = run(["docker", "restart", "crm2-app"], 120)
    state["api_restarted"] = now
    state["api_fails"] = 0
    repairs.append("API перезапущен после 3 неудачных проверок" if c2 == 0 else "перезапуск API не удался")

# 4. WhatsApp: at least one connected number
code, out = run(["docker", "exec", "crm2-whatsapp", "node", "-e", WA_HEALTH])
try:
    sessions = int(json.loads(out).get("sessions", 0))
except Exception:
    sessions = -1
checks["whatsapp"] = (
    sessions >= 1,
    "WhatsApp не подключён: нужно заново привязать номер (Профиль → WhatsApp)" if sessions == 0 else "служба WhatsApp не отвечает",
)

# 5. Telegram: an account whose login was revoked keeps failing until the manager signs in again
code, out = run(["docker", "logs", "--since", "11m", "crm2-telegram"])
dead = sorted(set(re.findall(r"\(user (\d+)\)[^\n]*AUTH_KEY_UNREGISTERED", out)), key=int)
checks["telegram"] = (
    not dead,
    "Telegram отключён у пользователей CRM № " + ", ".join(dead) + ": нужно войти заново (Профиль → Telegram)",
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
    # a storage that is connected but did not take last night's copy; "not connected" is not an alarm
    checks["offsite"] = (b.get("offsite") != "failed", "копия бэкапа вне сервера не удалась (подробности в backup.log)")
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

bad = {k: v[1] for k, v in checks.items() if not v[0]}
with open(STATUS, "w", encoding="utf-8") as f:
    json.dump(
        {"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "ok": not bad, "problems": bad, "checks": len(checks)},
        f,
        ensure_ascii=False,
        indent=1,
    )

if messages:
    text = "CRM, сторож сервера:\n" + "\n".join(messages)
    log(text.replace("\n", " | "))
    token = env("CRM_BOT_TOKEN")
    code, out = run(
        ["docker", "exec", "-i", "crm-db", "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'],
        stdin=CHATS_SQL,
    )
    chats = [c for c in out.split() if re.fullmatch(r"-?\d+", c)] if code == 0 else []
    if not token or not chats:
        log("nobody to tell: no admin has linked the CRM bot")
    for chat in chats:
        data = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
        try:
            urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data=data, timeout=15).read()
        except Exception as e:
            log(f"telegram send failed: {type(e).__name__}")

with open(STATE, "w") as f:
    json.dump(state, f)
