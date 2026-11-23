"""The FTP side (pyftpdlib): login with the manager's recorder token, one home per manager.

Any user name is accepted; the password is the recorder token the admin issued in the CRM
(settings -> calls). The API says whose token it is (GET /calls/recorder) and the session gets
FTP_ROOT/<user_id>/ as its root: nothing above it can be named, listed or written.

With a certificate explicit FTPS (AUTH TLS) is offered. Plain FTP stays for the phones whose sync
app cannot do TLS, but it can be narrowed: FTP_PLAIN_NETWORKS (plain logins only from the office
network or the VPN, refused at USER, before the token is sent), FTP_PLAIN_DOWNLOAD=0 (a plain
session uploads only, the recordings cannot be read back), FTP_TLS_REQUIRED=1 (no plain FTP at all).
"""
import hashlib
import logging
import os
import threading
import time
from typing import Callable, Dict, Optional, Tuple

from pyftpdlib.authorizers import AuthenticationFailed
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import ThreadedFTPServer

from config import Config, address_in
from crm import CrmApi
from forwarder import shown, wanted
from state import State

log = logging.getLogger("ftp.server")

# pyftpdlib's letters: e cwd, l list, r retrieve, a append, d delete, f rename, m mkdir, w store, T set mtime (MFMT)
PERMISSIONS = "elradfmwT"
DENIED_CACHE_SEC = 30.0        # a token the API refused is not asked about again this long
STALE_WHEN_API_DOWN_SEC = 86400.0  # a token the API accepted earlier keeps working this long while the API is unreachable


class TokenAuthorizer:
    """pyftpdlib authorizer. After a successful login the session's user name is replaced by the
    CRM user id, so every later question of pyftpdlib (home, permissions) is about that id and two
    managers who typed the same user name never share anything."""

    def __init__(self, api: CrmApi, root: str, cache_sec: float = 300.0, clock: Callable[[], float] = time.monotonic):
        self.api = api
        self.root = os.path.abspath(root)
        self.cache_sec = cache_sec
        self.clock = clock
        self._lock = threading.Lock()
        self._known: Dict[str, Tuple[int, str, float]] = {}   # sha256(token) -> (user id, CRM name, asked at)
        self._denied: Dict[str, float] = {}                   # sha256(token) -> refused at

    def home_of(self, user_id) -> str:
        return os.path.join(self.root, str(int(user_id)))

    def resolve(self, token: str) -> Tuple[int, str]:
        """(user id, CRM name) of a recorder token; AuthenticationFailed otherwise."""
        if not (16 <= len(token) <= 256):
            raise AuthenticationFailed("Authentication failed.")
        key = hashlib.sha256(token.encode("utf-8", "replace")).hexdigest()
        now = self.clock()
        with self._lock:
            known = self._known.get(key)
            denied_at = self._denied.get(key)
        if known and now - known[2] < self.cache_sec:
            return known[0], known[1]
        if denied_at is not None and now - denied_at < DENIED_CACHE_SEC:
            raise AuthenticationFailed("Authentication failed.")
        answer = self.api.recorder(token)
        with self._lock:
            if answer.kind == "ok":
                self._denied.pop(key, None)
                self._known[key] = (answer.user_id, answer.username, now)
                return answer.user_id, answer.username
            if answer.kind == "denied":
                self._known.pop(key, None)
                self._denied[key] = now
                if len(self._denied) > 10000:
                    self._denied = {k: at for k, at in self._denied.items() if now - at < DENIED_CACHE_SEC}
                raise AuthenticationFailed("Authentication failed.")
        # the API did not answer the question
        if known and now - known[2] < STALE_WHEN_API_DOWN_SEC:
            log.warning("the API cannot check a token (%s): user=%s is let in on its earlier answer", answer.detail, known[0])
            return known[0], known[1]
        log.warning("the API cannot check a token (%s): login refused for now", answer.detail)
        raise AuthenticationFailed("Service not available, try again later.")

    # --- what pyftpdlib asks

    def validate_authentication(self, username, password, handler):
        user_id, name = self.resolve(password or "")
        os.makedirs(self.home_of(user_id), mode=0o700, exist_ok=True)
        handler.username = str(user_id)
        handler.crm_user_id = user_id
        handler.crm_user_name = name

    def get_home_dir(self, username):
        return self.home_of(username)

    def has_user(self, username):
        return str(username).isdigit()

    def has_perm(self, username, perm, path=None):
        if perm not in PERMISSIONS:
            return False
        if path is None:
            return True
        home = os.path.realpath(self.home_of(username))
        return os.path.commonpath([home, os.path.realpath(path)]) == home

    def get_perms(self, username):
        return PERMISSIONS

    def get_msg_login(self, username):
        return "Parisa CRM: folder for call recordings."

    def get_msg_quit(self, username):
        return "Goodbye."

    def impersonate_user(self, username, password):
        pass

    def terminate_impersonation(self, username):
        pass


class RecorderSession:
    """What is added to pyftpdlib's handler: the log lines the owner reads and the marks that keep
    the forwarder away from files that are still being uploaded. Mixed into FTPHandler / TLS_FTPHandler."""

    state: State = None            # set by make_handler
    kick: Callable[[], None] = staticmethod(lambda: None)
    crm_user_id: Optional[int] = None
    crm_user_name: str = ""
    tls_offered: bool = False      # a certificate is configured (FTPS can be used)
    plain_networks = None          # Config.plain_networks: where plain FTP may log in from (None: anywhere)
    plain_download: bool = True    # Config.plain_download: RETR without TLS

    def _relative(self, path: str) -> str:
        home = self.authorizer.home_of(self.crm_user_id)
        try:
            return os.path.relpath(path, home)
        except ValueError:
            return path

    def _secured(self) -> bool:
        return bool(getattr(self, "_ssl_established", False))

    def _data_secured(self) -> bool:
        # TLS on the control connection and PROT P: the data connection is encrypted too
        return self._secured() and bool(getattr(self, "_prot", False))

    def on_login(self, username):
        how = " tls" if self._secured() else (" plain" if self.tls_offered else "")
        log.info("login user=%s name=%s ip=%s%s", self.crm_user_id, shown(self.crm_user_name), self.remote_ip, how)

    def ftp_USER(self, line):
        # plain FTP from a network that is not trusted: refused before the password (the token) is sent in clear
        if not self._secured() and not address_in(self.plain_networks, self.remote_ip):
            if self.tls_offered:
                msg = "Plain FTP is not allowed from this network: use FTPS (explicit TLS, AUTH TLS)."
            else:
                msg = "FTP is not allowed from this network."
            self.respond("550 " + msg)
            log.warning("login refused ip=%s: plain FTP from outside FTP_PLAIN_NETWORKS", self.remote_ip)
            return
        return super().ftp_USER(line)

    def ftp_RETR(self, file):
        # FTP_PLAIN_DOWNLOAD=0: a token read off the network uploads at most, the recordings are not read back
        if not self.plain_download and not self._data_secured():
            self.respond("550 Downloads need FTPS (AUTH TLS and PROT P).")
            return None
        return super().ftp_RETR(file)

    def on_login_failed(self, username, password):
        # neither the user name nor the password goes to the log: people paste the token into either field
        log.warning("login refused ip=%s", self.remote_ip)

    # --- uploads: marked from the first byte to the last

    def ftp_STOR(self, file, mode="w"):
        path = super().ftp_STOR(file, mode)
        if path:
            self.state.receiving_start(path)
        return path

    def ftp_STOU(self, line):
        name = super().ftp_STOU(line)
        if name:
            queued = getattr(self, "_in_dtp_queue", None)
            handle = queued[0] if queued else getattr(getattr(self, "data_channel", None), "file_obj", None)
            if handle is not None:
                self.state.receiving_start(handle.name)
        return name

    def on_file_received(self, file):
        self.state.receiving_done(file)
        try:
            size = os.path.getsize(file)
        except OSError:
            size = -1
        note = "" if wanted(os.path.basename(file)) else " (not forwarded: temporary name or not audio)"
        log.info("received user=%s file=%s size=%s%s", self.crm_user_id, shown(self._relative(file)), size, note)
        self.kick()

    def on_incomplete_file_received(self, file):
        try:
            size = os.path.getsize(file)
        except OSError:
            size = -1
        log.warning("incomplete user=%s file=%s size=%s (upload broke off: kept, forwarded only after the phone uploads it to the end)", self.crm_user_id, shown(self._relative(file)), size)

    def ftp_RNTO(self, path):
        done = super().ftp_RNTO(path)
        if done:
            source, target = done
            self.state.receiving_rename(source, target)
            log.info("renamed user=%s file=%s to=%s", self.crm_user_id, shown(self._relative(source)), shown(self._relative(target)))
            self.kick()
        return done

    def ftp_DELE(self, path):
        done = super().ftp_DELE(path)
        if done:
            self.state.receiving_done(done)
            log.info("deleted user=%s file=%s (by the phone)", self.crm_user_id, shown(self._relative(done)))
        return done

    def ftp_MFMT(self, path, timeval):
        done = super().ftp_MFMT(path, timeval)
        if done:
            self.kick()
        return done


def make_handler(config: Config, authorizer: TokenAuthorizer, state: State, kick: Callable[[], None]):
    """The handler class for this configuration (pyftpdlib keeps its settings on the class)."""
    base = FTPHandler
    settings = {}
    if config.tls_cert:
        # explicit FTPS: offered (AUTH TLS); required only with FTP_TLS_REQUIRED - the phones' sync apps
        # often speak plain FTP only (FTP_PLAIN_NETWORKS / FTP_PLAIN_DOWNLOAD narrow what they may do)
        from pyftpdlib.handlers import TLS_FTPHandler
        base = TLS_FTPHandler
        required = bool(config.tls_required)
        settings.update(certfile=config.tls_cert, keyfile=config.tls_key, tls_control_required=required, tls_data_required=required, ssl_context=None)
    settings.update(
        tls_offered=bool(config.tls_cert),
        plain_networks=config.plain_networks,
        plain_download=config.plain_download,
        authorizer=authorizer,
        state=state,
        kick=staticmethod(kick),
        banner="Parisa CRM call recordings.",
        passive_ports=config.passive_ports,
        masquerade_address=config.masquerade_address,
        max_login_attempts=3,
        auth_failed_timeout=3,
        timeout=300,
    )
    return type("RecorderFTPHandler", (RecorderSession, base), settings)


def make_server(config: Config, state: State, api: CrmApi, kick: Callable[[], None]) -> ThreadedFTPServer:
    """A thread per connection: a login asks the API, and a slow answer must not stall the others."""
    os.makedirs(config.root, mode=0o700, exist_ok=True)
    authorizer = TokenAuthorizer(api, config.root, cache_sec=config.auth_cache_sec)
    server = ThreadedFTPServer((config.host, config.port), make_handler(config, authorizer, state, kick))
    server.max_cons = 256
    server.max_cons_per_ip = 64  # a whole office can come from one address (NAT, VPN)
    return server
