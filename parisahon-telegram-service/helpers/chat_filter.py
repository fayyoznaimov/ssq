"""Which Telegram messages of a manager's account belong to the CRM.

Only private chats with people: no groups and channels, no bots, no Telegram's
own service accounts (777000 sends the login codes, which used to end up in the
deal history), no "Saved Messages", no service messages (joined, pinned, ...).
"""
from typing import Optional, Tuple

# Telegram's service accounts: login codes and notifications (777000), the old
# "Telegram Notifications" (42777), anonymous group admin and channel senders.
SERVICE_IDS = {777000, 42777, 1087968824, 136817688, 333000, 4244000}

ACCEPTED_MEDIA = ("contact", "location", "voice", "document", "video", "video_note", "photo", "sticker")

# chat.photo of the payload: left out when the CRM already has the client's current photo
# (helpers/profile_photo.py decides); otherwise a file name in the uploads folder, or None (no photo)
PHOTO_UNCHANGED = object()


def chat_type_is_private(chat) -> bool:
    chat_type = getattr(chat, "type", None)
    if chat_type is None:
        return getattr(chat, "id", 0) > 0
    value = getattr(chat_type, "value", chat_type)
    return str(value).lower().endswith("private")


def peer_of(message, me_id: int):
    """The other side of the chat: the chat itself for an outgoing message, the sender otherwise."""
    if getattr(message, "outgoing", False):
        return message.chat
    return message.from_user or message.chat


def has_content(message) -> bool:
    if getattr(message, "text", None):
        return True
    return any(getattr(message, media, None) is not None for media in ACCEPTED_MEDIA)


def reason_to_skip(message, me_id: int) -> Optional[str]:
    """None when the message must be recorded, otherwise a short reason for the log."""
    if getattr(message, "empty", False):
        return "empty"
    if getattr(message, "service", None):
        return "service message"
    chat = getattr(message, "chat", None)
    if chat is None or not chat_type_is_private(chat):
        return "not a private chat"
    peer = peer_of(message, me_id)
    if peer is None or not getattr(peer, "id", None):
        return "no peer"
    if peer.id == me_id or getattr(peer, "is_self", False):
        return "saved messages"
    if peer.id in SERVICE_IDS or getattr(peer, "is_support", False):
        return "telegram service account"
    if getattr(peer, "is_bot", False):
        return "bot"
    if not has_content(message):
        return "no text and no media"
    return None


def peer_fields(peer) -> dict:
    phone = getattr(peer, "phone_number", None)
    if phone and not str(phone).startswith("+"):
        phone = "+" + str(phone)
    return {
        "tg_id": peer.id,
        "phone": phone or None,
        "first_name": getattr(peer, "first_name", None) or None,
        "last_name": getattr(peer, "last_name", None) or None,
        "username": getattr(peer, "username", None) or None,
    }


def iso_date(date) -> Optional[str]:
    """Pyrogram gives naive datetimes in the local time of this process: send them with the offset,
    so that the API (possibly in another time zone) stores the right moment."""
    if date is None:
        return None
    if getattr(date, "tzinfo", None) is None:
        date = date.astimezone()
    return date.isoformat()


def message_payload(message, me_id: int, agent_id: int, files: list, photo=PHOTO_UNCHANGED) -> Tuple[dict, dict]:
    """(payload for POST /telegram/incoming, the peer as a dict).
    `photo`: the client's profile photo for chat.photo (a file name or None); PHOTO_UNCHANGED leaves it out."""
    peer = peer_of(message, me_id)
    chat = peer_fields(peer)
    if photo is not PHOTO_UNCHANGED:
        chat["photo"] = photo
    payload = {
        "agent_id": agent_id,
        "agent_tg_id": me_id,
        "chat": chat,
        "tg_message_id": message.id,
        "text": getattr(message, "text", None) or getattr(message, "caption", None) or "",
        "outgoing": bool(getattr(message, "outgoing", False)),
        "date": iso_date(getattr(message, "date", None)),
        "files": [f.convert_to_dict() for f in files if f is not None],
        "contact": None,
        "location": None,
    }
    contact = getattr(message, "contact", None)
    if contact:
        payload["contact"] = {
            "_": "Contact",
            "phone_number": contact.phone_number,
            "first_name": contact.first_name,
            "tg_user_id": contact.user_id,
        }
    location = getattr(message, "location", None)
    if location:
        payload["location"] = {"_": "Location", "longitude": location.longitude, "latitude": location.latitude}
    return payload, chat
