import os
import tempfile
import unittest

import helpers  # noqa: F401  (puts the service on sys.path)
from config import ConfigError, from_env, parse_passive_ports


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = {
            "FTP_ROOT": os.path.join(self.tmp.name, "data"), "FTP_STATE_DIR": os.path.join(self.tmp.name, "state"),
            "CRM_API_URL": "http://127.0.0.1:3100/api/v1/", "CALLS_SERVICE_TOKEN": "t" * 48,
        }

    def test_defaults(self):
        config = from_env(self.base)
        self.assertEqual((config.host, config.port), ("0.0.0.0", 2121))
        self.assertEqual((config.retain_days, config.settle_sec, config.scan_sec), (30.0, 5.0, 10.0))
        self.assertIsNone(config.passive_ports)
        self.assertIsNone(config.masquerade_address)
        self.assertIsNone(config.tls_cert)
        self.assertEqual(config.api_url, "http://127.0.0.1:3100/api/v1")
        self.assertEqual(os.path.dirname(config.state_db), self.base["FTP_STATE_DIR"])

    def test_everything_set(self):
        cert = os.path.join(self.tmp.name, "cert.pem")
        key = os.path.join(self.tmp.name, "key.pem")
        for path in (cert, key):
            open(path, "w").close()
        config = from_env({**self.base, "FTP_HOST": "127.0.0.1", "FTP_PORT": "2131", "FTP_PASSIVE_PORTS": "21310-21319",
                           "FTP_MASQUERADE_ADDRESS": "203.0.113.7", "FTP_TLS_CERT": cert, "FTP_TLS_KEY": key,
                           "FTP_RETAIN_DAYS": "0", "FTP_SETTLE_SEC": "2", "FTP_SCAN_SEC": "3"})
        self.assertEqual((config.host, config.port), ("127.0.0.1", 2131))
        self.assertEqual(config.passive_ports, range(21310, 21320))
        self.assertEqual(config.masquerade_address, "203.0.113.7")
        self.assertEqual((config.tls_cert, config.tls_key), (cert, key))
        self.assertEqual((config.retain_days, config.settle_sec, config.scan_sec), (0.0, 2.0, 3.0))

    def test_empty_values_are_defaults(self):
        config = from_env({**self.base, "FTP_MASQUERADE_ADDRESS": "", "FTP_TLS_CERT": "", "FTP_TLS_KEY": "", "FTP_PASSIVE_PORTS": "", "FTP_PORT": ""})
        self.assertEqual(config.port, 2121)
        self.assertIsNone(config.tls_cert)

    def test_missing_keys_are_named(self):
        with self.assertRaises(ConfigError) as raised:
            from_env({"FTP_ROOT": "/x"})
        for key in ("FTP_STATE_DIR", "CRM_API_URL", "CALLS_SERVICE_TOKEN"):
            self.assertIn(key, str(raised.exception))

    def test_state_inside_the_homes_is_refused(self):
        with self.assertRaises(ConfigError):
            from_env({**self.base, "FTP_STATE_DIR": os.path.join(self.base["FTP_ROOT"], "state")})
        with self.assertRaises(ConfigError):
            from_env({**self.base, "FTP_STATE_DIR": self.base["FTP_ROOT"]})

    def test_half_a_certificate_is_refused(self):
        with self.assertRaises(ConfigError):
            from_env({**self.base, "FTP_TLS_CERT": "/nope/cert.pem"})
        with self.assertRaises(ConfigError):
            from_env({**self.base, "FTP_TLS_CERT": "/nope/cert.pem", "FTP_TLS_KEY": "/nope/key.pem"})

    def test_bad_numbers(self):
        for key, value in (("FTP_PORT", "ftp"), ("FTP_RETAIN_DAYS", "-1"), ("FTP_SCAN_SEC", "0"), ("FTP_PASSIVE_PORTS", "21319-21310"), ("FTP_PASSIVE_PORTS", "a-b")):
            with self.assertRaises(ConfigError, msg=f"{key}={value}"):
                from_env({**self.base, key: value})

    def test_passive_ports(self):
        self.assertEqual(parse_passive_ports("21310-21319"), range(21310, 21320))
        self.assertEqual(parse_passive_ports("21310"), range(21310, 21311))
        self.assertIsNone(parse_passive_ports(" "))


if __name__ == "__main__":
    unittest.main()
