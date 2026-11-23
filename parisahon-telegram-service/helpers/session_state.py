"""The state of each manager's Telegram session, shared by the listener and the HTTP side (app.py).

States:
  starting    the listener is starting the client (also right after a restart)
  connected   the client works (the last check, `checked_at`, answered)
  error       it could not start or does not answer (network, Telegram busy): tried again by itself
  revoked     Telegram does not know the session any more (ended on the phone in Settings -> Devices,
              AUTH_KEY_UNREGISTERED, the account deleted): only a new connection helps. Not retried
              until the manager connects again (the stored session string changes)
  stopped     disconnected from the CRM (POST /logout) — the row is gone, so this is short-lived
Live states are in a multiprocessing manager dict (user_id -> dict); every change is also written to
the sqlite `sessions` row (status, status_error, status_at, status_hash), so /get-sessions shows the
truth right after a restart and a revoked session is not hammered at each start.
"""
import hashlib
import sqlite3
import time
from typing import Dict, List, Optional

COLUMNS = {"status": "TEXT", "status_error": "TEXT", "status_at": "REAL", "status_hash": "TEXT"}


def string_hash(session_string: str) -> str:
    return hashlib.sha256((session_string or "").encode()).hexdigest()[:16]


def ensure_columns(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, user_id INTEGER, name VARCHAR(255), session_string TEXT)"
    )
    present = {row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()}
    for name, kind in COLUMNS.items():
        if name not in present:
            conn.execute(f"ALTER TABLE sessions ADD COLUMN {name} {kind}")
    conn.commit()


def persist(db_path: str, user_id: int, status: str, error: Optional[str], since: float, session_hash: Optional[str]) -> None:
    conn = sqlite3.connect(db_path)
    try:
        ensure_columns(conn)
        conn.execute(
            "UPDATE sessions SET status = ?, status_error = ?, status_at = ?, status_hash = ? WHERE user_id = ?",
            (status, (error or "")[:300] or None, since, session_hash, user_id),
        )
        conn.commit()
    finally:
        conn.close()


def stored_rows(db_path: str) -> List[dict]:
    """The rows with a session: user_id, name and the persisted state (no session strings)."""
    conn = sqlite3.connect(db_path)
    try:
        ensure_columns(conn)
        rows = conn.execute(
            "SELECT user_id, name, status, status_error, status_at FROM sessions WHERE session_string IS NOT NULL"
        ).fetchall()
        return [{"user_id": r[0], "name": r[1], "status": r[2], "error": r[3], "since": r[4]} for r in rows]
    finally:
        conn.close()


def merged(rows: List[dict], live: Dict) -> List[dict]:
    """/get-sessions: every stored session with its live state (the persisted one until the listener reports)."""
    out = []
    for row in rows:
        state = dict(live.get(row["user_id"]) or live.get(str(row["user_id"])) or {})
        status = state.get("status") or row.get("status") or "starting"
        out.append({
            "user_id": row["user_id"],
            "name": row["name"],
            "status": status,
            "error": state.get("error") if state else row.get("error"),
            "since": state.get("since") or row.get("since"),
            "checked_at": state.get("checked_at"),
            "tg_id": state.get("tg_id"),
            "username": state.get("username"),
            "phone": state.get("phone"),
            "last_message_at": state.get("last_message_at"),
        })
    return out


def health(rows: List[dict]) -> dict:
    """Counts for /health: how many sessions, how many work, which do not (user ids only)."""
    states: Dict[str, str] = {}
    problems = []
    for row in rows:
        states[str(row["user_id"])] = row["status"]
        if row["status"] in ("revoked", "error"):
            problems.append({"user_id": row["user_id"], "status": row["status"], "since": row.get("since"),
                             "error": (row.get("error") or "")[:200] or None})
    return {
        "sessions": len(rows),
        "connected": sum(1 for r in rows if r["status"] == "connected"),
        "states": states,
        "problems": problems,
        "checked_at": int(time.time()),
    }
