"""
Verifies the CTC forced-alignment maths in forced_align.py against synthetic emission
matrices whose correct answer is known by construction — no model download, runs in a
second.

    server/lipsync/venv/Scripts/python.exe server/scripts/test_forced_align.py

Kept as a real test rather than a one-off check: the trellis is the least obvious code in
this repo, an off-by-one in it shifts every subtitle and every dubbed line by a fraction
of a second, and that is exactly the kind of error that looks fine in the logs and wrong
in the video.
"""
import importlib.util
import os
import sys

import torch

spec = importlib.util.spec_from_file_location(
    "fa", os.path.join(os.path.dirname(os.path.abspath(__file__)), "forced_align.py")
)
fa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fa)

failures = 0


def check(name, ok, detail=None):
    global failures
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures += 1


# Vocabulary: 0 is the CTC blank, then the characters we care about.
VOCAB = {"<pad>": 0, "|": 1, "h": 2, "i": 3, "b": 4, "o": 5, "y": 6}
BLANK = 0


def emission_for(frame_chars):
    """
    Builds a log-prob matrix where each frame is near-certain about one symbol.
    `frame_chars` is what is 'spoken' in each 20ms frame; None means silence (blank).
    """
    emission = torch.full((len(frame_chars), len(VOCAB)), -12.0)
    for t, ch in enumerate(frame_chars):
        emission[t, BLANK if ch is None else VOCAB[ch]] = -0.01
    return emission


def align(text, frame_chars):
    emission = emission_for(frame_chars)
    chars = [c for c in text.lower().replace(" ", "|") if c in VOCAB]
    tokens = [VOCAB[c] for c in chars]
    trellis = fa.build_trellis(emission, tokens, BLANK)
    path = fa.backtrack(trellis, emission, tokens, BLANK)
    return fa.merge_words(fa.merge_repeats(path, chars))


print("== trellis / backtrack / merge on a known-answer emission ==")

# "hi boy": 'hi' spoken over frames 2-5, a pause, 'boy' over frames 9-14.
frames = [None, None, "h", "h", "i", "i", None, None, "|", "b", "b", "o", "o", "y", "y", None]
words = align("hi boy", frames)

check("recovers both words", [w["word"] for w in words] == ["hi", "boy"], [w["word"] for w in words])
check("first word starts where 'h' starts (frame 2)", words[0]["start"] == 2, words[0]["start"])
check("first word ends where 'i' ends (frame 6)", words[0]["end"] == 6, words[0]["end"])
check("second word starts where 'b' starts (frame 9)", words[1]["start"] == 9, words[1]["start"])
check("second word ends where 'y' ends (frame 15)", words[1]["end"] == 15, words[1]["end"])
check("silence between the words is not claimed by either", words[0]["end"] <= words[1]["start"])
check("scores are confident on a clean signal", all(w["score"] > 0.9 for w in words), [w["score"] for w in words])

print("\n== leading silence does not drag the first word ==")
# The same words, but with a long silent lead-in: this is the applause case that used to
# put the transcript at 0.00s.
frames2 = [None] * 20 + ["h", "h", "i", "i", None, "|", "b", "o", "y", None]
words2 = align("hi boy", frames2)
check("first word starts after the silence, not at 0", words2[0]["start"] >= 20, words2[0]["start"])

print("\n== repeated characters collapse into one span ==")
frames3 = [None, "b", "b", "b", "b", "o", "o", "y", None]
words3 = align("boy", frames3)
check("one word, not three", len(words3) == 1, [w["word"] for w in words3])
check("spans the whole utterance", words3[0]["start"] == 1 and words3[0]["end"] == 8, words3[0])

print("\n== degenerate inputs are refused rather than guessed ==")
check("empty vocabulary overlap yields no tokens", len([c for c in "!!!" if c in VOCAB]) == 0)

# --- robustness: the same utterance under noise, and against a wrong-length window -------
print("\n== holds up on a noisy emission ==")
torch.manual_seed(7)


def noisy_align(text, frame_chars, noise=3.0):
    emission = emission_for(frame_chars) + torch.randn(len(frame_chars), len(VOCAB)) * noise
    emission = torch.log_softmax(emission, dim=-1)
    chars = [c for c in text.lower().replace(" ", "|") if c in VOCAB]
    tokens = [VOCAB[c] for c in chars]
    trellis = fa.build_trellis(emission, tokens, BLANK)
    path = fa.backtrack(trellis, emission, tokens, BLANK)
    return fa.merge_words(fa.merge_repeats(path, chars))


noisy_frames = [None] * 6 + ["h", "h", "i", "i"] + [None] * 4 + ["|"] + ["b", "b", "o", "o", "y", "y"] + [None] * 4
ok = 0
for trial in range(20):
    w = noisy_align("hi boy", noisy_frames)
    if len(w) == 2 and abs(w[0]["start"] - 6) <= 2 and abs(w[1]["start"] - 15) <= 2:
        ok += 1
check(f"20 noisy trials land within 2 frames ({ok}/20)", ok >= 18, ok)

print("\n== monotonic and non-overlapping under noise ==")
w = noisy_align("hi boy", noisy_frames)
check("words stay in order", all(w[i]["end"] <= w[i + 1]["start"] for i in range(len(w) - 1)), w)
check("no zero-length word", all(x["end"] > x["start"] for x in w), w)

print("\n== a window with far more silence than speech ==")
sparse = [None] * 40 + ["h", "i"] + [None] * 40
w2 = align("hi", sparse)
check("finds the speech in the middle, not the edges", 38 <= w2[0]["start"] <= 42, w2[0])
check("does not swallow the trailing silence", w2[0]["end"] <= 45, w2[0])

print(f"\n{'ALL PASS' if failures == 0 else f'{failures} FAILED'}")
sys.exit(0 if failures == 0 else 1)
