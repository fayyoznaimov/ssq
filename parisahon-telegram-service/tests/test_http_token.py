"""TG-15: the service's HTTP API answers only to the CRM API (the shared token), /health stays open."""
import unittest
from unittest import mock


class TokenTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import app as service  # starts a multiprocessing manager, nothing else
        cls.service = service
        cls.saved = service.config.HTTP_API_TOKEN
        service.config.HTTP_API_TOKEN = "test-service-token"
        cls.client = service.app.test_client()

    @classmethod
    def tearDownClass(cls):
        cls.service.config.HTTP_API_TOKEN = cls.saved

    def test_no_token_is_401_everywhere(self):
        for method, path in (("get", "/get-sessions"), ("post", "/new-message"), ("post", "/send-code"),
                             ("post", "/resolve-phone"), ("get", "/download?user_id=1&chat_id=1&message_id=1"), ("post", "/logout")):
            response = getattr(self.client, method)(path, json={})
            self.assertEqual(response.status_code, 401, path)

    def test_a_wrong_token_is_401(self):
        response = self.client.get("/get-sessions", headers={"X-Telegram-Service-Token": "test-service-tokeX"})
        self.assertEqual(response.status_code, 401)

    def test_the_right_token_passes(self):
        with mock.patch.object(self.service, "fetch_all_db_sessions", return_value=[]):
            response = self.client.get("/get-sessions", headers={"X-Telegram-Service-Token": "test-service-token"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), [])

    def test_health_needs_no_token_and_tells_the_states(self):
        rows = [{"user_id": 5, "status": "connected"}, {"user_id": 7, "status": "revoked", "since": 1.0, "error": "AuthKeyUnregistered"}]
        alive = mock.Mock()
        alive.is_alive.return_value = True
        with mock.patch.object(self.service, "fetch_all_db_sessions", return_value=rows), \
                mock.patch.object(self.service, "listener_process", alive):
            response = self.client.get("/health")
        body = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual((body["sessions"], body["connected"]), (2, 1))
        self.assertEqual(body["states"], {"5": "connected", "7": "revoked"})
        self.assertEqual([p["user_id"] for p in body["problems"]], [7])

    def test_a_send_that_failed_on_the_managers_side_is_400(self):
        # OMNI-9: the CRM shows the reason under the composer and keeps the text; 502 is for Telegram refusing
        with self.service.app.app_context():
            for reason, status in (("Ваш Telegram не подключён к CRM: подключите его в разделе «Телеграм» и отправьте ещё раз", 400),
                                   ("Ваш Telegram сейчас не на связи с CRM: сообщение не отправлено, попробуйте через минуту", 400),
                                   ("Ваш Telegram отключён в самом Telegram (сеанс завершён)", 400),
                                   ("FloodWait", 502)):
                _, code = self.service.send_answer({"ok": False, "reason": reason, "sent": []})
                self.assertEqual(code, status, reason)

    def test_without_any_token_configured_everything_is_closed(self):
        with mock.patch.object(self.service.config, "HTTP_API_TOKEN", ""):
            response = self.client.get("/get-sessions", headers={"X-Telegram-Service-Token": ""})
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
