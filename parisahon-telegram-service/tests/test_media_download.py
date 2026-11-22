"""Big files stay in Telegram: the size check, the on-demand stream, and GET /download end to end
(with a fake Telegram client instead of the listener process)."""
import asyncio
import os
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace

from helpers import media_download, media_type_handler
from helpers.file import File

MB = 1024 * 1024


def message_with(kind=None, size=0, name=None, mime=None, caption=None, empty=False):
    fields = {k: None for k in ("voice", "document", "video", "video_note", "photo", "sticker")}
    if kind:
        fields[kind] = SimpleNamespace(file_size=size, file_name=name, mime_type=mime)
    return SimpleNamespace(caption=caption, empty=empty, id=77, **fields)


class FakeClient:
    """get_messages / stream_media / get_dialogs of pyrogram.Client, as far as the download needs them."""

    def __init__(self, message, chunks=(), unknown_chat_first=False, delay=0.0):
        self.message = message
        self.chunks = list(chunks)
        self.unknown_chat = unknown_chat_first
        self.delay = delay
        self.dialogs_loaded = 0
        self.streamed = 0

    async def get_messages(self, chat_id, message_id):
        if self.unknown_chat:
            self.unknown_chat = False
            raise ValueError(f"Peer id invalid: {chat_id}")
        return self.message

    async def get_dialogs(self, limit=0):
        self.dialogs_loaded += 1
        for item in ():
            yield item

    async def stream_media(self, message):
        for chunk in self.chunks:
            if self.delay:
                await asyncio.sleep(self.delay)
            self.streamed += 1
            yield chunk


class SizeCheck(unittest.TestCase):
    def test_small_file_is_saved_as_before(self):
        self.assertIsNone(media_type_handler.remote_file(message_with("video", 10 * MB, "a.mp4"), 25))
        self.assertIsNone(media_type_handler.remote_file(message_with("video", 25 * MB, "a.mp4"), 25))
        self.assertIsNone(media_type_handler.remote_file(message_with(), 25))

    def test_big_file_stays_in_telegram(self):
        file = media_type_handler.remote_file(message_with("video", 239 * MB, "выставка.mp4", "video/mp4", "смотрите"), 25)
        self.assertIsInstance(file, File)
        self.assertEqual(
            file.convert_to_dict(),
            {"name": "выставка.mp4", "path": "", "type": "video", "caption": "смотрите",
             "remote": True, "size": 239 * MB, "mime": "video/mp4"},
        )

    def test_a_file_without_a_name_gets_a_readable_one(self):
        self.assertEqual(media_type_handler.remote_file(message_with("video_note", 30 * MB), 25).name, "Видеосообщение")

    def test_zero_turns_the_limit_off(self):
        self.assertIsNone(media_type_handler.remote_file(message_with("document", 900 * MB, "a.zip"), 0))

    def test_local_files_are_sent_without_the_new_fields(self):
        self.assertEqual(set(File("a", "x.jpg", "photo").convert_to_dict()), {"name", "path", "type", "caption"})


class Download(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(prefix="tgdl_test_")
        os.close(fd)
        self.addCleanup(media_download.remove_quietly, self.path)
        self.job = media_download.MediaDownload(5, 1001, 77, self.path)
        self.results = {}

    def run_job(self, client):
        errors = []
        asyncio.run(media_download.run_download(client, self.job, self.results, errors.append))
        return errors

    def test_the_file_arrives_whole(self):
        chunks = [bytes([i]) * 100_000 for i in range(7)]
        client = FakeClient(message_with("document", 700_000, "каталог.pdf", "application/pdf"), chunks)
        self.assertEqual(self.run_job(client), [])
        self.assertEqual(self.results[self.job.request_id],
                         {"ok": True, "name": "каталог.pdf", "size": 700_000, "mime": "application/pdf"})
        self.assertEqual(self.results[self.job.request_id + ":done"], {"ok": True})
        with open(self.path, "rb") as f:
            self.assertEqual(f.read(), b"".join(chunks))

    def test_a_deleted_message_is_a_404(self):
        self.run_job(FakeClient(message_with(empty=True)))
        self.assertEqual(self.results[self.job.request_id]["status"], 404)
        self.assertNotIn(self.job.request_id + ":done", self.results)

    def test_a_chat_unknown_after_a_restart_is_found_in_the_dialogs(self):
        client = FakeClient(message_with("video", 3, "v.mp4"), [b"abc"], unknown_chat_first=True)
        self.run_job(client)
        self.assertEqual(client.dialogs_loaded, 1)
        self.assertTrue(self.results[self.job.request_id]["ok"])

    def test_telegram_failing_in_the_middle_is_reported(self):
        class Broken(FakeClient):
            async def stream_media(self, message):
                yield b"abc"
                raise ConnectionError("lost")

        errors = self.run_job(Broken(message_with("video", 6, "v.mp4")))
        self.assertEqual(len(errors), 1)
        self.assertEqual(self.results[self.job.request_id + ":done"], {"ok": False})

    def test_cancel_stops_the_stream(self):
        client = FakeClient(message_with("video", 5, "v.mp4"), [b"a", b"b", b"c", b"d", b"e"])
        self.results[self.job.request_id + ":cancel"] = True
        self.run_job(client)
        self.assertEqual(self.results[self.job.request_id + ":done"], {"ok": False})
        self.assertEqual(os.path.getsize(self.path), 0)
        self.assertNotIn(self.job.request_id + ":cancel", self.results)


class FollowFile(unittest.TestCase):
    def test_a_growing_file_is_read_to_the_end(self):
        fd, path = tempfile.mkstemp(prefix="tgdl_test_")
        os.close(fd)
        self.addCleanup(media_download.remove_quietly, path)
        done = threading.Event()
        parts = [os.urandom(300_000) for _ in range(5)]

        def writer():
            with open(path, "ab") as out:
                for part in parts:
                    time.sleep(0.05)
                    out.write(part)
                    out.flush()
            done.set()

        thread = threading.Thread(target=writer)
        thread.start()
        got = b"".join(media_download.follow_file(path, done.is_set))
        thread.join()
        self.assertEqual(got, b"".join(parts))

    def test_a_stalled_writer_does_not_hang_the_reader(self):
        fd, path = tempfile.mkstemp(prefix="tgdl_test_")
        os.close(fd)
        self.addCleanup(media_download.remove_quietly, path)
        started = time.time()
        self.assertEqual(list(media_download.follow_file(path, lambda: False, stall_sec=0.3)), [])
        self.assertLess(time.time() - started, 3)


class Route(unittest.TestCase):
    """GET /download of app.py with a thread that plays the listener process."""

    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("SERVICE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))
        import app as service
        cls.service = service
        cls.saved = (service.DOWNLOAD_START_TIMEOUT_SEC, service.has_session, service.listener_process)
        service.DOWNLOAD_START_TIMEOUT_SEC = 3
        service.has_session = lambda user_id: int(user_id) == 5
        service.listener_process = SimpleNamespace(is_alive=lambda: True)
        cls.http = service.app.test_client()

    @classmethod
    def tearDownClass(cls):
        # the module is shared with the other route tests
        cls.service.DOWNLOAD_START_TIMEOUT_SEC, cls.service.has_session, cls.service.listener_process = cls.saved

    def listen(self, client):
        """Takes one job from the queue, like the listener's main loop, and streams it."""
        def work():
            job = self.service.new_messages.get(timeout=5)
            asyncio.run(media_download.run_download(client, job, self.service.send_results))
            self.paths.append(job.path)

        self.paths = []
        thread = threading.Thread(target=work)
        thread.start()
        return thread

    def test_the_browser_gets_the_file_and_nothing_stays_on_disk(self):
        chunks = [os.urandom(400_000) for _ in range(6)]
        client = FakeClient(message_with("video", 2_400_000, "показ коллекции.mp4", "video/mp4"), chunks, delay=0.03)
        thread = self.listen(client)
        answer = self.http.get("/download?user_id=5&chat_id=1001&message_id=77")
        thread.join()
        self.assertEqual(answer.status_code, 200)
        self.assertEqual(answer.data, b"".join(chunks))
        self.assertEqual(answer.headers["Content-Length"], "2400000")
        self.assertEqual(answer.headers["Content-Type"], "video/mp4")
        self.assertFalse(os.path.exists(self.paths[0]))

    def test_no_telegram_session(self):
        answer = self.http.get("/download?user_id=6&chat_id=1&message_id=2")
        self.assertEqual(answer.status_code, 400)

    def test_bad_parameters(self):
        self.assertEqual(self.http.get("/download?user_id=5").status_code, 400)

    def test_a_deleted_message(self):
        thread = self.listen(FakeClient(message_with(empty=True)))
        answer = self.http.get("/download?user_id=5&chat_id=1001&message_id=77")
        thread.join()
        self.assertEqual(answer.status_code, 404)
        self.assertFalse(os.path.exists(self.paths[0]))

    def test_the_listener_does_not_answer(self):
        answer = self.http.get("/download?user_id=5&chat_id=1001&message_id=78")
        self.assertEqual(answer.status_code, 504)
        self.service.new_messages.get(timeout=2)  # the job nobody took


if __name__ == "__main__":
    unittest.main()
