"""POST /resolve-name: validation, the answers of the route, and the lookup with a fake Pyrogram client.
Run: local/dev/tg-venv/bin/python -m unittest discover -s parisahon-telegram-service/tests -t parisahon-telegram-service
"""
import asyncio
import unittest
from types import SimpleNamespace
from unittest import mock

from pyrogram import enums
from pyrogram.errors import FloodWait

from helpers import name_lookup
from helpers.name_lookup import NameLookup, names_of, normalize, parse_request


def person(id, first=None, last=None, phone=None, username=None, **more):
    return SimpleNamespace(id=id, first_name=first, last_name=last, phone_number=phone, username=username, **more)


class FakeClient:
    def __init__(self, contacts=(), chats=(), error=None):
        self.contacts, self.chats, self.error = list(contacts), list(chats), error
        self.dialogs_read = False

    async def get_contacts(self):
        if self.error:
            raise self.error
        return self.contacts

    async def get_dialogs(self, limit=0):
        self.dialogs_read = True
        for chat in self.chats[:limit]:
            yield SimpleNamespace(chat=chat)


def run(client, name, me_id=1):
    return asyncio.run(name_lookup.lookup(client, me_id, NameLookup(7, name)))


class NamesTest(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(normalize("  Анвар   ОПТОВИК "), "анвар оптовик")
        self.assertEqual(normalize(None), "")
        self.assertEqual(normalize(5), "")

    def test_names_of(self):
        self.assertEqual(names_of("Анвар", "Оптовик"), {"анвар оптовик", "оптовик анвар"})
        self.assertEqual(names_of("Anvar", None), {"anvar"})
        self.assertEqual(names_of(None, None), set())

    def test_parse_request(self):
        req = parse_request({"user_id": "7", "name": "  Анвар Оптовик "})
        self.assertEqual((req.user_id, req.name), (7, "Анвар Оптовик"))
        for body in (None, [], {}, {"user_id": 7}, {"user_id": 7, "name": "  "}, {"user_id": 7, "name": 5},
                     {"user_id": True, "name": "x"}, {"name": "x"}, {"user_id": 7, "name": "я" * 300}):
            with self.assertRaises(ValueError, msg=repr(body)):
                parse_request(body)


class LookupTest(unittest.TestCase):
    def test_contact_by_the_saved_name(self):
        client = FakeClient(contacts=[person(10, "Anvar"), person(11, "Анвар", "Оптовик", phone="998901234567", username="anvar")])
        answer = run(client, "анвар  оптовик")
        self.assertEqual(answer, {"ok": True, "result": {"matches": [
            {"tg_id": 11, "phone": "+998901234567", "username": "anvar", "first_name": "Анвар", "last_name": "Оптовик"}]}})
        self.assertFalse(client.dialogs_read)

    def test_chats_are_read_only_when_no_contact_matches(self):
        private, group = enums.ChatType.PRIVATE, enums.ChatType.GROUP
        client = FakeClient(contacts=[person(10, "Anvar")],
                            chats=[person(20, "Анвар", "Оптовик", type=group), person(21, "Анвар", "Оптовик", type=private)])
        answer = run(client, "Анвар Оптовик")
        self.assertEqual([m["tg_id"] for m in answer["result"]["matches"]], [21])
        self.assertIsNone(answer["result"]["matches"][0]["phone"])

    def test_namesakes_are_all_returned_self_bots_and_deleted_are_not(self):
        client = FakeClient(contacts=[person(1, "Али"), person(2, "Али"), person(3, "Али"), person(4, "Али", is_bot=True),
                                      person(5, "Али", is_deleted=True)])
        self.assertEqual([m["tg_id"] for m in run(client, "али", me_id=1)["result"]["matches"]], [2, 3])

    def test_nobody(self):
        self.assertEqual(run(FakeClient(contacts=[person(10, "Anvar")]), "Кто-то"), {"ok": True, "result": {"matches": []}})

    def test_flood_wait_is_429(self):
        answer = run(FakeClient(error=FloodWait(33)), "Анвар")
        self.assertEqual((answer["ok"], answer["status"], answer["retry_after"]), (False, 429, 33))


class RouteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import app as service  # starts a multiprocessing manager, nothing else
        cls.service = service
        cls.client = service.app.test_client()
        # the CRM API sends the shared token on every request (TG-15)
        service.config.HTTP_API_TOKEN = "test-service-token"
        cls.client.environ_base["HTTP_X_TELEGRAM_SERVICE_TOKEN"] = "test-service-token"

    def post(self, body, answer=None, sessions=({"user_id": 7, "name": "Manager"},)):
        results, items = {}, []

        class Queue:
            def put_nowait(self, item):
                items.append(item)
                if answer is not None:
                    results[item.request_id] = answer

        alive = mock.Mock()
        alive.is_alive.return_value = True
        with mock.patch.object(self.service, "fetch_all_db_sessions", return_value=list(sessions)), \
                mock.patch.object(self.service, "listener_process", alive), \
                mock.patch.object(self.service, "send_results", results), \
                mock.patch.object(self.service, "new_messages", Queue()), \
                mock.patch.object(self.service, "RESOLVE_TIMEOUT_SEC", 0.5):
            return self.client.post("/resolve-name", json=body), items

    def test_matches_are_answered(self):
        matches = [{"tg_id": 11, "phone": None, "username": None, "first_name": "Анвар", "last_name": "Оптовик"}]
        response, items = self.post({"user_id": 7, "name": "Анвар Оптовик"}, {"ok": True, "result": {"matches": matches}})
        self.assertEqual((response.status_code, response.get_json()), (200, {"matches": matches}))
        self.assertIsInstance(items[0], NameLookup)

    def test_bad_request_and_no_session_are_400(self):
        self.assertEqual(self.post({"user_id": 7})[0].status_code, 400)
        response, items = self.post({"user_id": 8, "name": "Анвар"})
        self.assertEqual((response.status_code, items), (400, []))

    def test_flood_wait_is_passed_on(self):
        response, _ = self.post({"user_id": 7, "name": "Анвар"}, {"ok": False, "status": 429, "retry_after": 5, "message": "x"})
        self.assertEqual((response.status_code, response.get_json()["retry_after"]), (429, 5))

    def test_no_answer_is_503(self):
        self.assertEqual(self.post({"user_id": 7, "name": "Анвар"})[0].status_code, 503)


if __name__ == "__main__":
    unittest.main()
