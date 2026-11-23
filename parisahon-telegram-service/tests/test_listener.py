"""The listener's own rules (imported with the real Pyrogram of the image, no Telegram needed)."""
import asyncio
import os
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace as NS

import listener_session_string as listener
from helpers.message_handler import Message


class Errors(unittest.TestCase):
    def test_an_ended_session_is_told_from_a_network_error(self):
        from pyrogram.errors import AuthKeyUnregistered, SessionRevoked
        self.assertTrue(listener.is_revoked(AuthKeyUnregistered()))
        self.assertTrue(listener.is_revoked(SessionRevoked()))
        self.assertFalse(listener.is_revoked(TimeoutError()))
        self.assertFalse(listener.is_revoked(OSError("network")))

    def test_an_unknown_chat(self):
        from pyrogram.errors import PeerIdInvalid
        self.assertTrue(listener.is_unknown_peer(PeerIdInvalid()))
        self.assertTrue(listener.is_unknown_peer(KeyError(5)))
        self.assertFalse(listener.is_unknown_peer(TimeoutError()))


class LatePayload(unittest.TestCase):
    def test_a_send_nobody_waited_for_is_recorded_like_a_phone_message_with_its_deal(self):
        ctx = listener.ClientContext(5, "session_5", None, NS(id=500))
        message = Message(5, 777, "прайс во вложении", None, None, [], None, request_id="r1", deal_id=42)
        sent = [{"tg_message_id": 10, "file": {"name": "прайс.pdf", "path": "a.pdf", "type": "document", "caption": ""}},
                {"tg_message_id": 11, "file": None}]
        payload = listener.late_payload(ctx, message, sent)
        self.assertEqual((payload["agent_id"], payload["chat"], payload["tg_message_id"], payload["outgoing"], payload["deal_id"]),
                         (5, {"tg_id": 777}, 11, True, 42))
        self.assertEqual(payload["text"], "прайс во вложении")
        self.assertEqual([f["name"] for f in payload["files"]], ["прайс.pdf"])

    def test_only_files_went_out_the_text_is_not_claimed(self):
        ctx = listener.ClientContext(5, "session_5", None, NS(id=500))
        message = Message(5, 777, "текст", None, None, [], None, request_id="r2")
        payload = listener.late_payload(ctx, message, [{"tg_message_id": 10, "file": {"name": "a", "path": "a", "type": "photo"}}])
        self.assertEqual(payload["text"], "")
        self.assertIsNone(payload["deal_id"])


class FakeStorage:
    def __init__(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.execute("CREATE TABLE peers (id INTEGER PRIMARY KEY, access_hash INTEGER, type INTEGER NOT NULL, username TEXT, phone_number TEXT)")

    async def update_peers(self, peers):
        self.conn.executemany("REPLACE INTO peers (id, access_hash, type, username, phone_number) VALUES (?, ?, ?, ?, ?)", peers)


class Peers(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = listener.config.SERVICE_DB
        listener.config.SERVICE_DB = os.path.join(self.tmp.name, "svc.db")
        listener.init_db()

    def tearDown(self):
        listener.config.SERVICE_DB = self.saved
        self.tmp.cleanup()

    def test_the_chats_a_session_met_survive_a_restart(self):
        before = NS(storage=FakeStorage())
        before.storage.conn.execute("INSERT INTO peers VALUES (777, 123456, 'user', 'client', '998901234567')")
        before.storage.conn.execute("INSERT INTO peers VALUES (-100, 5, 'group', NULL, NULL)")
        ctx = listener.ClientContext(5, "session_5", before, NS(id=500))
        self.assertEqual(listener.save_peers(ctx), 1)
        after = NS(storage=FakeStorage())
        self.assertEqual(asyncio.run(listener.restore_peers(after, 5)), 1)
        self.assertEqual(after.storage.conn.execute("SELECT id, access_hash FROM peers").fetchall(), [(777, 123456)])
        self.assertEqual(asyncio.run(listener.restore_peers(NS(storage=FakeStorage()), 6)), 0)


if __name__ == "__main__":
    unittest.main()
