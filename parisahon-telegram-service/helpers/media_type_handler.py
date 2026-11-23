import asyncio
import re
import secrets
import pyrogram
from typing import List
from .file import File
from .Logger import Logger
import random
import string
from pydub import AudioSegment
from dotenv import load_dotenv
import os

load_dotenv()  # take environment variables from .env.

logger = Logger('files.log')
output_dir = os.environ.get('RECORDINGS_TARGET')


def message_has_acceptable_media_type(message: pyrogram.types.Message) -> bool:
    return any(getattr(message, media_type, None) is not None for media_type in [
        "contact",
        "location",
        "voice",
        "document",
        "video",
        "video_note",
        "photo",
        "sticker",
    ]) or message.text


def remote_file(message: pyrogram.types.Message, max_mb: float):
    """A File without a local copy when the media of the message is bigger than max_mb, else None."""
    from .media_download import media_name, media_of
    if not max_mb or max_mb <= 0:
        return None
    kind, media = media_of(message)
    size = int(getattr(media, 'file_size', 0) or 0)
    if media is None or size <= max_mb * 1024 * 1024:
        return None
    return File(media_name(kind, media), '', kind, message.caption,
                remote=True, size=size, mime=getattr(media, 'mime_type', None))


def generate_random_filename():
    # uploads are served by URL: names must not be guessable (cryptographic, 128 bits)
    return secrets.token_hex(16)


# Extensions a browser would open as a page with scripts in the CRM origin: stored as .bin
# (the same rule as the API, parisahon-api/src/file/file.service.ts ACTIVE_EXTENSIONS)
ACTIVE_EXTENSIONS = {'html', 'htm', 'xhtml', 'xht', 'shtml', 'svg', 'svgz', 'xml', 'xsl', 'xslt', 'js', 'mjs'}


def safe_extension(ext: str) -> str:
    ext = (ext or '').lower()
    if not re.fullmatch(r'[a-z0-9]{1,8}', ext) or ext in ACTIVE_EXTENSIONS:
        return 'bin'
    return ext


def extract_file_name(url: str, without_extension: bool = False) -> str:
    split_by = '/'
    index = -1
    if without_extension:
        split_by = '.'
        index = -2
    # Split the URL by '/'
    parts = url.split(split_by)

    # Get the last part after the last '/'
    last_part = parts[index]

    return last_part


def extract_file_extension(url: str) -> str:
    # Split the URL by '.'
    parts = url.split('.')

    # Get the last part after the last '/'
    last_part = parts[-1]

    return last_part


def determine_file_format(file_path: str) -> str:
    # Open the file and read the first few bytes to determine the file format
    with open(file_path, 'rb') as file:
        header = file.read(4)

    # Check if the file starts with the JPEG magic number
    if header.startswith(b'\xFF\xD8\xFF\xE0'):
        return 'jpg'
    # Check if the file starts with the WEBP magic number
    elif header.startswith(b'RIFF') and header[8:12] == b'WEBP':
        return 'webp'
    # Add more checks for other formats as needed

    # If the format cannot be determined, default to JPG
    return 'jpg'


def convert_ogg_to_mp3(source: str, target: str) -> None:
    """ffmpeg through pydub; blocking, so the listener runs it in a worker thread."""
    if os.environ.get('USE_CUSTOM_FFMPEG_INSTALLATION') == 'true':
        AudioSegment.converter = f"{os.environ.get('FFMPEG_INSTALLATION_DIR')}/ffmpeg"
        AudioSegment.ffprobe = f"{os.environ.get('FFMPEG_INSTALLATION_DIR')}/ffprobe"
    AudioSegment.from_ogg(source).export(target, format="mp3")


async def save_audio(
        client: pyrogram.Client,
        message: pyrogram.types.Message,
) -> List[File]:
    """A voice message: mp3 for every browser; when ffmpeg fails the original ogg is kept (never an empty bubble)."""
    file_name = f"{output_dir}/voice_{generate_random_filename()}"
    full_file_name = f"{file_name}.ogg"
    try:
        await client.download_media(message=message, file_name=full_file_name, in_memory=False, block=True)
    except Exception as e:
        logger.error(f"Something went wrong during downloading a voice message: {e}")
        return []
    if not os.path.exists(full_file_name):
        return []
    exported_name = f"{file_name}.mp3"
    try:
        # off the event loop: a conversion must not stop the messages of every account
        await asyncio.to_thread(convert_ogg_to_mp3, full_file_name, exported_name)
        os.remove(full_file_name)
        return [File('voice_message', extract_file_name(exported_name), 'voice', message.caption)]
    except Exception as e:
        logger.error(f"voice message not converted to mp3, the ogg is kept: {e}")
        try:
            if os.path.exists(exported_name):
                os.remove(exported_name)
        except OSError:
            pass
        return [File('voice_message.ogg', extract_file_name(full_file_name), 'voice', message.caption)]


def name_with_extension(name: str, default_ext: str) -> str:
    """'Видео' -> 'Видео.mp4'; a name that has an extension stays as it is."""
    name = (name or '').strip()
    if not name:
        return name
    return name if re.search(r'\.[A-Za-z0-9]{1,8}$', name) else f"{name}.{default_ext}"


async def save_audio_file(client: pyrogram.Client, message: pyrogram.types.Message) -> List[File]:
    """A music / audio file (not a voice message)."""
    try:
        audio = message.audio
        original = getattr(audio, 'file_name', None) or ''
        if '.' in original:
            ext = safe_extension(extract_file_extension(original))
        else:
            mime = (getattr(audio, 'mime_type', None) or '').split('/')[-1]
            ext = safe_extension({'mpeg': 'mp3', 'mp4': 'm4a', 'x-m4a': 'm4a'}.get(mime, mime) or 'mp3')
        file_name = f"{output_dir}/audio_{generate_random_filename()}.{ext}"
        await client.download_media(message=message, file_name=file_name, in_memory=False, block=True)
        name = original or getattr(audio, 'title', None) or 'Аудио'
        return [File(name_with_extension(name, ext), extract_file_name(file_name), 'audio', message.caption)]
    except Exception as e:
        logger.error(f"Error while saving an audio file: {e}")
        return []


async def save_animation(client: pyrogram.Client, message: pyrogram.types.Message) -> List[File]:
    """A GIF (Telegram sends it as an mp4 without sound): kept as a video."""
    try:
        file_name = f"{output_dir}/video_{generate_random_filename()}.mp4"
        await client.download_media(message=message, file_name=file_name, in_memory=False, block=True)
        name = getattr(message.animation, 'file_name', None) or 'GIF.mp4'
        return [File(name_with_extension(name, 'mp4'), extract_file_name(file_name), 'video', message.caption)]
    except Exception as e:
        logger.error(f"Error while saving a GIF: {e}")
        return []


async def save_document(
        client: pyrogram.Client,
        message: pyrogram.types.Message,
) -> List[File]:
    files = []
    try:
        # Generate a unique file name
        original = message.document.file_name or ''
        file_name = f"{output_dir}/document_{generate_random_filename()}.{safe_extension(extract_file_extension(original) if '.' in original else 'bin')}"

        # Download document file
        await client.download_media(message=message, file_name=file_name, in_memory=False, block=True)

        # Create File object and append to list
        files.append(File(original or 'Файл', extract_file_name(file_name), 'document', message.caption))

        return files
    except Exception as e:
        logger.error(f"Something went wrong during processing document file: {e}")
        return []


async def save_photo(
        client: pyrogram.Client,
        message: pyrogram.types.Message,
) -> List[File]:
    files = []
    try:
        # Generate a unique file name
        generated_file_name = generate_random_filename()
        file_name = f"{output_dir}/photo_{generated_file_name}"
        full_file_name = f"{file_name}.jpg"  # Default to JPG format

        # Download photo message
        await client.download_media(message=message, file_name=full_file_name, in_memory=False, block=True)

        if os.path.exists(full_file_name):
            # Determine the actual file format based on the downloaded file's header
            file_format = determine_file_format(full_file_name)

            # Rename the file with the correct extension
            os.rename(full_file_name, f"{file_name}.{file_format}")

            # Create File object and append to list
            files.append(File("Photo", f"{extract_file_name(file_name)}.{file_format}", 'photo', message.caption))

        return files
    except Exception as e:
        logger.error(f"Error while saving photo message: {e}")
        return []


# TODO: Need to check the case when video format is .MOV
async def save_video(
        client: pyrogram.Client,
        message: pyrogram.types.Message,
) -> List[File]:
    files = []
    try:
        # Generate a unique file name
        file_name = f"{output_dir}/video_{generate_random_filename()}"
        full_file_name = f"{file_name}.mp4"

        # Download video message
        await client.download_media(message=message, file_name=full_file_name, in_memory=False, block=True)

        # a phone video usually has no file name (Pyrogram gives None): named by its kind, never null
        name = name_with_extension(getattr(message.video, 'file_name', None) or 'Видео', 'mp4')
        files.append(File(name, extract_file_name(full_file_name), 'video', message.caption))

        return files
    except Exception as e:
        logger.error(f"Error while saving video message: {e}")
        return []


async def save_video_note(
        client: pyrogram.Client,
        message: pyrogram.types.Message,
) -> List[File]:
    files = []
    try:
        # Generate a unique file name
        file_name = f"{output_dir}/video_note_{generate_random_filename()}"
        full_file_name = f"{file_name}.mp4"

        # Download video message
        await client.download_media(message=message, file_name=full_file_name, in_memory=False, block=True)

        # Create File object and append to list
        files.append(File("video_note", extract_file_name(full_file_name), 'video_note', message.caption))

        return files
    except Exception as e:
        logger.error(f"Error while saving video message: {e}")
        return []


async def save_sticker(client: pyrogram.Client, message: pyrogram.types.Message) -> List[File]:
    files = []
    try:
        # Generate a unique file name
        file_name = f"{output_dir}/sticker_{generate_random_filename()}"
        original = message.sticker.file_name or ''
        full_file_name = f"{file_name}.{safe_extension(extract_file_extension(original) if '.' in original else 'webp')}"

        # Download video message
        await client.download_media(message=message, file_name=full_file_name, in_memory=False, block=True)

        # Create File object and append to list
        files.append(File(original or 'Стикер', extract_file_name(full_file_name), 'sticker', message.caption))

        return files

    except Exception as e:
        logger.error(f"Error while saving video message: {e}")
        return []
