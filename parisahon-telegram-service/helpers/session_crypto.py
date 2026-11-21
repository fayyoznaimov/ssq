"""Encryption of the Telegram session strings kept in sqlite (sessions.session_string).

A Pyrogram session string is a full login to the manager's Telegram account: whoever
has it reads and writes as that person, without a code or password. So it is stored
encrypted with SESSION_ENCRYPTION_KEY (Fernet: AES-128-CBC + HMAC-SHA256), which lives
only in the service's environment, never in the database file or in git.

- stored value "fernet:<token>" = encrypted; anything else = an old plain-text value;
- encrypt_existing() (at start) encrypts the old plain-text rows in place;
- without the key the service still works with plain values and warns, so a dev copy
  does not need one; a value that cannot be decrypted (wrong / missing key) is skipped
  with an error in the log, the manager then connects Telegram again.

New key:  python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
"""
import logging
import os
import sqlite3
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

PREFIX = "fernet:"
log = logging.getLogger("session_crypto")
_warned = False


def _fernet() -> Optional[Fernet]:
    key = os.environ.get("SESSION_ENCRYPTION_KEY", "").strip()
    if not key:
        global _warned
        if not _warned:
            log.warning("SESSION_ENCRYPTION_KEY is not set: Telegram sessions are stored as plain text")
            _warned = True
        return None
    return Fernet(key.encode())


def encrypt(session_string: str) -> str:
    f = _fernet()
    if not f or not session_string or session_string.startswith(PREFIX):
        return session_string
    return PREFIX + f.encrypt(session_string.encode()).decode()


def decrypt(stored: Optional[str]) -> Optional[str]:
    """The session string, or None when it cannot be read (no / wrong key)."""
    if not stored or not stored.startswith(PREFIX):
        return stored
    f = _fernet()
    if not f:
        log.error("an encrypted Telegram session needs SESSION_ENCRYPTION_KEY")
        return None
    try:
        return f.decrypt(stored[len(PREFIX):].encode()).decode()
    except InvalidToken:
        log.error("a Telegram session cannot be decrypted with this SESSION_ENCRYPTION_KEY")
        return None


def encrypt_existing(db_path: str) -> int:
    """Encrypts the plain-text rows; returns how many were changed."""
    if not _fernet():
        return 0
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT id, session_string FROM sessions WHERE session_string IS NOT NULL AND session_string NOT LIKE ?",
            (PREFIX + "%",),
        ).fetchall()
        for row_id, value in rows:
            conn.execute("UPDATE sessions SET session_string = ? WHERE id = ?", (encrypt(value), row_id))
        conn.commit()
        if rows:
            log.info(f"encrypted {len(rows)} Telegram session(s) stored as plain text")
        return len(rows)
    except sqlite3.Error as e:
        log.error(f"cannot encrypt the stored sessions: {e}")
        return 0
    finally:
        conn.close()
