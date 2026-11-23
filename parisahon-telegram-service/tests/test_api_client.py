"""The outbox: a message the API cannot take now is delivered later, in order; a refused one is kept aside."""
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

    def test_refused_message_is_kept_aside_not_retried(self):
        FakeApi.status = 400
        self.assertIsNone(self.api.deliver({"tg_message_id": 9}))
        self.assertEqual(self.api.outbox_size(), 0)
        rows = self.api.db.execute("SELECT payload, status FROM rejected").fetchall()
        self.assertEqual([(json.loads(p)["tg_message_id"], s) for p, s in rows], [(9, 400)])
        self.assertEqual(self.api.stats()["rejected"], 1)

    def test_a_wrong_token_keeps_the_messages(self):
        # 401: the service and the API disagree about the token (a deploy mistake): nothing may be lost
        FakeApi.status = 401
        self.assertIsNone(self.api.deliver({"tg_message_id": 11}))
        self.assertEqual(self.api.outbox_size(), 1)
        self.assertEqual(self.api.stats()["rejected"], 0)
        FakeApi.status = 200
        self.assertEqual(self.api.flush(), 1)
        self.assertEqual(self.api.outbox_size(), 0)

    def test_a_message_that_fails_with_500_does_not_block_the_others(self):
        FakeApi.status = lambda body: 500 if body["tg_message_id"] == 1 else 200
        self.assertIsNone(self.api.deliver({"tg_message_id": 1}))
        self.assertEqual(self.api.outbox_size(), 1)
        # the next message goes through the queue, past the one waiting for its retry
        self.assertIsNone(self.api.deliver({"tg_message_id": 2}))
        self.assertIn(2, [b["tg_message_id"] for b in FakeApi.received])
        self.assertEqual(self.api.outbox_size(), 1)

    def test_a_message_failing_with_500_again_and_again_is_kept_aside(self):
        from helpers import api_client
        FakeApi.status = 500
        self.api.deliver({"tg_message_id": 3})
        for _ in range(api_client.MAX_FAILED_ATTEMPTS + 1):
            self.api.db.execute("UPDATE outbox SET next_at = 0")
            self.api.flush()
        self.assertEqual(self.api.outbox_size(), 0)
        self.assertEqual(self.api.stats()["rejected"], 1)

    def test_stats_tell_how_long_messages_wait(self):
        FakeApi.status = 503
        self.api.deliver({"tg_message_id": 4})
        stats = self.api.stats()
        self.assertEqual(stats["outbox"], 1)
        self.assertGreaterEqual(stats["outbox_oldest_sec"], 0)

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
