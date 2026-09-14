---
title: Dubly Voice Cloning
emoji: 🎙️
colorFrom: red
colorTo: orange
sdk: gradio
app_file: app.py
pinned: false
---

# Dubly — voice cloning worker

Runs [Chatterbox](https://github.com/resemble-ai/chatterbox) (MIT) on a free ZeroGPU
Space so Dubly can dub in a user's own voice without a paid cloning vendor.

## Why a Space and not the app's own server

The models are small enough to self-host, but a laptop CPU renders them at about
realtime, so a multi-language dub takes longer than anyone will wait. ZeroGPU gives the
same models a GPU for free. When Dubly moves to a GPU host, the identical model runs
in-process and this Space is no longer needed — nothing here is throwaway.

## Setup

1. Create a Space: **Gradio** SDK, **ZeroGPU** hardware.
2. Upload `app.py` and `requirements.txt`.
3. First build takes a while (it downloads the Chatterbox weights).

## Calling it from Dubly

Set these on the Dubly server and it routes cloning here automatically:

```
HF_SPACE_URL=https://<user>-<space>.hf.space
HF_TOKEN=hf_...
```

The token is what makes the call count against *your* daily quota (5 min on a free
account, 40 on PRO) instead of the stricter shared anonymous pool, and it gives better
queue priority. It is required for a private Space.

## Quota

Declared GPU duration is what gets billed, so `app.py` estimates a tight per-line duration
rather than reserving a flat maximum. A 5-minute daily quota goes a long way at a few
seconds per line — but it is a real ceiling, so a long video is best dubbed with catalog
voices and cloning saved for the lines that need it.
