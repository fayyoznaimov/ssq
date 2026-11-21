"""The client's profile photo in the payload (chat.photo): sent once, then at most once a day and only when changed.
Run: local/dev/tg-venv/bin/python -m unittest discover -s parisahon-telegram-service/tests -t parisahon-telegram-service
"""
import asyncio
import os
import re
import tempfile
import unittest
from types import SimpleNamespace as NS

from helpers import profile_photo
from helpers.chat_filter import PHOTO_UNCHANGED, message_payload
from tests.test_chat_filter import ME, msg, user

DAY = 24 * 3600


def chat_photo(unique="u1", big="big-1", small="small-1"):
    return NS(big_file_id=big, big_photo_unique_id=unique, small_file_id=small, small_photo_unique_id=unique + "s")


class FakeClient:
    """download_media writes a small file where Pyrogram would, or fails like Telegram can."""

    def __init__(self, fail=None, empty=False, delay=0.0):
        self.fail = fail
        self.empty = empty
        self.delay = delay
        self.downloads = []

    async def download_media(self, file_id, file_name=None, **kwargs):
        self.downloads.append(file_id)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            with open(file_name + ".temp", "wb") as fh:   # a half-written download is cleaned up
                fh.write(b"\xff")
            raise self.fail
        with open(file_name, "wb") as fh:
            fh.write(b"" if self.empty else b"\xff\xd8\xff\xe0 jpeg")
        return file_name


class PayloadPhotoTest(unittest.TestCase):
    def test_photo_is_left_out_by_default(self):
        payload, _ = message_payload(msg(user(42)), ME, 7, [])
        self.assertNotIn("photo", payload["chat"])

    def test_photo_file_name_goes_into_chat(self):
        payload, peer = message_payload(msg(user(42)), ME, 7, [], photo="0a1b2c.jpg")
        self.assertEqual(payload["chat"]["photo"], "0a1b2c.jpg")
        self.assertEqual(payload["chat"]["tg_id"], 42)
        self.assertEqual(peer["photo"], "0a1b2c.jpg")

    def test_no_photo_is_null(self):
        payload, _ = message_payload(msg(user(42)), ME, 7, [], photo=None)
        self.assertIn("photo", payload["chat"])
        self.assertIsNone(payload["chat"]["photo"])

    def test_unchanged_is_left_out(self):
        payload, _ = message_payload(msg(user(42)), ME, 7, [], photo=PHOTO_UNCHANGED)
        self.assertNotIn("photo", payload["chat"])


class FreshPhotoTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.cache = profile_photo.PhotoCache()

    def tearDown(self):
        self.tmp.cleanup()

    def fresh(self, client, peer, now):
        return asyncio.run(profile_photo.fresh_photo(client, peer, self.cache, now=now, uploads_dir=self.dir))

    def files(self):
        return sorted(os.listdir(self.dir))

    def test_first_message_brings_the_big_photo_under_a_random_hex_name(self):
        client = FakeClient()
        name = self.fresh(client, user(42, photo=chat_photo()), 1000)
        self.assertRegex(name, r"^[0-9a-f]{32}\.jpg$")
        self.assertEqual(self.files(), [name])
        self.assertEqual(client.downloads, ["big-1"])

    def test_small_photo_when_there_is_no_big_one(self):
        client = FakeClient()
        name = self.fresh(client, user(42, photo=chat_photo(big=None)), 1000)
        self.assertIsNotNone(name)
        self.assertEqual(client.downloads, ["small-1"])

    def test_then_not_again_within_a_day(self):
        client = FakeClient()
        self.fresh(client, user(42, photo=chat_photo()), 1000)
        self.assertIs(self.fresh(client, user(42, photo=chat_photo("u2", "big-2")), 1000 + DAY - 1), PHOTO_UNCHANGED)
        self.assertEqual(len(client.downloads), 1)

    def test_after_a_day_an_unchanged_photo_is_not_downloaded(self):
        client = FakeClient()
        self.fresh(client, user(42, photo=chat_photo()), 1000)
        self.assertIs(self.fresh(client, user(42, photo=chat_photo()), 1000 + DAY), PHOTO_UNCHANGED)
        self.assertEqual(len(client.downloads), 1)
        # and the next look is a day later again
        self.assertIs(self.fresh(client, user(42, photo=chat_photo("u2", "big-2")), 1000 + DAY + 10), PHOTO_UNCHANGED)

    def test_after_a_day_a_changed_photo_is_sent(self):
        client = FakeClient()
        first = self.fresh(client, user(42, photo=chat_photo()), 1000)
        second = self.fresh(client, user(42, photo=chat_photo("u2", "big-2")), 1000 + DAY)
        self.assertRegex(second, r"^[0-9a-f]{32}\.jpg$")
        self.assertNotEqual(first, second)
        self.assertEqual(client.downloads, ["big-1", "big-2"])

    def test_each_chat_has_its_own_day(self):
        client = FakeClient()
        self.assertIsNotNone(self.fresh(client, user(42, photo=chat_photo()), 1000))
        self.assertIsNotNone(self.fresh(client, user(43, photo=chat_photo("v1", "big-v")), 1001))

    def test_no_photo_or_hidden_by_privacy_is_null_once(self):
        client = FakeClient()
        self.assertIsNone(self.fresh(client, user(42, photo=None), 1000))
        self.assertIs(self.fresh(client, user(42, photo=None), 1000 + DAY), PHOTO_UNCHANGED)
        self.assertEqual(client.downloads, [])

    def test_a_photo_set_later_comes_after_the_day(self):
        client = FakeClient()
        self.assertIsNone(self.fresh(client, user(42, photo=None), 1000))
        self.assertIsNotNone(self.fresh(client, user(42, photo=chat_photo()), 1000 + DAY))

    def test_photo_removed_later_is_null(self):
        client = FakeClient()
        self.fresh(client, user(42, photo=chat_photo()), 1000)
        self.assertIsNone(self.fresh(client, user(42, photo=None), 1000 + DAY))

    def test_failed_download_leaves_photo_out_cleans_up_and_retries_later(self):
        client = FakeClient(fail=OSError("network"))
        self.assertIs(self.fresh(client, user(42, photo=chat_photo()), 1000), PHOTO_UNCHANGED)
        self.assertEqual(self.files(), [])
        # not with every message ...
        self.assertIs(self.fresh(client, user(42, photo=chat_photo()), 1000 + 60), PHOTO_UNCHANGED)
        self.assertEqual(len(client.downloads), 1)
        # ... but after RETRY_FAILED_SEC
        client.fail = None
        name = self.fresh(client, user(42, photo=chat_photo()), 1000 + profile_photo.RETRY_FAILED_SEC)
        self.assertIsNotNone(name)
        self.assertEqual(self.files(), [name])

    def test_empty_file_counts_as_failed(self):
        client = FakeClient(empty=True)
        self.assertIs(self.fresh(client, user(42, photo=chat_photo()), 1000), PHOTO_UNCHANGED)
        self.assertEqual(self.files(), [])

    def test_slow_download_times_out(self):
        client = FakeClient(delay=5)
        name = asyncio.run(profile_photo.download(client, chat_photo(), uploads_dir=self.dir, timeout=0.05))
        self.assertIsNone(name)
        self.assertEqual(self.files(), [])

    def test_broken_peer_never_fails_the_message(self):
        class Broken:
            id = 42

            @property
            def photo(self):
                raise RuntimeError("boom")
        self.assertIs(self.fresh(FakeClient(), Broken(), 1000), PHOTO_UNCHANGED)

    def test_outgoing_message_uses_the_chat_photo(self):
        from helpers.chat_filter import peer_of
        chat = NS(id=42, type="ChatType.PRIVATE", first_name="Клиент", photo=chat_photo())
        m = msg(user(ME, is_self=True), chat=chat, outgoing=True)
        name = self.fresh(FakeClient(), peer_of(m, ME), 1000)
        payload, _ = message_payload(m, ME, 7, [], photo=name)
        self.assertTrue(re.match(r"^[0-9a-f]{32}\.jpg$", payload["chat"]["photo"]))


if __name__ == "__main__":
    unittest.main()
