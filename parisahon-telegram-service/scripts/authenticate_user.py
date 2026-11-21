"""Connects a manager's Telegram account: code to the phone, then sign in.

Runs in its own process started by app.py. Two-step verification is supported:
when Telegram asks for the cloud password the result `needs_password` is
reported, the CRM asks the manager for the password and sends it together with
the code again (app.py puts it under "<session>-password").
"""
import asyncio
import multiprocessing
import sqlite3
from typing import Optional

from pyrogram import Client
from pyrogram.errors import SessionPasswordNeeded

from helpers import config, session_crypto
from helpers.Logger import Logger
from helpers.Session import LoginCode, ActivationResult

auth_logger = Logger("authentication.log")


async def wait_for_value(
        key: str,
        login_codes: dict,
        codes_mutex: multiprocessing.Lock,
        timeout: int = 120,
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
) -> None:
    result = ActivationResult(is_successful, reason)
    result.needs_password = needs_password
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
    try:
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
            save_activation_result(activation_results, activation_mutex, f"{session}-code", False, f"Could not send code: {e}")
            return
        save_activation_result(activation_results, activation_mutex, f"{session}-code", True)
        auth_logger.info(f"Login code has been sent for session: {session}")

        login_code = await wait_for_value(session, login_codes, codes_mutex)
        try:
            await client.sign_in(phone_number, sent_code_info.phone_code_hash, login_code)
        except SessionPasswordNeeded:
            # two-step verification: ask the CRM for the password, wait for the next /activate-auth
            password_key = f"{session}-password"
            with codes_mutex:
                password = login_codes.pop(password_key, None)
            if password is None:
                save_activation_result(activation_results, activation_mutex, session, False, "password needed", needs_password=True)
                # the manager types the code again together with the password
                await wait_for_value(session, login_codes, codes_mutex)
                password = await wait_for_value(password_key, login_codes, codes_mutex, timeout=5)
            await client.check_password(password.login_code if hasattr(password, "login_code") else password)

        save_session(user_id, session, await client.export_session_string())
        save_activation_result(activation_results, activation_mutex, session, True)
        auth_logger.info(f"Signed in: {session}")

    except Exception as e:
        auth_logger.error(f"An error occurred while authenticating '{session}': {e}")
        save_activation_result(activation_results, activation_mutex, session, False, f"Could not activate session: {e}")
    finally:
        if client is not None:
            try:
                await client.disconnect()
            except Exception:
                pass


def start(activation_results, activation_mutex, login_codes, codes_mutex, session, phone_number, tg_api_id, tg_api_hash, user_id) -> None:
    asyncio.run(execute(activation_results, activation_mutex, login_codes, codes_mutex, session, phone_number, tg_api_id, tg_api_hash, user_id))
