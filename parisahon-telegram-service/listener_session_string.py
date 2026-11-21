"""The listener: one Pyrogram client per connected manager.

What changed against the first version:
  - every client knows its own manager (user_id, Telegram id): with two or more
    connected accounts the messages of all of them are recorded, not only of
    the last one that was started;
  - nothing is written to Postgres here any more: every message goes to the CRM
    API (POST /telegram/incoming), which creates the contact, the deal and the
    history record with the CRM's own rules and triggers. If the API is down the
    message waits in the sqlite outbox and is resent in order;
  - chats are filtered (helpers/chat_filter.py): bots, Telegram's service
    accounts with login codes, groups and "Saved Messages" are never recorded;
  - a message sent from the CRM is answered synchronously (what Telegram
    accepted, with message ids); the API writes the history itself;
  - a session that fails to start (revoked on the phone, network) is retried
    every SESSION_RETRY_SEC seconds instead of being forgotten until a restart;
  - the client's profile photo goes with the first message of a chat, then at most
    once a day and only when it changed (helpers/profile_photo.py, chat.photo);
  - POST /resolve-phone of app.py comes through the same queue as /new-message:
    is there a Telegram account behind a phone number (helpers/phone_lookup.py).
Call recordings from the recorder's folders go to the API too (POST /calls/upload).
"""
import asyncio
import multiprocessing
import os
import sqlite3
import time
from typing import Dict, List, Optional, Set, Tuple

import pyrogram.types
from dotenv import load_dotenv
from pyrogram import Client
from pyrogram.handlers import MessageHandler

load_dotenv()  # take environment variables from .env.

from helpers import config  # noqa: E402  (after load_dotenv)
from helpers import media_type_handler, message_handler, name_lookup, phone_lookup, profile_photo, session_crypto  # noqa: E402
from helpers.api_client import CrmApi  # noqa: E402
from helpers.chat_filter import message_payload, peer_of, reason_to_skip  # noqa: E402
from helpers.file import File  # noqa: E402
from helpers.Logger import Logger  # noqa: E402
from helpers.call_recordings_handler import check_for_existing_recordings  # noqa: E402

listener_logger = Logger("listener.log")
message_logger = Logger("message.log")


class LocalSession:
    def __init__(self, user_id: int, name: str, session_string: str):
        self.user_id = user_id
        self.name = name
        self.session_string = session_string


class ClientContext:
    """A started Pyrogram client and the manager it belongs to."""

    def __init__(self, user_id: int, name: str, client: Client, me: pyrogram.types.User):
        self.user_id = user_id
        self.name = name
        self.client = client
        self.me = me


# state of the listener process
contexts: Dict[int, ClientContext] = {}          # user_id -> context
contexts_by_name: Dict[str, ClientContext] = {}  # pyrogram client name -> context
failed_sessions: Dict[int, float] = {}           # user_id -> when to try again
db_sessions: Dict[int, LocalSession] = {}
api: Optional[CrmApi] = None
photo_cache = profile_photo.PhotoCache()         # chat id -> when the client's photo was sent / checked
lookup_tasks: Set[asyncio.Task] = set()          # running /resolve-phone lookups


def recordings_enabled() -> bool:
    return bool(os.environ.get('RECORDINGS_SOURCE')) and os.path.isdir(os.environ.get('RECORDINGS_SOURCE', ''))


# ------------------------------------------------------------------ sessions (sqlite)

def init_db() -> None:
    conn = sqlite3.connect(config.SERVICE_DB)
    try:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY,
                user_id INTEGER,
                name VARCHAR(255),
                session_string TEXT
            )
        ''')
        conn.commit()
    finally:
        conn.close()
    session_crypto.encrypt_existing(config.SERVICE_DB)


def fetch_all_sessions() -> Dict[int, LocalSession]:
    conn = sqlite3.connect(config.SERVICE_DB)
    try:
        rows = conn.execute("SELECT id, user_id, name, session_string FROM sessions").fetchall()
        sessions = {}
        for _, user_id, name, stored in rows:
            session_string = session_crypto.decrypt(stored)
            if session_string:
                sessions[user_id] = LocalSession(user_id, name, session_string)
        return sessions
    except sqlite3.Error as e:
        listener_logger.error(f"Error fetching sessions: {e}")
        return {}
    finally:
        conn.close()


# ------------------------------------------------------------------ incoming messages

async def save_files(client: Client, message: pyrogram.types.Message) -> List[File]:
    if message.voice:
        return await media_type_handler.save_audio(client, message)
    if message.document:
        return await media_type_handler.save_document(client, message)
    if message.video:
        return await media_type_handler.save_video(client, message)
    if message.video_note:
        return await media_type_handler.save_video_note(client, message)
    if message.photo:
        return await media_type_handler.save_photo(client, message)
    if message.sticker:
        return await media_type_handler.save_sticker(client, message)
    return []


def remove_files(files: List[File]) -> None:
    for file in files:
        if file is None:
            continue
        path = os.path.join(config.UPLOADS_DIR, os.path.basename(file.path))
        try:
            os.remove(path)
        except OSError:
            pass


async def handler(client: Client, message: pyrogram.types.Message) -> None:
    """Every message of a private chat of the manager, incoming or sent from the phone."""
    ctx = contexts_by_name.get(client.name)
    if ctx is None:
        listener_logger.warning(f"message for an unknown client {client.name}, skipped")
        return
    reason = reason_to_skip(message, ctx.me.id)
    if reason:
        message_logger.info(f"[{ctx.name}] chat {message.chat.id} message {message.id} skipped: {reason}")
        return

    files = await save_files(client, message)
    photo = await profile_photo.fresh_photo(client, peer_of(message, ctx.me.id), photo_cache)
    payload, peer = message_payload(message, ctx.me.id, ctx.user_id, files, photo=photo)
    result = api.deliver(payload)
    if result is None:
        message_logger.info(f"[{ctx.name}] message {message.id} from chat {peer['tg_id']} queued for the API")
        return
    status = result.get("status")
    if status == "ignored":
        # the API decided the chat is not for the CRM (TELEGRAM_KNOWN_CONTACTS_ONLY): no files either
        remove_files(files)
        if isinstance(photo, str):
            profile_photo.remove(photo)
    message_logger.info(
        f"[{ctx.name}] message {message.id} from chat {peer['tg_id']}: {status}"
        f"{' (' + str(result.get('reason')) + ')' if result.get('reason') else ''}, deals {result.get('deal_ids')}"
    )


# ------------------------------------------------------------------ outgoing (from the CRM)

async def send_message(message: message_handler.Message) -> Tuple[bool, str, list]:
    """Returns (ok, reason, [{tg_message_id, file}])."""
    ctx = contexts.get(int(message.from_user))
    if ctx is None:
        return False, "У менеджера нет подключённого Telegram", []
    sent: List[dict] = []
    try:
        if message.files:
            for sent_message, file in await message_handler.send_files(ctx.client, message.to_user, message.files):
                sent.append({"tg_message_id": sent_message.id, "file": file.convert_to_dict() if file else None})
        if message.message:
            sent_message = await message_handler.send_message(ctx.client, message.to_user, message.message, message.reply_to)
            if sent_message:
                sent.append({"tg_message_id": sent_message.id, "file": None})
        if not sent:
            return False, "Нечего отправлять", []
        return True, "", sent
    except Exception as e:
        listener_logger.error(f"[{ctx.name}] could not send to {message.to_user}: {e}")
        return False, f"Telegram не принял сообщение: {e}", sent


# ------------------------------------------------------------------ phone lookup (POST /resolve-phone)

async def resolve_phone(request: phone_lookup.PhoneLookup, send_results) -> None:
    """Answers app.py through send_results[request_id], unless app.py has already given up waiting."""
    ctx = contexts.get(int(request.user_id))
    masked = phone_lookup.mask_phone(request.phone)
    if ctx is None:
        answer = {"ok": False, "status": 400, "message": "У менеджера нет подключённого Telegram"}
    else:
        try:
            answer = await asyncio.wait_for(
                phone_lookup.lookup(ctx.client, ctx.me.id, request, profile_photo.download),
                timeout=max(1.0, request.deadline - time.time() - 1),
            )
        except asyncio.TimeoutError:
            answer = {"ok": False, "status": 503, "message": "Telegram не ответил вовремя"}
        except Exception as e:
            listener_logger.error(f"[{ctx.name}] resolve {masked}: {type(e).__name__}")
            answer = {"ok": False, "status": 502, "message": "Не удалось проверить номер в Telegram"}
        if answer.get("ok"):
            tg_id = answer["result"].get("tg_id")
            listener_logger.info(f"[{ctx.name}] resolve {masked}: {'tg ' + str(tg_id) if tg_id else 'no Telegram'}")
        else:
            listener_logger.warning(f"[{ctx.name}] resolve {masked}: {answer.get('status')} {answer.get('message')}")
    if time.time() > request.deadline:
        # app.py has already answered 503: nobody reads this answer, nor its photo
        profile_photo.remove((answer.get("result") or {}).get("photo"))
        return
    send_results[request.request_id] = answer


async def resolve_name(request: name_lookup.NameLookup, send_results) -> None:
    """POST /resolve-name: the Telegram accounts this manager's Telegram shows under a name."""
    ctx = contexts.get(int(request.user_id))
    if ctx is None:
        answer = {"ok": False, "status": 400, "message": "У менеджера нет подключённого Telegram"}
    else:
        try:
            answer = await asyncio.wait_for(
                name_lookup.lookup(ctx.client, ctx.me.id, request),
                timeout=max(1.0, request.deadline - time.time() - 1),
            )
        except asyncio.TimeoutError:
            answer = {"ok": False, "status": 503, "message": "Telegram не ответил вовремя"}
        except Exception as e:
            listener_logger.error(f"[{ctx.name}] resolve name: {type(e).__name__}")
            answer = {"ok": False, "status": 502, "message": "Не удалось найти имя в Telegram"}
        if answer.get("ok"):
            listener_logger.info(f"[{ctx.name}] resolve name: {len(answer['result']['matches'])} match(es)")
        else:
            listener_logger.warning(f"[{ctx.name}] resolve name: {answer.get('status')} {answer.get('message')}")
    if time.time() <= request.deadline:
        send_results[request.request_id] = answer


def start_lookup(request, send_results) -> None:
    """In the background: a slow lookup must not hold up messages sent from the CRM."""
    resolve = resolve_name if isinstance(request, name_lookup.NameLookup) else resolve_phone
    task = asyncio.create_task(resolve(request, send_results))
    lookup_tasks.add(task)
    task.add_done_callback(lookup_tasks.discard)


# ------------------------------------------------------------------ clients

async def create_new_client(user_id: int, session_name: str, session_string: str) -> Optional[ClientContext]:
    try:
        client = Client(name=session_name, session_string=session_string, in_memory=True)
        client.add_handler(MessageHandler(handler))
        await client.start()
        me: pyrogram.types.User = await client.get_me()
        # the session lives in memory: load the contacts once so the clients found by phone
        # (POST /resolve-phone) can be written to right after a restart
        try:
            await client.get_contacts()
        except Exception as e:  # never stops the listener
            listener_logger.warning(f"Could not load the contacts of {session_name}: {type(e).__name__}")
        ctx = ClientContext(user_id, session_name, client, me)
        contexts[user_id] = ctx
        contexts_by_name[session_name] = ctx
        failed_sessions.pop(user_id, None)
        listener_logger.info(f"Started listener for {session_name} (user {user_id}, tg {me.id})")
        return ctx
    except Exception as e:
        failed_sessions[user_id] = time.time() + config.SESSION_RETRY_SEC
        listener_logger.error(f"Could not start {session_name} (user {user_id}), retry in {config.SESSION_RETRY_SEC}s: {e}")
        return None


async def start_sessions(sessions: Dict[int, LocalSession]) -> None:
    for user_id, local_session in sessions.items():
        if user_id in contexts:
            continue
        if failed_sessions.get(user_id, 0) > time.time():
            continue
        await create_new_client(user_id, local_session.name, local_session.session_string)


async def main_loop(message_queue: multiprocessing.Queue, send_results) -> None:
    global api, db_sessions

    init_db()
    api = CrmApi(config.CRM_API_URL, config.CRM_API_TOKEN, config.SERVICE_DB, config.CRM_API_TIMEOUT)
    listener_logger.info(f"CRM API: {config.CRM_API_URL}, outbox: {api.outbox_size()} message(s) waiting")
    if recordings_enabled():
        listener_logger.info(f"call recordings: folders in {os.environ.get('RECORDINGS_SOURCE')} are sent to the API")
    else:
        listener_logger.info("call recordings folders are off (no RECORDINGS_SOURCE)")

    db_sessions = fetch_all_sessions()
    listener_logger.info(f"Found sessions: {sorted(db_sessions)}")
    await start_sessions(db_sessions)

    last_poll = 0.0
    while True:
        # messages from the CRM and phone lookups: answered through the shared dict, keyed by request id
        try:
            while not message_queue.empty():
                message = message_queue.get_nowait()
                if isinstance(message, (phone_lookup.PhoneLookup, name_lookup.NameLookup)):
                    start_lookup(message, send_results)
                    continue
                ok, reason, sent = await send_message(message)
                send_results[message.request_id] = {"ok": ok, "reason": reason, "sent": sent}
        except Exception as e:
            listener_logger.error(f"send loop: {e}")

        if time.time() - last_poll >= config.POLL_SEC:
            last_poll = time.time()
            try:
                db_sessions = fetch_all_sessions()
                await start_sessions(db_sessions)
                if api.outbox_size() > 0:
                    api.flush()
                if recordings_enabled():
                    check_for_existing_recordings(api)
            except Exception as e:
                listener_logger.error(f"poll: {e}")

        await asyncio.sleep(0.2)


def start(messages: multiprocessing.Queue, send_results) -> None:
    try:
        asyncio.run(main_loop(messages, send_results))
    except Exception as e:
        listener_logger.error(f"listener stopped: {e}")
        raise
