"""
Zero-shot voice cloning worker: speaks arbitrary text in a voice taken from one short
reference recording.

Two engines, picked by target language, mirroring how the TTS providers are routed on the
Node side (Sarvam for Indic, Google otherwise):

  * IndicF5 (AI4Bharat, MIT) for the 11 Indian languages it was trained on. Chatterbox's
    multilingual model covers Hindi but none of Tamil/Telugu/Bengali/Kannada/Malayalam/
    Marathi/Gujarati/Punjabi/Odia/Assamese, which is exactly the coverage this product
    needs, so IndicF5 wins for those.
  * Chatterbox (Resemble AI, MIT) for the other 20-odd languages. Its Nano variant runs
    faster than realtime on CPU, which matters because this box has no GPU.

Both are optional installs. Missing engines are reported as a clean JSON error rather than
a traceback, so the caller can fall back to a catalog voice instead of failing a render.

Persistent worker: reads one JSON request per line from stdin, writes one JSON response per
line to stdout, for as long as the caller keeps the pipe open — rather than the one-shot
CLI-args-in, one-clip-out process this used to be. A dub renders one clip per line back to
back, and each engine's `from_pretrained()` is a multi-second-to-tens-of-seconds load, so the
old shape paid that cost again for every single line of a cloned-voice dub. A warm worker
loads each engine at most once per process lifetime and reuses it for every request after.

Text arrives in a UTF-8 file path rather than inline in the request — Devanagari and Tamil
round-tripping through stdin JSON works fine, but keeping the on-disk-file convention this
already used avoids re-plumbing the Node side's temp-file handling for no benefit.
"""
import io
import json
import os
import sys

# Model chatter goes to stderr; stdout stays a clean JSON-lines channel for the caller.
# Windows defaults stdout to cp1252, which cannot encode Devanagari or Tamil — the
# process dies mid-write with a UnicodeEncodeError after having already emitted half
# a JSON document. Callers can set PYTHONIOENCODING, but the worker should not depend
# on them remembering to.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

INDIC_LANGUAGES = {"as", "bn", "gu", "hi", "kn", "ml", "mr", "or", "pa", "ta", "te"}
# Chatterbox multilingual v3's roster.
CHATTERBOX_LANGUAGES = {
    "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja",
    "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh",
}


def respond(payload):
    """One JSON object per line on stdout — the framing the persistent worker loop reads by."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def have(module_name):
    from importlib.util import find_spec

    try:
        return find_spec(module_name) is not None
    except (ImportError, ValueError):
        return False


def pick_engine(requested, language):
    """Resolves 'auto' to whichever installed engine covers this language best."""
    if requested != "auto":
        return requested
    if language in INDIC_LANGUAGES and have("f5_tts"):
        return "indicf5"
    if language in CHATTERBOX_LANGUAGES and have("chatterbox"):
        return "chatterbox"
    # Nothing covers it well; try anything installed rather than refusing outright — a
    # cloned voice in a slightly-off accent beats no cloned voice at all.
    if have("chatterbox"):
        return "chatterbox"
    if have("f5_tts"):
        return "indicf5"
    return "none"


# Each engine loads into at most one instance for this process's whole lifetime — unlike the
# forced-alignment worker there's no per-language model zoo here, just these two, so a plain
# cache slot per engine (no eviction) is all that's needed.
_chatterbox_model = None
_indicf5_model = None


def get_chatterbox_model():
    global _chatterbox_model
    if _chatterbox_model is None:
        import torch
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        device = "cuda" if torch.cuda.is_available() else "cpu"
        _chatterbox_model = ChatterboxMultilingualTTS.from_pretrained(device=device)
    return _chatterbox_model


def get_indicf5_model():
    global _indicf5_model
    if _indicf5_model is None:
        from transformers import AutoModel

        _indicf5_model = AutoModel.from_pretrained("ai4bharat/IndicF5", trust_remote_code=True)
    return _indicf5_model


def run_chatterbox(text, ref_audio, language, out_path):
    model = get_chatterbox_model()
    wav = model.generate(text, language_id=language, audio_prompt_path=ref_audio)

    import torchaudio

    torchaudio.save(out_path, wav, model.sr)
    return model.sr


def run_indicf5(text, ref_audio, ref_text, out_path):
    import numpy as np
    import soundfile as sf

    model = get_indicf5_model()
    audio = model(text, ref_audio_path=ref_audio, ref_text=ref_text)
    audio = np.asarray(audio, dtype=np.float32)
    # IndicF5 returns int16-scaled floats; normalize before writing or the file clips.
    if np.max(np.abs(audio)) > 1.0:
        audio = audio / 32768.0
    sf.write(out_path, audio, 24000)
    return 24000


def read_text(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read().strip()


def handle_synthesize(request):
    text_file = request.get("textFile")
    ref_audio = request.get("refAudio")
    ref_text = request.get("refText", "")
    language = request.get("language")
    out_path = request.get("out")
    requested_engine = request.get("engine", "auto")

    missing = [k for k in ("textFile", "refAudio", "language", "out") if not request.get(k)]
    if missing:
        return {"ok": False, "error": "Missing required fields: " + ", ".join(missing)}
    if not os.path.exists(ref_audio):
        return {"ok": False, "error": f"Reference recording not found: {ref_audio}"}

    engine = pick_engine(requested_engine, language)
    if engine == "none":
        return {
            "ok": False,
            "error": (
                "No voice-cloning engine is installed. Install one into the server venv: "
                "`pip install chatterbox-tts` (23 languages incl. Hindi), and/or "
                "`pip install f5-tts` for the other Indian languages."
            ),
        }
    if engine == "indicf5" and not ref_text:
        return {"ok": False, "error": "IndicF5 needs the reference recording's transcript, which was not provided"}

    try:
        text = read_text(text_file)
        if engine == "chatterbox":
            sample_rate = run_chatterbox(text, ref_audio, language, out_path)
        else:
            sample_rate = run_indicf5(text, ref_audio, ref_text, out_path)
    except Exception as err:  # surfaced to the caller as a soft failure, not a crash
        return {"ok": False, "error": f"{engine} failed: {err}"}

    return {"ok": True, "engine": engine, "sampleRate": sample_rate}


def main():
    """Persistent worker loop — see module docstring for why this isn't one-shot-per-clip."""
    # TextIOWrapper over the raw buffer (rather than sys.stdin directly) so decoding is
    # explicit utf-8 regardless of the console's codepage — Windows defaults stdin to
    # cp1252, which mangles Devanagari and Tamil before json.loads ever sees it.
    stream = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace", newline="\n")
    first_line = True
    for raw_line in stream:
        # Tolerate a UTF-8 BOM on the very first line: some shells prepend one when piping.
        line = raw_line.lstrip("﻿").strip() if first_line else raw_line.strip()
        first_line = False
        if not line:
            continue

        try:
            request = json.loads(line)
        except Exception as err:
            respond({"ok": False, "error": f"Invalid request JSON: {err}"})
            continue

        if request.get("cmd") == "shutdown":
            break

        if request.get("probe"):
            respond({"ok": True, "engines": {"chatterbox": have("chatterbox"), "indicf5": have("f5_tts")}})
            continue

        try:
            respond(handle_synthesize(request))
        except Exception as err:  # one bad request must not take the whole warm worker down
            print(f"[voice_clone] request failed: {err}", file=sys.stderr)
            respond({"ok": False, "error": str(err)})


if __name__ == "__main__":
    main()
