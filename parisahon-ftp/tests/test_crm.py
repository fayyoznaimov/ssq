import os
import tempfile
import unittest

from helpers import CUBE_NAME, FakeApi, dead_url, read, write
from crm import CrmApi, error_text


class CrmApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fake = FakeApi()
        self.addCleanup(self.fake.stop)
        self.fake.tokens["rec_" + "a" * 48] = (5, "Алишер")
        self.api = CrmApi(self.fake.url, self.fake.service_token, timeout=5, upload_timeout=10)
        self.audio = write(os.path.join(self.tmp.name, CUBE_NAME), b"RIFF" + os.urandom(3000))

    # ---------------------------------------------------------------- GET /calls/recorder

    def test_recorder_ok(self):
        answer = self.api.recorder("rec_" + "a" * 48)
        self.assertEqual((answer.kind, answer.user_id, answer.username), ("ok", 5, "Алишер"))

    def test_recorder_unknown_token_is_denied(self):
        self.assertEqual(self.api.recorder("rec_" + "b" * 48).kind, "denied")

    def test_recorder_route_missing_or_broken_is_unavailable_not_denied(self):
        for status in (404, 500, 403):
            self.fake.recorder_status = status
            answer = self.api.recorder("rec_" + "a" * 48)
            self.assertEqual(answer.kind, "unavailable", status)
            self.assertIn(str(status), answer.detail)

    def test_recorder_network_error_is_unavailable(self):
        answer = CrmApi(dead_url(), "x", timeout=2).recorder("rec_" + "a" * 48)
        self.assertEqual(answer.kind, "unavailable")
        self.assertNotIn("rec_", answer.detail)

    # ---------------------------------------------------------------- POST /calls/upload

    def test_upload_sends_the_file_under_its_own_name(self):
        result = self.api.upload(5, self.audio, CUBE_NAME, recorded_at_ms=1795255392000)
        self.assertEqual((result.kind, result.status, result.duplicate), ("sent", 201, False))
        upload = self.fake.uploads[0]
        self.assertEqual(result.upload_id, upload["id"])
        self.assertEqual(upload["file_name"], CUBE_NAME, "Cyrillic and the arrow arrive as UTF-8")
        self.assertEqual(upload["user_id"], 5)
        self.assertEqual(upload["recorded_at"], "1795255392000")
        self.assertEqual(upload["data"], read(self.audio))
        self.assertIsNone(upload["meta"])
        self.assertEqual(self.fake.seen_headers[0]["X-Calls-Service-Token"], self.fake.service_token)

    def test_upload_without_recorded_at_and_with_meta(self):
        meta = write(os.path.join(self.tmp.name, "call.json"), '{"duration":"71825","callee":"+998900000000","direction":"Incoming"}'.encode())
        result = self.api.upload(5, self.audio, "call.wav", meta_path=meta)
        self.assertEqual(result.kind, "sent")
        upload = self.fake.uploads[0]
        self.assertIsNone(upload["recorded_at"])
        self.assertEqual(upload["meta"], ("call.json", read(meta)))

    def test_big_file_is_streamed_whole(self):
        big = write(os.path.join(self.tmp.name, "big.m4a"), os.urandom(3 * 1024 * 1024 + 17))
        self.assertEqual(self.api.upload(5, big, "big.m4a").kind, "sent")
        self.assertEqual(self.fake.uploads[0]["data"], read(big))

    def test_repeated_content_is_a_success_marked_duplicate(self):
        first = self.api.upload(5, self.audio, "a.wav")
        again = self.api.upload(5, self.audio, "b.wav")
        self.assertEqual((again.kind, again.duplicate, again.upload_id), ("sent", True, first.upload_id))

    def test_quote_in_the_name_does_not_break_the_request(self):
        self.assertEqual(self.api.upload(5, self.audio, 'say "hi".wav').kind, "sent")
        self.assertEqual(self.fake.uploads[0]["file_name"], "say %22hi%22.wav")

    def test_bad_file_answers_are_rejected_with_the_api_words(self):
        for status in (400, 413, 415):
            self.fake.upload_statuses = [status]
            result = self.api.upload(5, self.audio, "a.wav")
            self.assertEqual((result.kind, result.status, result.error), ("rejected", status, f"forced {status}"))
        text = write(os.path.join(self.tmp.name, "notes.txt"), b"hello")
        result = self.api.upload(5, text, "notes.txt")
        self.assertEqual((result.kind, result.error), ("rejected", 'Unsupported audio file "notes.txt"'))

    def test_wrong_service_token_is_auth(self):
        result = CrmApi(self.fake.url, "wrong-token", timeout=5).upload(5, self.audio, "a.wav")
        self.assertEqual((result.kind, result.status), ("auth", 401))
        self.fake.upload_statuses = [403]
        self.assertEqual(self.api.upload(5, self.audio, "a.wav").kind, "auth")
        self.assertEqual(self.fake.uploads, [])

    def test_server_errors_and_unknown_answers_are_retried(self):
        for status in (500, 502, 404, 429):
            self.fake.upload_statuses = [status]
            result = self.api.upload(5, self.audio, "a.wav")
            self.assertEqual((result.kind, result.status), ("retry", status))
            self.assertIn(f"HTTP {status}", result.error)

    def test_network_error(self):
        result = CrmApi(dead_url(), "x", timeout=2, upload_timeout=2).upload(5, self.audio, "a.wav")
        self.assertEqual(result.kind, "network")
        self.assertIn("not reachable", result.error)

    def test_vanished_file_is_tried_later(self):
        result = self.api.upload(5, os.path.join(self.tmp.name, "gone.wav"), "gone.wav")
        self.assertEqual((result.kind, result.status), ("retry", 0))
        self.assertEqual(self.fake.posts, 0)

    def test_error_text(self):
        self.assertEqual(error_text(400, b'{"statusCode":400,"message":["a","b"]}'), "a; b")
        self.assertEqual(error_text(502, b"<html>\n<h1>Bad  Gateway</h1></html>"), "<html> <h1>Bad Gateway</h1></html>")
        self.assertEqual(error_text(500, b""), "HTTP 500")


if __name__ == "__main__":
    unittest.main()
