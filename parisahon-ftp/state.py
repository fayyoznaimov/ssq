"""What the FTP receiver remembers between restarts (sqlite, standard library).

  upload     one row per (manager, sha256 of the content): sent (with the API's upload id), rejected
             (with the API's words) or waiting for the next try. This is what keeps a file from being
             sent twice, whatever its name and however often the phone uploads it again.
  seen       path + size + mtime -> sha256, so a file is hashed once and not on every scan.
  receiving  uploads that are in progress or broke off: the forwarder leaves those files alone
             until the phone finishes them (survives a restart in the middle of an upload).
"""
import os
import sqlite3
import threading
import time
from typing import Iterable, Optional

SCHEMA = """
create table if not exists upload (
  user_id    integer not null,
  sha256     text    not null,
  status     text    not null,           -- sent | rejected | retry
  upload_id  integer,                    -- id of the row in the API's queue
  duplicate  integer not null default 0, -- the API already had these bytes for this manager
  error      text,                       -- the API's words (rejected) or the last failure (retry)
  attempts   integer not null default 0,
  next_try   real,                       -- unix time of the next try (retry)
  file_name  text,                       -- name relative to the manager's home, as last seen
  size       integer,
  created_at real    not null,
  updated_at real    not null,
  primary key (user_id, sha256)
);
create table if not exists seen (
  user_id  integer not null,
  rel_path text    not null,
  size     integer not null,
  mtime_ns integer not null,
  sha256   text    not null,
  primary key (user_id, rel_path)
);
create table if not exists receiving (
  path       text primary key,
  started_at real not null
);
"""


class State:
    def __init__(self, path: str):
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        self._lock = threading.RLock()
        # one connection shared by the FTP threads and the forwarder, every use under the lock
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=30)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute("pragma journal_mode=wal")
            self._db.execute("pragma synchronous=normal")
            self._db.executescript(SCHEMA)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ------------------------------------------------------------------ upload

    def upload(self, user_id: int, sha256: str) -> Optional[sqlite3.Row]:
        with self._lock:
            return self._db.execute("select * from upload where user_id = ? and sha256 = ?", (user_id, sha256)).fetchone()

    def _put(self, user_id: int, sha256: str, file_name: str, size: int, **values) -> None:
        now = time.time()
        with self._lock:
            self._db.execute(
                "insert into upload (user_id, sha256, status, file_name, size, created_at, updated_at) values (?, ?, 'retry', ?, ?, ?, ?) "
                "on conflict (user_id, sha256) do update set file_name = excluded.file_name, size = excluded.size, updated_at = excluded.updated_at",
                (user_id, sha256, file_name, size, now, now))
            names = ", ".join(f"{key} = ?" for key in values)
            self._db.execute(f"update upload set {names} where user_id = ? and sha256 = ?", (*values.values(), user_id, sha256))

    def mark_sent(self, user_id: int, sha256: str, file_name: str, size: int, upload_id: Optional[int], duplicate: bool) -> None:
        self._put(user_id, sha256, file_name, size, status="sent", upload_id=upload_id, duplicate=int(duplicate), error=None, next_try=None)

    def mark_rejected(self, user_id: int, sha256: str, file_name: str, size: int, error: str) -> None:
        self._put(user_id, sha256, file_name, size, status="rejected", error=error, next_try=None)

    def mark_retry(self, user_id: int, sha256: str, file_name: str, size: int, error: str, next_try: float, count: bool = True) -> int:
        """Returns the number of tries so far. count=False: the failure was not about this file (API down)."""
        with self._lock:
            row = self.upload(user_id, sha256)
            attempts = (row["attempts"] if row else 0) + (1 if count else 0)
            self._put(user_id, sha256, file_name, size, status="retry", error=error, next_try=next_try, attempts=attempts)
            return attempts

    def counts(self) -> dict:
        with self._lock:
            return {row["status"]: row["n"] for row in self._db.execute("select status, count(*) n from upload group by status")}

    # ------------------------------------------------------------------ seen

    def seen_sha(self, user_id: int, rel_path: str, size: int, mtime_ns: int) -> Optional[str]:
        with self._lock:
            row = self._db.execute("select sha256 from seen where user_id = ? and rel_path = ? and size = ? and mtime_ns = ?", (user_id, rel_path, size, mtime_ns)).fetchone()
            return row["sha256"] if row else None

    def handled_files(self, user_id: int) -> dict:
        """{name relative to the home: (size, mtime_ns)} of the files that are done with (sent or rejected):
        one query per manager and scan instead of two per file."""
        with self._lock:
            return {row[0]: (row[1], row[2]) for row in self._db.execute(
                "select s.rel_path, s.size, s.mtime_ns from seen s join upload u on u.user_id = s.user_id and u.sha256 = s.sha256 "
                "where s.user_id = ? and u.status in ('sent', 'rejected')", (user_id,))}

    def remember_seen(self, user_id: int, rel_path: str, size: int, mtime_ns: int, sha256: str) -> None:
        with self._lock:
            self._db.execute("insert or replace into seen (user_id, rel_path, size, mtime_ns, sha256) values (?, ?, ?, ?, ?)", (user_id, rel_path, size, mtime_ns, sha256))

    def forget_seen_except(self, user_id: int, rel_paths: Iterable[str]) -> None:
        """Drops the cache rows of files that are no longer in the manager's home."""
        keep = set(rel_paths)
        with self._lock:
            gone = [row["rel_path"] for row in self._db.execute("select rel_path from seen where user_id = ?", (user_id,)) if row["rel_path"] not in keep]
            self._db.executemany("delete from seen where user_id = ? and rel_path = ?", [(user_id, rel) for rel in gone])

    def known_users(self) -> list:
        with self._lock:
            return [row[0] for row in self._db.execute("select user_id from upload union select user_id from seen")]

    def forget_user(self, user_id: int) -> None:
        """The manager's home is gone (removed by hand): nothing of it is left to remember."""
        with self._lock:
            self._db.execute("delete from upload where user_id = ?", (user_id,))
            self._db.execute("delete from seen where user_id = ?", (user_id,))

    # ------------------------------------------------------------------ receiving

    def receiving_start(self, path: str) -> None:
        with self._lock:
            self._db.execute("insert or replace into receiving (path, started_at) values (?, ?)", (path, time.time()))

    def receiving_done(self, path: str) -> None:
        with self._lock:
            self._db.execute("delete from receiving where path = ?", (path,))

    def receiving_rename(self, source: str, target: str) -> None:
        """A renamed file (or folder) takes its "not finished" marks along; a finished file that
        replaces an unfinished one clears that mark."""
        with self._lock:
            moved = []
            for row in self._db.execute("select path, started_at from receiving").fetchall():
                path = row["path"]
                if path == source:
                    moved.append((target, row["started_at"]))
                elif path.startswith(source + os.sep):
                    moved.append((target + path[len(source):], row["started_at"]))
                elif path != target and not path.startswith(target + os.sep):
                    continue
                self._db.execute("delete from receiving where path = ?", (path,))
            self._db.executemany("insert or replace into receiving (path, started_at) values (?, ?)", moved)

    def is_receiving(self, path: str) -> bool:
        with self._lock:
            return self._db.execute("select 1 from receiving where path = ?", (path,)).fetchone() is not None

    def receiving_paths(self) -> list:
        with self._lock:
            return [row[0] for row in self._db.execute("select path from receiving")]
