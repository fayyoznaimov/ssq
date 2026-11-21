"""Call recordings from the recorder's folders, sent to the CRM API.

The recorder app used to drop `<name>.amr` + `<name>.json` into
RECORDINGS_SOURCE/<CRM user id>/ and this service converted and wrote them
straight into Postgres. Now the files go to POST /calls/upload of the API
(the service's token plus the user id of the folder); the API converts,
links and records them, one file at a time, so a broken file no longer stops
the pass. The recorder app itself can send to the API directly with the
manager's recorder token; the folders stay as the fallback way.
"""
import os
from typing import List

from .Logger import Logger
from .api_client import ApiRefused, ApiUnavailable, CrmApi

logger = Logger('recordings.log')

input_dir = os.environ.get('RECORDINGS_SOURCE')


def pending_recordings() -> List[tuple]:
    """(user_id, amr path, json path) for every pair in the folders."""
    found = []
    if not input_dir or not os.path.isdir(input_dir):
        return found
    for user_id in sorted(os.listdir(input_dir)):
        user_dir = os.path.join(input_dir, user_id)
        if not os.path.isdir(user_dir) or not user_id.isdigit():
            continue
        for name in sorted(os.listdir(user_dir)):
            base, ext = os.path.splitext(name)
            if ext.lower() not in ('.amr', '.mp3', '.m4a', '.wav'):
                continue
            meta = os.path.join(user_dir, base + '.json')
            if os.path.exists(meta):
                found.append((int(user_id), os.path.join(user_dir, name), meta))
    return found


def check_for_existing_recordings(api: CrmApi) -> int:
    """Uploads every pair found; a pair the API refused is moved aside (.rejected) with the reason."""
    sent = 0
    for user_id, audio, meta in pending_recordings():
        try:
            result = api.upload_call(user_id, audio, meta)
        except ApiUnavailable as error:
            logger.warning(f"API unavailable, recordings wait: {error}")
            break
        except ApiRefused as error:
            logger.error(f"API refused {audio} (user {user_id}): {error}")
            for path in (audio, meta):
                try:
                    os.rename(path, path + '.rejected')
                except OSError:
                    pass
            continue
        logger.info(f"uploaded {os.path.basename(audio)} of user {user_id}: queue id {result.get('id')}")
        for path in (audio, meta):
            try:
                os.remove(path)
            except OSError as error:
                logger.error(f"could not delete {path}: {error}")
        sent += 1
    return sent
