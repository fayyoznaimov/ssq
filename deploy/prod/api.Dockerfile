# API container: the official node image plus ffmpeg from Debian (call recordings and voice messages)
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
