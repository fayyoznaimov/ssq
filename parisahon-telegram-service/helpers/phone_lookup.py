"""POST /resolve-phone: does a phone number have Telegram? Looked up with a manager's own account.

Telegram finds a user by phone only through contacts.importContacts, so the number is imported into
the manager's Telegram contacts (under the given name, or the phone) and stays there: the manager can
write to the client later, and Pyrogram needs the peer for that. A number without Telegram, or one
the user hides by privacy settings, gives tg_id null. FloodWait is answered at once with 429 and the
seconds to wait, never slept through: the CRM calls this in the background.

app.py validates the request (parse_request) and puts a PhoneLookup into the listener's queue, the
same one /new-message uses; the listener runs lookup() with that manager's client and answers
through the shared results dict. Phone numbers are logged only masked (mask_phone).
"""
import re
import time
import uuid
from typing import Optional

# at import time, not inside lookup(): Pyrogram's first import needs the main thread's event loop
from pyrogram import raw, types
from pyrogram.errors import FloodWait, RPCError

PHONE_RE = re.compile(r"^\+?\d{7,15}$")
SEPARATORS_RE = re.compile(r"[\s\-().]")
NAME_MAX = 64   # Telegram's limit for a contact's first and last name

NOT_FOUND = {"tg_id": None, "username": None, "first_name": None, "last_name": None, "photo": None}


class PhoneLookup:
    """A request from app.py to the listener process (pickled through the multiprocessing queue)."""

    def __init__(self, user_id: int, phone: str, first_name: Optional[str] = None, last_name: Optional[str] = None,
                 deadline: Optional[float] = None, request_id: Optional[str] = None):
        self.user_id = user_id
        self.phone = phone
        self.first_name = first_name
        self.last_name = last_name
        self.deadline = deadline if deadline is not None else time.time() + 20
        self.request_id = request_id or uuid.uuid4().hex


def normalize_phone(value) -> Optional[str]:
    """'+998 (90) 123-45-67' -> '+998901234567'; None when it is not a phone number."""
    if not isinstance(value, str):
        return None
    compact = SEPARATORS_RE.sub("", value.strip())
    if not PHONE_RE.match(compact):
        return None
    return "+" + compact.lstrip("+")


def mask_phone(phone) -> str:
    """'+998901234567' -> '+9989******67': enough to tell numbers apart in a log, not the number."""
    text = str(phone or "")
    if len(text) <= 6:
        return "*" * len(text)
    return text[:5] + "*" * (len(text) - 7) + text[-2:]


def optional_name(value) -> Optional[str]:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:NAME_MAX] or None


def parse_request(body, timeout: float = 20) -> PhoneLookup:
    """The body of POST /resolve-phone -> PhoneLookup; ValueError(message for the 400 answer) otherwise."""
    if not isinstance(body, dict):
        raise ValueError("Нужен JSON: {user_id, phone}")
    user_id = body.get("user_id")
    if isinstance(user_id, bool) or not isinstance(user_id, (int, str)) or not str(user_id).strip().isdigit():
        raise ValueError("Нужен user_id менеджера")
    phone = normalize_phone(body.get("phone"))
    if phone is None:
        raise ValueError("Неверный номер телефона: нужен формат +998901234567")
    return PhoneLookup(
        user_id=int(str(user_id).strip()),
        phone=phone,
        first_name=optional_name(body.get("first_name")),
        last_name=optional_name(body.get("last_name")),
        deadline=time.time() + timeout,
    )


def found(user, photo: Optional[str]) -> dict:
    return {
        "tg_id": user.id,
        "username": getattr(user, "username", None) or None,
        "first_name": getattr(user, "first_name", None) or None,
        "last_name": getattr(user, "last_name", None) or None,
        "photo": photo,
    }


async def lookup(client, me_id: int, request: PhoneLookup, download_photo) -> dict:
    """{"ok": True, "result": {tg_id, username, first_name, last_name, photo}}
    or {"ok": False, "status": 429|502, "message": ..., "retry_after"?: seconds}.
    `download_photo(client, chat_photo)` -> file name or None (helpers/profile_photo.download)."""
    contact = types.InputPhoneContact(request.phone, request.first_name or request.phone, request.last_name or "")
    try:
        # sleep_threshold=0: a FloodWait of any length is raised here instead of being slept through
        imported = await client.invoke(raw.functions.contacts.ImportContacts(contacts=[contact]), sleep_threshold=0)
    except FloodWait as error:
        seconds = int(error.value or 0)
        return {"ok": False, "status": 429, "retry_after": seconds,
                "message": f"Telegram ограничил поиск по номеру, повторите через {seconds} с"}
    except RPCError as error:
        return {"ok": False, "status": 502,
                "message": f"Telegram не выполнил поиск по номеру: {getattr(error, 'ID', None) or type(error).__name__}"}

    if contact.client_id in (getattr(imported, "retry_contacts", None) or []):
        # Telegram's daily limit for importing numbers that are not in the address book yet
        return {"ok": False, "status": 429, "message": "Telegram временно ограничил поиск по номеру, повторите позже"}

    entries = list(getattr(imported, "imported", None) or [])
    user_ids = {entry.user_id for entry in entries if entry.client_id == contact.client_id} \
        or {entry.user_id for entry in entries}
    raw_user = next((u for u in (getattr(imported, "users", None) or []) if getattr(u, "id", None) in user_ids), None)
    if raw_user is None:
        return {"ok": True, "result": dict(NOT_FOUND)}
    user = types.User._parse(client, raw_user)
    if user is None or user.id == me_id or getattr(user, "is_deleted", False) or getattr(user, "is_bot", False):
        return {"ok": True, "result": dict(NOT_FOUND)}
    photo = None
    if getattr(user, "photo", None) is not None:
        try:
            photo = await download_photo(client, user.photo)
        except Exception:
            photo = None
    return {"ok": True, "result": found(user, photo)}
