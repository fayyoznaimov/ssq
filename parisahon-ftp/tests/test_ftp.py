"""The whole service over real sockets: ftplib -> pyftpdlib -> forwarder -> stand-in API."""
import ftplib
import io
import logging
import os
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import warnings

from helpers import CUBE_NAME, SERVICE_DIR, FakeApi, read
from config import Config, parse_networks
from crm import CrmApi
from forwarder import Forwarder
from ftpd import make_server
from server import NoTokens
from state import State

TOKEN_A = "rec_" + "a1" * 24
TOKEN_B = "rec_" + "b2" * 24
UNKNOWN = "rec_" + "0f" * 24


def free_port_range(count=6):
    """A run of ports nothing listens on (for the passive range)."""
    for first in range(42000, 60000, 37):
        socks = []
        try:
            for port in range(first, first + count):
                socks.append(socket.socket())
                socks[-1].bind(("127.0.0.1", port))
            return range(first, first + count)
        except OSError:
            continue
        finally:
            for sock in socks:
                sock.close()
    raise RuntimeError("no free ports")


class FtpCase(unittest.TestCase):
    tls = False
    tls_required = False
    plain_networks = None
    plain_download = True
    auth_cache_sec = 300.0

    def setUp(self):
        warnings.filterwarnings("ignore", category=DeprecationWarning, module=r"pyftpdlib\..*")  # its MFMT uses utcfromtimestamp
        self.tmp = tempfile.mkdtemp(prefix="ftp-e2e-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.fake = FakeApi()
        self.addCleanup(self.fake.stop)
        self.fake.tokens = {TOKEN_A: (5, "Алишер"), TOKEN_B: (6, "Феруз")}
        cert = key = None
        if self.tls:
            cert, key = os.path.join(self.tmp, "cert.pem"), os.path.join(self.tmp, "key.pem")
            done = subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=test", "-keyout", key, "-out", cert], capture_output=True)
            if done.returncode != 0:
                self.skipTest("openssl cannot make a certificate")
        self.config = Config(root=os.path.join(self.tmp, "data"), state_dir=os.path.join(self.tmp, "state"), api_url=self.fake.url,
                             service_token=self.fake.service_token, host="127.0.0.1", port=0, passive_ports=free_port_range(),
                             settle_sec=0.0, scan_sec=0.2, auth_cache_sec=self.auth_cache_sec, tls_cert=cert, tls_key=key,
                             tls_required=self.tls_required, plain_networks=self.plain_networks, plain_download=self.plain_download)
        self.state = State(self.config.state_db)
        self.api = CrmApi(self.fake.url, self.fake.service_token, timeout=3, upload_timeout=5)
        self.forwarder = Forwarder(self.config, self.state, self.api)
        self.server = make_server(self.config, self.state, self.api, self.forwarder.kick)
        self.server.handler.auth_failed_timeout = 0.05  # pyftpdlib's pause after a wrong password (3 s in the service)
        self.authorizer = self.server.handler.authorizer
        self.port = self.server.address[1]
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()
        self.addCleanup(self._shutdown)
        self._clients = []

    def _serve(self):
        while not self._stop.is_set():
            self.server.serve_forever(timeout=0.05, blocking=False, handle_exit=False)

    def _shutdown(self):
        for client in self._clients:
            try:
                client.close()
            except Exception:
                pass
        self._stop.set()
        self._thread.join(5)
        self.server.close_all()
        self.state.close()

    def connect(self, cls=ftplib.FTP, **kwargs):
        client = cls(**kwargs)
        client.connect("127.0.0.1", self.port, timeout=5)
        self._clients.append(client)
        return client

    def login(self, token=TOKEN_A, user="crm"):
        client = self.connect()
        client.login(user, token)
        return client

    def home(self, user_id, *parts):
        return os.path.join(self.config.root, str(user_id), *parts)

    def wait_for(self, check, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if check():
                return True
            time.sleep(0.02)
        return bool(check())

    def received(self, user_id, name):
        """The server has finished with the upload (its mark is gone and the file is there)."""
        path = self.home(user_id, *name.split("/"))
        return self.wait_for(lambda: os.path.exists(path) and not self.state.is_receiving(path))


class LoginTest(FtpCase):
    def test_unknown_token_is_refused(self):
        client = self.connect()
        with self.assertRaises(ftplib.error_perm) as raised:
            client.login("crm", UNKNOWN)
        self.assertTrue(str(raised.exception).startswith("530"))
        self.assertEqual(self.fake.recorder_calls, 1)
        with self.assertRaises(ftplib.error_perm):
            client.login("crm", UNKNOWN)
        self.assertEqual(self.fake.recorder_calls, 1, "a refused token is not asked about again at once")
        with self.assertRaises(ftplib.error_perm):
            client.nlst()
        self.assertFalse(os.path.exists(self.home(5)))

    def test_too_short_or_empty_password_never_reaches_the_api(self):
        for password in ("", "x", "anonymous@"):
            with self.assertRaises(ftplib.error_perm):
                self.connect().login("anonymous", password)
        self.assertEqual(self.fake.recorder_calls, 0)

    def test_third_wrong_password_closes_the_connection(self):
        client = self.connect()
        for _ in range(3):
            with self.assertRaises(ftplib.error_perm):
                client.login("crm", UNKNOWN)
        with self.assertRaises((EOFError, OSError, ftplib.Error)):
            client.login("crm", TOKEN_A)

    def test_any_user_name_and_the_home_is_made(self):
        with self.assertLogs("ftp.server", "INFO") as logs:
            for user in ("crm", "Алишер", "5", "6", "anonymous"):
                client = self.login(TOKEN_A, user)
                self.assertEqual(client.pwd(), "/")
                client.quit()
        self.assertTrue(os.path.isdir(self.home(5)))
        self.assertEqual(os.listdir(self.config.root), ["5"], "the user name decides nothing")
        self.assertIn('login user=5 name="Алишер" ip=127.0.0.1', logs.output[0])
        self.assertEqual(self.fake.recorder_calls, 1, "an accepted token is cached")

    def test_tokens_are_not_in_the_log(self):
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.addFilter(NoTokens())
        handler.setLevel(logging.DEBUG)
        root = logging.getLogger()
        old_level = root.level
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)
        try:
            self.login(TOKEN_A).quit()
            client = self.connect()
            for user, password in (("crm", UNKNOWN), (TOKEN_B, "secret-password-1234567")):  # the token typed into the wrong field
                with self.assertRaises(ftplib.error_perm):
                    client.login(user, password)
            time.sleep(0.3)
        finally:
            root.removeHandler(handler)
            root.setLevel(old_level)
        text = stream.getvalue()
        self.assertIn("login user=5", text)
        self.assertIn("login refused ip=127.0.0.1", text)
        for secret in (TOKEN_A, TOKEN_B, UNKNOWN, "secret-password-1234567", self.fake.service_token):
            self.assertNotIn(secret, text)

    def test_api_down_at_login(self):
        self.fake.recorder_status = 500
        with self.assertRaises(ftplib.error_perm) as raised:
            self.connect().login("crm", TOKEN_A)
        self.assertIn("try again later", str(raised.exception))
        self.fake.recorder_status = None
        self.login(TOKEN_A).quit()  # and it was not remembered as refused


class CacheTest(FtpCase):
    auth_cache_sec = 0.3

    def test_cache_expires_and_revoked_token_stops_working(self):
        self.login(TOKEN_A).quit()
        self.login(TOKEN_A).quit()
        self.assertEqual(self.fake.recorder_calls, 1)
        time.sleep(0.4)
        self.login(TOKEN_A).quit()
        self.assertEqual(self.fake.recorder_calls, 2)
        del self.fake.tokens[TOKEN_A]  # revoked in the CRM
        time.sleep(0.4)
        with self.assertRaises(ftplib.error_perm):
            self.connect().login("crm", TOKEN_A)

    def test_known_token_gets_in_while_the_api_is_down(self):
        self.login(TOKEN_A).quit()
        time.sleep(0.4)
        self.fake.recorder_status = 502
        with self.assertLogs("ftp.server", "WARNING") as logs:
            client = self.login(TOKEN_A)
        self.assertEqual(client.pwd(), "/")
        self.assertIn("user=5 is let in on its earlier answer", logs.output[0])
        with self.assertRaises(ftplib.error_perm):
            self.connect().login("crm", TOKEN_B)  # never seen before: cannot be checked


class HomeTest(FtpCase):
    def test_a_manager_cannot_leave_the_home(self):
        a, b = self.login(TOKEN_A, "same"), self.login(TOKEN_B, "same")
        a.storbinary("STOR secret of A.wav", io.BytesIO(b"RIFF" + b"a" * 500))
        self.assertTrue(self.received(5, "secret of A.wav"))
        self.assertEqual(a.nlst(), ["secret of A.wav"])
        self.assertEqual(b.nlst(), [], "the same user name is not the same folder")
        b.cwd("..")
        self.assertEqual(b.pwd(), "/")
        b.cwd("/../../..")
        self.assertEqual(b.pwd(), "/")
        self.assertEqual(b.nlst("/.."), [])
        for command in ("SIZE /../5/secret of A.wav", "RETR ../5/secret of A.wav", "CWD /../5", "CWD " + self.home(5), "DELE ../5/secret of A.wav",
                        "RNFR ../5/secret of A.wav", "MKD ../5/planted", "SIZE ../../state/state.sqlite", "CWD " + self.config.state_dir):
            with self.assertRaises(ftplib.error_perm, msg=command) as raised:
                b.sendcmd(command) if not command.startswith("RETR") else b.retrbinary(command, lambda chunk: None)
            self.assertTrue(str(raised.exception).startswith("550"), (command, str(raised.exception)))
        with self.assertRaises(ftplib.error_perm):
            b.storbinary("STOR ../5/planted.wav", io.BytesIO(b"x" * 100))
        self.assertEqual(sorted(os.listdir(self.home(5))), ["secret of A.wav"])
        self.assertEqual(os.listdir(self.home(6)), [])
        self.assertEqual(sorted(os.listdir(self.config.root)), ["5", "6"])

    def test_symlink_out_of_the_home_is_not_followed(self):
        client = self.login(TOKEN_A)
        os.symlink(self.config.state_dir, self.home(5, "link"))
        for command in ("CWD link", "SIZE link/state.sqlite"):
            with self.assertRaises(ftplib.error_perm):
                client.sendcmd(command)

    def test_what_sync_apps_do_is_allowed(self):
        client = self.login(TOKEN_A)
        client.mkd("Cube ACR")
        client.cwd("Cube ACR")
        client.storbinary("STOR a.wav.tmp", io.BytesIO(b"1234567890"))
        client.rename("a.wav.tmp", "a.wav")
        self.assertTrue(client.sendcmd("MFMT 20261121090312 a.wav").startswith("213"))
        self.assertEqual(os.stat(self.home(5, "Cube ACR", "a.wav")).st_mtime, 1795251792)  # 2026-11-21 09:03:12 UTC
        client.voidcmd("TYPE I")
        self.assertEqual(client.size("a.wav"), 10)
        self.assertEqual(client.sendcmd("MDTM a.wav"), "213 20261121090312")
        self.assertEqual([name for name, _ in client.mlsd()], ["a.wav"])
        client.storbinary("APPE a.wav", io.BytesIO(b"more"))
        chunks = []
        client.retrbinary("RETR a.wav", chunks.append)
        self.assertEqual(b"".join(chunks), b"1234567890more")
        client.delete("a.wav")
        client.cwd("/")
        client.rmd("Cube ACR")
        self.assertEqual(client.nlst(), [])
        with self.assertRaises(ftplib.error_perm):
            client.sendcmd("SITE CHMOD 777 /")

    def test_passive_ports_come_from_the_range(self):
        client = self.login(TOKEN_A)
        client.af = socket.AF_INET
        _host, port = client.makepasv()
        self.assertIn(port, self.config.passive_ports)


class UploadTest(FtpCase):
    def test_cube_acr_file_reaches_the_api_for_that_manager(self):
        data = b"RIFF" + os.urandom(4000)
        client = self.login(TOKEN_B)
        with self.assertLogs("ftp.server", "INFO") as logs:
            client.storbinary("STOR " + CUBE_NAME, io.BytesIO(data))
            self.assertTrue(self.received(6, CUBE_NAME))
        self.assertIn(f'received user=6 file="{CUBE_NAME}" size=4004', logs.output[-1])
        self.forwarder.scan_once()
        upload = self.fake.uploads[0]
        self.assertEqual((upload["user_id"], upload["file_name"], upload["data"]), (6, CUBE_NAME, data))
        self.assertEqual(client.nlst(), [CUBE_NAME], "the file is still listed after it was forwarded")
        client.voidcmd("TYPE I")
        self.assertEqual(client.size(CUBE_NAME), 4004)

    def test_temp_name_rename_and_mfmt_give_one_upload(self):
        data = os.urandom(3000)
        client = self.login(TOKEN_A)
        client.mkd("calls")
        client.storbinary("STOR calls/x.m4a.part", io.BytesIO(data))
        self.assertTrue(self.received(5, "calls/x.m4a.part"))
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 0, "the temporary name is left alone")
        with self.assertLogs("ftp.server", "INFO") as logs:
            client.rename("calls/x.m4a.part", "calls/Звонок ↙.m4a")
            self.wait_for(lambda: logs.output)
        self.assertIn('renamed user=5 file="calls/x.m4a.part" to="calls/Звонок ↙.m4a"', logs.output[0])
        client.sendcmd("MFMT 20261121090312 calls/Звонок ↙.m4a")
        for _ in range(3):
            self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 1)
        upload = self.fake.uploads[0]
        self.assertEqual((upload["user_id"], upload["file_name"], upload["recorded_at"], upload["data"]), (5, "Звонок ↙.m4a", "1795251792000", data))
        # the same recording uploaded once more under another name: no second upload
        client.storbinary("STOR calls/again.m4a", io.BytesIO(data))
        self.assertTrue(self.received(5, "calls/again.m4a"))
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 1)
        self.assertEqual(sorted(client.nlst("calls")), ["again.m4a", "Звонок ↙.m4a"], "both stay listed")

    def test_not_audio_is_received_and_ignored(self):
        client = self.login(TOKEN_A)
        with self.assertLogs("ftp.server", "INFO") as logs:
            client.storbinary("STOR notes.txt", io.BytesIO(b"hello"))
            self.assertTrue(self.received(5, "notes.txt"))
        self.assertIn('received user=5 file="notes.txt" size=5 (not forwarded', logs.output[-1])
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 0)
        self.assertEqual(client.nlst(), ["notes.txt"])

    def test_upload_in_progress_is_not_forwarded(self):
        client = self.login(TOKEN_A)
        client.voidcmd("TYPE I")
        data_socket = client.transfercmd("STOR long call.wav")
        data_socket.sendall(b"x" * 5000)
        path = self.home(5, "long call.wav")
        self.assertTrue(self.wait_for(lambda: os.path.exists(path) and os.path.getsize(path) == 5000))
        self.forwarder.scan_once()
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 0, "half a call must not reach the CRM")
        data_socket.sendall(b"y" * 5000)
        data_socket.close()
        client.voidresp()
        self.assertTrue(self.received(5, "long call.wav"))
        self.forwarder.scan_once()
        self.assertEqual(len(self.fake.uploads[0]["data"]), 10000)

    def test_broken_upload_waits_for_the_phone_to_finish_it(self):
        client = self.login(TOKEN_A)
        client.voidcmd("TYPE I")
        data_socket = client.transfercmd("STOR call.wav")
        data_socket.sendall(b"x" * 5000)
        path = self.home(5, "call.wav")
        self.assertTrue(self.wait_for(lambda: os.path.exists(path) and os.path.getsize(path) == 5000))
        with self.assertLogs("ftp.server", "WARNING") as logs:
            client.sock.close()  # the phone lost the network: the control connection dies first
            client.file.close()
            self.assertTrue(self.wait_for(lambda: any("incomplete" in line for line in logs.output)))
            data_socket.close()
        self.assertIn('incomplete user=5 file="call.wav" size=5000', logs.output[0])
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 0)
        # the service is restarted: the half file is still not sent
        self.forwarder = Forwarder(self.config, State(self.config.state_db), self.api)
        self.forwarder.scan_once()
        self.assertEqual(self.fake.posts, 0)
        self.forwarder.state.close()
        # the phone comes back and resumes the upload
        client = self.login(TOKEN_A)
        client.storbinary("APPE call.wav", io.BytesIO(b"y" * 5000))
        self.assertTrue(self.received(5, "call.wav"))
        self.forwarder = Forwarder(self.config, self.state, self.api)
        self.forwarder.scan_once()
        self.assertEqual(self.fake.uploads[0]["data"], b"x" * 5000 + b"y" * 5000)

    def test_delete_by_the_phone_clears_everything(self):
        client = self.login(TOKEN_A)
        client.storbinary("STOR a.wav", io.BytesIO(b"z" * 300))
        self.assertTrue(self.received(5, "a.wav"))
        client.delete("a.wav")
        self.assertIsNone(self.forwarder.scan_once())
        self.assertEqual(self.fake.posts, 0)

    def test_running_loop_forwards_soon_after_the_upload(self):
        self.config.scan_sec = 30  # only the kick from the FTP side can make it this fast
        self.forwarder.start()
        self.addCleanup(self.forwarder.stop)
        time.sleep(0.2)
        client = self.login(TOKEN_A)
        client.storbinary("STOR a.wav", io.BytesIO(os.urandom(700)))
        self.assertTrue(self.wait_for(lambda: self.fake.uploads, timeout=5))
        self.assertEqual(self.fake.names(), ["a.wav"])


@unittest.skipUnless(shutil.which("openssl"), "no openssl")
class TlsTest(FtpCase):
    tls = True

    def test_ftps_is_offered_and_plain_ftp_still_works(self):
        secure = self.connect(ftplib.FTP_TLS, context=ssl._create_unverified_context())
        self.assertIn("AUTH TLS", secure.sendcmd("FEAT"))
        with self.assertLogs("ftp.server", "INFO") as logs:
            secure.login("crm", TOKEN_A)  # ftplib sends AUTH TLS before USER
            self.wait_for(lambda: logs.output)  # the server thread logs the login a moment after the client has its 230
        self.assertIn("login user=5", logs.output[0])
        self.assertTrue(logs.output[0].endswith(" tls"))
        secure.prot_p()
        secure.storbinary("STOR over tls.wav", io.BytesIO(b"t" * 2000))
        self.assertTrue(self.received(5, "over tls.wav"))
        self.assertEqual(secure.nlst(), ["over tls.wav"])
        with self.assertLogs("ftp.server", "INFO") as logs:
            plain = self.login(TOKEN_A)
            self.wait_for(lambda: logs.output)  # the server thread logs the login a moment after the client has its 230
        self.assertTrue(logs.output[0].endswith(" plain"), "the log tells which phones still send without TLS")
        plain.storbinary("STOR plain.wav", io.BytesIO(b"p" * 2000))
        self.assertTrue(self.received(5, "plain.wav"))
        self.forwarder.scan_once()
        self.assertEqual(sorted(self.fake.names()), ["over tls.wav", "plain.wav"])


class PlainNetworksTest(FtpCase):
    plain_networks = parse_networks("10.99.0.0/16")

    def test_plain_login_from_outside_is_refused_before_the_password(self):
        client = self.connect()
        with self.assertLogs("ftp.server", "WARNING") as logs:
            with self.assertRaises(ftplib.error_perm) as raised:
                client.sendcmd("USER crm")
            self.wait_for(lambda: logs.output)
        self.assertTrue(str(raised.exception).startswith("550"), str(raised.exception))
        self.assertIn("login refused ip=127.0.0.1: plain FTP from outside FTP_PLAIN_NETWORKS", logs.output[0])
        with self.assertRaises(ftplib.error_perm) as raised:
            client.sendcmd("PASS " + TOKEN_A)
        self.assertTrue(str(raised.exception).startswith("503"), "no user name was taken: the password is not checked")
        self.assertEqual(self.fake.recorder_calls, 0, "the token never reached the API")
        self.assertFalse(os.path.exists(self.home(5)))


class PlainNetworkAllowedTest(FtpCase):
    plain_networks = parse_networks("192.168.1.0/24 127.0.0.0/8")

    def test_plain_login_from_the_office_network(self):
        client = self.login(TOKEN_A)
        client.storbinary("STOR a.wav", io.BytesIO(b"a" * 300))
        self.assertTrue(self.received(5, "a.wav"))


class PlainUploadOnlyTest(FtpCase):
    plain_download = False

    def test_plain_session_uploads_but_cannot_read_back(self):
        client = self.login(TOKEN_A)
        client.mkd("calls")
        client.storbinary("STOR calls/a.wav.tmp", io.BytesIO(b"1234567890"))
        client.rename("calls/a.wav.tmp", "calls/a.wav")
        self.assertTrue(client.sendcmd("MFMT 20261121090312 calls/a.wav").startswith("213"))
        client.voidcmd("TYPE I")
        client.storbinary("APPE calls/a.wav", io.BytesIO(b"more"))
        self.assertEqual(client.size("calls/a.wav"), 14)
        self.assertEqual(client.nlst("calls"), ["a.wav"])
        with self.assertRaises(ftplib.error_perm) as raised:
            client.retrbinary("RETR calls/a.wav", lambda chunk: None)
        self.assertTrue(str(raised.exception).startswith("550"), str(raised.exception))
        self.assertIn("FTPS", str(raised.exception))
        client.delete("calls/a.wav")
        self.assertEqual(client.nlst("calls"), [])


@unittest.skipUnless(shutil.which("openssl"), "no openssl")
class TlsRequiredTest(FtpCase):
    tls = True
    tls_required = True

    def test_plain_ftp_is_refused_and_ftps_works(self):
        plain = self.connect()
        with self.assertRaises(ftplib.error_perm) as raised:
            plain.login("crm", TOKEN_A)
        self.assertTrue(str(raised.exception).startswith("550"), str(raised.exception))
        self.assertEqual(self.fake.recorder_calls, 0)
        secure = self.connect(ftplib.FTP_TLS, context=ssl._create_unverified_context())
        secure.login("crm", TOKEN_A)
        secure.prot_p()
        secure.storbinary("STOR over tls.wav", io.BytesIO(b"t" * 2000))
        self.assertTrue(self.received(5, "over tls.wav"))
        self.forwarder.scan_once()
        self.assertEqual(self.fake.names(), ["over tls.wav"])


@unittest.skipUnless(shutil.which("openssl"), "no openssl")
class TlsFromAnywhereTest(FtpCase):
    tls = True
    plain_networks = parse_networks("10.99.0.0/16")
    plain_download = False

    def test_ftps_from_any_network_with_downloads(self):
        plain = self.connect()
        with self.assertRaises(ftplib.error_perm) as raised:
            plain.login("crm", TOKEN_A)
        self.assertIn("use FTPS", str(raised.exception))
        secure = self.connect(ftplib.FTP_TLS, context=ssl._create_unverified_context())
        with self.assertLogs("ftp.server", "INFO") as logs:
            secure.login("crm", TOKEN_A)
            self.wait_for(lambda: logs.output)
        self.assertTrue(logs.output[0].endswith(" tls"), logs.output[0])
        secure.prot_p()
        secure.storbinary("STOR a.wav", io.BytesIO(b"x" * 100))
        self.assertTrue(self.received(5, "a.wav"))
        chunks = []
        secure.retrbinary("RETR a.wav", chunks.append)
        self.assertEqual(b"".join(chunks), b"x" * 100, "over FTPS the sync app may read its files back")


class ProcessTest(unittest.TestCase):
    """server.py as systemd runs it: settings from the environment, SIGTERM to stop."""

    def test_service_process_end_to_end(self):
        tmp = tempfile.mkdtemp(prefix="ftp-proc-")
        self.addCleanup(shutil.rmtree, tmp, True)
        fake = FakeApi()
        self.addCleanup(fake.stop)
        fake.tokens[TOKEN_A] = (5, "Алишер")
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        passive = free_port_range(3)
        env = {"PATH": os.environ.get("PATH", ""), "FTP_HOST": "127.0.0.1", "FTP_PORT": str(port), "FTP_PASSIVE_PORTS": f"{passive.start}-{passive.stop - 1}",
               "FTP_ROOT": os.path.join(tmp, "data"), "FTP_STATE_DIR": os.path.join(tmp, "state"), "CRM_API_URL": fake.url,
               "CALLS_SERVICE_TOKEN": fake.service_token, "FTP_SETTLE_SEC": "0.3", "FTP_SCAN_SEC": "0.5"}

        def start():
            process = subprocess.Popen([sys.executable, "-u", os.path.join(SERVICE_DIR, "server.py")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            deadline = time.time() + 10
            while time.time() < deadline:
                try:
                    socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
                    return process
                except OSError:
                    time.sleep(0.1)
            process.kill()
            self.fail("the service did not start: " + process.communicate()[0].decode("utf-8", "replace"))

        def stop(process):
            process.send_signal(signal.SIGTERM)
            output = process.communicate(timeout=15)[0].decode("utf-8")
            self.assertEqual(process.returncode, 0, output)
            return output

        def wait_uploads(count):
            deadline = time.time() + 10
            while len(fake.uploads) < count and time.time() < deadline:
                time.sleep(0.05)
            return len(fake.uploads)

        process = start()
        try:
            client = ftplib.FTP()
            client.connect("127.0.0.1", port, timeout=5)
            client.login("crm", TOKEN_A)
            client.storbinary("STOR " + CUBE_NAME, io.BytesIO(b"RIFF" + b"1" * 1000))
            self.assertEqual(wait_uploads(1), 1)
            client.quit()
        finally:
            output = stop(process)
        self.assertEqual(oct(os.stat(os.path.join(tmp, "data", "5", CUBE_NAME)).st_mode & 0o777), "0o600")
        self.assertIn("listening on 127.0.0.1", output)
        self.assertIn('login user=5 name="Алишер" ip=127.0.0.1', output)
        self.assertIn(f'received user=5 file="{CUBE_NAME}" size=1004', output)
        self.assertIn(f'forwarded user=5 file="{CUBE_NAME}" size=1004 upload_id={fake.uploads[0]["id"]}', output)
        self.assertNotIn(TOKEN_A, output)
        self.assertNotIn(fake.service_token, output)

        # a file that arrives while the API cannot take it is sent after the restart, the first one is not sent again
        with open(os.path.join(tmp, "data", "5", "second.wav"), "wb") as handle:
            handle.write(b"RIFF" + b"2" * 1000)
        process = start()
        try:
            self.assertEqual(wait_uploads(2), 2)
            time.sleep(1.2)
        finally:
            stop(process)
        self.assertEqual(fake.names(), [CUBE_NAME, "second.wav"])
        self.assertEqual(fake.posts, 2)

    def test_bad_settings_stop_the_start(self):
        done = subprocess.run([sys.executable, os.path.join(SERVICE_DIR, "server.py")], env={"PATH": os.environ.get("PATH", ""), "FTP_ROOT": "/tmp/x"}, capture_output=True, timeout=20)
        self.assertEqual(done.returncode, 2)
        self.assertIn(b"CALLS_SERVICE_TOKEN", done.stderr)


if __name__ == "__main__":
    unittest.main()
