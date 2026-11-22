#!/usr/bin/env python3
"""Adds a size limit for container logs to every service of /root/crm2/compose.yml (applies when a
container is recreated). argv[1] compose file (edited in place, backup next to it)."""
import re, shutil, sys, time

path = sys.argv[1]
text = open(path, encoding="utf-8").read()
if "x-crm-logging" in text:
    print("already patched")
    sys.exit(0)
shutil.copy2(path, f"{path}.bak-{time.strftime('%Y%m%d-%H%M')}")
anchor = (
    "# logs of every CRM container: 3 files of 20 MB at most\n"
    "x-crm-logging: &crm-logging\n"
    "  driver: json-file\n"
    "  options:\n"
    '    max-size: "20m"\n'
    '    max-file: "3"\n\n'
)
assert text.count("\nservices:\n") == 1
text = text.replace("\nservices:\n", "\n" + anchor + "services:\n", 1)
text, n = re.subn(r"(\n    restart: unless-stopped\n)", r"\1    logging: *crm-logging\n", text)
open(path, "w", encoding="utf-8").write(text)
print(f"patched: {n} service(s)")
