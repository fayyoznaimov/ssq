#!/usr/bin/env python3
"""Replaces identical files in a folder by hard links to one copy (names and links keep working).
Usage: dedupe-uploads.py <folder> [--dry]. Cron runs it weekly for the CRM uploads."""
import hashlib, os, sys
from collections import defaultdict

folder = sys.argv[1]
dry = "--dry" in sys.argv
by_size = defaultdict(list)
for name in os.listdir(folder):
    path = os.path.join(folder, name)
    if os.path.isfile(path) and not os.path.islink(path):
        st = os.stat(path)
        if st.st_size >= 1024:
            by_size[st.st_size].append((st.st_mtime, path, st.st_ino))


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


linked = saved = 0
for size, items in by_size.items():
    if len(items) < 2:
        continue
    groups = defaultdict(list)
    for mtime, path, ino in items:
        groups[digest(path)].append((mtime, path, ino))
    for same in groups.values():
        same.sort()
        master_path, master_ino = same[0][1], same[0][2]
        counted = {master_ino}
        for mtime, path, ino in same[1:]:
            if ino == master_ino:
                continue  # already a link to the kept copy
            if not dry:
                tmp = path + ".dedupe-tmp"
                os.link(master_path, tmp)
                os.replace(tmp, path)
            linked += 1
            if ino not in counted:
                counted.add(ino)
                saved += size
print(f"{folder}: {linked} duplicate file(s) {'would be ' if dry else ''}linked, {saved / 1048576:.0f} MB freed")
