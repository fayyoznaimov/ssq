#!/usr/bin/env python3
"""parisahome.com: makes the three Dockerfiles two-stage, so the next real build gives the same small
images as the ones made by site_slim.sh. The build steps themselves are not changed; only the result
(/build) is copied onto a clean base. Backups: Dockerfile.before-slim-2026-11-22."""
import shutil, sys

ROOT = "/var/www/app"
SERVICES = {
    "frontend": ("/build/.next/cache", 'CMD [ "npm", "run", "start", "--prefix", "./build" ]'),
    "admin": ("/build/admin/.next/cache", 'CMD [ "npm", "run", "start", "--prefix", "./build" ]'),
    "backend": (None, 'CMD [ "node", "/build/dist/main.js" ]'),
}
FINAL = """RUN rm -r /pre_build
{drop}
# Only the result goes into the image that runs. Without this second stage every step above stays
# in the image as a layer: npm install, the build and both copies ({was} instead of {now}).
FROM node:18-alpine
COPY --from=build /build /build
"""
SIZES = {"frontend": ("2.9 GB", "0.9 GB"), "admin": ("2.3 GB", "0.8 GB"), "backend": ("565 MB", "380 MB")}

for name, (cache, cmd) in SERVICES.items():
    path = f"{ROOT}/{name}/Dockerfile"
    text = open(path, encoding="utf-8").read()
    if "AS build" in text:
        print(f"{name}: already two-stage")
        continue
    assert text.count("FROM node:18-alpine") == 1 and text.count("RUN rm -r /pre_build\n") == 1 and cmd in text, name
    shutil.copy2(path, path + ".before-slim-2026-11-22")
    drop = ("# the build cache and npm's cache are not needed to run the site\n"
            f"RUN rm -rf {cache} /root/.npm\n") if cache else "RUN rm -rf /root/.npm\n"
    text = text.replace("FROM node:18-alpine", "FROM node:18-alpine AS build", 1)
    text = text.replace("RUN rm -r /pre_build\n", FINAL.format(drop=drop, was=SIZES[name][0], now=SIZES[name][1]), 1)
    open(path, "w", encoding="utf-8").write(text)
    print(f"{name}: updated")
