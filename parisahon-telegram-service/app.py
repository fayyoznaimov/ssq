"""HTTP side of parisahon-telegram-service (Flask), called only by the CRM API.

Every route except GET /health needs the header X-Telegram-Service-Token = SERVICE_HTTP_TOKEN (default
CRM_API_TOKEN, the same shared secret the service sends to the API): otherwise 401.

  POST /send-code      {session, phone, api_id, api_hash, user_id}  -> code sent to the phone; one login
                       process per manager (two managers connecting at once do not disturb each other)
  POST /activate-auth  {session, code, password?}  -> session saved ({tg_id, phone} of the account);
                       400 + needs_password when the account has two-step verification and no password was
                       given; 400 + retry when the code or the password was wrong (enter it again, no new code)
  GET  /get-sessions   connected managers [{user_id, name, status, error, since, tg_id, username, phone,
                       last_message_at}]: status connected | starting | error | revoked (ended in Telegram)
  POST /logout         {user_id} -> the session is signed out of Telegram and forgotten
  POST /new-message    {from_user, to_user, to_phone?, message, files, reply_to, deal_id?, request_id?} ->
                       sent through the manager's account; answers {sent: [{tg_message_id, file}]} or an error
                       (with the parts that were sent before it). 504 + pending when Telegram is still busy
                       after SEND_TIMEOUT_SEC: the listener records the message in the CRM itself when it is
                       out. The same request_id again (a repeated click) is not sent twice: the first answer
                       is repeated, or awaited while it is still being sent.
  POST /resolve-phone  {user_id, phone, first_name?, last_name?} -> 200 {tg_id|null, username, first_name,
                       last_name, photo|null}: is there a Telegram account behind the number, looked up with
                       that manager's account (the number stays in their Telegram contacts); 400 {message}
                       no session / bad phone, 429 {message, retry_after?} Telegram's flood limit,
                       503 {message} the listener is not running or did not answer in RESOLVE_TIMEOUT_SEC
  POST /resolve-name   {user_id, name} -> 200 {matches: [{tg_id, phone|null, username, first_name, last_name}]}:
                       whom that manager's Telegram shows under this name (contacts, then the latest chats);
                       a call recorder knows a Telegram call by the name only. Errors as /resolve-phone.
  GET  /download       ?user_id&chat_id&message_id -> the file of that message, streamed from Telegram
                       through the manager's account (files above TG_MAX_AUTO_DOWNLOAD_MB are not saved
                       in the CRM; this fetches one when somebody asks for it). Nothing is kept here.
                       400 no session, 404 the message or file is gone, 502/504 Telegram did not answer
  GET  /health         {ok, sessions, connected, states, problems, outbox, outbox_oldest_sec, rejected, ffmpeg}, no token

The listener (listener_session_string.py) runs in a separate process; the two
talk through a multiprocessing queue and manager dicts.
"""
import hmac
import os
import sqlite3
import tempfile
import threading
import time
import uuid
import multiprocessing
from typing import Dict, List
from urllib.parse import quote

from dotenv import load_dotenv
from flask import Flask, Response, request, jsonify

load_dotenv()  # take environment variables from .env.

from helpers import config  # noqa: E402
from helpers.Logger import Logger  # noqa: E402
from helpers.Session import LoginCode, ActivationResult  # noqa: E402
from helpers.message_handler import Message, Location, Contact  # noqa: E402
from helpers.file import File  # noqa: E402
from helpers import converter as ffmpeg_lookup, media_download, name_lookup, phone_lookup, session_state  # noqa: E402
from helpers.session_jobs import Logout  # noqa: E402
from scripts import authenticate_user  # noqa: E402

app = Flask(__name__)
logger = Logger("main.log")

manager = multiprocessing.Manager()

auth_processes: Dict[str, multiprocessing.Process] = {}   # session -> its login process
listener_process: multiprocessing.Process = None

# Shared memory
session_login_codes: dict = manager.dict()          # session -> LoginCode (and "<session>-password" -> LoginCode)
session_activation_results: dict = manager.dict()   # signal -> ActivationResult
send_results: dict = manager.dict()                 # request id -> {ok, reason, sent}
send_done: dict = manager.dict()                    # request id -> {ok, reason, sent, at}: answers kept 15 min
session_states: dict = manager.dict()               # user id -> state of the session (helpers/session_state.py)
new_messages: multiprocessing.Queue = multiprocessing.Queue()

# Mutexes
login_code_mutex = multiprocessing.Lock()
activation_result_mutex = multiprocessing.Lock()
send_lock = multiprocessing.Lock()                  # the hand-over of a send result between the two processes
requests_lock = threading.Lock()                    # the same request_id twice at once (Flask threads)
in_flight: Dict[str, float] = {}

SEND_TIMEOUT_SEC = int(os.environ.get("SEND_TIMEOUT_SEC", "60"))
RESOLVE_TIMEOUT_SEC = float(os.environ.get("RESOLVE_TIMEOUT_SEC", "20"))
DOWNLOAD_START_TIMEOUT_SEC = float(os.environ.get("DOWNLOAD_START_TIMEOUT_SEC", "45"))
LOGOUT_TIMEOUT_SEC = 40


# ------------------------------------------------------------------ the shared token (TG-15)

def token_matches(given: str) -> bool:
    expected = (config.HTTP_API_TOKEN or "").strip()
    if not expected or not given:
        return False
    return hmac.compare_digest(given.strip().encode(), expected.encode())


@app.before_request
def require_token():
    if request.path == "/health":
        return None
    if not token_matches(request.headers.get("X-Telegram-Service-Token", "")):
        return jsonify({"message": "Нет доступа к Telegram-сервису"}), 401
    return None


# ------------------------------------------------------------------ sessions

def fetch_all_db_sessions() -> List[dict]:
    try:
        return session_state.merged(session_state.stored_rows(config.SERVICE_DB), session_states)
    except sqlite3.Error as e:
        logger.error(f"Error fetching sessions: {e}")
        return []


def has_session(user_id: int) -> bool:
    return any(str(row["user_id"]) == str(user_id) for row in fetch_all_db_sessions())


def outbox_stats() -> dict:
    try:
        conn = sqlite3.connect(config.SERVICE_DB)
        try:
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()}
            size, oldest = conn.execute("SELECT count(*), min(created_at) FROM outbox").fetchone() if "outbox" in tables else (0, None)
            rejected = conn.execute("SELECT count(*) FROM rejected").fetchone()[0] if "rejected" in tables else 0
            return {"outbox": size, "outbox_oldest_sec": int(time.time() - oldest) if oldest else 0, "rejected": rejected}
        finally:
            conn.close()
    except sqlite3.Error:
        return {"outbox": 0, "outbox_oldest_sec": 0, "rejected": 0}


def wait_for_signal_and_send_response(signal: str, timeout: int = 50):
    """Waits for the login process to report on `signal` and turns the report into an HTTP answer."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with activation_result_mutex:
            if signal in session_activation_results:
                result: ActivationResult = session_activation_results.pop(signal)
                if result.is_activated:
                    answer = {"message": "Telegram подключён"}
                    for key in ("tg_id", "phone"):
                        if getattr(result, key, None):
                            answer[key] = getattr(result, key)
                    return jsonify(answer), 200
                payload = {"message": result.reason or "Telegram не подключён"}
                if getattr(result, "needs_password", False):
                    payload["needs_password"] = True
                if getattr(result, "retry", False):
                    payload["retry"] = True
                return jsonify(payload), 400
        time.sleep(0.5)
    logger.warning(f"Did not receive signal in {timeout} seconds: {signal}")
    return jsonify({"message": "Telegram не ответил вовремя, попробуйте ещё раз"}), 504


def forget_results(session: str) -> None:
    """A new attempt: nothing of the previous one may be taken for its answer."""
    with activation_result_mutex:
        for key in (session, f"{session}-code"):
            session_activation_results.pop(key, None)
    with login_code_mutex:
        for key in (session, f"{session}-password"):
            session_login_codes.pop(key, None)


@app.route("/send-code", methods=["POST"])
def send_code():
    try:
        body = request.json or {}
        session = body.get("session")
        phone = body.get("phone")
        if not session or not phone:
            return jsonify({"message": "session and phone are required"}), 400
        logger.info(f"starting authentication process for: {session}")
        previous = auth_processes.get(session)
        if previous is not None and previous.is_alive():
            # the same manager asked for a new code: only their own previous attempt ends
            previous.terminate()
        forget_results(session)
        process = multiprocessing.Process(
            target=authenticate_user.start,
            args=(
                session_activation_results, activation_result_mutex,
                session_login_codes, login_code_mutex,
                session, phone, body.get("api_id"), body.get("api_hash"), body.get("user_id"),
            ),
        )
        process.start()
        for name, other in list(auth_processes.items()):
            if not other.is_alive():
                auth_processes.pop(name, None)
        auth_processes[session] = process
        return wait_for_signal_and_send_response(f"{session}-code")
    except Exception as e:
        logger.error(f"Something went wrong in /send-code: {e}")
        return jsonify({"message": f"Не удалось запросить код: {e}"}), 400


@app.route("/activate-auth", methods=["POST"])
def activate_auth():
    try:
        body = request.json or {}
        session = body.get("session")
        code = body.get("code")
        password = body.get("password")
        if not session or not code:
            return jsonify({"message": "session and code are required"}), 400
        process = auth_processes.get(session)
        if process is None or not process.is_alive():
            return jsonify({"message": "Код не запрашивался или устарел: нажмите «Подключить» ещё раз"}), 400
        with activation_result_mutex:
            session_activation_results.pop(session, None)
        with login_code_mutex:
            session_login_codes[session] = LoginCode(str(code))
            if password:
                session_login_codes[f"{session}-password"] = LoginCode(str(password))
        return wait_for_signal_and_send_response(session, timeout=90)
    except Exception as e:
        logger.error(f"Something went wrong in /activate-auth: {e}")
        return jsonify({"message": f"Не удалось подключить Telegram: {e}"}), 400


@app.route("/get-sessions", methods=["GET"])
def get_sessions():
    return jsonify(fetch_all_db_sessions())


@app.route("/health", methods=["GET"])
def health():
    alive = listener_process is not None and listener_process.is_alive()
    rows = fetch_all_db_sessions()
    # ffmpeg false: voice messages are kept as .ogg (FFMPEG_BIN, helpers/converter.py); the watchdog reports it
    return jsonify({"ok": alive, **session_state.health(rows), **outbox_stats(), "ffmpeg": ffmpeg_lookup.find()[2]}), 200 if alive else 503


@app.route("/logout", methods=["POST"])
def logout():
    """«Отключить» in the CRM: the session is signed out of Telegram (the device disappears there) and forgotten."""
    body = request.get_json(silent=True) or {}
    try:
        user_id = int(body.get("user_id"))
    except (TypeError, ValueError):
        return jsonify({"message": "user_id is required"}), 400
    if listener_process is None or not listener_process.is_alive():
        return jsonify({"message": "Telegram-сервис не запущен"}), 503
    job = Logout(user_id)
    new_messages.put_nowait(job)
    deadline = time.time() + LOGOUT_TIMEOUT_SEC
    while time.time() < deadline:
        result = send_results.pop(job.request_id, None)
        if result is not None:
            return jsonify({"message": "Telegram отключён", **result}), 200
        time.sleep(0.2)
    return jsonify({"message": "Telegram не ответил вовремя"}), 504


def send_answer(result: dict, repeated: bool = False):
    extra = {"repeated": True} if repeated else {}
    if result["ok"]:
        return jsonify({"message": "Отправлено", "sent": result["sent"], **extra}), 200
    reason = result.get("reason") or "Telegram не принял сообщение"
    # the manager's own side (no session, ended or offline session, nothing to send, unknown chat): 400, the CRM keeps the text
    mine = ("нет подключённого", "не подключён", "не на связи", "Нечего", "отключён", "не знает этот чат")
    status = 400 if any(part in reason for part in mine) else 502
    return jsonify({"message": reason, "sent": result.get("sent") or [], **extra}), status


@app.route("/new-message", methods=["POST"])
def send_message():
    """Sends through the manager's account and answers only when Telegram accepted the messages."""
    try:
        body = request.json or {}
        files = [File(f.get('name'), f['path'], f['media_type'], f.get('caption')) for f in (body.get('files') or [])]
        location = body.get('location')
        contact = body.get('contact')
        request_id = str(body.get('request_id') or '').strip()[:64] or uuid.uuid4().hex
        message = Message(
            from_user=int(body.get('from_user')),
            to_user=int(body.get('to_user')),
            message=body.get('message') or "",
            location=Location(location['latitude'], location['longitude']) if location else None,
            contact=Contact(contact['user_id']) if contact else None,
            files=files,
            reply_to=body.get('reply_to'),
            request_id=request_id,
            to_phone=body.get('to_phone'),
            deal_id=body.get('deal_id'),
        )
    except Exception as e:
        logger.error(f"bad /new-message body: {e}")
        return jsonify({"message": "Could not send message: bad request"}), 400

    if listener_process is None or not listener_process.is_alive():
        return jsonify({"message": "Telegram-сервис не запущен"}), 503

    # the same request again (a repeated click, a retry after a timeout): never sent twice
    with requests_lock:
        done = send_done.get(request_id)
        if done is not None and not done.get("ok") and not done.get("sent"):
            # failed before anything went out: a retry with the same id is sent again (e.g. after reconnecting)
            send_done.pop(request_id, None)
            done = None
        busy = request_id in in_flight
        if done is not None:
            in_flight.pop(request_id, None)
        elif not busy:
            in_flight[request_id] = time.time()
    if done is not None:
        return send_answer(done, repeated=True)
    if not busy:
        new_messages.put_nowait(message)
    answered = False
    try:
        deadline = time.time() + SEND_TIMEOUT_SEC
        while time.time() < deadline:
            result = send_results.pop(request_id, None) if not busy else None
            if result is None and busy:
                result = send_done.get(request_id)
            if result is not None:
                answered = True
                return send_answer(result, repeated=busy)
            time.sleep(0.2)
        with send_lock:
            result = send_results.pop(request_id, None) if not busy else send_done.get(request_id)
            if result is None and not busy:
                # the listener records it in the CRM itself when Telegram has taken it
                send_results[request_id + ":abandoned"] = True
        if result is not None:
            answered = True
            return send_answer(result, repeated=busy)
        logger.warning(f"send {request_id} to {message.to_user}: no answer in {SEND_TIMEOUT_SEC}s, recorded by the listener when sent")
        return jsonify({"message": "Telegram ещё отправляет сообщение", "pending": True}), 504
    finally:
        # still being sent after the wait: the id stays "in flight", a repeat waits for that send, never a second one
        if not busy and answered:
            with requests_lock:
                in_flight.pop(request_id, None)


@app.route("/resolve-phone", methods=["POST"])
def resolve_phone():
    """Does the phone number have Telegram? The CRM asks when a client first writes on WhatsApp."""
    try:
        lookup = phone_lookup.parse_request(request.get_json(silent=True), timeout=RESOLVE_TIMEOUT_SEC)
    except ValueError as e:
        return jsonify({"message": str(e)}), 400
    if not has_session(lookup.user_id):
        return jsonify({"message": "У менеджера нет подключённого Telegram"}), 400
    if listener_process is None or not listener_process.is_alive():
        return jsonify({"message": "Telegram-сервис не запущен"}), 503
    new_messages.put_nowait(lookup)
    while True:
        result = send_results.pop(lookup.request_id, None)
        if result is not None:
            if result.get("ok"):
                return jsonify(result["result"]), 200
            answer = {"message": result.get("message") or "Не удалось проверить номер"}
            if result.get("retry_after"):
                answer["retry_after"] = result["retry_after"]
            return jsonify(answer), int(result.get("status") or 502)
        if time.time() >= lookup.deadline:
            break
        time.sleep(0.2)
    logger.warning(f"resolve {phone_lookup.mask_phone(lookup.phone)} for user {lookup.user_id}: "
                   f"no answer in {RESOLVE_TIMEOUT_SEC:g}s")
    return jsonify({"message": "Telegram не ответил вовремя"}), 503


@app.route("/resolve-name", methods=["POST"])
def resolve_name():
    """Whom does the manager's Telegram show under this name? The CRM asks for a recorded Telegram call."""
    try:
        lookup = name_lookup.parse_request(request.get_json(silent=True), timeout=RESOLVE_TIMEOUT_SEC)
    except ValueError as e:
        return jsonify({"message": str(e)}), 400
    if not has_session(lookup.user_id):
        return jsonify({"message": "У менеджера нет подключённого Telegram"}), 400
    if listener_process is None or not listener_process.is_alive():
        return jsonify({"message": "Telegram-сервис не запущен"}), 503
    new_messages.put_nowait(lookup)
    while time.time() < lookup.deadline:
        result = send_results.pop(lookup.request_id, None)
        if result is not None:
            if result.get("ok"):
                return jsonify(result["result"]), 200
            answer = {"message": result.get("message") or "Не удалось найти имя в Telegram"}
            if result.get("retry_after"):
                answer["retry_after"] = result["retry_after"]
            return jsonify(answer), int(result.get("status") or 502)
        time.sleep(0.2)
    logger.warning(f"resolve name for user {lookup.user_id}: no answer in {RESOLVE_TIMEOUT_SEC:g}s")
    return jsonify({"message": "Telegram не ответил вовремя"}), 503


@app.route("/download", methods=["GET"])
def download():
    """A big file straight from Telegram: found and streamed by the listener, passed on while it arrives."""
    try:
        user_id = int(request.args["user_id"])
        chat_id = int(request.args["chat_id"])
        message_id = int(request.args["message_id"])
    except (KeyError, ValueError):
        return jsonify({"message": "user_id, chat_id and message_id are required"}), 400
    if not has_session(user_id):
        return jsonify({"message": "У менеджера нет подключённого Telegram"}), 400
    if listener_process is None or not listener_process.is_alive():
        return jsonify({"message": "Telegram-сервис не запущен"}), 503

    fd, path = tempfile.mkstemp(prefix="tgdl_")
    os.close(fd)
    job = media_download.MediaDownload(user_id, chat_id, message_id, path)
    rid = job.request_id
    new_messages.put_nowait(job)

    meta = None
    deadline = time.time() + DOWNLOAD_START_TIMEOUT_SEC
    while time.time() < deadline:
        meta = send_results.pop(rid, None)
        if meta is not None:
            break
        time.sleep(0.2)
    if meta is None or not meta.get("ok"):
        media_download.remove_quietly(path)
        if meta is None:
            # the listener may still pick the job up: it must not start streaming into nowhere
            send_results[rid + ":cancel"] = True
            logger.warning(f"download of message {message_id} for user {user_id}: no answer in {DOWNLOAD_START_TIMEOUT_SEC:g}s")
            return jsonify({"message": "Telegram не ответил вовремя"}), 504
        return jsonify({"message": meta.get("message") or "Не удалось получить файл"}), int(meta.get("status") or 502)

    def generate():
        try:
            yield from media_download.follow_file(path, lambda: (rid + ":done") in send_results)
        finally:
            # the browser went away before the end: tell the listener to stop
            if send_results.pop(rid + ":done", None) is None:
                send_results[rid + ":cancel"] = True
            media_download.remove_quietly(path)

    headers = {"X-File-Name": quote(str(meta.get("name") or "file"))}
    if meta.get("size"):
        headers["Content-Length"] = str(meta["size"])
    return Response(generate(), mimetype=meta.get("mime") or "application/octet-stream", headers=headers)


def start_listener() -> None:
    global listener_process
    import listener_session_string
    listener_process = multiprocessing.Process(
        target=listener_session_string.start,
        args=(new_messages, send_results, session_states, send_lock, send_done),
    )
    listener_process.start()
    logger.info("Listener process started" if listener_process.is_alive() else "Listener process could not be started")


def main_app():
    if not (config.HTTP_API_TOKEN or "").strip():
        logger.warning("Neither SERVICE_HTTP_TOKEN nor CRM_API_TOKEN is set: every route except /health answers 401")
    binary, _, ok, tried = ffmpeg_lookup.find()
    if ok:
        logger.info(f"ffmpeg: {binary}")
    else:
        logger.error(f"ffmpeg not found ({'; '.join(tried)}): voice messages stay .ogg; set FFMPEG_BIN")
    start_listener()
    app.run(debug=False, port=int(os.environ.get('PORT') or 3030), host=os.environ.get('HOST') or '0.0.0.0', threaded=True)


if __name__ == "__main__":
    main_app()
