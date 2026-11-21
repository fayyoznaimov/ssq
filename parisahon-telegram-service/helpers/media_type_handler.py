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


def generate_random_filename():
    letters = string.ascii_lowercase
    return ''.join(random.choice(letters) for i in range(10))


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


# TODO: No need to save .ogg files, change download_media to in_memory and generate .mp3 file from there
async def save_audio(
        client: pyrogram.Client,
        message: pyrogram.types.Message,
) -> List[File]:
    files = []
    try:
        # Generate a unique file name
        file_name = f"{output_dir}/voice_{generate_random_filename()}"
        full_file_name = f"{file_name}.ogg"

        # Download voice message
        await client.download_media(message=message, file_name=full_file_name, in_memory=False, block=True)

        if os.environ.get('USE_CUSTOM_FFMPEG_INSTALLATION') == 'true':
            AudioSegment.converter = f"{os.environ.get('FFMPEG_INSTALLATION_DIR')}/ffmpeg"
            AudioSegment.ffprobe = f"{os.environ.get('FFMPEG_INSTALLATION_DIR')}/ffprobe"

        audio = AudioSegment.from_ogg(full_file_name)
        exported_name = f"{file_name}.mp3"
        audio.export(exported_name, format="mp3")

        if os.path.exists(full_file_name):
            # Delete the file
            os.remove(full_file_name)

        # Create File object and append to list
        files.append(File('voice_message', extract_file_name(exported_name), 'voice', message.caption))

        return files
    except Exception as e:
        logger.error(f"Something went wrong during processing voice message: {e}")
        return []


async def save_document(
        client: pyrogram.Client,
        message: pyrogram.types.Message,
) -> List[File]:
    files = []
    try:
        # Generate a unique file name
        file_name = f"{output_dir}/document_{generate_random_filename()}.{extract_file_extension(message.document.file_name)}"

        # Download document file
        await client.download_media(message=message, file_name=file_name, in_memory=False, block=True)

        # Create File object and append to list
        files.append(File(message.document.file_name, extract_file_name(file_name), 'document', message.caption))

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

        # Create File object and append to list
        files.append(File(message.video.file_name, extract_file_name(full_file_name), 'video', message.caption))

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
        full_file_name = f"{file_name}.{extract_file_extension(message.sticker.file_name)}"

        # Download video message
        await client.download_media(message=message, file_name=full_file_name, in_memory=False, block=True)

        # Create File object and append to list
        files.append(File(message.sticker.file_name, extract_file_name(full_file_name), 'sticker', message.caption))

        return files

    except Exception as e:
        logger.error(f"Error while saving video message: {e}")
        return []
