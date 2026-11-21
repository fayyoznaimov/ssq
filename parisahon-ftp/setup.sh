#!/usr/bin/env bash
# Installs the FTP receiver of call recordings without root: a Python venv with requirements.txt and,
# when a folder for it is given and openssl is there, a self-signed certificate for FTPS (AUTH TLS).
#   parisahon-ftp/setup.sh <venv dir> [tls dir]
# Dev copy: parisahon-ftp/setup.sh local/dev/ftp/venv local/dev/ftp/tls   (unit crm-dev-ftp, local/dev/units.sh)
# Then run: <venv dir>/bin/python -u parisahon-ftp/server.py   (settings from the environment: see README.md)
# The certificate is written once (cert.pem + key.pem, 10 years); delete the two files to get a new one.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${1:?usage: setup.sh <venv dir> [tls dir]}"
TLS="${2:-}"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$HERE/requirements.txt"
"$VENV/bin/python" -I -c "import pyftpdlib, OpenSSL; print('pyftpdlib', pyftpdlib.__ver__, '/ pyOpenSSL', OpenSSL.__version__)"
if [ -n "$TLS" ]; then
  if [ -s "$TLS/cert.pem" ] && [ -s "$TLS/key.pem" ]; then
    echo "certificate kept: $TLS/cert.pem"
  elif command -v openssl >/dev/null 2>&1; then
    mkdir -p "$TLS" && chmod 700 "$TLS"
    name="$(hostname 2>/dev/null || echo parisa-crm)"
    ( umask 077
      openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 -subj "/CN=$name/O=Parisa CRM call recordings" \
        -keyout "$TLS/key.pem" -out "$TLS/cert.pem" >/dev/null 2>&1 )
    chmod 600 "$TLS/key.pem" "$TLS/cert.pem"
    echo "self-signed certificate written: $TLS/cert.pem (set FTP_TLS_CERT / FTP_TLS_KEY to cert.pem / key.pem)"
  else
    echo "no openssl: no certificate, the service will offer plain FTP only"
  fi
fi
