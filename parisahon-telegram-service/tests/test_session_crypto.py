"""Unit tests of the session encryption (helpers/session_crypto.py), no Telegram needed."""
import os
import sqlite3
import tempfile
import unittest

from cryptography.fernet import Fernet

from helpers import session_crypto as sc


class SessionCryptoTest(unittest.TestCase):
    def setUp(self):
        self.old = os.environ.get("SESSION_ENCRYPTION_KEY")
        os.environ["SESSION_ENCRYPTION_KEY"] = Fernet.generate_key().decode()

    def tearDown(self):
        if self.old is None:
            os.environ.pop("SESSION_ENCRYPTION_KEY", None)
        else:
            os.environ["SESSION_ENCRYPTION_KEY"] = self.old

    def test_round_trip_and_no_plain_text(self):
        stored = sc.encrypt("BQAAsecretSESSION")
        self.assertTrue(stored.startswith("fernet:"))
        self.assertNotIn("secretSESSION", stored)
        self.assertEqual(sc.decrypt(stored), "BQAAsecretSESSION")

    def test_encrypt_twice_keeps_one_layer(self):
        once = sc.encrypt("abc")
        self.assertEqual(sc.encrypt(once), once)

    def test_old_plain_value_is_read(self):
        self.assertEqual(sc.decrypt("plain-session"), "plain-session")

    def test_wrong_key_gives_none(self):
        stored = sc.encrypt("abc")
        os.environ["SESSION_ENCRYPTION_KEY"] = Fernet.generate_key().decode()
        self.assertIsNone(sc.decrypt(stored))

    def test_no_key_keeps_plain_and_cannot_read_encrypted(self):
        stored = sc.encrypt("abc")
        os.environ["SESSION_ENCRYPTION_KEY"] = ""
        self.assertEqual(sc.encrypt("xyz"), "xyz")
        self.assertIsNone(sc.decrypt(stored))

    def test_existing_rows_are_encrypted_in_place(self):
        with tempfile.TemporaryDirectory() as d:
            db = os.path.join(d, "s.db")
            conn = sqlite3.connect(db)
            conn.execute("CREATE TABLE sessions (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, session_string TEXT)")
            conn.execute("INSERT INTO sessions (user_id, name, session_string) VALUES (1, 'a', 'plainA'), (2, 'b', NULL)")
            conn.commit()
            conn.close()
            self.assertEqual(sc.encrypt_existing(db), 1)
            self.assertEqual(sc.encrypt_existing(db), 0)
            conn = sqlite3.connect(db)
            value = conn.execute("SELECT session_string FROM sessions WHERE user_id = 1").fetchone()[0]
            conn.close()
            self.assertTrue(value.startswith("fernet:"))
            self.assertEqual(sc.decrypt(value), "plainA")


if __name__ == "__main__":
    unittest.main()
