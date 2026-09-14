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

Talks JSON over stdout: one object, `{"ok": true}` or `{"ok": false, "error": "..."}`.
Text arrives in a UTF-8 file rather than argv — Devanagari and Tamil through a Windows
command line is a mojibake generator.
"""
import argparse
import json
import os
import sys

# Model chatter goes to stderr; stdout stays a clean JSON channel for the caller.
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


def fail(message):
    json.dump({"ok": False, "error": message}, sys.stdout)
    sys.stdout.flush()
    sys.exit(1)


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


def run_chatterbox(args, out_path):
    import torch
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = ChatterboxMultilingualTTS.from_pretrained(device=device)
    wav = model.generate(
        read_text(args.text_file),
        language_id=args.language,
        audio_prompt_path=args.ref_audio,
    )

    import torchaudio

    torchaudio.save(out_path, wav, model.sr)
    return model.sr


def run_indicf5(args, out_path):
    import numpy as np
    import soundfile as sf
    from transformers import AutoModel

    if not args.ref_text:
        fail("IndicF5 needs the reference recording's transcript, which was not provided")

    model = AutoModel.from_pretrained("ai4bharat/IndicF5", trust_remote_code=True)
    audio = model(
        read_text(args.text_file),
        ref_audio_path=args.ref_audio,
        ref_text=args.ref_text,
    )
    audio = np.asarray(audio, dtype=np.float32)
    # IndicF5 returns int16-scaled floats; normalize before writing or the file clips.
    if np.max(np.abs(audio)) > 1.0:
        audio = audio / 32768.0
    sf.write(out_path, audio, 24000)
    return 24000


def read_text(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read().strip()


def main():
    parser = argparse.ArgumentParser()
    # Nothing is argparse-required: --probe is a standalone mode, and making these
    # required would make it impossible to call. Checked by hand below instead.
    parser.add_argument("--text-file", help="UTF-8 file holding the text to speak")
    parser.add_argument("--ref-audio", help="the recording to clone the voice from")
    parser.add_argument("--ref-text", default="", help="transcript of --ref-audio (IndicF5 needs it)")
    parser.add_argument("--language")
    parser.add_argument("--out")
    parser.add_argument("--engine", default="auto", choices=["auto", "chatterbox", "indicf5"])
    parser.add_argument("--probe", action="store_true", help="report installed engines and exit")
    args = parser.parse_args()

    if args.probe:
        json.dump(
            {
                "ok": True,
                "engines": {"chatterbox": have("chatterbox"), "indicf5": have("f5_tts")},
            },
            sys.stdout,
        )
        return

    missing = [n for n in ("text-file", "ref-audio", "language", "out") if not getattr(args, n.replace("-", "_"))]
    if missing:
        fail("Missing required arguments: " + ", ".join("--" + m for m in missing))

    if not os.path.exists(args.ref_audio):
        fail(f"Reference recording not found: {args.ref_audio}")

    engine = pick_engine(args.engine, args.language)
    if engine == "none":
        fail(
            "No voice-cloning engine is installed. Install one into the server venv: "
            "`pip install chatterbox-tts` (23 languages incl. Hindi), and/or "
            "`pip install f5-tts` for the other Indian languages."
        )

    try:
        sample_rate = run_chatterbox(args, args.out) if engine == "chatterbox" else run_indicf5(args, args.out)
    except Exception as err:  # surfaced to the user as a soft failure, not a crash
        fail(f"{engine} failed: {err}")

    json.dump({"ok": True, "engine": engine, "sampleRate": sample_rate}, sys.stdout)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
