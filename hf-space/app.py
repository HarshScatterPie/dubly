"""
Dubly's voice-cloning worker, running on a free Hugging Face ZeroGPU Space.

Why this exists: the cloning models are MIT-licensed and already wired into Dubly, but a
15W laptop CPU renders them at roughly realtime, which makes a five-language dub take
longer than anyone will wait. A ZeroGPU Space gives the same models a Blackwell GPU for
free, so the prototype runs at production speed without a vendor contract, an allow-list,
or a per-character bill — and it is the exact code path that will run on a self-hosted GPU
later, so none of this is throwaway.

Two entry points on purpose:
  * the visible UI, for a human to sanity-check a voice by ear;
  * the `clone` API endpoint, which takes and returns base64 so Dubly's Node server can
    call it over plain JSON — no Gradio client, no multipart upload dance.

Both are wired with `api_name` on a click handler rather than a nested `gr.Interface`,
because that is the one shape that behaves the same across Gradio 4, 5 and 6.

ZeroGPU specifics this file is built around (per the Spaces docs):
  * the model is placed on `cuda` at module level, not lazily inside the decorated
    function — ZeroGPU runs a CUDA emulation at startup precisely so this works, and
    doing the transfer at call time is documented as significantly slower;
  * `@spaces.GPU` takes a *dynamic* duration, so a short line reserves a short slot.
    Declared duration is what gets billed against the daily quota and what sets queue
    priority, so guessing high wastes both.
"""
# The Chatterbox package is vendored under src/ rather than installed from PyPI:
# chatterbox-tts pins torch==2.6.0, which ZeroGPU (2.8+) will not run. This mirrors how
# ResembleAI ship their own Space.
import base64
import os
import tempfile

import gradio as gr
import numpy as np
import soundfile as sf
import spaces
import torch
from src.chatterbox.mtl_tts import ChatterboxMultilingualTTS

# Chatterbox multilingual v3's roster. Anything outside it is rejected up front rather
# than silently synthesized in the wrong accent.
SUPPORTED = sorted(
    {
        "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja",
        "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh",
    }
)

# Loaded once, on cuda, at import. See the note at the top of the file.
model = ChatterboxMultilingualTTS.from_pretrained(device="cuda")


def _normalize_language(language: str) -> str:
    """Dubly writes Hinglish in Latin script, but it is spoken as Hindi."""
    return "hi" if language == "hinglish" else (language or "en").strip()


def _estimate_duration(text: str, *_args) -> float:
    """
    GPU seconds to reserve for one line.

    Deliberately tight: the declared duration is charged against a 5-minute daily quota
    and also decides queue priority, so a blanket 120s would burn the day's allowance in
    two calls. Roughly a second of GPU per dozen characters, plus a floor for warm-up.
    """
    return float(min(90, max(12, len(text or "") / 12 + 8)))


@spaces.GPU(duration=_estimate_duration)
def _synthesize(text: str, reference_path: str, language: str):
    wav = model.generate(text, language_id=language, audio_prompt_path=reference_path)
    return model.sr, wav.squeeze(0).detach().cpu().numpy()


def _write_temp_wav(raw: bytes) -> str:
    handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    handle.write(raw)
    handle.close()
    return handle.name


def clone_api(text: str, reference_audio_b64: str, language: str) -> str:
    """
    Dubly's entry point: base64 wav in, base64 wav out.

    Failures come back as a string starting with "ERROR: " rather than as an exception,
    because a Gradio exception reaches the caller as an opaque 500 and the dub pipeline
    needs a reason it can actually show the user.
    """
    try:
        if not text or not text.strip():
            return "ERROR: no text to speak"
        if not reference_audio_b64:
            return "ERROR: no reference audio"

        language = _normalize_language(language)
        if language not in SUPPORTED:
            return f"ERROR: this model cannot speak '{language}'"

        reference_path = _write_temp_wav(base64.b64decode(reference_audio_b64))
        try:
            sample_rate, audio = _synthesize(text.strip(), reference_path, language)
        finally:
            os.unlink(reference_path)

        out_path = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        out_path.close()
        sf.write(out_path.name, np.asarray(audio, dtype=np.float32), sample_rate)
        with open(out_path.name, "rb") as fh:
            encoded = base64.b64encode(fh.read()).decode("ascii")
        os.unlink(out_path.name)
        return encoded
    except Exception as err:  # noqa: BLE001 - reported to the caller, not swallowed
        return f"ERROR: {type(err).__name__}: {err}"


def clone_ui(text: str, reference_audio, language: str):
    """The human-facing path: a file from the browser rather than base64."""
    if reference_audio is None:
        raise gr.Error("Upload or record a reference clip first")
    if not text or not text.strip():
        raise gr.Error("Type something for it to say")
    language = _normalize_language(language)
    if language not in SUPPORTED:
        raise gr.Error(f"This model cannot speak '{language}'")
    return _synthesize(text.strip(), reference_audio, language)


with gr.Blocks(title="Dubly voice cloning") as demo:
    gr.Markdown(
        "## Dubly — voice cloning worker\n"
        "Give it 5–30 seconds of clean speech and any text, and it speaks that text in that "
        "voice. Dubly's server calls the `clone` API endpoint; this page exists so a human "
        "can check a voice by ear first."
    )
    with gr.Row():
        with gr.Column():
            ui_reference = gr.Audio(label="Reference voice (5–30s, clean)", type="filepath")
            ui_text = gr.Textbox(label="Text to speak", lines=3)
            ui_language = gr.Dropdown(label="Language", choices=SUPPORTED, value="en")
            ui_button = gr.Button("Speak", variant="primary")
        ui_output = gr.Audio(label="Result")

    ui_button.click(clone_ui, [ui_text, ui_reference, ui_language], ui_output, api_name="speak")

    # Not rendered on the page, but published in the API schema as `clone` — this is the
    # endpoint Dubly's server talks to.
    api_text = gr.Textbox(visible=False)
    api_reference = gr.Textbox(visible=False)
    api_language = gr.Textbox(visible=False)
    api_output = gr.Textbox(visible=False)
    api_trigger = gr.Button(visible=False)
    api_trigger.click(
        clone_api,
        [api_text, api_reference, api_language],
        api_output,
        api_name="clone",
    )

demo.queue(max_size=8).launch()
