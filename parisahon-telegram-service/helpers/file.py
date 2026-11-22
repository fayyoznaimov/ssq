"""A media file of a message (saved into the API's uploads folder) and its form for the CRM API."""
from typing import List, Union


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


class File:
    def __init__(
            self,
            name: str,
            path: str,
            media_type: str,
            caption: Union[str, None] = None,
            event_type: Union[int, None] = None,
            duration: Union[int, None] = None,
            from_number: Union[str, None] = None,
            direction: Union[str, None] = None,
            agent_id: Union[int, None] = None,
            remote: bool = False,
            size: Union[int, None] = None,
            mime: Union[str, None] = None,
    ):
        self.name = name
        self.path = path
        self.media_type = media_type
        self.caption = caption
        self.event_type = event_type
        self.duration = duration
        self.from_number = from_number
        self.direction = direction
        self.agent_id = agent_id
        # remote: too big to keep in the CRM, left in Telegram (no path); the CRM shows a download link
        self.remote = remote
        self.size = size
        self.mime = mime

    def convert_to_dict(self) -> dict:
        data = {
            "name": self.name,
            "path": extract_file_name(self.path),
            "type": self.media_type,
            "caption": self.caption,
        }
        if self.remote:
            data.update({"remote": True, "size": self.size, "mime": self.mime})
        return data

    @staticmethod
    def convert_list_to_dict(files: List['File']) -> List[dict]:
        list_of_dicts = []
        for file in files:
            if file is not None:
                list_of_dicts.append(file.convert_to_dict())

        return list_of_dicts
