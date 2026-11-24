"""Where ffmpeg is (HACK-10; not named ffmpeg*.py: local/deploy.sh leaves ffmpeg* out): one variable for the API and both messenger services, FFMPEG_BIN.

    FFMPEG_BIN=/usr/bin/ffmpeg   a path (the Debian ffmpeg of the image), or a name looked up in PATH;
    empty                        "ffmpeg" from PATH.

The old pair USE_CUSTOM_FFMPEG_INSTALLATION=true + FFMPEG_INSTALLATION_DIR is still read when FFMPEG_BIN is
not set (existing env files), but a flag without the directory, or a directory without ffmpeg, no longer
breaks the voice messages: "ffmpeg" from PATH is tried next. ffprobe is taken next to the chosen ffmpeg.
The binary must answer `ffmpeg -version`; nothing found = voice messages stay .ogg and GET /health says
ffmpeg: false.
"""
import os
import shutil
import subprocess
from typing import List, Optional, Tuple

_found: Optional[Tuple[str, str, bool, List[str]]] = None


def _candidates() -> List[str]:
    out = []
    configured = (os.environ.get("FFMPEG_BIN") or "").strip()
    if configured:
        out.append(configured)
    elif (os.environ.get("USE_CUSTOM_FFMPEG_INSTALLATION") or "").strip().lower() == "true":
        directory = (os.environ.get("FFMPEG_INSTALLATION_DIR") or "").strip()
        if directory:
            out.append(os.path.join(directory, "ffmpeg"))
    out.append("ffmpeg")
    return list(dict.fromkeys(out))


def locate(name: str) -> str:
    """A path -> itself when it is an executable file; a name -> the first one in PATH."""
    if os.sep in name or "/" in name:
        path = os.path.abspath(name)
        return path if os.path.isfile(path) and os.access(path, os.X_OK) else ""
    return shutil.which(name) or ""


def answers(binary: str) -> bool:
    try:
        done = subprocess.run([binary, "-version"], capture_output=True, text=True, timeout=10)
        return done.returncode == 0 and "ffmpeg version" in (done.stdout or "").lower()
    except Exception:
        return False


def find(check=answers, refresh: bool = False) -> Tuple[str, str, bool, List[str]]:
    """(ffmpeg, ffprobe, ok, what was tried); found once per process."""
    global _found
    if _found is not None and not refresh:
        return _found
    tried = []
    for name in _candidates():
        binary = locate(name)
        tried.append(f"{name} -> {binary}" if binary else f"{name}: not found")
        if binary and check(binary):
            probe = os.path.join(os.path.dirname(binary), "ffprobe" + (".exe" if binary.lower().endswith(".exe") else ""))
            if not (os.path.isfile(probe) and os.access(probe, os.X_OK)):
                probe = shutil.which("ffprobe") or "ffprobe"
            _found = (binary, probe, True, tried)
            return _found
    _found = ("", "", False, tried)
    return _found
