"""Requests from app.py to the listener about a session itself (pickled through the multiprocessing queue)."""
import uuid


class Logout:
    """POST /logout: sign the manager's session out of Telegram and forget it (the CRM's «Отключить»)."""

    def __init__(self, user_id: int):
        self.user_id = user_id
        self.request_id = uuid.uuid4().hex
