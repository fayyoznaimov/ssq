"""Delivers messages to the CRM API (POST /telegram/incoming) with an outbox.

What happens to a message the API did not take:
  - the API is not there or not ready (network error, timeout, 502 / 503 / 504), or refuses the service
    itself (401 / 403: the token was changed, 408, 429): the message waits in the sqlite outbox and is
    sent again later, in order, however long it takes. Nothing is dropped because of a wrong token;
  - the API answered 500 for this one message (it is up, but this payload fails): it is tried again
    with a growing pause (it does not hold up the messages behind it); after MAX_FAILED_ATTEMPTS it is
    moved to the `rejected` table;
  - the API refused this message (400, 404, 409, 410, 413, 422 ...): resending would not help, it is
    moved to the `rejected` table at once (kept with the error, never silently dropped).
/health shows the outbox and the rejected count; the server watchdog alarms on them.
The API itself never saves the same Telegram message twice, so a retry after a half-failure is safe.
Thread-safe: the listener calls it from worker threads (asyncio.to_thread), one call at a time.
"""
import json
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import uuid
from typing import Callable, Optional

from .Logger import Logger

logger = Logger("api.log")

# statuses that say "the API (or the way to it) is not ready", not "this message is wrong"
UNAVAILABLE_STATUSES = {401, 403, 408, 425, 429, 502, 503, 504}
MAX_FAILED_ATTEMPTS = int(os.environ.get("API_MAX_FAILED_ATTEMPTS", "8"))
REJECTED_KEEP = 2000


class ApiUnavailable(Exception):
    pass


class ApiFailed(Exception):
    """The API is up but answered 5xx for this message."""

    def __init__(self, status: int, body: str):
        super().__init__(f"{status} {body[:300]}")
        self.status = status
        self.body = body


class ApiRefused(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"{status} {body[:300]}")
        self.status = status
        self.body = body


def classify(status: int, body: str) -> Exception:
    if status in UNAVAILABLE_STATUSES:
        return ApiUnavailable(f"{status} {body[:200]}")
    if status >= 500:
        return ApiFailed(status, body)
    return ApiRefused(status, body)


class CrmApi:
    def __init__(self, base_url: str, token: str, db_path: str, timeout: int = 30,
                 on_refused: Optional[Callable[[dict, "ApiRefused"], None]] = None):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.on_refused = on_refused
        self.lock = threading.RLock()
        self.db = sqlite3.connect(db_path, check_same_thread=False)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, "
            "created_at REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)"
        )
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(outbox)").fetchall()}
        if "next_at" not in columns:
            self.db.execute("ALTER TABLE outbox ADD COLUMN next_at REAL NOT NULL DEFAULT 0")
        if "failures" not in columns:
            self.db.execute("ALTER TABLE outbox ADD COLUMN failures INTEGER NOT NULL DEFAULT 0")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS rejected (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at REAL NOT NULL, "
            "rejected_at REAL NOT NULL, status INTEGER, error TEXT)"
        )
        self.db.commit()

    # ----------------------------------------------------------------- http

    def post(self, path: str, payload: dict) -> dict:
        if not self.token:
            raise ApiUnavailable("CRM_API_TOKEN is not set")
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            method="POST",
            headers={"Content-Type": "application/json", "X-Telegram-Service-Token": self.token},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                text = response.read().decode("utf-8", "replace")
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", "replace")
            raise classify(error.code, body)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            raise ApiUnavailable(str(error))

    def post_incoming(self, payload: dict) -> dict:
        return self.post("/telegram/incoming", payload)

    def upload_call(self, user_id: int, audio_path: str, meta_path: str) -> dict:
        """POST /calls/upload (multipart: the audio and the recorder's json) as the service, for a manager's folder."""
        if not self.token:
            raise ApiUnavailable("CRM_API_TOKEN is not set")
        boundary = "----crm-call-" + uuid.uuid4().hex
        body = bytearray()

        def part(name: str, filename: str, content_type: str, data: bytes) -> None:
            body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n"
                        f"Content-Type: {content_type}\r\n\r\n".encode())
            body.extend(data)
            body.extend(b"\r\n")

        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"user_id\"\r\n\r\n{user_id}\r\n".encode())
        with open(audio_path, "rb") as fh:
            part("file", os.path.basename(audio_path), "application/octet-stream", fh.read())
        with open(meta_path, "rb") as fh:
            part("meta", os.path.basename(meta_path), "application/json", fh.read())
        body.extend(f"--{boundary}--\r\n".encode())
        request = urllib.request.Request(
            self.base_url + "/calls/upload",
            data=bytes(body),
            method="POST",
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "X-Telegram-Service-Token": self.token},
        )
        try:
            with urllib.request.urlopen(request, timeout=max(self.timeout, 120)) as response:
                text = response.read().decode("utf-8", "replace")
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as error:
            text = error.read().decode("utf-8", "replace")
            if error.code >= 500 or error.code in UNAVAILABLE_STATUSES:
                raise ApiUnavailable(f"{error.code} {text[:200]}")
            raise ApiRefused(error.code, text)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            raise ApiUnavailable(str(error))

    # --------------------------------------------------------------- outbox

    def deliver(self, payload: dict) -> Optional[dict]:
        """Sends now; on an unavailable API the message waits in the outbox. None = not delivered (yet)."""
        with self.lock:
            if self.outbox_size() > 0:
                # keep the order of the chat: everything goes through the queue until it is empty
                self.enqueue(payload, "queued behind older messages")
                self.flush()
                return None
            try:
                return self.post_incoming(payload)
            except ApiRefused as error:
                self.reject(payload, error.status, str(error), time.time())
                return None
            except ApiFailed as error:
                logger.warning(f"API failed on message {payload.get('tg_message_id')}, queued for a retry: {error}")
                self.enqueue(payload, str(error), failures=1, next_at=time.time() + self.retry_pause(1))
                return None
            except ApiUnavailable as error:
                logger.warning(f"API unavailable, message {payload.get('tg_message_id')} queued: {error}")
                self.enqueue(payload, str(error))
                return None

    @staticmethod
    def retry_pause(failures: int) -> float:
        return min(30 * 2 ** max(0, failures - 1), 3600)

    def enqueue(self, payload: dict, error: str, failures: int = 0, next_at: float = 0) -> None:
        with self.lock:
            self.db.execute(
                "INSERT INTO outbox (payload, created_at, attempts, last_error, next_at, failures) VALUES (?, ?, 0, ?, ?, ?)",
                (json.dumps(payload, ensure_ascii=False), time.time(), error[:500], next_at, failures),
            )
            self.db.commit()

    def reject(self, payload: dict, status: Optional[int], error: str, created_at: float) -> None:
        """Kept aside with the reason (never silently dropped): /health counts them, the watchdog alarms."""
        with self.lock:
            logger.error(f"API refused message {payload.get('tg_message_id')} of user {payload.get('agent_id')}, kept in 'rejected': {error}")
            self.db.execute(
                "INSERT INTO rejected (payload, created_at, rejected_at, status, error) VALUES (?, ?, ?, ?, ?)",
                (json.dumps(payload, ensure_ascii=False), created_at, time.time(), status, error[:500]),
            )
            self.db.execute(
                "DELETE FROM rejected WHERE id NOT IN (SELECT id FROM rejected ORDER BY id DESC LIMIT ?)", (REJECTED_KEEP,)
            )
            self.db.commit()
        if self.on_refused is not None and isinstance(status, int):
            try:
                self.on_refused(payload, ApiRefused(status, error))
            except Exception as callback_error:  # never breaks the delivery
                logger.warning(f"on_refused: {callback_error}")

    def outbox_size(self) -> int:
        with self.lock:
            return self.db.execute("SELECT count(*) FROM outbox").fetchone()[0]

    def stats(self) -> dict:
        """For /health: messages waiting (and since when), messages the API refused."""
        with self.lock:
            size, oldest = self.db.execute("SELECT count(*), min(created_at) FROM outbox").fetchone()
            rejected, last_rejected = self.db.execute("SELECT count(*), max(rejected_at) FROM rejected").fetchone()
        return {
            "outbox": size,
            "outbox_oldest_sec": int(time.time() - oldest) if oldest else 0,
            "rejected": rejected,
            "rejected_last_at": int(last_rejected) if last_rejected else None,
        }

    def flush(self, limit: int = 100) -> int:
        """Resends queued messages in order; stops at the first one the API still cannot take (unavailable).
        A message that keeps failing with 500 waits for its next try and does not hold up the others."""
        sent = 0
        now = time.time()
        with self.lock:
            rows = self.db.execute(
                "SELECT id, payload, attempts, created_at, next_at, failures FROM outbox ORDER BY id LIMIT ?", (limit,)
            ).fetchall()
            for row_id, payload, attempts, created_at, next_at, failures in rows:
                if next_at and next_at > now:
                    continue
                data = json.loads(payload)
                delivered = False
                try:
                    self.post_incoming(data)
                    delivered = True
                except ApiRefused as error:
                    self.reject(data, error.status, str(error), created_at)
                except ApiFailed as error:
                    failures += 1
                    if failures >= MAX_FAILED_ATTEMPTS:
                        self.reject(data, error.status, f"{failures} attempts: {error}", created_at)
                    else:
                        self.db.execute(
                            "UPDATE outbox SET attempts = ?, failures = ?, next_at = ?, last_error = ? WHERE id = ?",
                            (attempts + 1, failures, now + self.retry_pause(failures), str(error)[:500], row_id),
                        )
                        self.db.commit()
                        continue
                except ApiUnavailable as error:
                    self.db.execute(
                        "UPDATE outbox SET attempts = ?, last_error = ? WHERE id = ?",
                        (attempts + 1, str(error)[:500], row_id),
                    )
                    self.db.commit()
                    break
                self.db.execute("DELETE FROM outbox WHERE id = ?", (row_id,))
                self.db.commit()
                if delivered:
                    sent += 1
            if sent:
                logger.info(f"outbox: {sent} queued message(s) delivered, {self.outbox_size()} left")
        return sent
