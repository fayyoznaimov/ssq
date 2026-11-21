#!/usr/bin/env bash
# Installs the speech-to-text service of the CRM bot without root: a Python venv with
# requirements.txt and the Whisper model (downloaded once from Hugging Face, ~480 MB for "small").
#   parisahon-stt/setup.sh <venv dir> <models dir> [model, default small]
# Dev copy: parisahon-stt/setup.sh local/dev/stt/venv local/dev/stt/models   (unit crm-dev-stt, local/dev/units.sh)
# Then run: STT_MODELS_DIR=<models dir> <venv dir>/bin/python parisahon-stt/server.py  (settings: see server.py)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${1:?usage: setup.sh <venv dir> <models dir> [model]}"
MODELS="${2:?usage: setup.sh <venv dir> <models dir> [model]}"
MODEL="${3:-small}"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$HERE/requirements.txt"
mkdir -p "$MODELS"
"$VENV/bin/python" -I -c "import sys; from faster_whisper.utils import download_model; print(download_model(sys.argv[1], cache_dir=sys.argv[2]))" "$MODEL" "$MODELS"
du -sh "$VENV" "$MODELS"
