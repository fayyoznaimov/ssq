"""Speech-to-text for the CRM Telegram bot (voice messages of the managers).

A small local HTTP service around faster-whisper (Whisper on CTranslate2, CPU, int8):
no paid API, no GPU, no system packages. The model is loaded once and kept in memory;
requests are transcribed one at a time (the others wait in a short queue).

  GET  /health                    {"ok": true, "model": "small", ...}
  POST /transcribe?max_sec=180    body: the audio file as is (ogg/opus voice, mp3, m4a, mp4
                                  video note, wav...), decoded by PyAV (bundled ffmpeg libs)
       200 {"text", "language", "language_probability", "duration", "seconds"}
       400 {"error": "bad_audio"}   401 {"error": "unauthorized"}
       413 {"error": "too_long", "duration", "max_sec"} / {"error": "too_large"}
       503 {"error": "busy" | "loading"}

The CRM API calls it from the bot (CRM_BOT_STT_URL, see parisahon-api/src/bot/bot-speech.service.ts).

Settings (env):
  STT_HOST (127.0.0.1), STT_PORT (8097)
  STT_MODEL (small)            Whisper size (tiny/base/small/...) or a path to a CTranslate2 model
  STT_MODELS_DIR               where the model is downloaded/cached (default ./models)
  STT_COMPUTE_TYPE (int8), STT_THREADS (4: more is slower on this 4-core VM), STT_BEAM (1: greedy;
                               5 is ~3 s slower per 20 s of speech, same text on our test clips)
  STT_LANGUAGES (ru,uz)        the language is picked among these by Whisper's detector;
                               one value fixes it, empty means any language
  STT_PROMPT                   optional initial prompt (names, terms) for the decoder
  STT_MAX_SEC (300), STT_MAX_BYTES (25 MB), STT_QUEUE_SEC (90)
  STT_TOKEN                    if set, requests need "Authorization: Bearer <STT_TOKEN>"
  STT_TEST_HOOKS=1             dev copy only: POST /_test/outage {"seconds": N} makes /transcribe
                               and /health answer 503 for N seconds (local/checks/bot_check.py)

Setup: parisahon-stt/setup.sh <venv dir> <models dir> [model]; run: <venv>/bin/python server.py
"""
import hashlib
import hmac
import io
import json
import logging
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
from faster_whisper import WhisperModel, decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps

SAMPLE_RATE = 16000
HOST = os.environ.get("STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("STT_PORT", "8097"))
MODEL = os.environ.get("STT_MODEL", "small")
MODELS_DIR = os.environ.get("STT_MODELS_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
COMPUTE_TYPE = os.environ.get("STT_COMPUTE_TYPE", "int8")
THREADS = int(os.environ.get("STT_THREADS", "4"))
BEAM = int(os.environ.get("STT_BEAM", "1"))
LANGUAGES = [x.strip() for x in os.environ.get("STT_LANGUAGES", "ru,uz").split(",") if x.strip()]
PROMPT = os.environ.get("STT_PROMPT", "").strip() or None
MAX_SEC = float(os.environ.get("STT_MAX_SEC", "300"))
MAX_BYTES = int(os.environ.get("STT_MAX_BYTES", str(25 * 1024 * 1024)))
QUEUE_SEC = float(os.environ.get("STT_QUEUE_SEC", "90"))
TOKEN = os.environ.get("STT_TOKEN", "")
TEST_HOOKS = os.environ.get("STT_TEST_HOOKS") == "1"

# Phrases Whisper invents on noise/silence (subtitle credits of its Russian training data)
HALLUCINATIONS = re.compile(
    r"(субтитры (сделал|создавал|подготовил|делал)|редактор субтитров|корректор|dimatorzok|"
    r"продолжение следует|спасибо за просмотр|подписывайтесь на канал)",
    re.IGNORECASE,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
log = logging.getLogger("stt")
logging.getLogger("faster_whisper").setLevel(logging.WARNING)

state = {"model": None, "outage_until": 0.0}
gate = threading.Semaphore(1)
VAD = VadOptions(min_silence_duration_ms=500)


class Whisper(WhisperModel):
    """Remembers the last encoder output: the language detector and the first window of the
    transcription encode the same 30 s of speech, and the encoder is most of the CPU time."""

    _last = (None, None)

    def encode(self, features):
        key = hashlib.blake2b(np.ascontiguousarray(features).tobytes(), digest_size=16).digest()
        if self._last[0] != key:
            self._last = (key, super().encode(features))
        return self._last[1]


def load_model():
    started = time.time()
    try:
        try:
            model = Whisper(MODEL, device="cpu", compute_type=COMPUTE_TYPE, cpu_threads=THREADS,
                                 download_root=MODELS_DIR, local_files_only=True)
        except Exception:  # not in the cache yet: download once
            log.info("model %s is not in %s, downloading", MODEL, MODELS_DIR)
            model = Whisper(MODEL, device="cpu", compute_type=COMPUTE_TYPE, cpu_threads=THREADS,
                                 download_root=MODELS_DIR)
        # warm-up: the first run allocates buffers and is several times slower
        noise = (np.random.default_rng(0).standard_normal(SAMPLE_RATE * 2) * 0.01).astype(np.float32)
        list(model.transcribe(noise, language="ru", beam_size=1, max_new_tokens=4)[0])
    except Exception:
        log.exception("cannot load the model %s", MODEL)
        os._exit(1)  # systemd starts the service again
    state["model"] = model
    log.info("model %s (%s, %d threads) ready in %.1f s", MODEL, COMPUTE_TYPE, THREADS, time.time() - started)


def pick_language(model, speech):
    """The most probable of the allowed languages (Whisper alone would sometimes pick kk/tr/tg for Uzbek)."""
    if len(LANGUAGES) == 1:
        return LANGUAGES[0], 1.0
    # the features of the first window exactly as transcribe() cuts them (without the last frame),
    # so that the transcription reuses the encoder output (Whisper.encode)
    features = model.feature_extractor(speech)
    language, probability, all_probs = model.detect_language(features=features[..., :-1])
    if not LANGUAGES:
        return language, probability
    allowed = [(p, lang) for lang, p in all_probs if lang in LANGUAGES]
    if not allowed:
        return LANGUAGES[0], 0.0
    probability, language = max(allowed)
    return language, probability


def transcribe(data: bytes, max_sec: float):
    try:
        audio = decode_audio(io.BytesIO(data), sampling_rate=SAMPLE_RATE)
    except Exception as error:
        log.info("cannot decode %d bytes: %s", len(data), error)
        return 400, {"error": "bad_audio"}
    duration = round(len(audio) / SAMPLE_RATE, 1)
    if duration > max_sec:
        return 413, {"error": "too_long", "duration": duration, "max_sec": max_sec}
    if not gate.acquire(timeout=QUEUE_SEC):
        return 503, {"error": "busy"}
    try:
        started = time.time()
        model = state["model"]
        chunks = get_speech_timestamps(audio, VAD)
        if not chunks:
            return 200, {"text": "", "language": None, "language_probability": 0, "duration": duration, "seconds": round(time.time() - started, 1)}
        speech = np.concatenate([audio[c["start"]:c["end"]] for c in chunks])
        language, probability = pick_language(model, speech)
        # the speech without the pauses, exactly what the detector saw: its encoder output is reused
        segments, _ = model.transcribe(speech, language=language, beam_size=BEAM, vad_filter=False,
                                       condition_on_previous_text=False, initial_prompt=PROMPT)
        parts = [s.text.strip() for s in segments if s.text.strip() and not HALLUCINATIONS.search(s.text)]
        model._last = (None, None)
        text = re.sub(r"\s+", " ", " ".join(parts)).strip()
        seconds = round(time.time() - started, 1)
        # never log the words themselves: they are the managers' messages
        log.info("transcribed %.1f s of %s (%.2f) in %.1f s, %d chars", duration, language, probability, seconds, len(text))
        return 200, {"text": text, "language": language, "language_probability": round(probability, 3),
                     "duration": duration, "seconds": seconds}
    finally:
        gate.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "parisa-stt"  # HTTP/1.0: one request per connection, no unread body left behind

    def log_message(self, fmt, *args):  # the default access log goes to stderr; keep it short
        pass

    def reply(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):  # the caller gave up (timeout, API restart)
            self.close_connection = True
            log.info("the client left before the answer")

    def authorized(self):
        if not TOKEN:
            return True
        given = self.headers.get("Authorization", "")
        return hmac.compare_digest(given.encode(), f"Bearer {TOKEN}".encode())

    def read_body(self, limit):
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            return None
        return self.rfile.read(length) if length else b""

    def outage(self):
        return time.time() < state["outage_until"]

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            if self.outage():
                return self.reply(503, {"ok": False, "error": "test outage"})
            ready = state["model"] is not None
            return self.reply(200 if ready else 503, {"ok": ready, "model": MODEL, "compute_type": COMPUTE_TYPE,
                                                      "threads": THREADS, "languages": LANGUAGES, "max_sec": MAX_SEC})
        return self.reply(404, {"error": "not_found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/_test/outage" and TEST_HOOKS:
            body = json.loads(self.read_body(10_000) or b"{}")
            state["outage_until"] = time.time() + float(body.get("seconds", 0))
            return self.reply(200, {"ok": True, "outage_sec": float(body.get("seconds", 0))})
        if url.path != "/transcribe":
            return self.reply(404, {"error": "not_found"})
        if not self.authorized():
            return self.reply(401, {"error": "unauthorized"})
        data = self.read_body(MAX_BYTES)
        if data is None:
            self.close_connection = True
            return self.reply(413, {"error": "too_large"})
        if self.outage():
            return self.reply(503, {"error": "test outage"})
        if state["model"] is None:
            return self.reply(503, {"error": "loading"})
        try:
            max_sec = min(MAX_SEC, float(parse_qs(url.query).get("max_sec", [MAX_SEC])[0]))
        except ValueError:
            max_sec = MAX_SEC
        try:
            status, payload = transcribe(data, max_sec)
        except Exception:
            log.exception("transcription failed")
            status, payload = 500, {"error": "failed"}
        return self.reply(status, payload)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    log.info("listening on %s:%d%s", HOST, PORT, " (test hooks on)" if TEST_HOOKS else "")
    threading.Thread(target=load_model, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
