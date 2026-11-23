"""The listener: one Pyrogram client per connected manager.

  - every client knows its own manager (user_id, Telegram id): with two or more connected accounts
    the messages of all of them are recorded;
  - nothing is written to Postgres here: every message goes to the CRM API (POST /telegram/incoming),
    which creates the contact, the deal and the history record with the CRM's own rules and triggers.
    If the API is down the message waits in the sqlite outbox and is resent in order; a message the
    API refuses is kept aside (helpers/api_client.py). The API calls run in worker threads: a slow
    API never stops the messages of the other accounts;
  - chats are filtered (helpers/chat_filter.py): bots, Telegram's service accounts with login codes,
    groups and "Saved Messages" are never recorded;
  - edits of a message are sent too (edited: true): the CRM replaces the recorded text;
  - a message sent from the CRM is answered with what Telegram accepted; each manager has their own
    send queue, so a big upload of one manager does not hold up the others. A chat the in-memory session
    has not met since the start is looked up in the dialogs, then by the client's phone; the access hashes
    of the chats are kept in sqlite (peers) and loaded at start, so a restart does not forget them;
    a send the HTTP side stopped waiting for is recorded in the CRM by the listener when it is out;
  - the state of every session is known (helpers/session_state.py): each client is asked who it is every
    HEALTH_SEC; a session ended in Telegram (revoked on the phone) is stopped and shown as revoked, a new
    connection (a new session string) replaces the running client at once, without a restart;
  - a session that fails to start for another reason (network) is retried every SESSION_RETRY_SEC;
  - the client's profile photo goes with the first message of a chat, then at most once a day and only
    when it changed (helpers/profile_photo.py, chat.photo);
  - POST /resolve-phone, /resolve-name, GET /download and POST /logout of app.py come through the same queue.
Call recordings from the recorder's folders go to the API too (POST /calls/upload).
"""
import asyncio
import datetime
import multiprocessing
import os
import sqlite3
import time
from typing import Dict, List, Optional, Set, Tuple

import pyrogram.types
from dotenv import load_dotenv
from pyrogram import Client, raw, types
from pyrogram.handlers import EditedMessageHandler, MessageHandler

load_dotenv()  # take environment variables from .env.

from helpers import config  # noqa: E402  (after load_dotenv)
from helpers import media_download, media_type_handler, message_handler, name_lookup, phone_lookup, profile_photo, session_crypto, session_state  # noqa: E402
from helpers.api_client import CrmApi  # noqa: E402
from helpers.chat_filter import iso_date, message_payload, peer_of, reason_to_skip  # noqa: E402
from helpers.file import File  # noqa: E402
from helpers.Logger import Logger  # noqa: E402
from helpers.call_recordings_handler import check_for_existing_recordings  # noqa: E402
from helpers.session_jobs import Logout  # noqa: E402

listener_logger = Logger("listener.log")
message_logger = Logger("message.log")

REVOKED_ERRORS = {
    "Unauthorized", "AuthKeyUnregistered", "AuthKeyInvalid", "AuthKeyPermEmpty", "AuthKeyDuplicated", "SessionRevoked",
    "SessionExpired", "UserDeactivated", "UserDeactivatedBan",
}
UNKNOWN_PEER_ERRORS = {"PeerIdInvalid", "UserIdInvalid", "ChatIdInvalid", "ChannelInvalid"}
PEERS_SAVE_SEC = 600
SEND_DONE_KEEP_SEC = 900


class LocalSession:
    def __init__(self, user_id: int, name: str, session_string: str, status: Optional[str] = None, status_hash: Optional[str] = None):
        self.user_id = user_id
        self.name = name
        self.session_string = session_string
        self.status = status
        self.status_hash = status_hash


class ClientContext:
    """A started Pyrogram client and the manager it belongs to."""

    def __init__(self, user_id: int, name: str, client: Client, me: pyrogram.types.User, session_string: str = ""):
        self.user_id = user_id
        self.name = name
        self.client = client
        self.me = me
        self.session_string = session_string


# state of the listener process
contexts: Dict[int, ClientContext] = {}          # user_id -> context
contexts_by_name: Dict[str, ClientContext] = {}  # pyrogram client name -> context
failed_sessions: Dict[int, float] = {}           # user_id -> when to try again
revoked: Dict[int, str] = {}                     # user_id -> hash of the session string Telegram does not know
db_sessions: Dict[int, LocalSession] = {}
api: Optional[CrmApi] = None
photo_cache = profile_photo.PhotoCache()         # chat id -> when the client's photo was sent / checked
lookup_tasks: Set[asyncio.Task] = set()          # running /resolve-phone lookups
download_tasks: Set[asyncio.Task] = set()        # running GET /download streams
send_tasks: Set[asyncio.Task] = set()            # messages from the CRM being sent
user_locks: Dict[int, asyncio.Lock] = {}         # one send queue per manager
shared = {"states": None, "results": None, "lock": None, "done": None}


def recordings_enabled() -> bool:
    return bool(os.environ.get('RECORDINGS_SOURCE')) and os.path.isdir(os.environ.get('RECORDINGS_SOURCE', ''))


def error_name(error: BaseException) -> str:
    return type(error).__name__


def is_revoked(error: BaseException) -> bool:
    try:
        from pyrogram.errors import Unauthorized
        if isinstance(error, Unauthorized):
            return True
    except ImportError:
        pass
    return any(cls.__name__ in REVOKED_ERRORS for cls in type(error).__mro__)


def is_unknown_peer(error: BaseException) -> bool:
    return isinstance(error, (KeyError, ValueError)) or error_name(error) in UNKNOWN_PEER_ERRORS


# ------------------------------------------------------------------ session states

def set_state(user_id: int, status: str, error: Optional[str] = None, session_hash: Optional[str] = None, **extra) -> None:
    """The live state for /get-sessions and /health; a change is written to the sqlite row too."""
    states = shared["states"]
    now = time.time()
    previous = dict(states.get(user_id) or {}) if states is not None else {}
    changed = previous.get("status") != status
    since = now if changed or not previous.get("since") else previous["since"]
    state = {**previous, "user_id": user_id, "status": status, "error": error, "since": since, "checked_at": now, **extra}
    if states is not None:
        states[user_id] = state
    if changed or previous.get("error") != error:
        try:
            session_state.persist(config.SERVICE_DB, user_id, status, error, since, session_hash)
        except sqlite3.Error as e:
            listener_logger.warning(f"state of user {user_id} not stored: {e}")
        if changed:
            listener_logger.info(f"session of user {user_id}: {previous.get('status') or '-'} -> {status}{' (' + error + ')' if error else ''}")


def touch(user_id: int) -> None:
    states = shared["states"]
    if states is None:
        return
    state = dict(states.get(user_id) or {})
    if state:
        state["last_message_at"] = time.time()
        states[user_id] = state


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
        # the chats each session has met (access hashes): the in-memory session forgets them at a restart
        conn.execute('''
            CREATE TABLE IF NOT EXISTS peers (
                user_id INTEGER NOT NULL, peer_id INTEGER NOT NULL, access_hash INTEGER, type TEXT,
                username TEXT, phone_number TEXT, updated_at REAL, PRIMARY KEY (user_id, peer_id)
            )
        ''')
        conn.commit()
        session_state.ensure_columns(conn)
    finally:
        conn.close()
    session_crypto.encrypt_existing(config.SERVICE_DB)


def fetch_all_sessions() -> Dict[int, LocalSession]:
    conn = sqlite3.connect(config.SERVICE_DB)
    try:
        session_state.ensure_columns(conn)
        rows = conn.execute("SELECT id, user_id, name, session_string, status, status_hash FROM sessions").fetchall()
        sessions = {}
        for _, user_id, name, stored, status, status_hash in rows:
            session_string = session_crypto.decrypt(stored)
            if session_string:
                sessions[user_id] = LocalSession(user_id, name, session_string, status, status_hash)
        return sessions
    except sqlite3.Error as e:
        listener_logger.error(f"Error fetching sessions: {e}")
        return {}
    finally:
        conn.close()


def delete_session_rows(user_id: int) -> None:
    conn = sqlite3.connect(config.SERVICE_DB)
    try:
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM peers WHERE user_id = ?", (user_id,))
        conn.commit()
    finally:
        conn.close()


async def restore_peers(client: Client, user_id: int) -> int:
    """The chats this session met before the restart: written into the in-memory storage, so a reply to a
    client who wrote first works right after a deploy (no PeerIdInvalid)."""
    try:
        conn = sqlite3.connect(config.SERVICE_DB)
        try:
            rows = conn.execute(
                "SELECT peer_id, access_hash, type, username, phone_number FROM peers WHERE user_id = ?", (user_id,)
            ).fetchall()
        finally:
            conn.close()
        if rows:
            await client.storage.update_peers([tuple(r) for r in rows])
        return len(rows)
    except Exception as e:  # never stops the start
        listener_logger.warning(f"peers of user {user_id} not restored: {error_name(e)}")
        return 0


def save_peers(ctx: ClientContext) -> int:
    try:
        rows = ctx.client.storage.conn.execute(
            "SELECT id, access_hash, type, username, phone_number FROM peers WHERE type IN ('user', 'bot') AND access_hash IS NOT NULL"
        ).fetchall()
    except Exception as e:
        listener_logger.warning(f"peers of user {ctx.user_id} not read: {error_name(e)}")
        return 0
    if not rows:
        return 0
    conn = sqlite3.connect(config.SERVICE_DB)
    try:
        now = time.time()
        conn.executemany(
            "REPLACE INTO peers (user_id, peer_id, access_hash, type, username, phone_number, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(ctx.user_id, r[0], r[1], r[2], r[3], r[4], now) for r in rows],
        )
        conn.commit()
        return len(rows)
    finally:
        conn.close()


# ------------------------------------------------------------------ incoming messages

async def save_files(client: Client, message: pyrogram.types.Message) -> List[File]:
    # a big file is not downloaded: the CRM gets its name and size and fetches it on demand
    remote = media_type_handler.remote_file(message, config.MAX_AUTO_DOWNLOAD_MB)
    if remote is not None:
        return [remote]
    files: List[File] = []
    if message.voice:
        files = await media_type_handler.save_audio(client, message)
    elif getattr(message, "audio", None):
        files = await media_type_handler.save_audio_file(client, message)
    elif getattr(message, "animation", None):
        files = await media_type_handler.save_animation(client, message)
    elif message.document:
        files = await media_type_handler.save_document(client, message)
    elif message.video:
        files = await media_type_handler.save_video(client, message)
    elif message.video_note:
        files = await media_type_handler.save_video_note(client, message)
    elif message.photo:
        files = await media_type_handler.save_photo(client, message)
    elif message.sticker:
        files = await media_type_handler.save_sticker(client, message)
    else:
        return []
    if files:
        return files
    # the download failed: the CRM gets a link that fetches the file from Telegram later, never nothing
    return [media_type_handler.remote_file(message, 0.000001) or File("Файл", "", "document", message.caption, remote=True)]


def remove_files(files: List[File]) -> None:
    for file in files:
        if file is None or not file.path:
            continue
        path = os.path.join(config.UPLOADS_DIR, os.path.basename(file.path))
        try:
            os.remove(path)
        except OSError:
            pass


async def deliver(payload: dict) -> Optional[dict]:
    """POST /telegram/incoming in a worker thread: the event loop of all the accounts goes on meanwhile."""
    return await asyncio.to_thread(api.deliver, payload)


async def handler(client: Client, message: pyrogram.types.Message) -> None:
    """Every message of a private chat of the manager, incoming or sent from the phone."""
    await handle(client, message, edited=False)


async def edited_handler(client: Client, message: pyrogram.types.Message) -> None:
    """A message edited in Telegram: only the new text goes to the CRM (the files stay as they were)."""
    await handle(client, message, edited=True)


async def handle(client: Client, message: pyrogram.types.Message, edited: bool) -> None:
    ctx = contexts_by_name.get(client.name)
    if ctx is None:
        listener_logger.warning(f"message for an unknown client {client.name}, skipped")
        return
    reason = reason_to_skip(message, ctx.me.id)
    if reason:
        message_logger.info(f"[{ctx.name}] chat {message.chat.id} message {message.id} skipped{' (edit)' if edited else ''}: {reason}")
        return
    touch(ctx.user_id)

    files = [] if edited else await save_files(client, message)
    photo = profile_photo.PHOTO_UNCHANGED if edited else await profile_photo.fresh_photo(client, peer_of(message, ctx.me.id), photo_cache)
    payload, peer = message_payload(message, ctx.me.id, ctx.user_id, files, photo=photo, edited=edited)
    result = await deliver(payload)
    if result is None:
        message_logger.info(f"[{ctx.name}] message {message.id} from chat {peer['tg_id']} not taken by the API now (outbox / rejected)")
        return
    status = result.get("status")
    if status == "ignored":
        # the API decided the chat is not for the CRM (a colleague, «Не клиент», known contacts only): no files either
        remove_files(files)
        if isinstance(photo, str):
            profile_photo.remove(photo)
    message_logger.info(
        f"[{ctx.name}] message {message.id}{' (edit)' if edited else ''} from chat {peer['tg_id']}: {status}"
        f"{' (' + str(result.get('reason')) + ')' if result.get('reason') else ''}, deals {result.get('deal_ids')}"
    )


# ------------------------------------------------------------------ outgoing (from the CRM)

async def deliver_parts(ctx: ClientContext, message: message_handler.Message, sent: List[dict]) -> None:
    """Files first, then the text (in parts of 4096 characters); `sent` grows with every part that went out."""
    if message.files:
        done: List[Tuple[pyrogram.types.Message, Optional[File]]] = []
        try:
            await message_handler.send_files(ctx.client, message.to_user, message.files, done)
        finally:
            for sent_message, file in done:
                sent.append({"tg_message_id": sent_message.id, "file": file.convert_to_dict() if file else None})
    for part in message_handler.split_text(message.message or ""):
        sent_message = await message_handler.send_message(ctx.client, message.to_user, part, message.reply_to)
        if sent_message:
            sent.append({"tg_message_id": sent_message.id, "file": None})


async def find_peer(ctx: ClientContext, message: message_handler.Message) -> bool:
    """A chat the in-memory session has not met: the latest dialogs, then the client's phone (imported into
    the manager's Telegram contacts, as /resolve-phone does)."""
    try:
        async for _ in ctx.client.get_dialogs(limit=500):
            pass
        await ctx.client.resolve_peer(int(message.to_user))
        return True
    except Exception as e:
        listener_logger.info(f"[{ctx.name}] chat {message.to_user} not in the dialogs: {error_name(e)}")
    phone = phone_lookup.normalize_phone(getattr(message, "to_phone", None) or "")
    if not phone:
        return False
    try:
        contact = types.InputPhoneContact(phone, phone, "")
        imported = await ctx.client.invoke(raw.functions.contacts.ImportContacts(contacts=[contact]), sleep_threshold=0)
        users = getattr(imported, "users", None) or []
        if users and hasattr(ctx.client, "fetch_peers"):
            await ctx.client.fetch_peers(users)
        await ctx.client.resolve_peer(int(message.to_user))
        return True
    except Exception as e:
        listener_logger.warning(f"[{ctx.name}] chat {message.to_user} not found by phone {phone_lookup.mask_phone(phone)}: {error_name(e)}")
        return False


async def send_message(message: message_handler.Message) -> Tuple[bool, str, list]:
    """Returns (ok, reason, [{tg_message_id, file}])."""
    user_id = int(message.from_user)
    ctx = contexts.get(user_id)
    if ctx is None:
        state = (shared["states"] or {}).get(user_id) or {}
        if state.get("status") == "revoked":
            return False, "Ваш Telegram отключён в самом Telegram (сеанс завершён): подключите его заново (Телеграм → Подключить)", []
        return False, "У менеджера нет подключённого Telegram", []
    sent: List[dict] = []
    try:
        try:
            await deliver_parts(ctx, message, sent)
        except Exception as e:
            # nothing went out yet and Telegram does not know the chat in this session: look it up, try once more
            if sent or not is_unknown_peer(e) or not await find_peer(ctx, message):
                raise
            await deliver_parts(ctx, message, sent)
        if not sent:
            return False, "Нечего отправлять", []
        return True, "", sent
    except Exception as e:
        listener_logger.error(f"[{ctx.name}] could not send to {message.to_user} after {len(sent)} part(s): {error_name(e)} {e}")
        if is_revoked(e):
            await revoke(ctx, e)
        reason = "Telegram не знает этот чат в вашем аккаунте: попросите клиента написать вам ещё раз" if is_unknown_peer(e) else f"Telegram не принял сообщение: {e}"
        return False, reason, sent


def late_payload(ctx: ClientContext, message: message_handler.Message, sent: List[dict]) -> dict:
    """A send the HTTP side stopped waiting for, recorded in the CRM like a message sent from the phone (the deal is kept)."""
    return {
        "agent_id": ctx.user_id,
        "agent_tg_id": ctx.me.id,
        "chat": {"tg_id": int(message.to_user)},
        "tg_message_id": sent[-1]["tg_message_id"],
        "text": (message.message or "") if any(not s.get("file") for s in sent) else "",
        "outgoing": True,
        "date": iso_date(datetime.datetime.now()),
        "files": [s["file"] for s in sent if s.get("file")],
        "contact": None,
        "location": None,
        "deal_id": int(message.deal_id) if getattr(message, "deal_id", None) else None,
    }


async def send_job(message: message_handler.Message) -> None:
    """One message from the CRM: in the manager's own queue; the answer goes to app.py, or — when app.py has
    given up waiting — the sent parts go to the CRM directly, so the history is complete."""
    user_id = int(message.from_user)
    lock = user_locks.setdefault(user_id, asyncio.Lock())
    async with lock:
        ok, reason, sent = await send_message(message)
    result = {"ok": ok, "reason": reason, "sent": sent}
    results, done = shared["results"], shared["done"]
    with shared["lock"]:
        abandoned = results.pop(message.request_id + ":abandoned", None)
        if not abandoned:
            results[message.request_id] = result
        done[message.request_id] = {**result, "at": time.time()}
    ctx = contexts.get(user_id)
    if abandoned and sent and ctx is not None:
        payload = late_payload(ctx, message, sent)
        answer = await deliver(payload)
        listener_logger.info(f"[{ctx.name}] late send {message.request_id} recorded in the CRM: {answer.get('status') if answer else 'outbox'}")


def prune_done() -> None:
    done = shared["done"]
    if done is None:
        return
    limit = time.time() - SEND_DONE_KEEP_SEC
    for key, value in list(done.items()):
        if (value or {}).get("at", 0) < limit:
            done.pop(key, None)


# ------------------------------------------------------------------ big files on demand (GET /download)

def start_download(request: media_download.MediaDownload, send_results) -> None:
    ctx = contexts.get(int(request.user_id))
    if ctx is None:
        send_results[request.request_id] = {"ok": False, "status": 400, "message": "У менеджера нет подключённого Telegram"}
        return
    task = asyncio.get_running_loop().create_task(
        media_download.run_download(ctx.client, request, send_results, listener_logger.error))
    download_tasks.add(task)
    task.add_done_callback(download_tasks.discard)


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

def forget(ctx: ClientContext) -> None:
    if contexts.get(ctx.user_id) is ctx:
        contexts.pop(ctx.user_id, None)
    if contexts_by_name.get(ctx.name) is ctx:
        contexts_by_name.pop(ctx.name, None)


async def stop_client(ctx: ClientContext) -> None:
    forget(ctx)
    try:
        save_peers(ctx)
    except Exception:
        pass
    try:
        await asyncio.wait_for(ctx.client.stop(), 20)
    except Exception as e:
        listener_logger.warning(f"[{ctx.name}] stop: {error_name(e)}")


async def revoke(ctx: ClientContext, error: BaseException) -> None:
    """Telegram does not know the session any more: the client stops, the state says so until a new connection."""
    revoked[ctx.user_id] = session_state.string_hash(ctx.session_string)
    set_state(ctx.user_id, "revoked", f"{error_name(error)}", session_hash=revoked[ctx.user_id])
    await stop_client(ctx)


async def create_new_client(user_id: int, session_name: str, session_string: str) -> Optional[ClientContext]:
    set_state(user_id, "starting")
    client = Client(name=session_name, session_string=session_string, in_memory=True)
    try:
        client.add_handler(MessageHandler(handler))
        client.add_handler(EditedMessageHandler(edited_handler))
        await client.start()
        me: pyrogram.types.User = await client.get_me()
        restored = await restore_peers(client, user_id)
        # load the contacts once so the clients found by phone (POST /resolve-phone) can be written to right after a restart
        try:
            await client.get_contacts()
        except Exception as e:  # never stops the listener
            listener_logger.warning(f"Could not load the contacts of {session_name}: {type(e).__name__}")
        ctx = ClientContext(user_id, session_name, client, me, session_string)
        contexts[user_id] = ctx
        contexts_by_name[session_name] = ctx
        failed_sessions.pop(user_id, None)
        revoked.pop(user_id, None)
        set_state(user_id, "connected", tg_id=me.id, username=getattr(me, "username", None),
                  phone=("+" + str(me.phone_number).lstrip("+")) if getattr(me, "phone_number", None) else None)
        listener_logger.info(f"Started listener for {session_name} (user {user_id}, tg {me.id}), {restored} known chat(s) restored")
        return ctx
    except Exception as e:
        h = session_state.string_hash(session_string)
        if is_revoked(e):
            revoked[user_id] = h
            set_state(user_id, "revoked", error_name(e), session_hash=h)
            listener_logger.error(f"Could not start {session_name} (user {user_id}): the session was ended in Telegram ({error_name(e)}); waiting for a new connection")
        else:
            failed_sessions[user_id] = time.time() + config.SESSION_RETRY_SEC
            set_state(user_id, "error", f"{error_name(e)}: {e}"[:200], session_hash=h)
            listener_logger.error(f"Could not start {session_name} (user {user_id}), retry in {config.SESSION_RETRY_SEC}s: {e}")
        return None


async def start_sessions(sessions: Dict[int, LocalSession]) -> None:
    # sessions removed from the database (POST /logout): their clients stop
    for user_id in [u for u in contexts if u not in sessions]:
        await stop_client(contexts[user_id])
    for user_id, local_session in sessions.items():
        h = session_state.string_hash(local_session.session_string)
        ctx = contexts.get(user_id)
        if ctx is not None:
            if ctx.session_string == local_session.session_string:
                continue
            # the manager connected again (a new session string): the new one replaces the running client now
            listener_logger.info(f"user {user_id}: a new Telegram session, restarting the client")
            await stop_client(ctx)
        if revoked.get(user_id) == h or (local_session.status == "revoked" and local_session.status_hash == h):
            revoked[user_id] = h
            states = shared["states"]
            if states is not None and (states.get(user_id) or {}).get("status") != "revoked":
                set_state(user_id, "revoked", "the session was ended in Telegram", session_hash=h)
            continue
        if failed_sessions.get(user_id, 0) > time.time():
            continue
        await create_new_client(user_id, local_session.name, local_session.session_string)


async def check_health() -> None:
    """Every HEALTH_SEC: each client is asked who it is; an ended session is stopped and shown as revoked."""
    for ctx in list(contexts.values()):
        try:
            await asyncio.wait_for(ctx.client.get_me(), 30)
            set_state(ctx.user_id, "connected")
        except Exception as e:
            if is_revoked(e):
                listener_logger.error(f"[{ctx.name}] the session was ended in Telegram: {error_name(e)}")
                await revoke(ctx, e)
            else:
                set_state(ctx.user_id, "error", f"{error_name(e)}"[:200])


async def logout(job: Logout, send_results) -> None:
    """POST /logout: the session is signed out of Telegram (the device disappears there) and forgotten here."""
    user_id = int(job.user_id)
    ctx = contexts.get(user_id)
    delete_session_rows(user_id)
    db_sessions.pop(user_id, None)
    failed_sessions.pop(user_id, None)
    revoked.pop(user_id, None)
    signed_out = False
    if ctx is not None:
        forget(ctx)
        try:
            await asyncio.wait_for(ctx.client.log_out(), 20)
            signed_out = True
        except Exception as e:
            listener_logger.warning(f"[{ctx.name}] log out: {error_name(e)}; the session is forgotten anyway")
            try:
                await asyncio.wait_for(ctx.client.stop(), 10)
            except Exception:
                pass
    states = shared["states"]
    if states is not None:
        states.pop(user_id, None)
    listener_logger.info(f"user {user_id}: Telegram disconnected from the CRM{' (signed out in Telegram)' if signed_out else ''}")
    send_results[job.request_id] = {"ok": True, "signed_out": signed_out}


def on_refused(payload: dict, error) -> None:
    """The API refused a message: 410 = the manager is not a staff user any more (the CRM disconnects the session)."""
    if getattr(error, "status", None) == 410:
        listener_logger.error(f"user {payload.get('agent_id')} is not a staff user in the CRM any more: messages are kept aside")


async def main_loop(message_queue: multiprocessing.Queue, send_results) -> None:
    global api, db_sessions

    init_db()
    api = CrmApi(config.CRM_API_URL, config.CRM_API_TOKEN, config.SERVICE_DB, config.CRM_API_TIMEOUT, on_refused=on_refused)
    listener_logger.info(f"CRM API: {config.CRM_API_URL}, outbox: {api.outbox_size()} message(s) waiting")
    if recordings_enabled():
        listener_logger.info(f"call recordings: folders in {os.environ.get('RECORDINGS_SOURCE')} are sent to the API")
    else:
        listener_logger.info("call recordings folders are off (no RECORDINGS_SOURCE)")

    db_sessions = fetch_all_sessions()
    listener_logger.info(f"Found sessions: {sorted(db_sessions)}")
    await start_sessions(db_sessions)

    last_poll = 0.0
    last_health = time.time()
    last_peers = time.time()
    background: Dict[str, Optional[asyncio.Task]] = {"health": None, "poll": None}

    async def poll() -> None:
        global db_sessions
        try:
            db_sessions = fetch_all_sessions()
            await start_sessions(db_sessions)
            if api.outbox_size() > 0:
                await asyncio.to_thread(api.flush)
            if recordings_enabled():
                await asyncio.to_thread(check_for_existing_recordings, api)
            prune_done()
        except Exception as e:
            listener_logger.error(f"poll: {e}")

    while True:
        # messages from the CRM and the other requests: answered through the shared dict, keyed by request id
        try:
            while not message_queue.empty():
                message = message_queue.get_nowait()
                if isinstance(message, (phone_lookup.PhoneLookup, name_lookup.NameLookup)):
                    start_lookup(message, send_results)
                    continue
                if isinstance(message, media_download.MediaDownload):
                    start_download(message, send_results)
                    continue
                if isinstance(message, Logout):
                    await logout(message, send_results)
                    continue
                task = asyncio.create_task(send_job(message))
                send_tasks.add(task)
                task.add_done_callback(send_tasks.discard)
        except Exception as e:
            listener_logger.error(f"send loop: {e}")

        now = time.time()
        if now - last_poll >= config.POLL_SEC and (background["poll"] is None or background["poll"].done()):
            last_poll = now
            background["poll"] = asyncio.create_task(poll())
        if config.HEALTH_SEC > 0 and now - last_health >= config.HEALTH_SEC and (background["health"] is None or background["health"].done()):
            last_health = now
            background["health"] = asyncio.create_task(check_health())
        if now - last_peers >= PEERS_SAVE_SEC:
            last_peers = now
            for ctx in list(contexts.values()):
                save_peers(ctx)

        await asyncio.sleep(0.2)


def start(messages: multiprocessing.Queue, send_results, session_states=None, send_lock=None, send_done=None) -> None:
    shared["states"] = session_states
    shared["results"] = send_results
    shared["lock"] = send_lock if send_lock is not None else multiprocessing.Lock()
    shared["done"] = send_done if send_done is not None else {}
    try:
        asyncio.run(main_loop(messages, send_results))
    except Exception as e:
        listener_logger.error(f"listener stopped: {e}")
        raise
