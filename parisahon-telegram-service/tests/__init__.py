import os
import tempfile

# the service's loggers write to LOGS_DIR (default "logs" in the current folder): keep test runs out of the repo
os.environ["LOGS_DIR"] = os.path.join(tempfile.gettempdir(), "parisahon-telegram-tests-logs")
