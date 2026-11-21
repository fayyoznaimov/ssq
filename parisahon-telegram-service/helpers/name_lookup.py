"""POST /resolve-name: who in the manager's own Telegram is called this?

A call recorder on the manager's phone knows a Telegram call only by the name on the screen
("Анвар Оптовик"): the name the manager saved the contact under, or the person's own name when
they are not in the contacts. The CRM asks for the Telegram accounts behind that name to put the
recording into the deal of the right client. Read-only: the manager's contacts first, then the
people of the latest private chats. Names are not written to the log.

app.py validates the request (parse_request) and puts a NameLookup into the listener's queue, the
same one /new-message and /resolve-phone use; the listener runs lookup() with that manager's
client and answers through the shared results dict.
"""
import re
import time
import uuid
from typing import Optional

# at import time, not inside lookup(): Pyrogram's first import needs the main thread's event loop
from pyrogram import enums
from pyrogram.errors import FloodWait, RPCError

NAME_MAX = 255
DIALOGS = 300      # the latest chats looked through when nobody in the contacts has the name
MATCHES_MAX = 5
SPACES_RE = re.compile(r"\s+")


class NameLookup:
    """A request from app.py to the listener process (pickled through the multiprocessing queue)."""

    def __init__(self, user_id: int, name: str, deadline: Optional[float] = None, request_id: Optional[str] = None):
        self.user_id = user_id
        self.name = name
        self.deadline = deadline if deadline is not None else time.time() + 20
        self.request_id = request_id or uuid.uuid4().hex


def normalize(value) -> str:
    """' Анвар   ОПТОВИК ' -> 'анвар оптовик'; '' for anything that is not a name."""
    if not isinstance(value, str):
        return ""
    return SPACES_RE.sub(" ", value).strip().casefold()


def names_of(first, last) -> set:
    """How Telegram may show a person: "first last" (the call screen), and "last first" to be safe."""
    first, last = normalize(first), normalize(last)
    return {name for name in (f"{first} {last}".strip(), f"{last} {first}".strip()) if name}


def parse_request(body, timeout: float = 20) -> NameLookup:
    """The body of POST /resolve-name -> NameLookup; ValueError(message for the 400 answer) otherwise."""
    if not isinstance(body, dict):
        raise ValueError("Нужен JSON: {user_id, name}")
    user_id = body.get("user_id")
    if isinstance(user_id, bool) or not isinstance(user_id, (int, str)) or not str(user_id).strip().isdigit():
        raise ValueError("Нужен user_id менеджера")
    name = body.get("name")
    if not normalize(name) or len(name) > NAME_MAX:
        raise ValueError("Нужно имя, как оно показано в Telegram")
    return NameLookup(user_id=int(str(user_id).strip()), name=name.strip(), deadline=time.time() + timeout)


def entry(person) -> dict:
    phone = getattr(person, "phone_number", None)
    return {
        "tg_id": person.id,
        "phone": ("+" + str(phone).lstrip("+")) if phone else None,
        "username": getattr(person, "username", None) or None,
        "first_name": getattr(person, "first_name", None) or None,
        "last_name": getattr(person, "last_name", None) or None,
    }


async def lookup(client, me_id: int, request: NameLookup) -> dict:
    """{"ok": True, "result": {"matches": [{tg_id, phone, username, first_name, last_name}]}} (at most
    MATCHES_MAX, none when nobody is called so) or {"ok": False, "status": 429|502, "message": ...}."""
    wanted = normalize(request.name)
    matches = {}

    def consider(person) -> None:
        if person is None or person.id == me_id or person.id in matches:
            return
        if getattr(person, "is_bot", False) or getattr(person, "is_deleted", False):
            return
        if wanted in names_of(getattr(person, "first_name", None), getattr(person, "last_name", None)):
            matches[person.id] = entry(person)

    try:
        for contact in await client.get_contacts():
            consider(contact)
        if not matches:
            async for dialog in client.get_dialogs(limit=DIALOGS):
                chat = getattr(dialog, "chat", None)
                if chat is not None and chat.type == enums.ChatType.PRIVATE:
                    consider(chat)
    except FloodWait as error:
        seconds = int(error.value or 0)
        return {"ok": False, "status": 429, "retry_after": seconds,
                "message": f"Telegram ограничил запросы, повторите через {seconds} с"}
    except RPCError as error:
        return {"ok": False, "status": 502,
                "message": f"Telegram не отдал контакты: {getattr(error, 'ID', None) or type(error).__name__}"}
    return {"ok": True, "result": {"matches": list(matches.values())[:MATCHES_MAX]}}
