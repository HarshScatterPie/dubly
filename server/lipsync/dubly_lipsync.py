"""
Dubly lip-sync: re-animates the speaker's mouth to the dubbed voice with Wav2Lip-256 (ONNX, CPU).

What this does differently from the vendored inference script, and why:
  * Frames stream through ffmpeg at a constant frame rate with rotation applied. The old
    script read frames with OpenCV at the container's *average* rate, so any variable-rate
    phone video drifted: the mouth moved ahead of or behind the voice by a growing margin.
  * Memory stays flat. The old script held every frame of the video in RAM.
  * The mouth is driven by the dubbed voice alone (no music bed), so it stays closed in
    pauses instead of chewing along to the soundtrack.
  * Only the mouth region is replaced, through a feathered mask, instead of pasting the
    model's whole square crop (which left a visible box and a colour seam on the face).
  * Frames outside speech, and frames without a usable face, pass through untouched.
  * Every run has its own files: nothing is shared through a fixed temp/ folder, so two
    dubs lip-syncing at once can no longer overwrite each other's audio.

Output is video only; the caller muxes the final mixed audio onto it.
Prints "PROGRESS <0..1>" lines while working and one "RESULT {json}" line at the end.
"""
import argparse
import json
import sys

import cv2
import numpy as np
import onnxruntime as ort

from dubly_vision import (
    DEFAULT_CHECKPOINT,
    DEFAULT_DETECTOR,
    MEL_FRAMES_PER_SECOND,
    MEL_STEP,
    FaceDetector,
    FrameReader,
    FrameWriter,
    first_frame,
    iou,
    melspectrogram,
    read_wav_mono16k,
    session_options,
)

IMG_SIZE = 256
# Frames this close to speech are synced too, so the mouth settles instead of snapping at the cut.
SPAN_MARGIN = 0.2
# A face smaller than this is a background figure: the model cannot animate it convincingly.
MIN_FACE_PX = 56


class Tracker:
    """Follows one face across frames: the one we locked onto, not whichever scores highest."""

    def __init__(self, detector, height):
        self.detector = detector
        self.box = None
        self.misses = 0
        self.min_face = max(MIN_FACE_PX, int(0.06 * height))

    def update(self, frame):
        dets, _ = self.detector.detect(frame, threshold=0.5, input_size=(480, 480))
        candidates = [d[:4].astype(np.float32) for d in dets if (d[3] - d[1]) >= self.min_face]
        if not candidates:
            self.misses += 1
            if self.misses > 2:
                self.box = None
            return None
        largest = max(candidates, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
        chosen = largest
        if self.box is not None:
            nearest = max(candidates, key=lambda b: iou(b, self.box))
            if iou(nearest, self.box) >= 0.2:
                chosen = nearest
        # Light smoothing while the face holds still; a real move (or a cut) is followed at once.
        if self.box is not None and iou(chosen, self.box) > 0.6:
            chosen = 0.55 * chosen + 0.45 * self.box
        self.box = chosen
        self.misses = 0
        return chosen


_mask_cache = {}


def mouth_mask(width, height):
    key = (width, height)
    cached = _mask_cache.get(key)
    if cached is not None:
        return cached
    if len(_mask_cache) > 256:
        _mask_cache.clear()
    mask = np.zeros((height, width), dtype=np.float32)
    cv2.ellipse(mask, (int(width * 0.5), int(height * 0.68)), (max(2, int(width * 0.36)), max(2, int(height * 0.26))), 0, 0, 360, 1.0, -1)
    sigma = max(1.5, width * 0.05)
    mask = cv2.GaussianBlur(mask, (0, 0), sigma)
    mask = mask[..., None]
    _mask_cache[key] = mask
    return mask


def model_inputs(session):
    frames_name, mel_name = None, None
    for inp in session.get_inputs():
        shape = inp.shape
        if len(shape) == 4 and shape[1] == 6:
            frames_name = inp.name
        elif 'mel' in inp.name.lower():
            mel_name = inp.name
    names = [i.name for i in session.get_inputs()]
    if frames_name is None:
        frames_name = 'video_frames' if 'video_frames' in names else names[-1]
    if mel_name is None:
        mel_name = next(n for n in names if n != frames_name)
    return frames_name, mel_name


def sync_face(frame, box, mel_chunk, session, frames_name, mel_name):
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = [float(v) for v in box]
    face_h = y2 - y1
    # A little below the chin, as the model was trained with.
    y2 = min(height, y2 + max(10.0, 0.06 * face_h))
    x1, y1, x2, y2 = max(0, int(x1)), max(0, int(y1)), min(width, int(x2)), int(y2)
    crop = frame[y1:y2, x1:x2]
    ch, cw = crop.shape[:2]
    if ch < 32 or cw < 32:
        return False

    face = cv2.resize(crop, (IMG_SIZE, IMG_SIZE), interpolation=cv2.INTER_AREA if ch > IMG_SIZE else cv2.INTER_CUBIC)
    masked = face.copy()
    masked[IMG_SIZE // 2:] = 0
    batch = (np.concatenate([masked, face], axis=2).astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
    mel = mel_chunk[None, None].astype(np.float32)
    pred = session.run(None, {frames_name: batch, mel_name: mel})[0][0]
    pred = np.clip(pred.transpose(1, 2, 0) * 255.0, 0, 255).astype(np.uint8)

    patch = cv2.resize(pred, (cw, ch), interpolation=cv2.INTER_CUBIC)
    if cw > IMG_SIZE * 1.3:
        # Upscaling a 256 px prediction softens it; a gentle unsharp mask restores some edge.
        soft = cv2.GaussianBlur(patch, (0, 0), 1.1)
        patch = cv2.addWeighted(patch, 1.45, soft, -0.45, 0)
    mask = mouth_mask(cw, ch)
    blended = patch.astype(np.float32) * mask + crop.astype(np.float32) * (1.0 - mask)
    frame[y1:y2, x1:x2] = np.clip(blended, 0, 255).astype(np.uint8)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--video', required=True)
    parser.add_argument('--audio', required=True, help='16 kHz mono WAV of the dubbed voice only')
    parser.add_argument('--out', required=True, help='video-only MP4 to write')
    parser.add_argument('--fps', type=float, required=True)
    parser.add_argument('--duration', type=float, required=True)
    parser.add_argument('--spans', default='', help='JSON file of [start, end] pairs to sync; everything else passes through')
    parser.add_argument('--checkpoint', default=DEFAULT_CHECKPOINT)
    parser.add_argument('--detector', default=DEFAULT_DETECTOR)
    parser.add_argument('--crf', type=int, default=17)
    args = parser.parse_args()

    fps = args.fps
    frame0 = first_frame(args.ffmpeg, args.video, fps)
    if frame0 is None:
        raise SystemExit('could not decode the video')
    height, width = frame0.shape[:2]

    mel = melspectrogram(read_wav_mono16k(args.audio))
    if mel.shape[1] < MEL_STEP:
        mel = np.pad(mel, ((0, 0), (0, MEL_STEP - mel.shape[1])), constant_values=-4.0)

    spans = []
    if args.spans:
        with open(args.spans, 'r', encoding='utf-8') as handle:
            spans = sorted((float(s) - SPAN_MARGIN, float(e) + SPAN_MARGIN) for s, e in json.load(handle))

    detector = FaceDetector(args.detector)
    session = ort.InferenceSession(args.checkpoint, sess_options=session_options(), providers=['CPUExecutionProvider'])
    frames_name, mel_name = model_inputs(session)
    tracker = Tracker(detector, height)

    reader = FrameReader(args.ffmpeg, args.video, fps, width, height)
    writer = FrameWriter(args.ffmpeg, args.out, fps, width, height, crf=args.crf)
    expected = max(1, int(round(args.duration * fps)))
    index = 0
    synced = 0
    span_at = 0
    try:
        while True:
            frame = reader.read()
            if frame is None:
                break
            t = index / fps
            while span_at < len(spans) and spans[span_at][1] < t:
                span_at += 1
            in_speech = not spans or (span_at < len(spans) and spans[span_at][0] <= t)
            if in_speech:
                box = tracker.update(frame)
                if box is not None:
                    start = int(index * MEL_FRAMES_PER_SECOND / fps)
                    if start + MEL_STEP > mel.shape[1]:
                        start = mel.shape[1] - MEL_STEP
                    if sync_face(frame, box, mel[:, start:start + MEL_STEP], session, frames_name, mel_name):
                        synced += 1
            else:
                tracker.box = None
            writer.write(frame)
            index += 1
            if index % 25 == 0:
                print(f'PROGRESS {min(0.999, index / expected):.3f}', flush=True)
    finally:
        reader.close()
        writer.close()

    print('RESULT ' + json.dumps({'frames': index, 'synced': synced, 'width': width, 'height': height}), flush=True)
    sys.stdout.flush()


if __name__ == '__main__':
    main()
