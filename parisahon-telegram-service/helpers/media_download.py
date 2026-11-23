"""Big files stay in Telegram: the CRM gets a link, and the file is fetched only when somebody clicks it.

GET /download (app.py) puts a MediaDownload into the queue; the listener finds the message with the
manager's account and streams the file into a temp file (run_download); the HTTP side sends that
file on while it grows (follow_file) and deletes it afterwards. Nothing is kept on the server.

Keys in the shared results dict: <request id> -> {ok, name, size, mime} or {ok: False, status,
message} as soon as the message is found; "<request id>:done" -> {ok} when the stream ended;
"<request id>:cancel" is set by the HTTP side when the browser went away.
"""
import os
import time
import uuid
from typing import Callable, Iterator, Optional

CHUNK = 256 * 1024

KIND_RU = {
    "video": "Видео",
    "video_note": "Видеосообщение",
    "document": "Файл",
    "voice": "Голосовое сообщение",
    "audio": "Аудио",
    "animation": "GIF",
    "photo": "Фото",
    "sticker": "Стикер",
}

# the extension of a nameless file by its kind (the browser's download needs one)
KIND_EXT = {"video": "mp4", "video_note": "mp4", "voice": "ogg", "audio": "mp3", "animation": "mp4", "photo": "jpg", "sticker": "webp"}


class MediaDownload:
    def __init__(self, user_id: int, chat_id: int, message_id: int, path: str):
        self.request_id = uuid.uuid4().hex
        self.user_id = user_id
        self.chat_id = chat_id
        self.message_id = message_id
        self.path = path


def media_of(message):
    """(kind, media object) of a message, or (None, None)."""
    for kind in ("voice", "audio", "animation", "document", "video", "video_note", "photo", "sticker"):
        media = getattr(message, kind, None)
        if media is not None:
            return kind, media
    return None, None


def media_name(kind: str, media) -> str:
    name = getattr(media, "file_name", None)
    if name:
        return name
    ext = KIND_EXT.get(kind)
    return f"{KIND_RU.get(kind, 'Файл')}.{ext}" if ext else KIND_RU.get(kind, "Файл")


async def fetch_message(client, chat_id: int, message_id: int):
    """The message again; a chat the in-memory session has not seen since the restart is looked up in the dialogs."""
    try:
        return await client.get_messages(chat_id, message_id)
    except Exception as e:
        # only "unknown chat" is worth a second try
        if not isinstance(e, (KeyError, ValueError)) and type(e).__name__ not in ("PeerIdInvalid", "ChannelInvalid"):
            raise
    async for _ in client.get_dialogs(limit=500):
        pass
    return await client.get_messages(chat_id, message_id)


async def run_download(client, request: MediaDownload, results, log: Optional[Callable[[str], None]] = None) -> None:
    rid = request.request_id
    try:
        message = await fetch_message(client, request.chat_id, request.message_id)
        kind, media = (None, None) if message is None or getattr(message, "empty", False) else media_of(message)
        if media is None:
            results[rid] = {"ok": False, "status": 404, "message": "Сообщение или файл удалены в Telegram"}
            return
        results[rid] = {
            "ok": True,
            "name": media_name(kind, media),
            "size": int(getattr(media, "file_size", 0) or 0),
            "mime": getattr(media, "mime_type", None),
        }
        ok = True
        with open(request.path, "ab") as out:
            async for chunk in client.stream_media(message):
                if results.get(rid + ":cancel"):
                    ok = False
                    break
                out.write(chunk)
                out.flush()
        results[rid + ":done"] = {"ok": ok}
    except Exception as e:  # the HTTP side must always get an answer
        if log:
            log(f"download of message {request.message_id} in chat {request.chat_id} failed: {type(e).__name__}: {e}")
        if rid not in results:
            results[rid] = {"ok": False, "status": 502, "message": "Telegram не отдал файл"}
        results[rid + ":done"] = {"ok": False}
    finally:
        results.pop(rid + ":cancel", None)


def follow_file(path: str, is_done: Callable[[], bool], stall_sec: float = 120, sleep=time.sleep) -> Iterator[bytes]:
    """Yields the file while another process appends to it; stops when is_done() and everything was read."""
    last = time.time()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(CHUNK)
            if chunk:
                last = time.time()
                yield chunk
                continue
            if is_done():
                chunk = f.read(CHUNK)  # what arrived between the last read and the flag
                if chunk:
                    yield chunk
                    continue
                return
            if time.time() - last > stall_sec:
                return
            sleep(0.1)


def remove_quietly(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass
