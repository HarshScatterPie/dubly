"""
Real forced alignment: places the words we already know were said at the exact moment they
were said, by aligning the transcript against the audio with a wav2vec2 CTC model.

This is the same technique WhisperX uses (github.com/m-bain/whisperX, 23.7k stars, BSD-2)
and it is a different class of thing from estimating timings. The STT providers guess
timestamps and drift; the VAD upstream of this finds *where speech is* but not *which word
is which*. A CTC forced alignment is given the text and the audio and solves for the only
frame-by-frame path through the audio that produces that exact text — so a word's start is
measured, not inferred.

Deliberately kept to torch + transformers rather than pulling in torchaudio: the trellis
below is only ~40 lines, and transformers is already needed by the IndicF5 cloning engine,
so the two optional features share one dependency instead of each adding their own.

Alignment happens per segment, inside a window the caller derives from voice-activity
detection, rather than over the whole file at once. A trellis is frames x characters, so a
ten-minute file against its whole transcript would be a hundreds-of-megabytes table; per
segment it is a few hundred kilobytes, and the VAD has already put the window in the right
place.

Talks JSON over stdin/stdout so unicode never touches a Windows command line.
"""
import io
import json
import os
import sys

# Windows defaults stdout to cp1252, which cannot encode Devanagari or Tamil — the
# process dies mid-write with a UnicodeEncodeError after having already emitted half
# a JSON document. Callers can set PYTHONIOENCODING, but the worker should not depend
# on them remembering to.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

SAMPLE_RATE = 16000

# Per-language CTC models. The base map is WhisperX's own (BSD-2), which covers Hindi,
# Telugu, Malayalam and Urdu among the Indian languages; the rest of the Indic entries are
# AI4Bharat's IndicWav2Vec, which WhisperX has no mapping for at all and which is trained
# on Indian speech rather than a multilingual model fine-tuned onto it.
#
# Languages absent here (Kannada, Punjabi) simply fall back to the caller's VAD-based
# timing — a missing model degrades precision, it does not break the dub.
# Per-language CTC models, in preference order. The base map is WhisperX's own (BSD-2),
# extended for the Indian languages it has no mapping for at all.
#
# Two candidates per Indic language on purpose. AI4Bharat's IndicWav2Vec is the better
# model — trained on Indian speech rather than a multilingual model fine-tuned onto it —
# but every one of its repos is gated, so it 403s until the account has accepted the terms
# and a token is present. The second entry is an ungated community model that works with no
# setup at all. Trying them in order means alignment works out of the box and silently
# upgrades once someone accepts the AI4Bharat terms.
#
# A language with no entry falls back to the caller's VAD timing — a missing model degrades
# precision, it does not break the dub.
ALIGN_MODELS = {
    "en": ["facebook/wav2vec2-base-960h"],
    "fr": ["jonatasgrosman/wav2vec2-large-xlsr-53-french"],
    "de": ["jonatasgrosman/wav2vec2-large-xlsr-53-german"],
    "es": ["jonatasgrosman/wav2vec2-large-xlsr-53-spanish"],
    "it": ["jonatasgrosman/wav2vec2-large-xlsr-53-italian"],
    "pt": ["jonatasgrosman/wav2vec2-large-xlsr-53-portuguese"],
    "nl": ["jonatasgrosman/wav2vec2-large-xlsr-53-dutch"],
    "ru": ["jonatasgrosman/wav2vec2-large-xlsr-53-russian"],
    "pl": ["jonatasgrosman/wav2vec2-large-xlsr-53-polish"],
    "ar": ["jonatasgrosman/wav2vec2-large-xlsr-53-arabic"],
    "ja": ["jonatasgrosman/wav2vec2-large-xlsr-53-japanese"],
    "zh": ["jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn"],
    "ko": ["kresnik/wav2vec2-large-xlsr-korean"],
    "tr": ["mpoyraz/wav2vec2-xls-r-300m-cv7-turkish"],
    "el": ["jonatasgrosman/wav2vec2-large-xlsr-53-greek"],
    "fa": ["jonatasgrosman/wav2vec2-large-xlsr-53-persian"],
    "fi": ["jonatasgrosman/wav2vec2-large-xlsr-53-finnish"],
    "he": ["imvladikon/wav2vec2-xls-r-300m-hebrew"],
    "id": ["cahya/wav2vec2-large-xlsr-indonesian"],
    "sv": ["KBLab/wav2vec2-large-voxrex-swedish"],
    "ur": ["kingabzpro/wav2vec2-large-xls-r-300m-Urdu"],
    # Indian languages: AI4Bharat (gated) first, ungated community model second.
    "hi": ["ai4bharat/indicwav2vec-hindi", "theainerd/Wav2Vec2-large-xlsr-hindi"],
    "ta": ["ai4bharat/indicwav2vec_v1_tamil", "Harveenchadha/vakyansh-wav2vec2-tamil-tam-250"],
    "te": ["ai4bharat/indicwav2vec_v1_telugu", "anuragshas/wav2vec2-large-xlsr-53-telugu"],
    "bn": ["ai4bharat/indicwav2vec_v1_bengali", "arijitx/wav2vec2-xls-r-300m-bengali"],
    "gu": ["ai4bharat/indicwav2vec_v1_gujarati", "gchhablani/wav2vec2-large-xlsr-gu"],
    "mr": ["ai4bharat/indicwav2vec_v1_marathi", "sumedh/wav2vec2-large-xlsr-marathi"],
    "or": ["ai4bharat/indicwav2vec_v1_odia", "Harveenchadha/odia_large_wav2vec2"],
    "ml": ["gvs/wav2vec2-large-xlsr-malayalam"],
    "kn": ["amoghsgopadi/wav2vec2-large-xlsr-kn"],
    "pa": ["kingabzpro/wav2vec2-large-xlsr-53-punjabi"],
}

# Written without spaces, so "words" cannot be recovered by splitting on them.
LANGUAGES_WITHOUT_SPACES = {"ja", "zh"}

# How far outside the caller's window the aligner may look. Speech onsets ramp up, and the
# VAD's boundary is a threshold crossing, so a little air on each side stops the first and
# last word of a segment being clipped.
WINDOW_PAD_SECONDS = 0.35


def respond(payload):
    """One JSON object per line on stdout — the framing the persistent worker loop reads by."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def models_for(language):
    """Candidate repos for a language, best first."""
    return ALIGN_MODELS.get("hi" if language == "hinglish" else language, [])


# Loaded (model, processor) pairs, keyed by repo id, kept for the life of this process.
# Bounded to 2: most sessions only ever touch one language, but a re-dub or a second
# project in a different language shouldn't evict the first one just to load itself.
_MODEL_CACHE: dict = {}
_MODEL_CACHE_ORDER: list = []
_MAX_CACHED_MODELS = 2


def _touch_cache(key):
    if key in _MODEL_CACHE_ORDER:
        _MODEL_CACHE_ORDER.remove(key)
    _MODEL_CACHE_ORDER.append(key)


def _cache_model(key, model, processor):
    _MODEL_CACHE[key] = (model, processor)
    _touch_cache(key)
    while len(_MODEL_CACHE_ORDER) > _MAX_CACHED_MODELS:
        evicted = _MODEL_CACHE_ORDER.pop(0)
        _MODEL_CACHE.pop(evicted, None)
        print(f"[forced_align] evicted {evicted} from warm cache", file=sys.stderr)


def get_model(language, token, Wav2Vec2ForCTC, Wav2Vec2Processor):
    """
    Returns (model, processor, repo, error) for `language`, reusing an already-loaded model
    from this process's cache when one exists. `from_pretrained()` deserializing a
    wav2vec2-large checkpoint is the single most expensive thing this worker does per
    language — seconds, same order as the alignment inference itself — so paying it once
    per warm-worker lifetime instead of once per request is the entire point of not
    spawning a fresh process for every transcribe.
    """
    candidates = models_for(language)
    if not candidates:
        return None, None, None, f"No forced-alignment model is mapped for language '{language}'"

    for candidate in candidates:
        if candidate in _MODEL_CACHE:
            _touch_cache(candidate)
            model, processor = _MODEL_CACHE[candidate]
            return model, processor, candidate, None

    problems = []
    for candidate in candidates:
        try:
            processor = Wav2Vec2Processor.from_pretrained(candidate, token=token)
            model = Wav2Vec2ForCTC.from_pretrained(candidate, token=token).eval()
            _cache_model(candidate, model, processor)
            return model, processor, candidate, None
        except Exception as err:
            problems.append(f"{candidate}: {str(err).splitlines()[0][:120]}")
    return None, None, None, "No alignment model could be loaded -> " + " | ".join(problems)


def build_trellis(emission, tokens, blank_id=0):
    """
    trellis[t][j] = best log-score of having emitted exactly the first j characters after
    t audio frames.

    Indexed with a leading row and column for "nothing consumed yet", which is what makes
    leading silence free: the path can sit at j=0 collecting blanks for as long as the
    speaker has not started.

    At each frame the path either stays on the character it is on, or advances to the next.
    Staying may emit a blank *or* repeat the same character — CTC allows both, and a model
    holding a long vowel emits the character across several frames rather than one frame
    followed by blanks. Scoring only the blank there (as the shortest textbook version of
    this does) makes every sustained sound look like a bad match.
    """
    import torch

    num_frames = emission.size(0)
    num_tokens = len(tokens)
    token_ids = torch.tensor(tokens, dtype=torch.long)

    trellis = torch.full((num_frames + 1, num_tokens + 1), -float("inf"))
    trellis[0, 0] = 0.0

    for t in range(num_frames):
        blank = emission[t, blank_id]
        on_token = emission[t, token_ids]
        # Nothing consumed yet: only blanks can have been emitted.
        trellis[t + 1, 0] = trellis[t, 0] + blank
        stay = trellis[t, 1:] + torch.maximum(blank.expand(num_tokens), on_token)
        advance = trellis[t, :-1] + on_token
        trellis[t + 1, 1:] = torch.maximum(stay, advance)

    return trellis


def backtrack(trellis, emission, tokens, blank_id=0):
    """
    Walks the best path back over the whole window, returning one entry per frame:
    (character index, frame, probability, whether the character was actually emitted).

    Every frame up to the end of the window has to belong to *some* character, so a pause
    between two words is charged to whichever character precedes it. That last flag is what
    lets the caller tell those filler frames apart from the frames carrying real acoustic
    evidence, and trim the word back to the latter.
    """
    num_tokens = len(tokens)
    t = trellis.size(0) - 1
    j = num_tokens

    path = []
    while j > 0 and t > 0:
        frame = t - 1
        on_token = emission[frame, tokens[j - 1]]
        blank = emission[frame, blank_id]

        # Staying may hold the character or emit a blank, whichever the model prefers here.
        holds_token = bool(on_token > blank)
        stay_emission = on_token if holds_token else blank
        stayed = trellis[frame, j] + stay_emission
        advanced = trellis[frame, j - 1] + on_token

        if advanced >= stayed:
            # This frame is where character j-1 began.
            path.append((j - 1, frame, on_token.exp().item(), True))
            j -= 1
        else:
            path.append((j - 1, frame, stay_emission.exp().item(), holds_token))
        t -= 1

    return path[::-1]


def merge_repeats(path, transcript):
    """
    Collapses the frames spent on one character into a single span.

    The span is trimmed to the frames where the character was actually emitted: without
    that, a word ending before a pause would run on to wherever the next word starts,
    because the silence in between is charged to its final character.
    """
    i1, i2 = 0, 0
    segments = []
    while i1 < len(path):
        while i2 < len(path) and path[i1][0] == path[i2][0]:
            i2 += 1
        run = path[i1:i2]
        evidence = [p for p in run if p[3]] or run
        segments.append(
            {
                "label": transcript[run[0][0]],
                "start": evidence[0][1],
                "end": evidence[-1][1] + 1,
                "score": sum(p[2] for p in evidence) / len(evidence),
            }
        )
        i1 = i2
    return segments


def merge_words(char_segments, separator="|"):
    """Joins character spans back into words at the separator the model uses for a space."""
    words = []
    i1, i2 = 0, 0
    while i1 < len(char_segments):
        if i2 >= len(char_segments) or char_segments[i2]["label"] == separator:
            if i1 != i2:
                chunk = char_segments[i1:i2]
                words.append(
                    {
                        "word": "".join(c["label"] for c in chunk),
                        "start": chunk[0]["start"],
                        "end": chunk[-1]["end"],
                        "score": sum(c["score"] for c in chunk) / len(chunk),
                    }
                )
            i1 = i2 + 1
            i2 = i1
        else:
            i2 += 1
    return words


def align_segment(model, processor, waveform, text, language, torch):
    """Returns word spans in seconds relative to the start of `waveform`, or None if unalignable."""
    vocab = {k.lower(): v for k, v in processor.tokenizer.get_vocab().items()}
    blank_id = vocab.get("<pad>", vocab.get("[pad]", 0))

    no_spaces = language in LANGUAGES_WITHOUT_SPACES
    cleaned = text.lower().strip()
    normalized = cleaned if no_spaces else cleaned.replace(" ", "|")
    # Characters the model has no symbol for (punctuation, digits, stray Latin in an Indic
    # line) are dropped rather than guessed at — they carry no acoustic evidence to align.
    chars = [c for c in normalized if c in vocab]
    if len(chars) < 2:
        return None

    tokens = [vocab[c] for c in chars]

    with torch.inference_mode():
        inputs = processor(waveform, sampling_rate=SAMPLE_RATE, return_tensors="pt")
        logits = model(inputs.input_values).logits[0]
        emission = torch.log_softmax(logits, dim=-1).cpu()

    if emission.size(0) <= len(tokens):
        # Fewer frames than characters: no valid CTC path exists (the window is too short
        # for this much text), so there is nothing honest to return.
        return None

    trellis = build_trellis(emission, tokens, blank_id)
    path = backtrack(trellis, emission, tokens, blank_id)
    words = merge_words(merge_repeats(path, chars))
    if not words:
        return None

    seconds_per_frame = (len(waveform) / SAMPLE_RATE) / emission.size(0)
    return [
        {
            "text": w["word"].replace("|", " "),
            "start": w["start"] * seconds_per_frame,
            "end": w["end"] * seconds_per_frame,
            "score": w["score"],
        }
        for w in words
    ]


def handle_align(request):
    """Runs one alignment request against the (possibly cached) model and returns a response dict."""
    audio_path = request["audioPath"]
    language = request.get("language", "en")
    segments = request.get("segments", [])

    try:
        import numpy as np
        import soundfile as sf
        import torch
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
    except ImportError as err:
        return {"ok": False, "error": f"Forced alignment needs `pip install transformers`: {err}"}

    # A gated repo 403s until its terms are accepted, so walk the candidates and use the
    # first that actually loads rather than failing the whole pass on the preferred one.
    token = os.environ.get("HF_TOKEN") or None
    model, processor, repo, err = get_model(language, token, Wav2Vec2ForCTC, Wav2Vec2Processor)
    if model is None:
        return {"ok": False, "error": err}

    try:
        audio, rate = sf.read(audio_path, dtype="float32")
    except Exception as err:
        return {"ok": False, "error": f"Could not read {audio_path}: {err}"}
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if rate != SAMPLE_RATE:
        return {"ok": False, "error": f"Expected {SAMPLE_RATE}Hz audio, got {rate}Hz"}

    total_seconds = len(audio) / SAMPLE_RATE
    aligned = []
    for segment in segments:
        window_start = max(0.0, float(segment["start"]) - WINDOW_PAD_SECONDS)
        window_end = min(total_seconds, float(segment["end"]) + WINDOW_PAD_SECONDS)
        clip = audio[int(window_start * SAMPLE_RATE) : int(window_end * SAMPLE_RATE)]

        words = None
        if len(clip) >= SAMPLE_RATE // 10:
            try:
                words = align_segment(model, processor, np.asarray(clip), segment["text"], language, torch)
            except Exception as err:  # one bad segment must not lose the whole pass
                print(f"[forced_align] segment failed: {err}", file=sys.stderr)

        if not words:
            aligned.append({"id": segment["id"], "aligned": False})
            continue

        aligned.append(
            {
                "id": segment["id"],
                "aligned": True,
                "start": window_start + words[0]["start"],
                "end": window_start + words[-1]["end"],
                "words": [
                    {"text": w["text"], "start": window_start + w["start"], "end": window_start + w["end"]}
                    for w in words
                ],
                "score": sum(w["score"] for w in words) / len(words),
            }
        )

    return {"ok": True, "model": repo, "segments": aligned}


def main():
    """
    Persistent worker: reads one JSON request per line from stdin and writes one JSON
    response per line to stdout, for as long as the caller keeps the pipe open, instead of
    handling a single request and exiting.

    The dominant cost on a cold run isn't the alignment math, it's standing up a fresh
    interpreter and importing torch/transformers (seconds) and then deserializing a
    wav2vec2 checkpoint from disk (more seconds) — both paid again on every request when
    the caller spawns a new process each time. A warm worker pays the import cost once per
    process lifetime for free (Python caches `sys.modules` regardless), and this loop adds
    the other half: `get_model()` caches loaded checkpoints so a second segment, or a second
    transcribe in the same language, only pays for the inference itself.
    """
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

        # Loads a language's model ahead of time, so it is ready by the time the transcript arrives.
        if request.get("cmd") == "warm":
            try:
                from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

                token = os.environ.get("HF_TOKEN") or None
                model, _processor, repo, err = get_model(request.get("language", "en"), token, Wav2Vec2ForCTC, Wav2Vec2Processor)
                respond({"ok": model is not None, "model": repo, "error": err})
            except Exception as err:
                respond({"ok": False, "error": str(err)})
            continue

        if request.get("probe"):
            from importlib.util import find_spec

            respond({"ok": True, "ready": find_spec("transformers") is not None})
            continue

        try:
            respond(handle_align(request))
        except Exception as err:  # one bad request must not take the whole warm worker down
            print(f"[forced_align] request failed: {err}", file=sys.stderr)
            respond({"ok": False, "error": str(err)})


if __name__ == "__main__":
    main()
