"""The client's Telegram profile photo for the CRM (chat.photo of POST /telegram/incoming).

The photo is downloaded into the API's uploads folder (config.UPLOADS_DIR) under a random
"<hex>.jpg" name and sent with the first message of a chat after the listener starts, then at most
once a day per chat, and only when it changed (its file_unique_id). No photo, or one hidden by the
client's privacy settings, gives null. A failed download leaves chat.photo out and never stops the
message. The photo's file name is never logged.
"""
import asyncio
import os
import secrets
import time
from typing import Dict, Optional

from . import config
from .chat_filter import PHOTO_UNCHANGED
from .Logger import Logger

logger = Logger("files.log")

CHECK_EVERY_SEC = 24 * 3600
RETRY_FAILED_SEC = 600      # a failed download is tried again after 10 minutes, not with every message
DOWNLOAD_TIMEOUT_SEC = 15

NOTHING = object()          # the CRM has not been told anything about this chat's photo yet


def unique_id(chat_photo) -> Optional[str]:
    if chat_photo is None:
        return None
    return getattr(chat_photo, "big_photo_unique_id", None) or getattr(chat_photo, "small_photo_unique_id", None)


class Seen:
    def __init__(self, next_check: float, told=NOTHING):
        self.next_check = next_check
        self.told = told    # file_unique_id of the photo sent to the CRM, None (told: no photo) or NOTHING


class PhotoCache:
    """In memory, per listener process: chat id -> when to look at the photo again and what the CRM has."""

    def __init__(self, check_every_sec: float = CHECK_EVERY_SEC, retry_failed_sec: float = RETRY_FAILED_SEC):
        self.check_every_sec = check_every_sec
        self.retry_failed_sec = retry_failed_sec
        self.entries: Dict[int, Seen] = {}


def remove(name: Optional[str], uploads_dir: Optional[str] = None) -> None:
    if not name:
        return
    path = os.path.join(uploads_dir or config.UPLOADS_DIR, os.path.basename(name))
    for leftover in (path, path + ".temp"):
        try:
            os.remove(leftover)
        except OSError:
            pass


async def download(client, chat_photo, uploads_dir: Optional[str] = None,
                   timeout: float = DOWNLOAD_TIMEOUT_SEC) -> Optional[str]:
    """Downloads the big (or the small) profile photo; the file name in the uploads folder, or None."""
    file_id = getattr(chat_photo, "big_file_id", None) or getattr(chat_photo, "small_file_id", None)
    if not file_id:
        return None
    directory = os.path.abspath(uploads_dir or config.UPLOADS_DIR)
    name = secrets.token_hex(16) + ".jpg"
    path = os.path.join(directory, name)
    saved = False
    try:
        await asyncio.wait_for(client.download_media(file_id, file_name=path), timeout)
        saved = os.path.isfile(path) and os.path.getsize(path) > 0
        if not saved:
            logger.warning("profile photo: Telegram gave no file")
    except Exception as error:
        logger.warning(f"profile photo not downloaded: {type(error).__name__}")
    finally:
        if not saved:
            remove(name, directory)
    return name if saved else None


async def fresh_photo(client, peer, cache: PhotoCache, now: Optional[float] = None,
                      uploads_dir: Optional[str] = None):
    """chat.photo for a message of `peer`'s chat: a file name, None (no photo or hidden),
    or PHOTO_UNCHANGED (leave it out: checked recently, unchanged, or the download failed)."""
    try:
        now = time.time() if now is None else now
        chat_id = getattr(peer, "id", None)
        if chat_id is None:
            return PHOTO_UNCHANGED
        seen = cache.entries.get(chat_id)
        if seen is not None and now < seen.next_check:
            return PHOTO_UNCHANGED
        photo = getattr(peer, "photo", None)
        current = unique_id(photo) if photo is not None else None
        told = seen.told if seen is not None else NOTHING
        if told is not NOTHING and told == current:
            cache.entries[chat_id] = Seen(now + cache.check_every_sec, current)
            return PHOTO_UNCHANGED
        if photo is None:
            cache.entries[chat_id] = Seen(now + cache.check_every_sec, None)
            return None
        # claim the check before downloading: another message of this chat arriving meanwhile does not download it again
        cache.entries[chat_id] = Seen(now + cache.check_every_sec, current)
        name = await download(client, photo, uploads_dir)
        if name is None:
            cache.entries[chat_id] = Seen(now + cache.retry_failed_sec, told)
            return PHOTO_UNCHANGED
        return name
    except Exception as error:
        logger.warning(f"profile photo skipped: {type(error).__name__}")
        return PHOTO_UNCHANGED
