"""
Samples frames across a video and reports whether a face worth lip-syncing is on screen.

Prints one JSON line: {"sampledFrames", "framesWithFace", "maxFaces", "medianFaceArea",
"frontalRatio", "best": {"time", "box"}}. Box coordinates are fractions of the frame.
"""
import argparse
import json
import sys

import numpy as np

from dubly_vision import DEFAULT_DETECTOR, FaceDetector, first_frame, is_frontal


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--video', required=True)
    parser.add_argument('--duration', type=float, required=True)
    parser.add_argument('--samples', type=int, default=12)
    parser.add_argument('--detector', default=DEFAULT_DETECTOR)
    args = parser.parse_args()

    detector = FaceDetector(args.detector)
    duration = max(0.5, args.duration)
    count = max(1, args.samples)
    # Evenly spread, skipping the very start and end where fades and title cards live.
    times = [duration * (0.04 + 0.92 * (i + 0.5) / count) for i in range(count)]

    sampled = 0
    with_face = 0
    frontal = 0
    max_faces = 0
    areas = []
    best = None
    for t in times:
        frame = first_frame(args.ffmpeg, args.video, 0, seek=t)
        if frame is None:
            continue
        sampled += 1
        h, w = frame.shape[:2]
        dets, kps = detector.detect(frame, threshold=0.5, input_size=(640, 640))
        # Tiny background faces are not what a viewer watches, and Wav2Lip cannot animate them.
        big = [i for i in range(len(dets)) if (dets[i, 3] - dets[i, 1]) >= max(40, 0.05 * h)]
        max_faces = max(max_faces, len(big))
        if not big:
            continue
        with_face += 1
        main_face = max(big, key=lambda i: (dets[i, 2] - dets[i, 0]) * (dets[i, 3] - dets[i, 1]))
        x1, y1, x2, y2, score = [float(v) for v in dets[main_face]]
        area = max(0.0, (x2 - x1) * (y2 - y1)) / float(w * h)
        areas.append(area)
        looks_ahead = kps is not None and is_frontal(kps[main_face])
        if looks_ahead:
            frontal += 1
        rank = area * score * (1.5 if looks_ahead else 1.0)
        if best is None or rank > best[0]:
            best = (rank, t, [max(0.0, x1 / w), max(0.0, y1 / h), min(1.0, x2 / w), min(1.0, y2 / h)])

    result = {
        'sampledFrames': sampled,
        'framesWithFace': with_face,
        'maxFaces': max_faces,
        'medianFaceArea': float(np.median(areas)) if areas else 0.0,
        'frontalRatio': (frontal / with_face) if with_face else 0.0,
    }
    if best is not None:
        result['best'] = {'time': round(best[1], 2), 'box': [round(v, 4) for v in best[2]]}
    print(json.dumps(result))
    sys.stdout.flush()


if __name__ == '__main__':
    main()
