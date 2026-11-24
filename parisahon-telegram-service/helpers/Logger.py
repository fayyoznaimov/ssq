import datetime
import os
import pytz

from .config import LOGS_DIR, env

# the CRM's time zone, one setting for every service (the API: helper/time-zone.ts): TZ, Asia/Tashkent by default
DEFAULT_TIME_ZONE = 'Asia/Tashkent'


def crm_timezone():
    """TZ of the environment when pytz knows it, otherwise Asia/Tashkent (UTC+5, as the Asia/Karachi of before)."""
    try:
        return pytz.timezone(env('TZ', DEFAULT_TIME_ZONE).strip())
    except pytz.UnknownTimeZoneError:
        return pytz.timezone(DEFAULT_TIME_ZONE)


class Logger:
    """Appends to logs/<name> (LOGS_DIR); also prints to stdout so that systemd / docker see it."""

    def __init__(self, log_file):
        self.log_file = log_file
        self.timezone = crm_timezone()

    def log(self, level, message):
        current_time = datetime.datetime.now(tz=self.timezone)
        timestamp = current_time.strftime("%Y-%m-%d %H:%M:%S")
        log_message = f"[{timestamp}] [{level.upper()}] {message}"
        print(f"{self.log_file}: {log_message}", flush=True)
        try:
            os.makedirs(LOGS_DIR, exist_ok=True)
            with open(os.path.join(LOGS_DIR, self.log_file), 'a', encoding='utf-8') as f:
                f.write(log_message + "\n")
        except OSError:
            pass

    def error(self, message):
        self.log("error", message)

    def warning(self, message):
        self.log("warning", message)

    def info(self, message):
        self.log("info", message)
