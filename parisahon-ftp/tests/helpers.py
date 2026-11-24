"""Shared by the tests: a stand-in for the CRM API (http.server) and small file helpers."""
import hashlib
import json
import logging
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SERVICE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SERVICE_DIR not in sys.path:
    sys.path.insert(0, SERVICE_DIR)

# the tests look at the log lines themselves (assertLogs); nothing is printed in between
logging.getLogger().addHandler(logging.NullHandler())

AUDIO = (".amr", ".mp3", ".m4a", ".wav", ".ogg", ".aac", ".3gp")
CUBE_NAME = "2026-11-21 14-03-12 (phone) Феруз Клиент (+998 90 000-00-00) ↗.wav"


def parse_multipart(content_type: str, body: bytes):
    """-> (fields {name: text}, files {name: (file name, bytes)}); names are read as UTF-8."""
    boundary = re.search(r'boundary=([^;]+)', content_type).group(1).strip('"').encode()
    fields, files = {}, {}
    for part in body.split(b"--" + boundary)[1:]:
        if part.startswith(b"--"):
            break
        head, _, data = part.lstrip(b"\r\n").partition(b"\r\n\r\n")
        data = data[:-2] if data.endswith(b"\r\n") else data
        disposition = next(line for line in head.decode("utf-8").split("\r\n") if line.lower().startswith("content-disposition"))
        name = re.search(r'\bname="([^"]*)"', disposition).group(1)
        file_name = re.search(r'\bfilename="([^"]*)"', disposition)
        if file_name:
            files[name] = (file_name.group(1), data)
        else:
            fields[name] = data.decode("utf-8")
    return fields, files


class FakeApi:
    """GET /calls/recorder and POST /calls/upload as the contract describes them."""

    def __init__(self, service_token="service-token-0123456789"):
        self.service_token = service_token
        self.tokens = {}            # recorder token -> (user id, CRM name[, FTPS only])
        self.uploads = []           # what reached the queue: dicts
        self.posts = 0              # every POST /calls/upload, whatever the answer
        self.recorder_calls = 0
        self.recorder_status = None  # answer GET /calls/recorder with this status instead
        self.upload_statuses = []   # answer the next uploads with these statuses (then normally again)
        self.seen_headers = []
        self._by_content = {}
        self._next_id = 100
        self._lock = threading.Lock()
        api = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def answer(self, status, data):
                body = json.dumps(data).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path != "/api/v1/calls/recorder":
                    return self.answer(404, {"statusCode": 404, "message": "Cannot GET " + self.path})
                with api._lock:
                    api.recorder_calls += 1
                    forced = api.recorder_status
                    who = api.tokens.get(self.headers.get("X-Recorder-Token", ""))
                if forced:
                    return self.answer(forced, {"statusCode": forced, "message": "forced"})
                if not who:
                    return self.answer(401, {"statusCode": 401, "message": "Unauthorized"})
                self.answer(200, {"user_id": who[0], "username": who[1], "tls_required": bool(who[2]) if len(who) > 2 else False})

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                if self.path != "/api/v1/calls/upload":
                    return self.answer(404, {"statusCode": 404, "message": "Cannot POST " + self.path})
                with api._lock:
                    api.posts += 1
                    api.seen_headers.append(dict(self.headers.items()))
                    forced = api.upload_statuses.pop(0) if api.upload_statuses else None
                if self.headers.get("X-Calls-Service-Token") != api.service_token:
                    return self.answer(401, {"statusCode": 401, "message": "Unauthorized"})
                if forced:
                    return self.answer(forced, {"statusCode": forced, "message": f"forced {forced}"})
                fields, files = parse_multipart(self.headers["Content-Type"], body)
                if "file" not in files:
                    return self.answer(400, {"statusCode": 400, "message": 'No audio file: send it as the multipart field "file"'})
                name, data = files["file"]
                if os.path.splitext(name)[1].lower() not in AUDIO:
                    return self.answer(415, {"statusCode": 415, "message": f'Unsupported audio file "{name}"'})
                user_id = int(fields["user_id"])
                key = (user_id, hashlib.sha256(data).hexdigest())
                with api._lock:
                    if key in api._by_content:
                        return self.answer(200, {"id": api._by_content[key], "status": "pending", "user_id": user_id, "duplicate": True})
                    api._next_id += 1
                    api._by_content[key] = api._next_id
                    api.uploads.append({
                        "id": api._next_id, "user_id": user_id, "file_name": name, "data": data,
                        "recorded_at": fields.get("recorded_at"), "meta": files.get("meta"),
                    })
                    upload_id = api._next_id
                self.answer(201, {"id": upload_id, "status": "pending", "user_id": user_id})

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.port = self._server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}/api/v1"
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self._thread.start()

    def stop(self):
        self._server.shutdown()
        self._server.server_close()

    def names(self):
        return [upload["file_name"] for upload in self.uploads]


def write(path: str, data: bytes, mtime: float = None) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def read(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read()


def dead_url() -> str:
    """An address nothing listens on."""
    import socket
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    return f"http://127.0.0.1:{port}/api/v1"
