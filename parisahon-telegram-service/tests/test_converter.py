"""HACK-10: one way to find ffmpeg (FFMPEG_BIN, else "ffmpeg" from PATH); a broken old setting does not lose voice notes."""
import os
import stat
import tempfile
import unittest
from unittest import mock

from helpers import converter as ffmpeg


def fake_bin(directory: str, name: str = "ffmpeg") -> str:
    path = os.path.join(directory, name)
    with open(path, "w") as f:
        f.write('#!/bin/sh\necho "ffmpeg version 6.1"\n')
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


@unittest.skipIf(os.name == "nt", "posix only")
class FfmpegTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path_dir = tempfile.mkdtemp()

    def find(self, env):
        with mock.patch.dict(os.environ, env, clear=True):
            return ffmpeg.find(check=lambda b: True, refresh=True)

    def test_ffmpeg_bin_is_used(self):
        binary = fake_bin(self.dir)
        found = self.find({"FFMPEG_BIN": binary, "PATH": self.path_dir})
        self.assertEqual((found[0], found[2]), (binary, True))

    def test_ffprobe_next_to_ffmpeg(self):
        binary = fake_bin(self.dir)
        probe = fake_bin(self.dir, "ffprobe")
        found = self.find({"FFMPEG_BIN": binary, "PATH": self.path_dir})
        self.assertEqual(found[1], probe)

    def test_the_old_flag_without_a_directory_falls_back_to_path(self):
        # prod telegram.env had USE_CUSTOM_FFMPEG_INSTALLATION=true and no FFMPEG_INSTALLATION_DIR ("None/ffmpeg")
        in_path = fake_bin(self.path_dir)
        found = self.find({"USE_CUSTOM_FFMPEG_INSTALLATION": "true", "PATH": self.path_dir})
        self.assertEqual((found[0], found[2]), (in_path, True))

    def test_an_empty_old_mount_falls_back_to_path(self):
        in_path = fake_bin(self.path_dir)
        found = self.find({"FFMPEG_BIN": "/opt/ffmpeg/ffmpeg", "PATH": self.path_dir})
        self.assertEqual((found[0], found[2]), (in_path, True))
        self.assertIn("not found", found[3][0])

    def test_the_old_directory_still_works(self):
        binary = fake_bin(self.dir)
        found = self.find({"USE_CUSTOM_FFMPEG_INSTALLATION": "true", "FFMPEG_INSTALLATION_DIR": self.dir, "PATH": self.path_dir})
        self.assertEqual(found[0], binary)

    def test_nothing_found(self):
        found = self.find({"PATH": self.path_dir})
        self.assertEqual(found[:3], ("", "", False))

    def test_the_real_check_runs_the_binary(self):
        binary = fake_bin(self.dir)
        self.assertTrue(ffmpeg.answers(binary))
        self.assertFalse(ffmpeg.answers(os.path.join(self.dir, "missing")))


if __name__ == "__main__":
    unittest.main()
