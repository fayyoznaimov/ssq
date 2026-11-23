"""Connects a manager's Telegram account: code to the phone, then sign in.

Runs in its own process started by app.py, one process per manager (two managers connecting at the
same time do not disturb each other). Two-step verification is supported: when Telegram asks for the
cloud password the result `needs_password` is reported, the CRM asks the manager for the password and
sends it together with the code again (app.py puts it under "<session>-password").
A wrong code or password is reported (`retry`) and the process waits for the next try with the SAME
code (no new code needed, Telegram limits how many are sent); up to MAX_TRIES tries, and the manager
has AUTH_CODE_WAIT_SEC (5 minutes) for each step. Every error is told in Russian.
"""
import asyncio
import multiprocessing
import os
import sqlite3
from typing import Optional

from pyrogram import Client
from pyrogram.errors import SessionPasswordNeeded

from helpers import config, session_crypto
from helpers.Logger import Logger
from helpers.Session import LoginCode, ActivationResult

auth_logger = Logger("authentication.log")

CODE_WAIT_SEC = int(os.environ.get("AUTH_CODE_WAIT_SEC", "300"))
MAX_TRIES = 5


class TooManyTries(Exception):
    pass


def russian(error: BaseException) -> str:
    """What the manager reads in the CRM when Telegram refused."""
    name = type(error).__name__
    if isinstance(error, TimeoutError):
        return "Время на ввод кода истекло (5 минут): нажмите «Подключить» ещё раз"
    if isinstance(error, TooManyTries):
        return "Слишком много неверных попыток: нажмите «Подключить» ещё раз и введите новый код"
    known = {
        "PhoneNumberInvalid": "Telegram не принял номер телефона из профиля: проверьте номер (с кодом страны)",
        "PhoneNumberBanned": "Этот номер заблокирован в Telegram",
        "PhoneNumberUnoccupied": "На этот номер не зарегистрирован Telegram",
        "PhoneNumberFlood": "Telegram временно ограничил вход с этого номера: попробуйте позже",
        "PhoneCodeExpired": "Код устарел: нажмите «Подключить» ещё раз и введите новый код",
        "PhoneCodeEmpty": "Введите код из Telegram",
        "ApiIdInvalid": "Неверные TELEGRAM_API_ID / TELEGRAM_API_HASH на сервере",
        "AuthRestart": "Telegram попросил начать заново: нажмите «Подключить» ещё раз",
    }
    if name == "FloodWait":
        seconds = int(getattr(error, "value", 0) or 0)
        return f"Telegram ограничил попытки входа: повторите через {max(1, seconds // 60 + (1 if seconds % 60 else 0))} мин"
    return known.get(name) or f"Telegram не подключён: {name}"


async def wait_for_value(
        key: str,
        login_codes: dict,
        codes_mutex: multiprocessing.Lock,
        timeout: int = CODE_WAIT_SEC,
) -> Optional[str]:
    auth_logger.info(f"Waiting for {key}")
    timer = 0
    while timer < timeout:
        if key in login_codes:
            with codes_mutex:
                if key in login_codes:
                    value = login_codes[key].login_code
                    del login_codes[key]
                    return value
        await asyncio.sleep(1)
        timer += 1
    raise TimeoutError(f"Did not receive {key} for {timeout} seconds")


def save_session(user_id: int, name: str, session_string: str) -> None:
    try:
        db_conn = sqlite3.connect(config.SERVICE_DB)
        cursor = db_conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY, user_id INTEGER, name VARCHAR(255), session_string TEXT
            )
        ''')
        session_string = session_crypto.encrypt(session_string)
        cursor.execute("SELECT id FROM sessions WHERE user_id = ?", (user_id,))
        if cursor.fetchone():
            cursor.execute("UPDATE sessions SET session_string = ?, name = ? WHERE user_id = ?", (session_string, name, user_id))
            auth_logger.info(f"Session string updated for: {name}")
        else:
            cursor.execute("INSERT INTO sessions (user_id, name, session_string) VALUES (?, ?, ?)", (user_id, name, session_string))
            auth_logger.info(f"Session string created for: {name}")
        db_conn.commit()
        cursor.close()
        db_conn.close()
    except sqlite3.Error as e:
        auth_logger.error(f"Error saving session: {e}")


def save_activation_result(
        activation_results: dict,
        activation_mutex: multiprocessing.Lock,
        session: str,
        is_successful: bool = False,
        reason: str = "",
        needs_password: bool = False,
        retry: bool = False,
        **extra,
) -> None:
    result = ActivationResult(is_successful, reason)
    result.needs_password = needs_password
    result.retry = retry
    for key, value in extra.items():
        setattr(result, key, value)
    with activation_mutex:
        activation_results[session] = result


async def execute(
        activation_results: dict,
        activation_mutex: multiprocessing.Lock,
        login_codes: dict,
        codes_mutex: multiprocessing.Lock,
        session: str,
        phone_number: str,
        tg_api_id,
        tg_api_hash: str,
        user_id: int,
) -> None:
    client: Optional[Client] = None

    def report(ok: bool, reason: str = "", **flags) -> None:
        save_activation_result(activation_results, activation_mutex, session, ok, reason, **flags)

    async def next_password() -> str:
        """The CRM sends the code again together with the password; a code without it asks again."""
        while True:
            await wait_for_value(session, login_codes, codes_mutex)
            try:
                return await wait_for_value(f"{session}-password", login_codes, codes_mutex, timeout=5)
            except TimeoutError:
                report(False, "Введите облачный пароль Telegram вместе с кодом", needs_password=True, retry=True)

    try:
        from pyrogram.errors import PasswordHashInvalid, PhoneCodeInvalid
        auth_logger.info(f"Authentication process started for: {session}")
        client = Client(
            name=session,
            phone_number=phone_number,
            api_id=int(tg_api_id),
            api_hash=str(tg_api_hash),
            in_memory=True,
        )
        await client.connect()

        try:
            sent_code_info = await client.send_code(phone_number)
        except Exception as e:
            auth_logger.error(f"send code for {session}: {type(e).__name__}")
            save_activation_result(activation_results, activation_mutex, f"{session}-code", False, russian(e))
            return
        save_activation_result(activation_results, activation_mutex, f"{session}-code", True)
        auth_logger.info(f"Login code has been sent for session: {session}")

        for attempt in range(1, MAX_TRIES + 1):
            login_code = await wait_for_value(session, login_codes, codes_mutex)
            try:
                await client.sign_in(phone_number, sent_code_info.phone_code_hash, login_code)
                break
            except SessionPasswordNeeded:
                # two-step verification: the password may have come with the code, else the CRM asks for it
                with codes_mutex:
                    given = login_codes.pop(f"{session}-password", None)
                password = given.login_code if given is not None and hasattr(given, "login_code") else given
                if password is None:
                    report(False, "Нужен облачный пароль Telegram (двухэтапная проверка)", needs_password=True)
                    password = await next_password()
                for _ in range(MAX_TRIES):
                    try:
                        await client.check_password(password)
                        break
                    except PasswordHashInvalid:
                        report(False, "Неверный облачный пароль: введите его ещё раз (код тот же)", needs_password=True, retry=True)
                        password = await next_password()
                else:
                    raise TooManyTries()
                break
            except PhoneCodeInvalid:
                if attempt == MAX_TRIES:
                    raise TooManyTries()
                report(False, "Неверный код: проверьте его и введите ещё раз (новый код не нужен)", retry=True)
        else:
            raise TooManyTries()

        me = await client.get_me()
        save_session(user_id, session, await client.export_session_string())
        report(True, "", tg_id=getattr(me, "id", None),
               phone=("+" + str(me.phone_number).lstrip("+")) if getattr(me, "phone_number", None) else None)
        auth_logger.info(f"Signed in: {session}")

    except Exception as e:
        auth_logger.error(f"An error occurred while authenticating '{session}': {type(e).__name__}")
        report(False, russian(e))
    finally:
        if client is not None:
            try:
                await client.disconnect()
            except Exception:
                pass


def start(activation_results, activation_mutex, login_codes, codes_mutex, session, phone_number, tg_api_id, tg_api_hash, user_id) -> None:
    asyncio.run(execute(activation_results, activation_mutex, login_codes, codes_mutex, session, phone_number, tg_api_id, tg_api_hash, user_id))
