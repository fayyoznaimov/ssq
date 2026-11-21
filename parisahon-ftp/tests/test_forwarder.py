import os
import shutil
import tempfile
import time
import unittest

from helpers import CUBE_NAME, FakeApi, dead_url, write
from config import Config
from crm import CrmApi
from forwarder import Forwarder, wanted
from state import State


class Clock:
    """The forwarder's wall clock, moved by hand (retry times)."""

    def __init__(self):
        self.now = 1_800_000_000.0

    def __call__(self):
        return self.now


class ForwarderCase(unittest.TestCase):
    settle = 0.0
    retain_days = 30.0

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ftp-fwd-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.fake = FakeApi()
        self.addCleanup(self.fake.stop)
        self.config = Config(root=os.path.join(self.tmp, "data"), state_dir=os.path.join(self.tmp, "state"), api_url=self.fake.url,
                             service_token=self.fake.service_token, settle_sec=self.settle, scan_sec=0.2, retain_days=self.retain_days)
        os.makedirs(self.config.root)
        self.clock = Clock()
        self.state = None
        self.forwarder = self.boot()
        self.addCleanup(lambda: self.state.close())

    def boot(self, api_url=None, service_token=None):
        """A (re)started service on the same folders."""
        if self.state:
            self.state.close()
        self.state = State(self.config.state_db)
        api = CrmApi(api_url or self.fake.url, service_token or self.fake.service_token, timeout=3, upload_timeout=5)
        return Forwarder(self.config, self.state, api, clock=self.clock)

    def home(self, user_id, *parts):
        return os.path.join(self.config.root, str(user_id), *parts)

    def put(self, user_id, name, data=None, mtime=None):
        return write(self.home(user_id, *name.split("/")), data if data is not None else os.urandom(2000), mtime)


class ForwardTest(ForwarderCase):
    def test_audio_file_is_sent_once_and_stays(self):
        path = self.put(5, CUBE_NAME, mtime=1795255392.25)
        with self.assertLogs("ftp.forward", "INFO") as logs:
            self.forwarder.scan_once()
        upload = self.fake.uploads[0]
        self.assertEqual((upload["user_id"], upload["file_name"], upload["recorded_at"]), (5, CUBE_NAME, "1795255392250"))
        self.assertIn(f'forwarded user=5 file="{CUBE_NAME}" size=2000 upload_id={upload["id"]}', logs.output[0], "the name is logged as it is")
        for _ in range(3):
            self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 1, "nothing is sent twice")
        self.assertTrue(os.path.exists(path), "the file stays for the sync app's comparison")

    def test_user_id_is_the_home_folder_and_subfolders_are_walked(self):
        self.put(5, "Cube/2026/a.m4a")
        self.put(12, "b.AMR")
        write(os.path.join(self.config.root, "lost+found", "c.wav"), b"xxxx")
        write(os.path.join(self.config.root, "0", "d.wav"), b"xxxx")
        write(os.path.join(self.config.root, "stray.wav"), b"xxxx")
        self.forwarder.scan_once()
        self.assertEqual(sorted((u["user_id"], u["file_name"]) for u in self.fake.uploads), [(5, "a.m4a"), (12, "b.AMR")])

    def test_only_finished_audio_names(self):
        for name in ("a.wav.part", "b.wav.tmp", "c.mp3.filepart", "d.wav~", ".e.wav", ".trash/f.wav", "notes.txt", "g.json", "noext", "h.wav.TMP"):
            self.put(5, name)
        self.put(5, "empty.wav", b"")
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 0)
        self.assertTrue(all(wanted("x" + ext) for ext in (".amr", ".mp3", ".m4a", ".wav", ".ogg", ".aac", ".3gp", ".WAV")))

    def test_oldest_recording_goes_first(self):
        self.put(5, "new.wav", mtime=2000)
        self.put(5, "old.wav", mtime=1000)
        self.put(5, "middle.wav", mtime=1500)
        self.forwarder.scan_once()
        self.assertEqual(self.fake.names(), ["old.wav", "middle.wav", "new.wav"])

    def test_same_content_under_another_name_is_not_sent_again(self):
        data = os.urandom(1500)
        self.put(5, "a.wav", data)
        self.forwarder.scan_once()
        self.put(5, "copy of a.wav", data)
        with self.assertLogs("ftp.forward", "INFO") as logs:
            self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 1)
        self.assertIn('already sent user=5 file="copy of a.wav"', logs.output[0])
        self.put(6, "a.wav", data)
        self.forwarder.scan_once()
        self.assertEqual([(u["user_id"], u["file_name"]) for u in self.fake.uploads], [(5, "a.wav"), (6, "a.wav")], "another manager's call is another call")

    def test_rename_and_touch_after_sending_do_not_resend(self):
        path = self.put(5, "a.wav")
        self.forwarder.scan_once()
        os.rename(path, self.home(5, "renamed.wav"))
        os.utime(self.home(5, "renamed.wav"), (1000, 1000))
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 1)

    def test_changed_content_is_a_new_upload(self):
        path = self.put(5, "a.wav", b"first" * 100)
        self.forwarder.scan_once()
        write(path, b"second" * 100)
        self.forwarder.scan_once()
        self.assertEqual([u["data"][:6] for u in self.fake.uploads], [b"firstf", b"second"])

    def test_json_next_to_the_audio_goes_as_meta(self):
        self.put(5, "call-1.m4a")
        self.put(5, "call-1.json", b'{"duration":"71825"}')
        self.put(5, "call-2.amr")
        self.put(5, "call-2.amr.json", b'{"duration":"5"}')
        self.put(5, "call-3.amr")
        self.forwarder.scan_once()
        metas = {u["file_name"]: u["meta"] for u in self.fake.uploads}
        self.assertEqual(metas, {"call-1.m4a": ("call-1.json", b'{"duration":"71825"}'), "call-2.amr": ("call-2.amr.json", b'{"duration":"5"}'), "call-3.amr": None})

    def test_file_still_being_received_waits(self):
        path = self.put(5, "a.wav")
        self.state.receiving_start(path)
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 0)
        self.state.receiving_done(path)
        self.forwarder.scan_once()
        self.assertEqual(self.fake.names(), ["a.wav"])


class SettleTest(ForwarderCase):
    settle = 0.4

    def test_file_must_hold_still_first(self):
        path = self.put(5, "a.wav")
        wait = self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 0)
        self.assertTrue(0 < wait <= 0.4, wait)
        time.sleep(0.25)
        with open(path, "ab") as handle:  # still growing: the timer starts again
            handle.write(b"more")
        self.forwarder.scan_once()
        time.sleep(0.25)
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 0, "0.25 s after the last change is not settled yet")
        time.sleep(0.2)
        self.assertIsNone(self.forwarder.scan_once(), "nothing left to wait for")
        self.assertEqual(len(self.fake.uploads[0]["data"]), 2004)

    def test_new_mtime_restarts_the_timer(self):
        path = self.put(5, "a.wav")
        self.forwarder.scan_once()
        time.sleep(0.3)
        os.utime(path, (1795255392, 1795255392))  # MFMT of the sync app
        self.forwarder.scan_once()
        time.sleep(0.2)
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 0)
        time.sleep(0.25)
        self.forwarder.scan_once()
        self.assertEqual(self.fake.uploads[0]["recorded_at"], "1795255392000")

    def test_loop_sends_after_a_kick(self):
        self.config.scan_sec = 30  # only the kick can make it this fast
        self.forwarder.start()
        self.addCleanup(self.forwarder.stop)
        time.sleep(0.2)
        self.put(5, "a.wav")
        self.forwarder.kick()
        deadline = time.time() + 5
        while not self.fake.uploads and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.fake.names(), ["a.wav"])


class FailureTest(ForwarderCase):
    def test_rejected_file_is_never_sent_again(self):
        self.put(5, "broken.wav")
        self.fake.upload_statuses = [415]
        with self.assertLogs("ftp.forward", "WARNING") as logs:
            self.forwarder.scan_once()
        self.assertIn('rejected user=5 file="broken.wav" size=2000 status=415 reason="forced 415"', logs.output[0])
        self.clock.now += 10 * 86400
        self.forwarder.scan_once()
        self.forwarder = self.boot()
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 1)
        row = self.state.upload(5, self.state.seen_sha(5, "broken.wav", 2000, os.stat(self.home(5, "broken.wav")).st_mtime_ns))
        self.assertEqual((row["status"], row["error"]), ("rejected", "forced 415"))

    def test_server_error_is_retried_with_growing_pauses(self):
        self.put(5, "a.wav")
        self.put(5, "b.wav", mtime=time.time() + 5)
        self.fake.upload_statuses = [500, 500]
        with self.assertLogs("ftp.forward", "WARNING") as logs:
            self.forwarder.scan_once()
        self.assertIn('retry user=5 file="a.wav" size=2000 attempt=1 next_try_in=30s reason="HTTP 500: forced 500"', logs.output[0])
        self.assertEqual(self.fake.names(), [], "b.wav got the second 500: a failing file does not stop the others")
        self.assertEqual(self.fake.posts, 2)
        self.clock.now += 29
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 2, "not before its time")
        self.clock.now += 2
        self.fake.upload_statuses = [500]
        self.forwarder.scan_once()
        self.assertEqual(self.fake.names(), ["b.wav"])
        self.clock.now += 59
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 4, "the second pause is 60 s")
        self.clock.now += 2
        self.forwarder.scan_once()
        self.assertEqual(self.fake.names(), ["b.wav", "a.wav"])

    def test_api_down_then_back(self):
        for n in range(3):
            self.put(5, f"{n}.wav", mtime=1000 + n)
        self.forwarder = self.boot(api_url=dead_url())
        with self.assertLogs("ftp.forward", "WARNING") as logs:
            wait = self.forwarder.scan_once()
        self.assertEqual(len(logs.output), 1, "one line, not one per waiting file")
        self.assertIn('retry user=5 file="0.wav"', logs.output[0])
        self.assertIn("not reachable", logs.output[0])
        self.assertAlmostEqual(wait, 10, delta=0.5)
        self.forwarder.api = CrmApi(self.fake.url, self.fake.service_token)
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 0, "paused for 10 s")
        self.clock.now += 11
        with self.assertLogs("ftp.forward", "INFO") as logs:
            self.forwarder.scan_once()
        self.assertEqual(self.fake.names(), ["0.wav", "1.wav", "2.wav"])
        self.assertIn("the API answers again", logs.output[0])

    def test_api_not_deployed_yet_is_like_down(self):
        self.put(5, "a.wav")
        self.put(5, "b.wav")
        self.fake.upload_statuses = [404, 502]
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 1)
        self.clock.now += 11
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 2)
        self.clock.now += 19
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 2, "the second pause is 20 s")
        self.clock.now += 2
        self.forwarder.scan_once()
        self.assertEqual(sorted(self.fake.names()), ["a.wav", "b.wav"])

    def test_wrong_service_token_is_loud_and_nothing_is_lost(self):
        self.put(5, "a.wav")
        self.put(6, "b.wav")
        self.forwarder = self.boot(service_token="not-the-token")
        with self.assertLogs("ftp.forward", "ERROR") as logs:
            wait = self.forwarder.scan_once()
        self.assertEqual(len(logs.output), 2, "one loud line per manager with files waiting")
        self.assertIn("CALLS_SERVICE_TOKEN IS REFUSED BY THE API (HTTP 401", logs.output[0])
        self.assertIn('retry file="a.wav" next_try_in=10s', logs.output[0])
        self.assertNotIn("not-the-token", "".join(logs.output))
        self.assertAlmostEqual(wait, 10, delta=0.5)
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 2, "not asked again before the pause is over")
        self.clock.now += 11
        with self.assertLogs("ftp.forward", "ERROR") as logs:
            self.forwarder.scan_once()
        self.assertIn("next_try_in=20s", logs.output[0])
        self.forwarder = self.boot()  # the env was fixed, the service restarted: no pause is left over
        self.forwarder.scan_once()
        self.assertEqual(sorted(self.fake.names()), ["a.wav", "b.wav"])

    def test_refused_manager_does_not_hold_up_the_others(self):
        # the API answers 401 for a user id it does not know (a manager removed from the CRM)
        self.put(5, "of a removed manager.wav", mtime=1000)
        self.put(6, "b.wav", mtime=2000)
        self.put(7, "c.wav", mtime=3000)
        self.fake.upload_statuses = [401]
        with self.assertLogs("ftp.forward", "INFO") as logs:
            self.forwarder.scan_once()
        self.assertEqual(self.fake.names(), ["b.wav", "c.wav"])
        self.assertIn("CALLS_SERVICE_TOKEN IS REFUSED", logs.output[0])
        self.put(5, "another.wav", mtime=1500)
        self.put(6, "d.wav", mtime=4000)
        self.fake.upload_statuses = [403]
        self.clock.now += 11
        with self.assertLogs("ftp.forward", "ERROR") as logs:
            self.forwarder.scan_once()
        self.assertIn("THE API REFUSES UPLOADS FOR user=5 (HTTP 403", logs.output[0], "others were accepted, so it is about this manager")
        self.assertEqual(len(logs.output), 1, "one line per manager, not per file")
        self.assertEqual(self.fake.names(), ["b.wav", "c.wav", "d.wav"])
        self.clock.now += 21
        self.forwarder.scan_once()  # the manager is back in the CRM
        self.assertEqual(self.fake.names(), ["b.wav", "c.wav", "d.wav", "of a removed manager.wav", "another.wav"])


class RestartTest(ForwarderCase):
    def test_restart_sends_nothing_twice_and_picks_up_the_rest(self):
        self.put(5, "sent.wav", mtime=1000)
        self.forwarder.scan_once()
        self.put(5, "new.wav", mtime=2000)
        self.forwarder = self.boot()
        self.forwarder.scan_once()
        self.forwarder.scan_once()
        self.assertEqual(self.fake.names(), ["sent.wav", "new.wav"])
        self.assertEqual(self.fake.posts, 2)

    def test_lost_record_of_a_delivered_file_ends_as_duplicate(self):
        # the service died between the API's answer and writing it down
        self.put(5, "a.wav")
        self.forwarder.scan_once()
        self.state.forget_user(5)
        with self.assertLogs("ftp.forward", "INFO") as logs:
            self.forwarder.scan_once()
        self.assertIn("duplicate", logs.output[0])
        self.assertEqual(len(self.fake.uploads), 1, "the API has it once")
        row = self.state.upload(5, self.state.seen_sha(5, "a.wav", 2000, os.stat(self.home(5, "a.wav")).st_mtime_ns))
        self.assertEqual((row["status"], row["duplicate"], row["upload_id"]), ("sent", 1, self.fake.uploads[0]["id"]))
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 2)


class PruneTest(ForwarderCase):
    retain_days = 0.2 / 86400  # 0.2 s

    def test_old_files_go_but_not_unsent_audio(self):
        sent = self.put(5, "sent.wav")
        self.forwarder.scan_once()
        junk = self.put(5, "notes.txt")
        partial = self.put(5, "partial.wav")
        self.state.receiving_start(partial)
        self.fake.upload_statuses = [500]
        waiting = self.put(5, "waiting.wav")
        self.forwarder.scan_once()
        time.sleep(0.3)
        fresh = self.put(5, "fresh.txt")
        with self.assertLogs("ftp.forward", "INFO") as logs:
            self.assertEqual(self.forwarder.prune(), 3)
        self.assertTrue(any('removed old user=5 file="sent.wav"' in line for line in logs.output))
        self.assertEqual([os.path.exists(p) for p in (sent, junk, partial, waiting, fresh)], [False, False, False, True, True])
        self.assertEqual(self.state.receiving_paths(), [])
        # the sync app uploads the removed file again: it is not sent again
        self.put(5, "sent.wav", self.fake.uploads[0]["data"])
        self.forwarder.scan_once()
        self.assertEqual(self.fake.names(), ["sent.wav"])

    def test_home_removed_by_hand_is_forgotten(self):
        self.put(5, "a.wav")
        self.put(6, "b.wav")
        self.forwarder.scan_once()
        shutil.rmtree(self.home(5))
        self.forwarder.prune()
        self.assertEqual(self.state.known_users(), [6])

    def test_missing_root_forgets_nothing(self):
        self.put(5, "a.wav")
        self.forwarder.scan_once()
        os.rename(self.config.root, self.config.root + ".away")
        self.forwarder.prune()
        self.assertIsNone(self.forwarder.scan_once())
        self.assertEqual(self.state.known_users(), [5])


class KeepForeverTest(ForwarderCase):
    retain_days = 0

    def test_zero_keeps_everything(self):
        old = self.put(5, "a.wav")
        self.forwarder.scan_once()
        time.sleep(0.05)
        self.assertEqual(self.forwarder.prune(), 0)
        self.assertTrue(os.path.exists(old))


if __name__ == "__main__":
    unittest.main()
