#!/usr/bin/env python3
"""FTP receiver of the managers' call recordings (Parisa CRM).

The phones' recorder (Cube ACR and the like) keeps the calls in a folder; an FTP sync app uploads
that folder here. Login: any user name, the password is the manager's recorder token from the CRM.
Every audio file that arrives is posted to the CRM API (POST /calls/upload); the API reads the
number, the direction and the time from the file name - this service only carries the files.

    <venv>/bin/python -u server.py        settings come from the environment, see README.md
"""
import logging
import os
import re
import signal
import sys

import config as config_module
from crm import CrmApi
from forwarder import Forwarder
from ftpd import make_server
from state import State

log = logging.getLogger("ftp")


class NoTokens(logging.Filter):
    """Recorder tokens never reach the log, even when someone types one into the user name field
    (pyftpdlib logs the user name of a failed login)."""
    pattern = re.compile(r"rec_[0-9A-Za-z_\-]{6,}")

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:
            return True
        if "rec_" in message:
            record.msg, record.args = self.pattern.sub("rec_***", message), None
        return True


def setup_logging(level: str) -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except Exception:
            pass
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S"))
    handler.addFilter(NoTokens())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(getattr(logging, level, logging.INFO))


def main() -> int:
    try:
        config = config_module.from_env()
    except config_module.ConfigError as error:
        print(f"parisahon-ftp: bad settings: {error}", file=sys.stderr)
        return 2
    setup_logging(config.log_level)
    os.umask(0o077)  # what the phones upload is readable by this service only
    os.makedirs(config.root, mode=0o700, exist_ok=True)
    state = State(config.state_db)
    api = CrmApi(config.api_url, config.service_token)
    forwarder = Forwarder(config, state, api)
    server = make_server(config, state, api, forwarder.kick)

    def stop(signum, _frame):
        log.info("signal %s: stopping", signum)
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    passive = f"{config.passive_ports.start}-{config.passive_ports.stop - 1}" if config.passive_ports else "any"
    ftps = "required" if config.tls_required else "offered (AUTH TLS)" if config.tls_cert else "off"
    if config.tls_required:
        plain = "off"
    else:
        plain = ("from " + " ".join(str(n) for n in config.plain_networks)) if config.plain_networks else "from anywhere"
        plain += "" if config.plain_download else ", upload only"
    log.info("listening on %s:%s, passive ports %s%s, FTPS %s, plain FTP %s, root %s, API %s, scan every %gs, settle %gs, keep files %s",
             config.host, config.port, passive, f" (announced address {config.masquerade_address})" if config.masquerade_address else "",
             ftps, plain, config.root, config.api_url, config.scan_sec, config.settle_sec,
             f"{config.retain_days:g} days" if config.retain_days > 0 else "forever")
    if not config.tls_required and not config.plain_networks:
        log.warning("plain FTP is allowed from any network: the recorder tokens can be read on the way "
                    "(set FTP_PLAIN_NETWORKS to the office / VPN networks, or FTP_TLS_REQUIRED=1 when every phone does FTPS)")
    forwarder.start()
    try:
        server.serve_forever(handle_exit=False)
    except KeyboardInterrupt:
        pass
    finally:
        forwarder.stop()
        server.close_all()
        state.close()
        log.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
