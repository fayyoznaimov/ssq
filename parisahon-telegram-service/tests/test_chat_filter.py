"""Unit tests of the chat filter and the payload for POST /telegram/incoming (no Telegram needed).
Run: local/dev/tg-venv/bin/python -m unittest discover -s parisahon-telegram-service/tests -t parisahon-telegram-service
"""
import datetime
import unittest
from types import SimpleNamespace as NS

from helpers.chat_filter import message_payload, reason_to_skip

ME = 500


def user(id, **kw):
    base = dict(id=id, is_bot=False, is_self=False, is_support=False, first_name="Имя", last_name=None,
                username=None, phone_number=None)
    base.update(kw)
    return NS(**base)


def msg(from_user=None, chat=None, outgoing=False, text="привет", **kw):
    base = dict(id=1, empty=False, service=None, outgoing=outgoing, text=text, caption=None,
                date=datetime.datetime(2026, 11, 18, 10, 0, 0), contact=None, location=None, voice=None,
                document=None, video=None, video_note=None, photo=None, sticker=None)
    base.update(kw)
    base["from_user"] = from_user
    base["chat"] = chat if chat is not None else NS(id=from_user.id if from_user else 1, type="ChatType.PRIVATE",
                                                    first_name="Имя", last_name=None, username=None)
    return NS(**base)


class FilterTest(unittest.TestCase):
    def test_private_chat_with_a_person_is_recorded(self):
        self.assertIsNone(reason_to_skip(msg(user(42)), ME))

    def test_outgoing_from_the_phone_is_recorded(self):
        m = msg(user(ME, is_self=True), chat=NS(id=42, type="ChatType.PRIVATE", first_name="Клиент"), outgoing=True)
        self.assertIsNone(reason_to_skip(m, ME))

    def test_login_code_from_telegram_is_skipped(self):
        self.assertEqual(reason_to_skip(msg(user(777000, is_support=False), text="Login code: 12345"), ME), "telegram service account")

    def test_support_account_is_skipped(self):
        self.assertEqual(reason_to_skip(msg(user(1234, is_support=True)), ME), "telegram service account")

    def test_bot_is_skipped(self):
        self.assertEqual(reason_to_skip(msg(user(99, is_bot=True)), ME), "bot")

    def test_group_is_skipped(self):
        m = msg(user(42), chat=NS(id=-100123, type="ChatType.SUPERGROUP"))
        self.assertEqual(reason_to_skip(m, ME), "not a private chat")

    def test_saved_messages_are_skipped(self):
        m = msg(user(ME, is_self=True), chat=NS(id=ME, type="ChatType.PRIVATE"), outgoing=True)
        self.assertEqual(reason_to_skip(m, ME), "saved messages")

    def test_service_message_is_skipped(self):
        self.assertEqual(reason_to_skip(msg(user(42), service="PINNED_MESSAGE"), ME), "service message")

    def test_message_without_text_or_media_is_skipped(self):
        self.assertEqual(reason_to_skip(msg(user(42), text=None), ME), "no text and no media")

    def test_media_without_text_is_recorded(self):
        self.assertIsNone(reason_to_skip(msg(user(42), text=None, photo=NS(file_id="x")), ME))


class PayloadTest(unittest.TestCase):
    def test_incoming_payload(self):
        m = msg(user(42, first_name="Анна", last_name="Клиент", phone_number="998901234567", username="anna"))
        payload, peer = message_payload(m, ME, 7, [])
        self.assertEqual(payload["agent_id"], 7)
        self.assertEqual(payload["agent_tg_id"], ME)
        self.assertEqual(payload["chat"], {"tg_id": 42, "phone": "+998901234567", "first_name": "Анна",
                                           "last_name": "Клиент", "username": "anna"})
        self.assertEqual(payload["tg_message_id"], 1)
        self.assertEqual(payload["text"], "привет")
        self.assertFalse(payload["outgoing"])
        # a naive local datetime leaves with its offset
        self.assertTrue(payload["date"].startswith("2026-11-18T10:00:00") and ("+" in payload["date"] or "-" in payload["date"][10:]), payload["date"])
        self.assertEqual(payload["files"], [])

    def test_outgoing_payload_uses_the_chat_as_peer(self):
        m = msg(user(ME, is_self=True), chat=NS(id=42, type="ChatType.PRIVATE", first_name="Клиент", last_name=None,
                                                username=None), outgoing=True, text="ответ")
        payload, _ = message_payload(m, ME, 7, [])
        self.assertTrue(payload["outgoing"])
        self.assertEqual(payload["chat"]["tg_id"], 42)
        self.assertEqual(payload["chat"]["phone"], None)

    def test_caption_becomes_text_and_files_are_listed(self):
        from helpers.file import File
        m = msg(user(42), text=None, caption="фото", photo=NS(file_id="x"))
        payload, _ = message_payload(m, ME, 7, [File("Photo", "/app/uploads/photo_abc.jpg", "photo", "фото"), None])
        self.assertEqual(payload["text"], "фото")
        self.assertEqual(payload["files"], [{"name": "Photo", "path": "photo_abc.jpg", "type": "photo", "caption": "фото"}])

    def test_contact_and_location(self):
        m = msg(user(42), contact=NS(phone_number="+998", first_name="К", user_id=5), location=NS(longitude=1.5, latitude=2.5))
        payload, _ = message_payload(m, ME, 7, [])
        self.assertEqual(payload["contact"]["tg_user_id"], 5)
        self.assertEqual(payload["location"], {"_": "Location", "longitude": 1.5, "latitude": 2.5})


if __name__ == "__main__":
    unittest.main()
