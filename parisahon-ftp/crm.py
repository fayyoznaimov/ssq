"""The two CRM API calls the FTP receiver makes (standard library only).

  GET  {CRM_API_URL}/calls/recorder   X-Recorder-Token: <the FTP password>    -> whose token it is
  POST {CRM_API_URL}/calls/upload     X-Calls-Service-Token: <service token>  -> one audio file into the queue

Tokens are never logged here and never put into error texts.
"""
import http.client
import json
import os
import secrets
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Iterator, Optional

CHUNK = 256 * 1024
# the file itself is bad: the API will never take it, do not try again
REJECT_STATUSES = (400, 413, 415)
# our service token is not accepted: nothing can be sent until someone fixes the env files
AUTH_STATUSES = (401, 403)


@dataclass
class Recorder:
    """Answer of GET /calls/recorder. kind: ok | denied (unknown or revoked token) | unavailable."""
    kind: str
    user_id: Optional[int] = None
    username: str = ""
    detail: str = ""


@dataclass
class UploadResult:
    """Answer of POST /calls/upload. kind: sent | rejected (bad file, never again) | auth (401 / 403) |
    retry (try this file later) | network (the API is not reachable)."""
    kind: str
    status: int = 0
    upload_id: Optional[int] = None
    duplicate: bool = False
    error: str = ""


def error_text(status: int, body: bytes) -> str:
    """The API's own words ({"message": ...} of NestJS), else the start of the body."""
    text = body.decode("utf-8", "replace").strip()
    try:
        data = json.loads(text)
        if isinstance(data, dict) and data.get("message"):
            message = data["message"]
            text = "; ".join(str(m) for m in message) if isinstance(message, list) else str(message)
    except ValueError:
        pass
    text = " ".join(text.split())[:300]
    return text or f"HTTP {status}"


def _quote_filename(name: str) -> str:
    # as browsers do it (HTML multipart/form-data): the name goes as raw UTF-8, only the characters
    # that would break the header are escaped
    return name.replace("\r", "%0D").replace("\n", "%0A").replace('"', "%22")


class CrmApi:
    def __init__(self, base_url: str, service_token: str, timeout: float = 15.0, upload_timeout: float = 180.0):
        self.base_url = base_url.rstrip("/")
        self._service_token = service_token
        self.timeout = timeout
        self.upload_timeout = upload_timeout
        # no proxies: the API is on this machine or next to it
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    # ------------------------------------------------------------------ login

    def recorder(self, token: str) -> Recorder:
        request = urllib.request.Request(self.base_url + "/calls/recorder", method="GET", headers={"X-Recorder-Token": token, "Accept": "application/json"})
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                data = json.loads(response.read() or b"null")
            user_id = int(data["user_id"])
            if user_id <= 0:
                raise ValueError("user_id")
            return Recorder("ok", user_id=user_id, username=str(data.get("username") or ""))
        except urllib.error.HTTPError as error:
            body = error.read()
            if error.code == 401:
                return Recorder("denied", detail="HTTP 401")
            return Recorder("unavailable", detail=f"HTTP {error.code}: {error_text(error.code, body)}")
        except (urllib.error.URLError, http.client.HTTPException, socket.timeout, OSError) as error:
            return Recorder("unavailable", detail=_network_error(error))
        except (ValueError, KeyError, TypeError):
            return Recorder("unavailable", detail="unexpected answer of GET /calls/recorder")

    # ------------------------------------------------------------------ upload

    def upload(self, user_id: int, path: str, file_name: str, recorded_at_ms: Optional[int] = None, meta_path: Optional[str] = None) -> UploadResult:
        """Posts one audio file. `file_name` is the name the manager's phone gave it, sent as it is."""
        boundary = "----parisa-ftp-" + secrets.token_hex(16)
        try:
            size = os.path.getsize(path)
            meta = None
            if meta_path:
                with open(meta_path, "rb") as handle:
                    meta = handle.read(1024 * 1024 + 1)
                if len(meta) > 1024 * 1024:
                    meta = None  # not a recorder's json
        except OSError as error:
            # about this file only (deleted a moment ago?): it gets its own next try, the others go on
            return UploadResult("retry", error=f"cannot read the file: {error.strerror or error}")

        head = bytearray()
        fields = {"user_id": str(user_id)}
        if recorded_at_ms is not None:
            fields["recorded_at"] = str(int(recorded_at_ms))
        for name, value in fields.items():
            head += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf-8")
        if meta is not None:
            head += (f'--{boundary}\r\nContent-Disposition: form-data; name="meta"; filename="{_quote_filename(os.path.basename(meta_path))}"\r\n'
                     "Content-Type: application/json\r\n\r\n").encode("utf-8") + meta + b"\r\n"
        head += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{_quote_filename(file_name)}"\r\n'
                 "Content-Type: application/octet-stream\r\n\r\n").encode("utf-8")
        tail = f"\r\n--{boundary}--\r\n".encode("ascii")

        def body() -> Iterator[bytes]:
            yield bytes(head)
            left = size
            with open(path, "rb") as handle:
                while left > 0:
                    chunk = handle.read(min(CHUNK, left))
                    if not chunk:
                        # the file became shorter while we were sending it: break the request, try later
                        raise OSError("the file changed while it was being sent")
                    left -= len(chunk)
                    yield chunk
            yield tail

        request = urllib.request.Request(
            self.base_url + "/calls/upload", method="POST", data=body(),
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Content-Length": str(len(head) + size + len(tail)),
                "X-Calls-Service-Token": self._service_token,
                "Accept": "application/json",
            })
        try:
            with self._opener.open(request, timeout=self.upload_timeout) as response:
                status = response.status
                raw = response.read()
        except urllib.error.HTTPError as error:
            raw = error.read()
            text = error_text(error.code, raw)
            if error.code in REJECT_STATUSES:
                return UploadResult("rejected", status=error.code, error=text)
            if error.code in AUTH_STATUSES:
                return UploadResult("auth", status=error.code, error=text)
            return UploadResult("retry", status=error.code, error=f"HTTP {error.code}: {text}")
        except (urllib.error.URLError, http.client.HTTPException, socket.timeout, OSError) as error:
            return UploadResult("network", error=_network_error(error))
        try:
            data = json.loads(raw or b"null")
        except ValueError:
            data = None
        if not isinstance(data, dict):
            # 2xx without the expected JSON: something else is answering on that address
            return UploadResult("retry", status=status, error=f"HTTP {status}: not the answer of POST /calls/upload")
        upload_id = data.get("id")
        return UploadResult("sent", status=status, upload_id=upload_id if isinstance(upload_id, int) else None, duplicate=bool(data.get("duplicate")))


def _network_error(error: BaseException) -> str:
    reason = getattr(error, "reason", None) or error
    return f"API is not reachable: {reason}"[:300]
