import os
import tempfile
import unittest

import helpers  # noqa: F401
from state import State


class StateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "state", "state.sqlite")
        self.state = State(self.path)
        self.addCleanup(lambda: self.state.close())

    def reopen(self):
        self.state.close()
        self.state = State(self.path)

    def test_sent_survives_a_restart(self):
        self.state.mark_sent(5, "aa", "Cube/a ↗.wav", 10, 812, False)
        self.reopen()
        row = self.state.upload(5, "aa")
        self.assertEqual((row["status"], row["upload_id"], row["duplicate"], row["file_name"], row["size"]), ("sent", 812, 0, "Cube/a ↗.wav", 10))
        self.assertIsNone(self.state.upload(6, "aa"), "the key is the manager and the content")

    def test_rejected_keeps_the_api_words(self):
        self.state.mark_rejected(5, "bb", "b.wav", 3, 'Unsupported audio file ".wav"')
        self.reopen()
        row = self.state.upload(5, "bb")
        self.assertEqual((row["status"], row["error"]), ("rejected", 'Unsupported audio file ".wav"'))

    def test_retry_counts_tries_and_then_sent(self):
        self.assertEqual(self.state.mark_retry(5, "cc", "c.wav", 3, "HTTP 500", 100.0), 1)
        self.assertEqual(self.state.mark_retry(5, "cc", "c.wav", 3, "HTTP 500", 200.0), 2)
        self.assertEqual(self.state.mark_retry(5, "cc", "c.wav", 3, "API is not reachable", 300.0, count=False), 2)
        row = self.state.upload(5, "cc")
        self.assertEqual((row["status"], row["attempts"], row["next_try"], row["error"]), ("retry", 2, 300.0, "API is not reachable"))
        self.state.mark_sent(5, "cc", "c.wav", 3, 7, True)
        row = self.state.upload(5, "cc")
        self.assertEqual((row["status"], row["upload_id"], row["duplicate"], row["error"], row["next_try"]), ("sent", 7, 1, None, None))
        self.assertEqual(self.state.counts(), {"sent": 1})

    def test_seen_cache(self):
        self.state.remember_seen(5, "a.wav", 10, 111, "aa")
        self.assertEqual(self.state.seen_sha(5, "a.wav", 10, 111), "aa")
        self.assertIsNone(self.state.seen_sha(5, "a.wav", 11, 111), "another size is another file")
        self.assertIsNone(self.state.seen_sha(5, "a.wav", 10, 112), "another mtime is another file")
        self.state.remember_seen(5, "b.wav", 1, 1, "bb")
        self.state.forget_seen_except(5, ["b.wav"])
        self.assertIsNone(self.state.seen_sha(5, "a.wav", 10, 111))
        self.assertEqual(self.state.seen_sha(5, "b.wav", 1, 1), "bb")

    def test_handled_files(self):
        self.state.remember_seen(5, "sent.wav", 10, 111, "aa")
        self.state.remember_seen(5, "rejected.wav", 20, 222, "bb")
        self.state.remember_seen(5, "waiting.wav", 30, 333, "cc")
        self.state.remember_seen(5, "new.wav", 40, 444, "dd")
        self.state.remember_seen(6, "other.wav", 50, 555, "aa")
        self.state.mark_sent(5, "aa", "sent.wav", 10, 1, False)
        self.state.mark_rejected(5, "bb", "rejected.wav", 20, "bad")
        self.state.mark_retry(5, "cc", "waiting.wav", 30, "HTTP 500", 1.0)
        self.assertEqual(self.state.handled_files(5), {"sent.wav": (10, 111), "rejected.wav": (20, 222)})
        self.assertEqual(self.state.handled_files(6), {})

    def test_receiving_marks(self):
        self.state.receiving_start("/r/5/a.wav.tmp")
        self.reopen()
        self.assertTrue(self.state.is_receiving("/r/5/a.wav.tmp"), "a mark outlives a restart in the middle of an upload")
        self.state.receiving_rename("/r/5/a.wav.tmp", "/r/5/a.wav")
        self.assertFalse(self.state.is_receiving("/r/5/a.wav.tmp"))
        self.assertTrue(self.state.is_receiving("/r/5/a.wav"), "an unfinished file stays unfinished under its new name")
        self.state.receiving_done("/r/5/a.wav")
        self.assertEqual(self.state.receiving_paths(), [])

    def test_finished_file_renamed_over_an_unfinished_one(self):
        self.state.receiving_start("/r/5/a.wav")
        self.state.receiving_rename("/r/5/full.tmp", "/r/5/a.wav")
        self.assertFalse(self.state.is_receiving("/r/5/a.wav"))

    def test_folder_rename_moves_the_marks(self):
        self.state.receiving_start("/r/5/old/a.wav")
        self.state.receiving_start("/r/5/older/b.wav")
        self.state.receiving_rename("/r/5/old", "/r/5/new")
        self.assertEqual(sorted(self.state.receiving_paths()), ["/r/5/new/a.wav", "/r/5/older/b.wav"])

    def test_forget_user(self):
        self.state.mark_sent(5, "aa", "a.wav", 1, 1, False)
        self.state.mark_sent(6, "aa", "a.wav", 1, 2, False)
        self.state.remember_seen(5, "a.wav", 1, 1, "aa")
        self.assertEqual(sorted(self.state.known_users()), [5, 6])
        self.state.forget_user(5)
        self.assertIsNone(self.state.upload(5, "aa"))
        self.assertIsNotNone(self.state.upload(6, "aa"))
        self.assertEqual(self.state.known_users(), [6])

    def test_file_is_private(self):
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
