"""POST /resolve-phone: validation, the answers of the route, and the lookup with a fake Pyrogram client.
Run: local/dev/tg-venv/bin/python -m unittest discover -s parisahon-telegram-service/tests -t parisahon-telegram-service
"""
import asyncio
import time
import unittest
from unittest import mock

from helpers import phone_lookup
from helpers.phone_lookup import PhoneLookup, mask_phone, normalize_phone, parse_request


class ValidationTest(unittest.TestCase):
    def test_phone_is_normalized(self):
        self.assertEqual(normalize_phone("+998901234567"), "+998901234567")
        self.assertEqual(normalize_phone("998901234567"), "+998901234567")
        self.assertEqual(normalize_phone(" +998 (90) 123-45-67 "), "+998901234567")

    def test_malformed_phones(self):
        for bad in (None, "", "+", "abc", "+998abc1234", "+12345", "+1234567890123456", "++998901234567", 998901234567):
            self.assertIsNone(normalize_phone(bad), bad)

    def test_parse_request(self):
        before = time.time()
        req = parse_request({"user_id": "7", "phone": "+998 90 123 45 67", "first_name": "  Анна ", "last_name": ""},
                            timeout=20)
        self.assertEqual((req.user_id, req.phone, req.first_name, req.last_name), (7, "+998901234567", "Анна", None))
        self.assertGreaterEqual(req.deadline, before + 20)
        self.assertRegex(req.request_id, r"^[0-9a-f]{32}$")

    def test_long_name_is_cut_to_telegram_limit(self):
        req = parse_request({"user_id": 7, "phone": "+998901234567", "first_name": "я" * 100})
        self.assertEqual(len(req.first_name), 64)

    def test_bad_requests(self):
        for body in (None, [], "x", {}, {"phone": "+998901234567"}, {"user_id": True, "phone": "+998901234567"},
                     {"user_id": "abc", "phone": "+998901234567"}, {"user_id": -3, "phone": "+998901234567"},
                     {"user_id": 7}, {"user_id": 7, "phone": "12"}):
            with self.assertRaises(ValueError, msg=repr(body)):
                parse_request(body)

    def test_phone_is_masked_for_logs(self):
        self.assertEqual(mask_phone("+998901234567"), "+9989******67")
        self.assertNotIn("1234", mask_phone("+998901234567"))
        self.assertEqual(mask_phone(None), "")
        self.assertEqual(mask_phone("12345"), "*****")


class FakeQueue:
    """Stands in for the listener: answers every lookup at once (or never)."""

    def __init__(self, results, answer):
        self.results = results
        self.answer = answer
        self.items = []

    def put_nowait(self, item):
        self.items.append(item)
        if self.answer is not None:
            self.results[item.request_id] = self.answer


class RouteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import app as service  # starts a multiprocessing manager, nothing else
        cls.service = service
        cls.client = service.app.test_client()
        # the CRM API sends the shared token on every request (TG-15)
        service.config.HTTP_API_TOKEN = "test-service-token"
        cls.client.environ_base["HTTP_X_TELEGRAM_SERVICE_TOKEN"] = "test-service-token"

    def setUp(self):
        self.results = {}
        alive = mock.Mock()
        alive.is_alive.return_value = True
        self.patches = [
            mock.patch.object(self.service, "fetch_all_db_sessions", return_value=[{"user_id": 7, "name": "Manager"}]),
            mock.patch.object(self.service, "listener_process", alive),
            mock.patch.object(self.service, "send_results", self.results),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()

    def post(self, body, answer=None, **kwargs):
        queue = FakeQueue(self.results, answer)
        with mock.patch.object(self.service, "new_messages", queue):
            response = self.client.post("/resolve-phone", json=body, **kwargs)
        return response, queue

    def test_malformed_phone_is_400(self):
        response, queue = self.post({"user_id": 7, "phone": "+99890abc"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("message", response.get_json())
        self.assertEqual(queue.items, [])

    def test_missing_user_is_400(self):
        response, _ = self.post({"phone": "+998901234567"})
        self.assertEqual(response.status_code, 400)

    def test_not_json_is_400(self):
        response = self.client.post("/resolve-phone", data="phone=1", content_type="text/plain")
        self.assertEqual(response.status_code, 400)
        self.assertIn("message", response.get_json())

    def test_user_without_session_is_400(self):
        response, queue = self.post({"user_id": 8, "phone": "+998901234567"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("Telegram", response.get_json()["message"])
        self.assertEqual(queue.items, [])

    def test_listener_down_is_503(self):
        with mock.patch.object(self.service, "listener_process", None):
            response, _ = self.post({"user_id": 7, "phone": "+998901234567"})
        self.assertEqual(response.status_code, 503)

    def test_found(self):
        result = {"tg_id": 42, "username": "anna", "first_name": "Анна", "last_name": None, "photo": "ab12.jpg"}
        response, queue = self.post({"user_id": "7", "phone": "+998 90 123-45-67", "first_name": "Анна"},
                                    answer={"ok": True, "result": result})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), result)
        sent = queue.items[0]
        self.assertIsInstance(sent, PhoneLookup)
        self.assertEqual((sent.user_id, sent.phone, sent.first_name), (7, "+998901234567", "Анна"))
        self.assertEqual(self.results, {})  # the answer was taken

    def test_not_found_is_200_with_null_tg_id(self):
        response, _ = self.post({"user_id": 7, "phone": "+998901234567"},
                                answer={"ok": True, "result": dict(phone_lookup.NOT_FOUND)})
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.get_json()["tg_id"])
        self.assertIsNone(response.get_json()["photo"])

    def test_flood_wait_is_429(self):
        response, _ = self.post({"user_id": 7, "phone": "+998901234567"},
                                answer={"ok": False, "status": 429, "retry_after": 35, "message": "подождите"})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.get_json(), {"message": "подождите", "retry_after": 35})

    def test_no_answer_from_the_listener_is_503(self):
        with mock.patch.object(self.service, "RESOLVE_TIMEOUT_SEC", 0.3):
            response, _ = self.post({"user_id": 7, "phone": "+998901234567"}, answer=None)
        self.assertEqual(response.status_code, 503)


# ------------------------------------------------------------------ lookup() with a fake client

class FakeTelegram:
    """client.invoke(ImportContacts) as Telegram answers it: the user, nobody, a flood wait or the import limit."""

    def __init__(self, user=None, flood=None, retry=False, me_id=500):
        self.user = user
        self.flood = flood
        self.retry = retry
        self.me_id = me_id
        self.queries = []
        self.sleep_thresholds = []

    async def invoke(self, query, sleep_threshold=None, **kwargs):
        from pyrogram import raw
        from pyrogram.errors import FloodWait
        self.queries.append(query)
        self.sleep_thresholds.append(sleep_threshold)
        if self.flood:
            raise FloodWait(value=self.flood)
        contact = query.contacts[0]
        if self.retry:
            return raw.types.contacts.ImportedContacts(imported=[], popular_invites=[],
                                                       retry_contacts=[contact.client_id], users=[])
        if self.user is None:
            return raw.types.contacts.ImportedContacts(imported=[], popular_invites=[], retry_contacts=[], users=[])
        return raw.types.contacts.ImportedContacts(
            imported=[raw.types.ImportedContact(user_id=self.user.id, client_id=contact.client_id)],
            popular_invites=[], retry_contacts=[], users=[self.user])


def raw_user(id=42, photo=False, **kw):
    from pyrogram import raw
    fields = dict(id=id, access_hash=777, first_name="Анна", last_name="Клиент", username="anna", phone="998901234567",
                  restriction_reason=[])  # as Pyrogram reads it from Telegram: an empty vector, not None
    fields.update(kw)
    if photo:
        fields["photo"] = raw.types.UserProfilePhoto(photo_id=123456, dc_id=2)
    return raw.types.User(**fields)


class LookupTest(unittest.TestCase):
    def run_lookup(self, telegram, first_name=None, downloaded="cafe.jpg"):
        downloads = []

        async def download(client, chat_photo):
            downloads.append(chat_photo)
            return downloaded

        req = PhoneLookup(user_id=7, phone="+998901234567", first_name=first_name)
        answer = asyncio.run(phone_lookup.lookup(telegram, telegram.me_id, req, download))
        return answer, downloads

    def test_found_with_photo(self):
        telegram = FakeTelegram(user=raw_user(photo=True))
        answer, downloads = self.run_lookup(telegram, first_name="Анна")
        self.assertEqual(answer, {"ok": True, "result": {"tg_id": 42, "username": "anna", "first_name": "Анна",
                                                         "last_name": "Клиент", "photo": "cafe.jpg"}})
        self.assertEqual(len(downloads), 1)
        contact = telegram.queries[0].contacts[0]
        self.assertEqual((contact.phone, contact.first_name), ("+998901234567", "Анна"))
        self.assertEqual(telegram.sleep_thresholds, [0])  # never sleeps through a FloodWait

    def test_contact_is_named_by_the_phone_when_no_name_is_given(self):
        telegram = FakeTelegram(user=raw_user())
        answer, downloads = self.run_lookup(telegram)
        self.assertEqual(telegram.queries[0].contacts[0].first_name, "+998901234567")
        self.assertIsNone(answer["result"]["photo"])
        self.assertEqual(downloads, [])

    def test_failed_photo_download_still_answers(self):
        answer, _ = self.run_lookup(FakeTelegram(user=raw_user(photo=True)), downloaded=None)
        self.assertEqual(answer["result"]["tg_id"], 42)
        self.assertIsNone(answer["result"]["photo"])

    def test_no_telegram_or_hidden_by_privacy(self):
        answer, _ = self.run_lookup(FakeTelegram(user=None))
        self.assertEqual(answer, {"ok": True, "result": phone_lookup.NOT_FOUND})

    def test_own_number_is_not_a_client(self):
        answer, _ = self.run_lookup(FakeTelegram(user=raw_user(id=500, is_self=True)))
        self.assertIsNone(answer["result"]["tg_id"])

    def test_flood_wait_is_429_with_seconds(self):
        answer, _ = self.run_lookup(FakeTelegram(flood=35))
        self.assertEqual((answer["ok"], answer["status"], answer["retry_after"]), (False, 429, 35))

    def test_import_limit_is_429(self):
        answer, _ = self.run_lookup(FakeTelegram(retry=True))
        self.assertEqual((answer["ok"], answer["status"]), (False, 429))


if __name__ == "__main__":
    unittest.main()
