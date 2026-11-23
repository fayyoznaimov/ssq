"""Settings of the service, all from the environment (.env is loaded by the callers)."""
import os


def env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


# where the CRM API is and the shared secret of POST /telegram/incoming (TELEGRAM_SERVICE_TOKEN there)
CRM_API_URL = env("CRM_API_URL", "http://crm-app:3000/api/v1").rstrip("/")
CRM_API_TOKEN = env("CRM_API_TOKEN")
CRM_API_TIMEOUT = int(env("CRM_API_TIMEOUT", "30"))

# the token the CRM API must send to this service's own HTTP API (X-Telegram-Service-Token on every route
# except /health). Default: CRM_API_TOKEN, the same shared secret (the API's TELEGRAM_SERVICE_TOKEN), so an
# existing setup needs no change. Without any token every route except /health answers 401.
HTTP_API_TOKEN = env("SERVICE_HTTP_TOKEN", CRM_API_TOKEN)

# every N seconds each connected account is asked who it is (get_me): a session ended in Telegram
# (revoked on the phone, AUTH_KEY_UNREGISTERED) is seen within this time, not only at the next restart
HEALTH_SEC = float(env("HEALTH_SEC", "300"))

# sqlite with the Telegram sessions of the managers and the outbox of undelivered messages
SERVICE_DB = env("SERVICE_DB", "telegram_service.db")
LOGS_DIR = env("LOGS_DIR", "logs")

# every N seconds: new sessions, outbox retry, call recordings
POLL_SEC = float(env("POLL_SEC", "3"))
# a session that could not start (revoked, network) is tried again after this many seconds
SESSION_RETRY_SEC = int(env("SESSION_RETRY_SEC", "300"))

# downloaded media go here (parisahon-api/public/uploads)
UPLOADS_DIR = env("RECORDINGS_TARGET", "/app/uploads")

# a file above this size is not saved in the CRM: it stays in Telegram and the CRM shows a link that
# fetches it on demand (GET /download). 0 = save everything, as before.
MAX_AUTO_DOWNLOAD_MB = float(env("TG_MAX_AUTO_DOWNLOAD_MB", "25"))
