"""The outbox: a message the API cannot take now is delivered later, in order; a refused one is dropped."""
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from helpers.api_client import CrmApi


class FakeApi(BaseHTTPRequestHandler):
    status = 503
    received = []
    tokens = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        FakeApi.received.append(body)
        FakeApi.tokens.append(self.headers.get("X-Telegram-Service-Token"))
        status = FakeApi.status(body) if callable(FakeApi.status) else FakeApi.status
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"status": "saved" if status == 200 else "error", "deal_ids": [1]}).encode())

    def log_message(self, *args):
        pass


class OutboxTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeApi)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/api/v1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeApi.received = []
        FakeApi.tokens = []
        FakeApi.status = 200
        self.tmp = tempfile.TemporaryDirectory()
        self.api = CrmApi(self.url, "secret-token", os.path.join(self.tmp.name, "svc.db"), timeout=5)

    def tearDown(self):
        self.tmp.cleanup()

    def test_delivered_at_once_with_the_token(self):
        result = self.api.deliver({"tg_message_id": 1})
        self.assertEqual(result["status"], "saved")
        self.assertEqual(FakeApi.tokens, ["secret-token"])
        self.assertEqual(self.api.outbox_size(), 0)

    def test_unavailable_api_queues_and_flush_keeps_order(self):
        FakeApi.status = 503
        self.assertIsNone(self.api.deliver({"tg_message_id": 1}))
        self.assertIsNone(self.api.deliver({"tg_message_id": 2}))
        self.assertEqual(self.api.outbox_size(), 2)
        FakeApi.status = 200
        # a new message while the queue is not empty goes behind the queued ones
        self.assertIsNone(self.api.deliver({"tg_message_id": 3}))
        self.assertEqual(self.api.outbox_size(), 0)
        delivered = [b["tg_message_id"] for b in FakeApi.received if b["tg_message_id"] in (1, 2, 3)]
        # the first two attempts failed (1, 2), then 1, 2, 3 were delivered in order
        self.assertEqual(delivered[-3:], [1, 2, 3])

    def test_network_error_queues(self):
        api = CrmApi("http://127.0.0.1:9/api/v1", "secret-token", os.path.join(self.tmp.name, "svc2.db"), timeout=2)
        self.assertIsNone(api.deliver({"tg_message_id": 5}))
        self.assertEqual(api.outbox_size(), 1)

    def test_refused_message_is_dropped_not_retried(self):
        FakeApi.status = 400
        self.assertIsNone(self.api.deliver({"tg_message_id": 9}))
        self.assertEqual(self.api.outbox_size(), 0)

    def test_flush_stops_at_the_first_failure(self):
        FakeApi.status = 503
        self.api.deliver({"tg_message_id": 1})
        self.api.deliver({"tg_message_id": 2})
        FakeApi.status = lambda body: 503 if body["tg_message_id"] == 2 else 200
        self.assertEqual(self.api.flush(), 1)
        self.assertEqual(self.api.outbox_size(), 1)
        attempts = self.api.db.execute("SELECT attempts FROM outbox").fetchone()[0]
        self.assertEqual(attempts, 1)

    def test_missing_token_means_unavailable(self):
        api = CrmApi(self.url, "", os.path.join(self.tmp.name, "svc3.db"))
        self.assertIsNone(api.deliver({"tg_message_id": 7}))
        self.assertEqual(api.outbox_size(), 1)
        self.assertEqual(FakeApi.received, [])


if __name__ == "__main__":
    unittest.main()
