"""Settings of the FTP receiver: everything comes from the environment (README.md lists the keys)."""
import ipaddress
import os
from dataclasses import dataclass
from typing import Mapping, Optional, Tuple

# what the CRM API accepts at POST /calls/upload; everything else stays in the folder untouched
AUDIO_EXTENSIONS = (".amr", ".mp3", ".m4a", ".wav", ".ogg", ".aac", ".3gp")


class ConfigError(Exception):
    pass


@dataclass
class Config:
    root: str                      # FTP_ROOT: homes of the managers, FTP_ROOT/<user_id>/
    state_dir: str                 # FTP_STATE_DIR: sqlite with what was sent; never inside FTP_ROOT
    api_url: str                   # CRM_API_URL, e.g. http://127.0.0.1:3000/api/v1
    service_token: str             # CALLS_SERVICE_TOKEN, the same value as in the API's env
    host: str = "0.0.0.0"
    port: int = 2121
    passive_ports: Optional[range] = None
    masquerade_address: Optional[str] = None
    tls_cert: Optional[str] = None
    tls_key: Optional[str] = None
    # FTP_TLS_REQUIRED: with a certificate, every login and transfer must be FTPS (no plain FTP at all)
    tls_required: bool = False
    # FTP_PLAIN_NETWORKS: plain (not TLS) FTP only from these networks (office, VPN); None = from anywhere
    plain_networks: Optional[Tuple[object, ...]] = None
    # FTP_PLAIN_DOWNLOAD: a session without TLS may download files (RETR); FTPS sessions always may
    plain_download: bool = True
    retain_days: float = 30.0      # 0 = keep the files forever
    settle_sec: float = 5.0        # size and mtime must not change this long before a file is sent
    scan_sec: float = 10.0
    auth_cache_sec: float = 300.0  # a recorder token that the API accepted is not asked about again this long
    log_level: str = "INFO"

    @property
    def state_db(self) -> str:
        return os.path.join(self.state_dir, "state.sqlite")


def _number(env: Mapping[str, str], key: str, default: float, minimum: float = 0.0) -> float:
    raw = (env.get(key) or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ConfigError(f"{key} must be a number, got {raw!r}") from None
    if value < minimum:
        raise ConfigError(f"{key} must be at least {minimum:g}, got {raw!r}")
    return value


def _flag(env: Mapping[str, str], key: str, default: bool) -> bool:
    raw = (env.get(key) or "").strip().lower()
    if not raw:
        return default
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    raise ConfigError(f"{key} must be 1 or 0, got {raw!r}")


def parse_networks(raw: str) -> Optional[Tuple[object, ...]]:
    """"10.0.0.0/8, 192.168.1.0/24 203.0.113.7" -> networks; empty -> None (no limit)."""
    parts = [part for part in (raw or "").replace(",", " ").split() if part]
    if not parts:
        return None
    networks = []
    for part in parts:
        try:
            networks.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            raise ConfigError(f"FTP_PLAIN_NETWORKS must be addresses or networks like 192.168.1.0/24, got {part!r}") from None
    return tuple(networks)


def address_in(networks: Optional[Tuple[object, ...]], address: str) -> bool:
    """Is the client's address in one of the networks (None: no limit)? An IPv4 address seen as IPv6 (::ffff:a.b.c.d) counts as IPv4."""
    if networks is None:
        return True
    try:
        ip = ipaddress.ip_address((address or "").split("%")[0])
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return any(ip.version == network.version and ip in network for network in networks)


def parse_passive_ports(raw: str) -> Optional[range]:
    """"21310-21319" -> range(21310, 21320); empty -> None (any free port)."""
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        low, _, high = raw.partition("-")
        first, last = int(low), int(high or low)
    except ValueError:
        raise ConfigError(f"FTP_PASSIVE_PORTS must look like 21310-21319, got {raw!r}") from None
    if not (0 < first <= last < 65536):
        raise ConfigError(f"FTP_PASSIVE_PORTS must look like 21310-21319, got {raw!r}")
    return range(first, last + 1)


def from_env(env: Optional[Mapping[str, str]] = None) -> Config:
    env = os.environ if env is None else env
    missing = [key for key in ("FTP_ROOT", "FTP_STATE_DIR", "CRM_API_URL", "CALLS_SERVICE_TOKEN") if not (env.get(key) or "").strip()]
    if missing:
        raise ConfigError("not set: " + ", ".join(missing))
    root = os.path.abspath(env["FTP_ROOT"].strip())
    state_dir = os.path.abspath(env["FTP_STATE_DIR"].strip())
    if os.path.commonpath([root, state_dir]) == root:
        raise ConfigError("FTP_STATE_DIR must be outside FTP_ROOT (the managers must not reach it over FTP)")
    cert = (env.get("FTP_TLS_CERT") or "").strip() or None
    key = (env.get("FTP_TLS_KEY") or "").strip() or None
    if bool(cert) != bool(key):
        raise ConfigError("FTP_TLS_CERT and FTP_TLS_KEY go together: set both or none")
    for path in (cert, key):
        if path and not os.path.isfile(path):
            raise ConfigError(f"TLS file does not exist: {path}")
    tls_required = _flag(env, "FTP_TLS_REQUIRED", False)
    if tls_required and not cert:
        raise ConfigError("FTP_TLS_REQUIRED needs a certificate: set FTP_TLS_CERT and FTP_TLS_KEY")
    return Config(
        root=root,
        state_dir=state_dir,
        api_url=env["CRM_API_URL"].strip().rstrip("/"),
        service_token=env["CALLS_SERVICE_TOKEN"].strip(),
        host=(env.get("FTP_HOST") or "").strip() or "0.0.0.0",
        port=int(_number(env, "FTP_PORT", 2121, 1)),
        passive_ports=parse_passive_ports(env.get("FTP_PASSIVE_PORTS", "")),
        masquerade_address=(env.get("FTP_MASQUERADE_ADDRESS") or "").strip() or None,
        tls_cert=cert,
        tls_key=key,
        tls_required=tls_required,
        plain_networks=parse_networks(env.get("FTP_PLAIN_NETWORKS", "")),
        plain_download=_flag(env, "FTP_PLAIN_DOWNLOAD", True),
        retain_days=_number(env, "FTP_RETAIN_DAYS", 30.0),
        settle_sec=_number(env, "FTP_SETTLE_SEC", 5.0),
        scan_sec=_number(env, "FTP_SCAN_SEC", 10.0, 0.05),
        auth_cache_sec=_number(env, "FTP_AUTH_CACHE_SEC", 300.0),
        log_level=((env.get("LOG_LEVEL") or "").strip() or "INFO").upper(),
    )
