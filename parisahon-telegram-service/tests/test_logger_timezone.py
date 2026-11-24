"""DB-1 / HACK-3: the log times are in the CRM's zone, one setting (TZ), Asia/Tashkent by default (was a fixed Asia/Karachi)."""
import importlib
import os
import unittest
from unittest import mock

# the module helpers/Logger.py (its class has the same name)
logger_module = importlib.import_module("helpers.Logger")


class LoggerTimeZoneTest(unittest.TestCase):
    def zone(self, env):
        with mock.patch.dict(os.environ, env, clear=True):
            return logger_module.Logger("test.log").timezone.zone

    def test_default_is_tashkent(self):
        self.assertEqual(self.zone({}), "Asia/Tashkent")

    def test_empty_tz_is_the_default(self):
        self.assertEqual(self.zone({"TZ": ""}), "Asia/Tashkent")

    def test_tz_of_the_environment_is_used(self):
        self.assertEqual(self.zone({"TZ": "Asia/Karachi"}), "Asia/Karachi")

    def test_unknown_zone_falls_back_to_the_default(self):
        self.assertEqual(self.zone({"TZ": "Mars/Olympus"}), "Asia/Tashkent")


if __name__ == "__main__":
    unittest.main()
