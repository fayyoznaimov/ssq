#!/usr/bin/env python3
"""Stand-in for the mail server on the dev copy (the docker stack uses GreenMail; there is no
docker on the server): an IMAP server (pymap, in-memory) plus an SMTP server (aiosmtpd) that
delivers every accepted message into the INBOX of the one mailbox. Both speak implicit TLS with
a self-signed certificate (the API runs with NODE_TLS_REJECT_UNAUTHORIZED=0 against it).

Environment: MAIL_USER, MAIL_PASSWORD, IMAP_PORT (8993), SMTP_PORT (8465), MAIL_DIR (cert and key).
Run with local/dev/mail-venv/bin/python (pymap, aiosmtpd).
"""
import asyncio
import imaplib
import os
import ssl
import subprocess
import sys
import time

from aiosmtpd.controller import Controller

USER = os.environ.get("MAIL_USER", "testing@parisahome.com")
PASSWORD = os.environ.get("MAIL_PASSWORD", "testing")
IMAP_PORT = int(os.environ.get("IMAP_PORT", "8993"))      # implicit TLS, for the API (like port 993)
IMAP_PLAIN_PORT = int(os.environ.get("IMAP_PLAIN_PORT", "8143"))  # pymap itself, plain, loopback only
SMTP_PORT = int(os.environ.get("SMTP_PORT", "8465"))
MAIL_DIR = os.environ.get("MAIL_DIR", os.path.dirname(os.path.abspath(__file__)))
CERT = os.path.join(MAIL_DIR, "cert.pem")
KEY = os.path.join(MAIL_DIR, "key.pem")
FOLDERS = ["INBOX", "INBOX.Sent", "INBOX.spam", "INBOX.Trash"]


def log(message):
    print(time.strftime("%H:%M:%S"), message, flush=True)


def ensure_cert():
    if os.path.exists(CERT) and os.path.exists(KEY):
        return
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
                    "-subj", "/CN=localhost", "-keyout", KEY, "-out", CERT], check=True, capture_output=True)
    log("self-signed certificate written")


def imap_connect():
    client = imaplib.IMAP4("127.0.0.1", IMAP_PLAIN_PORT)
    client.login(USER, PASSWORD)
    return client


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError, ssl.SSLError):
        pass
    finally:
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass


async def tls_front(ctx):
    """pymap speaks plain IMAP; the API wants implicit TLS on one port, like a real 993."""

    async def handle(client_reader, client_writer):
        try:
            upstream_reader, upstream_writer = await asyncio.open_connection("127.0.0.1", IMAP_PLAIN_PORT)
        except OSError as error:
            log(f"IMAP upstream unavailable: {error}")
            client_writer.close()
            return
        await asyncio.gather(pipe(client_reader, upstream_writer), pipe(upstream_reader, client_writer))

    server = await asyncio.start_server(handle, "127.0.0.1", IMAP_PORT, ssl=ctx)
    log(f"IMAPS front ready on {IMAP_PORT} -> {IMAP_PLAIN_PORT}")
    async with server:
        await server.serve_forever()


def wait_for_imap(timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            client = imap_connect()
            for folder in FOLDERS:
                client.create(folder)  # "already exists" is fine
            client.logout()
            log(f"IMAP ready on {IMAP_PLAIN_PORT}, mailboxes {', '.join(FOLDERS)}")
            return
        except Exception as error:  # noqa: BLE001
            last = error
            time.sleep(0.5)
    raise SystemExit(f"IMAP did not start: {last}")


class Deliver:
    """SMTP -> INBOX of the mailbox (what GreenMail does for its users)."""

    async def handle_DATA(self, server, session, envelope):
        # like a real server: only mail addressed to the mailbox of the stand lands in its INBOX;
        # mail to other addresses is accepted and goes nowhere (the CRM keeps its own Sent copy)
        if not any(rcpt.lower() == USER.lower() for rcpt in envelope.rcpt_tos):
            log(f"accepted for {envelope.rcpt_tos}, not local: dropped")
            return "250 OK"
        data = envelope.content
        if isinstance(data, str):
            data = data.encode("utf-8", "surrogateescape")
        try:
            await asyncio.get_running_loop().run_in_executor(None, self.append, data)
        except Exception as error:  # noqa: BLE001
            log(f"delivery failed: {error}")
            return "451 Temporary failure"
        log(f"delivered {len(data)} bytes from {envelope.mail_from} to INBOX")
        return "250 OK"

    @staticmethod
    def append(data):
        client = imap_connect()
        try:
            status, _ = client.append("INBOX", None, None, data)
            if status != "OK":
                raise RuntimeError(f"APPEND {status}")
        finally:
            client.logout()


class Authenticator:
    def __call__(self, server, session, envelope, mechanism, auth_data):
        from aiosmtpd.smtp import AuthResult
        login = getattr(auth_data, "login", b"")
        password = getattr(auth_data, "password", b"")
        ok = login.decode() == USER and password.decode() == PASSWORD
        return AuthResult(success=ok, handled=True)


def main():
    ensure_cert()
    pymap_bin = os.path.join(os.path.dirname(sys.executable), "pymap")
    pymap = subprocess.Popen([
        pymap_bin, "--host", "127.0.0.1", "--port", str(IMAP_PLAIN_PORT), "--no-tls",
        "dict", "--demo-user", USER, "--demo-password", PASSWORD,
    ])
    try:
        wait_for_imap()
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(CERT, KEY)
        controller = Controller(Deliver(), hostname="127.0.0.1", port=SMTP_PORT, ssl_context=ctx,
                                authenticator=Authenticator(), auth_required=False, auth_require_tls=False)
        controller.start()
        log(f"SMTPS ready on {SMTP_PORT}")

        async def run():
            front = asyncio.create_task(tls_front(ctx))
            while pymap.poll() is None:
                await asyncio.sleep(1)
            front.cancel()
            raise SystemExit(f"pymap exited with {pymap.returncode}")

        asyncio.run(run())
    finally:
        pymap.terminate()


if __name__ == "__main__":
    main()
