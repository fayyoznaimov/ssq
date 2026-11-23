"""The state of the sessions (/get-sessions, /health), long texts and edits (no Telegram needed)."""
import datetime
import os
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace as NS

from helpers import session_state
from helpers.chat_filter import message_payload, reason_to_skip
from helpers.message_handler import split_text


class SessionStateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "svc.db")
        conn = sqlite3.connect(self.db)
        conn.execute("CREATE TABLE sessions (id INTEGER PRIMARY KEY, user_id INTEGER, name VARCHAR(255), session_string TEXT)")
        conn.execute("INSERT INTO sessions (user_id, name, session_string) VALUES (5, 'session_5', 'x'), (7, 'session_7', 'y')")
        conn.commit()
        conn.close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_old_rows_get_the_state_columns_and_start_as_starting(self):
        rows = session_state.merged(session_state.stored_rows(self.db), {})
        self.assertEqual([(r["user_id"], r["status"]) for r in rows], [(5, "starting"), (7, "starting")])

    def test_a_revoked_session_is_remembered_across_a_restart(self):
        session_state.persist(self.db, 7, "revoked", "AuthKeyUnregistered", 1000.0, session_state.string_hash("y"))
        rows = session_state.merged(session_state.stored_rows(self.db), {})
        self.assertEqual({r["user_id"]: r["status"] for r in rows}, {5: "starting", 7: "revoked"})
        health = session_state.health(rows)
        self.assertEqual(health["sessions"], 2)
        self.assertEqual(health["connected"], 0)
        self.assertEqual([p["user_id"] for p in health["problems"]], [7])

    def test_the_live_state_wins(self):
        live = {5: {"status": "connected", "since": 1.0, "tg_id": 42, "username": "manager"}}
        rows = session_state.merged(session_state.stored_rows(self.db), live)
        row = next(r for r in rows if r["user_id"] == 5)
        self.assertEqual((row["status"], row["tg_id"], row["username"]), ("connected", 42, "manager"))
        self.assertEqual(session_state.health(rows)["connected"], 1)

    def test_the_hash_changes_with_a_new_session(self):
        self.assertNotEqual(session_state.string_hash("a"), session_state.string_hash("b"))


class TextTest(unittest.TestCase):
    def test_short_text_is_one_message(self):
        self.assertEqual(split_text("привет"), ["привет"])
        self.assertEqual(split_text(""), [])

    def test_long_text_goes_in_parts_of_at_most_4096(self):
        text = ("строка прайса " * 40 + "\n") * 30
        parts = split_text(text)
        self.assertGreater(len(parts), 1)
        self.assertTrue(all(len(p) <= 4096 for p in parts))
        self.assertEqual("".join(parts).replace("\n", "").replace(" ", ""), text.replace("\n", "").replace(" ", ""))


def msg(**kw):
    base = dict(id=9, empty=False, service=None, outgoing=False, text=None, caption=None,
                date=datetime.datetime(2026, 11, 18, 10, 0, 0), contact=None, location=None, voice=None, audio=None,
                animation=None, document=None, video=None, video_note=None, photo=None, sticker=None)
    base.update(kw)
    person = NS(id=42, is_bot=False, is_self=False, is_support=False, first_name="Имя", last_name=None, username=None, phone_number=None)
    base["from_user"] = person
    base["chat"] = NS(id=42, type="ChatType.PRIVATE", first_name="Имя", last_name=None, username=None)
    return NS(**base)


class MediaFilterTest(unittest.TestCase):
    def test_audio_and_gif_with_a_caption_are_recorded(self):
        self.assertIsNone(reason_to_skip(msg(audio=NS(file_id="a")), 500))
        self.assertIsNone(reason_to_skip(msg(animation=NS(file_id="g"), caption="смотрите"), 500))

    def test_an_edit_is_marked(self):
        payload, _ = message_payload(msg(text="исправленный заказ"), 500, 3, [], edited=True)
        self.assertTrue(payload["edited"])
        payload, _ = message_payload(msg(text="заказ"), 500, 3, [])
        self.assertNotIn("edited", payload)


if __name__ == "__main__":
    unittest.main()
