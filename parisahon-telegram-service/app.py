"""HTTP side of parisahon-telegram-service (Flask), called only by the CRM API.

  POST /send-code      {session, phone, api_id, api_hash, user_id}  -> code sent to the phone
  POST /activate-auth  {session, code, password?}  -> session saved; 400 + needs_password when the
                       account has two-step verification and no password was given
  GET  /get-sessions   connected managers [{user_id, name}]
  POST /new-message    {from_user, to_user, message, files, reply_to} -> sent synchronously,
                       answers {sent: [{tg_message_id, file}]} or an error
  POST /resolve-phone  {user_id, phone, first_name?, last_name?} -> 200 {tg_id|null, username, first_name,
                       last_name, photo|null}: is there a Telegram account behind the number, looked up with
                       that manager's account (the number stays in their Telegram contacts); 400 {message}
                       no session / bad phone, 429 {message, retry_after?} Telegram's flood limit,
                       503 {message} the listener is not running or did not answer in RESOLVE_TIMEOUT_SEC
  POST /resolve-name   {user_id, name} -> 200 {matches: [{tg_id, phone|null, username, first_name, last_name}]}:
                       whom that manager's Telegram shows under this name (contacts, then the latest chats);
                       a call recorder knows a Telegram call by the name only. Errors as /resolve-phone.
  GET  /health         {ok, sessions, outbox}

The listener (listener_session_string.py) runs in a separate process; the two
talk through a multiprocessing queue and manager dicts.
"""
import os
import sqlite3
import time
import uuid
import multiprocessing
from typing import List

from dotenv import load_dotenv
from flask import Flask, request, jsonify

load_dotenv()  # take environment variables from .env.

from helpers import config  # noqa: E402
from helpers.Logger import Logger  # noqa: E402
from helpers.Session import LoginCode, ActivationResult  # noqa: E402
from helpers.message_handler import Message, Location, Contact  # noqa: E402
from helpers.file import File  # noqa: E402
from helpers import name_lookup, phone_lookup  # noqa: E402
from scripts import authenticate_user  # noqa: E402

app = Flask(__name__)
logger = Logger("main.log")

manager = multiprocessing.Manager()

auth_process: multiprocessing.Process = None
listener_process: multiprocessing.Process = None

# Shared memory
session_login_codes: dict = manager.dict()          # session -> LoginCode (and "<session>-password" -> LoginCode)
session_activation_results: dict = manager.dict()   # signal -> ActivationResult
send_results: dict = manager.dict()                 # request id -> {ok, reason, sent}
new_messages: multiprocessing.Queue = multiprocessing.Queue()

# Mutexes
login_code_mutex = multiprocessing.Lock()
activation_result_mutex = multiprocessing.Lock()

SEND_TIMEOUT_SEC = int(os.environ.get("SEND_TIMEOUT_SEC", "60"))
RESOLVE_TIMEOUT_SEC = float(os.environ.get("RESOLVE_TIMEOUT_SEC", "20"))


def fetch_all_db_sessions() -> List[dict]:
    try:
        conn = sqlite3.connect(config.SERVICE_DB)
        try:
            rows = conn.execute("SELECT user_id, name FROM sessions WHERE session_string IS NOT NULL").fetchall()
            return [{"user_id": row[0], "name": row[1]} for row in rows]
        finally:
            conn.close()
    except sqlite3.Error as e:
        logger.error(f"Error fetching sessions: {e}")
        return []


def has_session(user_id: int) -> bool:
    return any(str(row["user_id"]) == str(user_id) for row in fetch_all_db_sessions())


def outbox_size() -> int:
    try:
        conn = sqlite3.connect(config.SERVICE_DB)
        try:
            return conn.execute("SELECT count(*) FROM outbox").fetchone()[0]
        finally:
            conn.close()
    except sqlite3.Error:
        return 0


def wait_for_signal_and_send_response(signal: str, timeout: int = 50):
    """Waits for the auth process to report on `signal` and turns the report into an HTTP answer."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with activation_result_mutex:
            if signal in session_activation_results:
                result: ActivationResult = session_activation_results.pop(signal)
                if result.is_activated:
                    return jsonify({"message": "Request processed successfully"}), 200
                payload = {"message": f"Could not process request: {result.reason}"}
                if getattr(result, "needs_password", False):
                    payload["needs_password"] = True
                    payload["message"] = "Нужен облачный пароль Telegram (двухэтапная проверка)"
                return jsonify(payload), 400
        time.sleep(0.5)
    logger.warning(f"Did not receive signal in {timeout} seconds: {signal}")
    return jsonify({"message": "Telegram не ответил вовремя, попробуйте ещё раз"}), 504


@app.route("/send-code", methods=["POST"])
def send_code():
    global auth_process
    try:
        body = request.json or {}
        session = body.get("session")
        phone = body.get("phone")
        if not session or not phone:
            return jsonify({"message": "session and phone are required"}), 400
        logger.info(f"starting authentication process for: {session}")
        if auth_process is not None and auth_process.is_alive():
            auth_process.terminate()
        auth_process = multiprocessing.Process(
            target=authenticate_user.start,
            args=(
                session_activation_results, activation_result_mutex,
                session_login_codes, login_code_mutex,
                session, phone, body.get("api_id"), body.get("api_hash"), body.get("user_id"),
            ),
        )
        auth_process.start()
        return wait_for_signal_and_send_response(f"{session}-code")
    except Exception as e:
        logger.error(f"Something went wrong in /send-code: {e}")
        return jsonify({"message": f"Something went wrong: {e}"}), 400


@app.route("/activate-auth", methods=["POST"])
def activate_auth():
    try:
        if auth_process is None or not auth_process.is_alive():
            return jsonify({"message": "Код не запрашивался или устарел: нажмите «Подключить» ещё раз"}), 400
        body = request.json or {}
        session = body.get("session")
        code = body.get("code")
        password = body.get("password")
        if not session or not code:
            return jsonify({"message": "session and code are required"}), 400
        with login_code_mutex:
            session_login_codes[session] = LoginCode(str(code))
            if password:
                session_login_codes[f"{session}-password"] = LoginCode(str(password))
        return wait_for_signal_and_send_response(session, timeout=90)
    except Exception as e:
        logger.error(f"Something went wrong in /activate-auth: {e}")
        return jsonify({"message": f"Something went wrong: {e}"}), 400


@app.route("/get-sessions", methods=["GET"])
def get_sessions():
    return jsonify(fetch_all_db_sessions())


@app.route("/health", methods=["GET"])
def health():
    alive = listener_process is not None and listener_process.is_alive()
    return jsonify({"ok": alive, "sessions": len(fetch_all_db_sessions()), "outbox": outbox_size()}), 200 if alive else 503


@app.route("/new-message", methods=["POST"])
def send_message():
    """Sends through the manager's account and answers only when Telegram accepted the messages."""
    try:
        body = request.json or {}
        files = [File(f['name'], f['path'], f['media_type'], f.get('caption')) for f in (body.get('files') or [])]
        location = body.get('location')
        contact = body.get('contact')
        message = Message(
            from_user=int(body.get('from_user')),
            to_user=int(body.get('to_user')),
            message=body.get('message') or "",
            location=Location(location['latitude'], location['longitude']) if location else None,
            contact=Contact(contact['user_id']) if contact else None,
            files=files,
            reply_to=body.get('reply_to'),
            request_id=uuid.uuid4().hex,
        )
    except Exception as e:
        logger.error(f"bad /new-message body: {e}")
        return jsonify({"message": "Could not send message: bad request"}), 400

    if listener_process is None or not listener_process.is_alive():
        return jsonify({"message": "Telegram-сервис не запущен"}), 503
    new_messages.put_nowait(message)
    deadline = time.time() + SEND_TIMEOUT_SEC
    while time.time() < deadline:
        result = send_results.pop(message.request_id, None)
        if result is not None:
            if result["ok"]:
                return jsonify({"message": "Отправлено", "sent": result["sent"]}), 200
            status = 400 if "нет подключённого" in result["reason"] or "Нечего" in result["reason"] else 502
            return jsonify({"message": result["reason"], "sent": result["sent"]}), status
        time.sleep(0.2)
    logger.warning(f"send {message.request_id} to {message.to_user}: no answer in {SEND_TIMEOUT_SEC}s")
    return jsonify({"message": "Telegram не ответил вовремя"}), 504


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


def start_listener() -> None:
    global listener_process
    import listener_session_string
    listener_process = multiprocessing.Process(target=listener_session_string.start, args=(new_messages, send_results))
    listener_process.start()
    logger.info("Listener process started" if listener_process.is_alive() else "Listener process could not be started")


def main_app():
    start_listener()
    app.run(debug=False, port=int(os.environ.get('PORT') or 3030), host=os.environ.get('HOST') or '0.0.0.0')


if __name__ == "__main__":
    main_app()
