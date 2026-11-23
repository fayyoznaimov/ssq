import os
from .file import File
import pyrogram
from typing import Union, List, Optional, Tuple
from enum import Enum
from helpers.Logger import Logger
from dotenv import load_dotenv

load_dotenv()  # take environment variables from .env.

logger = Logger("message_handler.log")
output_dir = os.environ.get('RECORDINGS_TARGET')


class Location:
    def __init__(self, latitude: int, longitude: int):
        self.latitude = latitude
        self.longitude = longitude


class Contact:
    def __init__(self, tg_user_id: int):
        self.tg_user_id = tg_user_id


class Message:
    def __init__(
            self,
            from_user: int,
            to_user: int,
            message: Union[str, None],
            location: Union[Location, None],
            contact: Union[Contact, None],
            files: List[File],
            reply_to: Union[int, None],
            request_id: Union[str, None] = None,
            to_phone: Union[str, None] = None,
            deal_id: Union[int, None] = None,
    ):
        self.request_id = request_id
        self.from_user = from_user
        self.to_user = to_user
        self.message = message
        self.location = location
        self.contact = contact
        self.files = files
        self.reply_to = reply_to
        # the client's number: a chat the in-memory session has not met yet is found by it
        self.to_phone = to_phone
        # the deal it was written from: echoed to the CRM when the message is recorded late
        self.deal_id = deal_id


TEXT_LIMIT = 4096


def split_text(text: str, limit: int = TEXT_LIMIT) -> List[str]:
    """Telegram takes at most 4096 characters per message: longer text goes out in parts, cut at a line or a space."""
    text = text or ""
    parts = []
    while len(text) > limit:
        cut = text.rfind("\n", 0, limit)
        if cut < limit // 2:
            cut = text.rfind(" ", 0, limit)
        if cut < limit // 2:
            cut = limit
        parts.append(text[:cut])
        text = text[cut:].lstrip("\n ")
    if text:
        parts.append(text)
    return parts


class AcceptableMediaTypesEnum(Enum):
    VOICE = 'voice'
    PHOTO = 'photo'
    VIDEO = 'video'
    DOCUMENT = 'document'
    AUDIO = 'audio'


async def send_message(client: pyrogram.Client, chat_id: int, text: str, reply_to: int = None) -> pyrogram.types.Message:
    return await client.send_message(chat_id=chat_id, text=text, reply_to_message_id=reply_to)


async def send_files(
        client: pyrogram.Client,
        chat_id: int,
        files: List[File],
        sent_messages: Optional[List[Tuple[pyrogram.types.Message, Optional[File]]]] = None,
) -> List[Tuple[pyrogram.types.Message, File]]:
    """Sends the files in order. `sent_messages` (when given) is filled as they go out, so a caller still
    knows what the client got when a later file fails."""

    if sent_messages is None:
        sent_messages = []

    for file in files:
        sent_message = None
        file.path = f"{output_dir}/{os.path.basename(file.path)}"

        if file.media_type == AcceptableMediaTypesEnum.VOICE.value:
            sent_message = await send_voice(client, chat_id, file)
        if file.media_type == AcceptableMediaTypesEnum.PHOTO.value:
            sent_message = await send_photo(client, chat_id, file)
        if file.media_type == AcceptableMediaTypesEnum.VIDEO.value:
            sent_message = await send_video(client, chat_id, file)
        if file.media_type == AcceptableMediaTypesEnum.DOCUMENT.value:
            sent_message = await send_document(client, chat_id, file)
        if file.media_type == AcceptableMediaTypesEnum.AUDIO.value:
            sent_message = await send_audio(client, chat_id, file)

        if sent_message:
            sent_messages.append((sent_message, file))

    return sent_messages


async def send_voice(client: pyrogram.Client, chat_id: int, file: File) -> Optional[pyrogram.types.Message]:
    return await client.send_voice(chat_id=chat_id, voice=file.path, caption=file.caption)


async def send_photo(client: pyrogram.Client, chat_id: int, file: File) -> Optional[pyrogram.types.Message]:
    return await client.send_photo(chat_id=chat_id, photo=file.path, caption=file.caption)


async def send_video(client: pyrogram.Client, chat_id: int, file: File) -> Optional[pyrogram.types.Message]:
    return await client.send_video(chat_id=chat_id, video=file.path, caption=file.caption, file_name=file.name)


async def send_document(client: pyrogram.Client, chat_id: int, file: File) -> Optional[pyrogram.types.Message]:
    return await client.send_document(chat_id=chat_id, document=file.path, caption=file.caption, file_name=file.name)


async def send_audio(client: pyrogram.Client, chat_id: int, file: File) -> Optional[pyrogram.types.Message]:
    return await client.send_audio(chat_id=chat_id, audio=file.path, caption=file.caption, file_name=file.name)
