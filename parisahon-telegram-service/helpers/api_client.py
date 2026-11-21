"""Delivers messages to the CRM API (POST /telegram/incoming) with an outbox.

A message the API could not take (network error, 5xx) is kept in the sqlite
outbox and sent again later, in order. A message the API refused (4xx) is
dropped with a log line: resending it would not help. The API itself never
saves the same Telegram message twice, so a retry after a half-failure is safe.
"""
import json
import os
import sqlite3
import time
import urllib.error
import urllib.request
import uuid
from typing import Optional

from .Logger import Logger

logger = Logger("api.log")


class ApiUnavailable(Exception):
    pass


class ApiRefused(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"{status} {body[:300]}")
        self.status = status
        self.body = body


class CrmApi:
    def __init__(self, base_url: str, token: str, db_path: str, timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.db = sqlite3.connect(db_path)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, "
            "created_at REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)"
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
            if error.code >= 500:
                raise ApiUnavailable(f"{error.code} {body[:200]}")
            raise ApiRefused(error.code, body)
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
            if error.code >= 500:
                raise ApiUnavailable(f"{error.code} {text[:200]}")
            raise ApiRefused(error.code, text)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            raise ApiUnavailable(str(error))

    # --------------------------------------------------------------- outbox

    def deliver(self, payload: dict) -> Optional[dict]:
        """Sends now; on an unavailable API the message waits in the outbox. None = not delivered yet."""
        if self.outbox_size() > 0:
            # keep the order of the chat: everything goes through the queue until it is empty
            self.enqueue(payload, "queued behind older messages")
            self.flush()
            return None
        try:
            return self.post_incoming(payload)
        except ApiRefused as error:
            logger.error(f"API refused message {payload.get('tg_message_id')}: {error}")
            return None
        except ApiUnavailable as error:
            logger.warning(f"API unavailable, message {payload.get('tg_message_id')} queued: {error}")
            self.enqueue(payload, str(error))
            return None

    def enqueue(self, payload: dict, error: str) -> None:
        self.db.execute(
            "INSERT INTO outbox (payload, created_at, attempts, last_error) VALUES (?, ?, 0, ?)",
            (json.dumps(payload, ensure_ascii=False), time.time(), error[:500]),
        )
        self.db.commit()

    def outbox_size(self) -> int:
        return self.db.execute("SELECT count(*) FROM outbox").fetchone()[0]

    def flush(self, limit: int = 100) -> int:
        """Resends queued messages in order; stops at the first one the API still cannot take."""
        sent = 0
        rows = self.db.execute("SELECT id, payload, attempts FROM outbox ORDER BY id LIMIT ?", (limit,)).fetchall()
        for row_id, payload, attempts in rows:
            try:
                self.post_incoming(json.loads(payload))
            except ApiRefused as error:
                logger.error(f"API refused queued message {row_id}, dropped: {error}")
            except ApiUnavailable as error:
                self.db.execute(
                    "UPDATE outbox SET attempts = ?, last_error = ? WHERE id = ?",
                    (attempts + 1, str(error)[:500], row_id),
                )
                self.db.commit()
                break
            self.db.execute("DELETE FROM outbox WHERE id = ?", (row_id,))
            self.db.commit()
            sent += 1
        if sent:
            logger.info(f"outbox: {sent} queued message(s) delivered, {self.outbox_size()} left")
        return sent
