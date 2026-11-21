"""Stand-in for the Anthropic Messages API, for local tests without a key.

POST /v1/messages answers with a canned recognition result and stores the
last request body (minus the image bytes) in /tmp/last_request.json so tests
can check what the CRM actually sent. The canned answer is chosen by the
text "MOCK:<name>" in the file name... no: by the image size, see SCENARIOS.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

CARD = {
    "document_type": "company_card",
    "company": {
        "name": "ООО \"AUDIT Textile Test\"",
        "inn": "305 123 456",
        "legal_address": "г. Ташкент, Чиланзарский р-н, ул. Тестовая, 1",
        "bank_account": "2020 8000 9051 2345 6001",
        "bank_name": "АКБ \"Тест Банк\"",
        "mfo": "00440",
        "oked": "13920",
        "director": "Тестов Тест Тестович",
        "phone": "+998 71 200 00 00",
        "email": "INFO@audit-textile.example",
    },
    "contacts": [
        {"full_name": "Аудитова Анна", "position": "Закупщик", "phone": "+998 90 123 45 67", "email": "anna@audit-textile.example"},
        {"full_name": None, "position": None, "phone": None, "email": None},
    ],
    "unclear_fields": ["company.oked"],
    "notes": None,
}

BAD = {
    "document_type": "company_card",
    "company": {"name": "AUDIT Bad Card", "inn": "12345", "legal_address": None, "bank_account": "123", "bank_name": None,
                "mfo": None, "oked": None, "director": None, "phone": None, "email": "not-an-email"},
    "contacts": [],
    "unclear_fields": [],
    "notes": None,
}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        image_len = 0
        for m in body.get("messages", []):
            for block in m.get("content", []) if isinstance(m.get("content"), list) else []:
                src = block.get("source", {})
                if "data" in src:
                    image_len = len(src["data"])
                    src["data"] = f"<{image_len} base64 chars>"
        with open("/tmp/last_request.json", "w", encoding="utf-8") as f:
            json.dump({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items() if k.lower() in ("anthropic-beta", "anthropic-version", "x-api-key")}, "body": body}, f, ensure_ascii=False)

        # Tiny images (< 200 base64 chars) get the "bad card" answer
        answer = BAD if image_len < 200 else CARD
        resp = {
            "id": "msg_mock", "type": "message", "role": "assistant", "model": body.get("model"),
            "content": [{"type": "text", "text": json.dumps(answer, ensure_ascii=False)}],
            "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 10, "output_tokens": 10},
        }
        data = json.dumps(resp, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/last":
            try:
                data = open("/tmp/last_request.json", "rb").read()
            except FileNotFoundError:
                data = b"{}"
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_response(404)
            self.end_headers()


HTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8000"))), Handler).serve_forever()
