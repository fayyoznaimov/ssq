"""Sends the audio files that arrived over FTP to the CRM API, each content once per manager.

The files stay where the phone put them (a sync app compares its folder with the listing here and
would upload a missing file again); what was done with them is in the sqlite state. Old files are
removed after FTP_RETAIN_DAYS, except audio that is not in the CRM: waiting to be sent, or refused
by the API (it is the only copy of that call; the admin decides, see README).
"""
import hashlib
import logging
import os
import stat
import threading
import time
from typing import Callable, Iterator, List, Optional, Tuple

from config import AUDIO_EXTENSIONS, Config
from crm import CrmApi, UploadResult
from state import State

log = logging.getLogger("ftp.forward")

# uploads in progress of the usual clients, editors' leftovers
TEMP_SUFFIXES = (".part", ".tmp", ".filepart", "~")
# answers that say "the API is not there" rather than something about the file
API_DOWN_STATUSES = (404, 502, 503, 504)
FILE_BACKOFF_FIRST, FILE_BACKOFF_MAX = 30.0, 3600.0
API_PAUSE_FIRST, API_PAUSE_MAX = 10.0, 300.0
# 401 / 403: our token is wrong, or the API does not know this manager any more - it does not say which
REFUSED_PAUSE_FIRST, REFUSED_PAUSE_MAX = 10.0, 600.0
PRUNE_EVERY_SEC = 600.0


def shown(name: str) -> str:
    """A file name for the log: as it is, in quotes; only line breaks are made visible."""
    return '"' + name.replace("\r", "\\r").replace("\n", "\\n") + '"'


def is_hidden_or_temp(name: str) -> bool:
    lower = name.lower()
    return name.startswith(".") or lower.endswith(TEMP_SUFFIXES)


def is_audio(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in AUDIO_EXTENSIONS


def wanted(name: str) -> bool:
    """Is this a file to forward: an audio extension and not a temporary or hidden name."""
    return is_audio(name) and not is_hidden_or_temp(name)


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Forwarder:
    def __init__(self, config: Config, state: State, api: CrmApi, clock: Callable[[], float] = time.time):
        self.config = config
        self.state = state
        self.api = api
        self.clock = clock
        self._observed = {}       # path -> (size, mtime_ns, unchanged since): the settle timer of unsent files
        self._pause_until = 0.0   # the API is down: no uploads before this moment
        self._pause_sec = 0.0
        self._refused = {}        # user id -> (no uploads for this manager before, length of that pause): 401 / 403
        self._accepted = False    # the API took something from us since the start: our token is right
        self._last_prune = 0.0
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------ loop

    def start(self) -> None:
        self._thread = threading.Thread(target=self.run, name="forwarder", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=10)

    def kick(self) -> None:
        """Something arrived or changed: look at the folders now instead of at the next scan."""
        self._wake.set()

    def run(self) -> None:
        while not self._stop.is_set():
            wait = None
            try:
                wait = self.scan_once()
                self.prune_if_due()
            except Exception:  # the loop must outlive anything a single pass runs into
                log.exception("scan failed")
            timeout = self.config.scan_sec if wait is None else max(0.1, min(self.config.scan_sec, wait + 0.05))
            if self._wake.wait(timeout) and not self._stop.is_set():
                # a burst of uploads wakes us once, not once per file
                self._stop.wait(min(0.5, self.config.settle_sec))
            self._wake.clear()

    # ------------------------------------------------------------------ one pass

    def homes(self) -> Iterator[Tuple[int, str]]:
        try:
            names = os.listdir(self.config.root)
        except FileNotFoundError:
            return
        for name in sorted(names):
            path = os.path.join(self.config.root, name)
            if name.isdigit() and int(name) > 0 and os.path.isdir(path) and not os.path.islink(path):
                yield int(name), path

    def sources(self) -> Iterator[Tuple[int, str, str]]:
        """(user id, folder, prefix of the names in it) of every folder to forward: the homes in FTP_ROOT
        and the FTP_EXTRA_HOMES (a folder an old FTP server fills; its names get "@extra-<n>/" in front,
        so they never meet the names of the home in the state). A missing extra folder is skipped."""
        for user_id, home in self.homes():
            yield user_id, home, ""
        for index, (user_id, folder) in enumerate(self.config.extra_homes, start=1):
            if os.path.isdir(folder) and not os.path.islink(folder):
                yield user_id, folder, f"@extra-{index}/"

    def files(self, home: str, prefix: str = "") -> Iterator[Tuple[str, str, os.stat_result]]:
        """(name relative to the home, full path, lstat) of every regular file, hidden folders left out."""
        for folder, folders, names in os.walk(home):
            folders[:] = sorted(name for name in folders if not name.startswith("."))
            for name in sorted(names):
                full = os.path.join(folder, name)
                try:
                    info = os.lstat(full)
                except OSError:
                    continue
                if stat.S_ISREG(info.st_mode):
                    yield prefix + os.path.relpath(full, home), full, info

    def scan_once(self) -> Optional[float]:
        """Looks at every home once and sends what is ready. Returns in how many seconds something
        that is not ready yet (still settling, waiting for its next try) should be looked at again."""
        waits: List[float] = []
        candidates = []
        present = {}
        handled = {}
        for user_id, home, prefix in self.sources():
            if user_id not in handled:
                handled[user_id] = self.state.handled_files(user_id)
                present[user_id] = []
            for rel, full, info in self.files(home, prefix):
                present[user_id].append(rel)
                if wanted(os.path.basename(rel)) and info.st_size > 0 and handled[user_id].get(rel) != (info.st_size, info.st_mtime_ns):
                    candidates.append((info.st_mtime_ns, user_id, rel, full, info))
        for user_id, names in present.items():
            self.state.forget_seen_except(user_id, names)
        candidates.sort(key=lambda item: item[:3])  # the oldest recording first

        alive = set()
        api_failed = False
        for _mtime, user_id, rel, full, info in candidates:
            # (files that are sent or rejected were left out above; what is here is new or waits for a try)
            sha = self.state.seen_sha(user_id, rel, info.st_size, info.st_mtime_ns)
            row = self.state.upload(user_id, sha) if sha else None
            if row is not None and row["status"] in ("sent", "rejected"):
                continue  # the same content was dealt with a moment ago in this pass
            alive.add(full)

            # size and mtime must hold still for FTP_SETTLE_SEC (the phone may still rename it or set its time)
            now_mono = time.monotonic()
            seen = self._observed.get(full)
            if seen is None or seen[0] != info.st_size or seen[1] != info.st_mtime_ns:
                self._observed[full] = (info.st_size, info.st_mtime_ns, now_mono)
                seen = self._observed[full]
            left = self.config.settle_sec - (now_mono - seen[2])
            if left > 0:
                waits.append(left)
                continue
            if self.state.is_receiving(full):
                continue  # the upload is still running or broke off; the phone will finish it

            if sha is None:
                try:
                    sha = sha256_of(full)
                    after = os.lstat(full)
                except OSError as error:
                    log.warning("cannot read user=%s file=%s: %s", user_id, shown(rel), error.strerror or error)
                    continue
                if after.st_size != info.st_size or after.st_mtime_ns != info.st_mtime_ns:
                    continue  # changed under our hands: it settles again
                self.state.remember_seen(user_id, rel, info.st_size, info.st_mtime_ns, sha)
                row = self.state.upload(user_id, sha)
                if row is not None and row["status"] == "sent":
                    log.info("already sent user=%s file=%s size=%s upload_id=%s (same content as %s)", user_id, shown(rel), info.st_size, row["upload_id"], shown(row["file_name"] or "?"))
                    continue
                if row is not None and row["status"] == "rejected":
                    log.info("already rejected user=%s file=%s size=%s reason=%s", user_id, shown(rel), info.st_size, shown(row["error"] or ""))
                    continue

            now = self.clock()
            if row is not None and row["next_try"] and row["next_try"] > now:
                waits.append(row["next_try"] - now)
                continue
            if api_failed or now < self._pause_until:
                if not api_failed:
                    waits.append(self._pause_until - now)
                continue
            refused_until = self._refused.get(user_id, (0.0, 0.0))[0]
            if now < refused_until:
                waits.append(refused_until - now)
                continue

            meta = self.meta_of(full)
            if meta and self.state.is_receiving(meta):
                waits.append(self.config.settle_sec)
                continue
            result = self.api.upload(user_id, full, os.path.basename(rel), recorded_at_ms=info.st_mtime_ns // 1_000_000, meta_path=meta)
            api_failed = self.record(user_id, rel, info.st_size, sha, result)
            if api_failed:
                waits.append(self._pause_until - self.clock())
            elif user_id in self._refused:
                waits.append(self._refused[user_id][0] - self.clock())

        self._observed = {path: seen for path, seen in self._observed.items() if path in alive}
        return max(0.0, min(waits)) if waits else None

    @staticmethod
    def meta_of(audio: str) -> Optional[str]:
        """The recorder's json next to the audio: "<name>.json" for "<name>.m4a" (or "<name>.m4a.json")."""
        for candidate in (os.path.splitext(audio)[0] + ".json", audio + ".json"):
            if os.path.isfile(candidate) and not os.path.islink(candidate):
                return candidate
        return None

    def record(self, user_id: int, rel: str, size: int, sha: str, result: UploadResult) -> bool:
        """Writes the outcome down and logs it. True = the API is not there, stop this pass."""
        now = self.clock()
        if result.kind == "sent":
            self.api_is_back()
            self._accepted = True
            self._refused.pop(user_id, None)
            self.state.mark_sent(user_id, sha, rel, size, result.upload_id, result.duplicate)
            log.info("forwarded user=%s file=%s size=%s upload_id=%s%s", user_id, shown(rel), size, result.upload_id, " duplicate (the API already had this content)" if result.duplicate else "")
            return False
        if result.kind == "rejected":
            self.api_is_back()
            self._accepted = True
            self._refused.pop(user_id, None)
            self.state.mark_rejected(user_id, sha, rel, size, result.error)
            log.error("rejected user=%s file=%s size=%s status=%s reason=%s (will not be sent again; the file stays in the folder: this call is not in the CRM)",
                      user_id, shown(rel), size, result.status, shown(result.error))
            return False
        if result.kind == "auth":
            # 401 / 403. The files of this manager wait; the other managers go on (if it is the token, they get the same answer)
            self.api_is_back()
            pause = min(REFUSED_PAUSE_MAX, self._refused[user_id][1] * 2) if user_id in self._refused else REFUSED_PAUSE_FIRST
            self._refused[user_id] = (now + pause, pause)
            self.state.mark_retry(user_id, sha, rel, size, f"HTTP {result.status}: {result.error}", now, count=False)
            if self._accepted:
                log.error("THE API REFUSES UPLOADS FOR user=%s (HTTP %s %s): is this still a staff user of the CRM? (or CALLS_SERVICE_TOKEN of the API changed); "
                          "retry file=%s next_try_in=%ds", user_id, result.status, shown(result.error), shown(rel), pause)
            else:
                log.error("CALLS_SERVICE_TOKEN IS REFUSED BY THE API (HTTP %s %s) for user=%s: it must be the same as CALLS_SERVICE_TOKEN of the API "
                          "(or user %s is not a staff user of the CRM); retry file=%s next_try_in=%ds", result.status, shown(result.error), user_id, user_id, shown(rel), pause)
            return False
        if result.kind == "retry" and result.status not in API_DOWN_STATUSES:
            self.api_is_back()
            row = self.state.upload(user_id, sha)
            delay = min(FILE_BACKOFF_MAX, FILE_BACKOFF_FIRST * 2 ** (row["attempts"] if row else 0))
            attempts = self.state.mark_retry(user_id, sha, rel, size, result.error, now + delay)
            log.warning("retry user=%s file=%s size=%s attempt=%s next_try_in=%ds reason=%s", user_id, shown(rel), size, attempts, delay, shown(result.error))
            return False
        # the API is down or not deployed yet: nothing goes through for now
        self._pause_sec = min(API_PAUSE_MAX, self._pause_sec * 2) if self._pause_sec else API_PAUSE_FIRST
        self._pause_until = now + self._pause_sec
        self.state.mark_retry(user_id, sha, rel, size, result.error, now, count=False)
        log.warning("retry user=%s file=%s size=%s next_try_in=%ds reason=%s (files wait in the folder)", user_id, shown(rel), size, self._pause_sec, shown(result.error))
        return True

    def api_is_back(self) -> None:
        if self._pause_sec:
            log.info("the API answers again")
        self._pause_sec = 0.0
        self._pause_until = 0.0

    # ------------------------------------------------------------------ old files

    def prune_if_due(self) -> None:
        now = self.clock()
        if now - self._last_prune >= PRUNE_EVERY_SEC:
            self._last_prune = now
            self.prune()

    def prune(self) -> int:
        """Removes files that have been here longer than FTP_RETAIN_DAYS (counted from when they
        arrived or last changed here, not from the recording's own date), except audio that is
        still waiting to be sent or that the API refused (the call is not in the CRM: this file is
        all there is of it). Also forgets what is no longer on the disk. Returns the number removed."""
        for path in self.state.receiving_paths():
            if not os.path.lexists(path):
                self.state.receiving_done(path)
        if not os.path.isdir(self.config.root):
            return 0  # the whole folder is away (not mounted?): touch nothing
        sources = list(self.sources())
        users = {user_id for user_id, _home, _prefix in sources}
        for user_id in self.state.known_users():
            if user_id not in users:
                self.state.forget_user(user_id)
                log.info("home of user=%s is gone: its records are dropped", user_id)
        if self.config.retain_days <= 0:
            return 0
        limit = time.time() - self.config.retain_days * 86400
        removed = 0
        for user_id, home, prefix in sources:
            for rel, full, info in self.files(home, prefix):
                if info.st_ctime > limit:
                    continue
                if wanted(os.path.basename(rel)) and info.st_size > 0 and not self.state.is_receiving(full):
                    sha = self.state.seen_sha(user_id, rel, info.st_size, info.st_mtime_ns)
                    row = self.state.upload(user_id, sha) if sha else None
                    if row is None or row["status"] != "sent":
                        continue  # not sent yet, or refused by the API: keep it whatever its age
                try:
                    os.remove(full)
                except OSError as error:
                    log.warning("cannot remove old user=%s file=%s: %s", user_id, shown(rel), error.strerror or error)
                    continue
                self.state.receiving_done(full)
                removed += 1
                log.info("removed old user=%s file=%s size=%s (older than %g days)", user_id, shown(rel), info.st_size, self.config.retain_days)
        return removed
