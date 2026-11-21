from datetime import datetime, timedelta


class Session:
    def __init__(self):
        self.time: datetime = datetime.now()

    def is_login_code_expired(self):
        # Get the current time
        current_time = datetime.now()

        # Calculate the difference between the current time and the given datetime
        time_difference = current_time - self.time

        # Check if the time difference is greater than or equal to 60 seconds
        if time_difference >= timedelta(seconds=60):
            return True

        return False


class LoginCode(Session):
    def __init__(self, login_code: str):
        super().__init__()
        self.login_code: str = login_code


class ActivationResult(Session):
    def __init__(self, is_activated: bool = False, reason: str = "Something went wrong"):
        super().__init__()
        self.is_activated = is_activated
        self.reason = reason
