#!/usr/bin/env python3
"""Adds compression and browser caching for the CRM site to the production nginx.conf.
argv[1] current config, argv[2] output."""
import sys

src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
MARK = "# crm-perf-2026-11-22"
if MARK in text:
    print("already patched")
    sys.exit(2)

HEADERS = """            add_header Strict-Transport-Security "max-age=31536000" always;
            add_header X-Frame-Options "SAMEORIGIN" always;
            add_header X-Content-Type-Options "nosniff" always;
            add_header Referrer-Policy "strict-origin-when-cross-origin" always;
"""

GZIP = f"""
        {MARK}: text answers (scripts, styles, API JSON) go compressed
        gzip on;
        gzip_comp_level 5;
        gzip_min_length 1024;
        gzip_proxied any;
        gzip_vary on;
        gzip_types text/plain text/css text/javascript application/javascript application/json application/xml image/svg+xml;
"""

STATIC = f"""
        {MARK}: build files carry a hash in the name, so the browser may keep them for a year
        location ^~ /_nuxt/ {{
            root /usr/share/nginx/html/client;
            add_header Cache-Control "public, max-age=31536000, immutable" always;
{HEADERS}        }}
        location ^~ /preview/_nuxt/ {{
            root /usr/share/nginx/html/client;
            add_header Cache-Control "public, max-age=31536000, immutable" always;
{HEADERS}        }}

"""

a1 = '        add_header Referrer-Policy "strict-origin-when-cross-origin" always;\n\n        # entry points of our own services'
assert text.count(a1) == 1, "anchor 1"
text = text.replace(a1, a1.split("\n\n")[0] + "\n" + GZIP + "\n        # entry points of our own services", 1)

a2 = "        location / {\n            root /usr/share/nginx/html/client;\n"
assert text.count(a2) == 1, "anchor 2"
# pages themselves are always re-checked, so a new build is picked up at once
text = text.replace(a2, STATIC + a2 + '            add_header Cache-Control "no-cache" always;\n' + HEADERS, 1)
open(dst, "w", encoding="utf-8").write(text)
print("patched ->", dst)
