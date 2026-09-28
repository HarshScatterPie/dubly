"""
Shared helpers for Dubly's face scan and lip-sync scripts.

Deliberately light: numpy, OpenCV and onnxruntime only. The vendored Wav2Lip code pulled in
insightface (which imports scikit-image) and librosa (which imports numba) just to find a
face box and build a mel spectrogram; those imports take longer than a short scan itself,
so both are reimplemented here against the same models and the same maths.
"""
import os
import subprocess

import cv2
import numpy as np
import onnxruntime as ort

ort.set_default_logger_severity(3)

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DETECTOR = os.path.join(HERE, 'wav2lip_onnx', 'insightface_func', 'models', 'antelope', 'scrfd_2.5g_bnkps.onnx')
DEFAULT_CHECKPOINT = os.path.join(HERE, 'wav2lip_onnx', 'checkpoints', 'wav2lip_256.onnx')


def session_options():
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.intra_op_num_threads = max(1, (os.cpu_count() or 2))
    options.log_severity_level = 3
    return options


# ---------------------------------------------------------------------------------------
# Face detection: SCRFD (the detector the vendored Wav2Lip build uses), decoded directly.
# ---------------------------------------------------------------------------------------

def _nms(dets, threshold=0.4):
    x1, y1, x2, y2, scores = dets[:, 0], dets[:, 1], dets[:, 2], dets[:, 3], dets[:, 4]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1 + 1)
        h = np.maximum(0.0, yy2 - yy1 + 1)
        overlap = (w * h) / (areas[i] + areas[order[1:]] - w * h)
        order = order[np.where(overlap <= threshold)[0] + 1]
    return keep


class FaceDetector:
    """SCRFD with 5 keypoints (eyes, nose, mouth corners)."""

    def __init__(self, model_path=DEFAULT_DETECTOR):
        self.session = ort.InferenceSession(model_path, sess_options=session_options(), providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name
        outputs = self.session.get_outputs()
        self.output_names = [o.name for o in outputs]
        self.batched = len(outputs[0].shape) == 3
        count = len(outputs)
        self.use_kps = count in (9, 15)
        self.fmc = 3 if count in (6, 9) else 5
        self.strides = [8, 16, 32] if self.fmc == 3 else [8, 16, 32, 64, 128]
        self.num_anchors = 2 if self.fmc == 3 else 1
        self._centers = {}

    def detect(self, image, threshold=0.5, input_size=(480, 480)):
        """Returns (boxes Nx5 [x1, y1, x2, y2, score], keypoints Nx5x2 or None), best score first."""
        height, width = image.shape[:2]
        model_ratio = input_size[1] / input_size[0]
        if height / width > model_ratio:
            new_h = input_size[1]
            new_w = int(new_h / (height / width))
        else:
            new_w = input_size[0]
            new_h = int(new_w * (height / width))
        scale = new_h / height
        canvas = np.zeros((input_size[1], input_size[0], 3), dtype=np.uint8)
        canvas[:new_h, :new_w] = cv2.resize(image, (new_w, new_h))
        blob = cv2.dnn.blobFromImage(canvas, 1.0 / 128, input_size, (127.5, 127.5, 127.5), swapRB=True)
        outs = self.session.run(self.output_names, {self.input_name: blob})

        scores_all, boxes_all, kps_all = [], [], []
        in_h, in_w = blob.shape[2], blob.shape[3]
        for idx, stride in enumerate(self.strides):
            take = (lambda k: outs[k][0]) if self.batched else (lambda k: outs[k])
            scores = take(idx).reshape(-1)
            box_preds = take(idx + self.fmc) * stride
            fh, fw = in_h // stride, in_w // stride
            key = (fh, fw, stride)
            centers = self._centers.get(key)
            if centers is None:
                centers = np.stack(np.mgrid[:fh, :fw][::-1], axis=-1).astype(np.float32)
                centers = (centers * stride).reshape(-1, 2)
                if self.num_anchors > 1:
                    centers = np.stack([centers] * self.num_anchors, axis=1).reshape(-1, 2)
                self._centers[key] = centers
            keep = np.where(scores >= threshold)[0]
            if keep.size == 0:
                continue
            c = centers[keep]
            d = box_preds[keep]
            boxes = np.stack([c[:, 0] - d[:, 0], c[:, 1] - d[:, 1], c[:, 0] + d[:, 2], c[:, 1] + d[:, 3]], axis=-1)
            scores_all.append(scores[keep])
            boxes_all.append(boxes)
            if self.use_kps:
                kp = take(idx + self.fmc * 2)[keep] * stride
                pts = np.empty((kp.shape[0], 5, 2), dtype=np.float32)
                for j in range(5):
                    pts[:, j, 0] = c[:, 0] + kp[:, j * 2]
                    pts[:, j, 1] = c[:, 1] + kp[:, j * 2 + 1]
                kps_all.append(pts)

        if not scores_all:
            return np.zeros((0, 5), dtype=np.float32), None
        scores = np.concatenate(scores_all)
        boxes = np.concatenate(boxes_all) / scale
        dets = np.hstack([boxes, scores[:, None]]).astype(np.float32)
        keep = _nms(dets)
        dets = dets[keep]
        kps = (np.concatenate(kps_all) / scale)[keep] if kps_all else None
        order = dets[:, 4].argsort()[::-1]
        return dets[order], (kps[order] if kps is not None else None)


def is_frontal(kps):
    """Nose roughly between the eyes: the face is turned towards the camera, where lip-sync reads best."""
    if kps is None:
        return False
    left_eye, right_eye, nose = kps[0], kps[1], kps[2]
    eye_distance = max(1.0, float(np.linalg.norm(right_eye - left_eye)))
    offset = abs(float(nose[0] - (left_eye[0] + right_eye[0]) / 2)) / eye_distance
    return offset < 0.38


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


# ---------------------------------------------------------------------------------------
# Audio features: Wav2Lip's mel spectrogram (hparams.py / audio.py), in plain numpy.
# ---------------------------------------------------------------------------------------

SAMPLE_RATE = 16000
N_FFT = 800
HOP = 200
N_MELS = 80
FMIN, FMAX = 55.0, 7600.0
MEL_STEP = 16
MEL_FRAMES_PER_SECOND = SAMPLE_RATE / HOP  # 80


def _hz_to_mel(freq):
    freq = np.asanyarray(freq, dtype=np.float64)
    f_sp = 200.0 / 3
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    return np.where(freq >= min_log_hz, min_log_mel + np.log(np.maximum(freq, 1e-10) / min_log_hz) / logstep, freq / f_sp)


def _mel_to_hz(mel):
    mel = np.asanyarray(mel, dtype=np.float64)
    f_sp = 200.0 / 3
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    return np.where(mel >= min_log_mel, min_log_hz * np.exp(logstep * (mel - min_log_mel)), f_sp * mel)


def _mel_basis():
    # librosa.filters.mel(sr=16000, n_fft=800, n_mels=80, fmin=55, fmax=7600): Slaney scale, Slaney norm.
    fft_freqs = np.linspace(0, SAMPLE_RATE / 2, 1 + N_FFT // 2)
    mel_points = _mel_to_hz(np.linspace(_hz_to_mel(FMIN), _hz_to_mel(FMAX), N_MELS + 2))
    fdiff = np.diff(mel_points)
    ramps = np.subtract.outer(mel_points, fft_freqs)
    weights = np.zeros((N_MELS, len(fft_freqs)))
    for i in range(N_MELS):
        lower = -ramps[i] / fdiff[i]
        upper = ramps[i + 2] / fdiff[i + 1]
        weights[i] = np.maximum(0, np.minimum(lower, upper))
    weights *= (2.0 / (mel_points[2:N_MELS + 2] - mel_points[:N_MELS]))[:, None]
    return weights.astype(np.float32)


def read_wav_mono16k(path):
    import wave
    with wave.open(path, 'rb') as w:
        if w.getsampwidth() != 2:
            raise ValueError('expected 16-bit PCM')
        rate, channels = w.getframerate(), w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE:
        raise ValueError(f'expected {SAMPLE_RATE} Hz audio, got {rate}')
    return data


def melspectrogram(wav):
    """80 x T normalized log-mel, identical in shape and scale to Wav2Lip's audio.melspectrogram."""
    y = np.append(wav[:1], wav[1:] - 0.97 * wav[:-1]).astype(np.float32)  # pre-emphasis
    y = np.pad(y, N_FFT // 2, mode='reflect')
    n_frames = 1 + (len(y) - N_FFT) // HOP
    window = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)).astype(np.float32)
    basis = _mel_basis()
    frames = np.lib.stride_tricks.as_strided(y, shape=(n_frames, N_FFT), strides=(y.strides[0] * HOP, y.strides[0]))
    mel = np.empty((N_MELS, n_frames), dtype=np.float32)
    block = 8192  # frames per chunk, so an hour of audio never materialises as one giant matrix
    for start in range(0, n_frames, block):
        chunk = frames[start:start + block] * window
        magnitude = np.abs(np.fft.rfft(chunk, n=N_FFT, axis=1)).T
        mel[:, start:start + block] = basis @ magnitude
    s = 20 * np.log10(np.maximum(1e-5, mel)) - 20
    return np.clip(8.0 * ((s + 100) / 100) - 4.0, -4.0, 4.0).astype(np.float32)


# ---------------------------------------------------------------------------------------
# Video I/O through ffmpeg: constant frame rate, rotation applied, any container.
# ---------------------------------------------------------------------------------------

def first_frame(ffmpeg, video, fps, seek=0.0):
    args = [ffmpeg, '-v', 'error', '-nostdin']
    if seek > 0:
        args += ['-ss', f'{seek:.3f}']
    args += ['-i', video, '-frames:v', '1']
    if fps:
        args += ['-vf', f'fps={fps}']
    args += ['-f', 'image2pipe', '-vcodec', 'bmp', '-']
    out = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if out.returncode != 0 or not out.stdout:
        return None
    return cv2.imdecode(np.frombuffer(out.stdout, dtype=np.uint8), cv2.IMREAD_COLOR)


class FrameReader:
    def __init__(self, ffmpeg, video, fps, width, height):
        self.size = width * height * 3
        self.shape = (height, width, 3)
        self.proc = subprocess.Popen(
            [ffmpeg, '-v', 'error', '-nostdin', '-i', video, '-vf', f'fps={fps}', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
            stdout=subprocess.PIPE,
            bufsize=self.size * 2,
        )

    def read(self):
        buf = self.proc.stdout.read(self.size)
        if not buf or len(buf) < self.size:
            return None
        return np.frombuffer(buf, dtype=np.uint8).reshape(self.shape).copy()

    def close(self):
        try:
            self.proc.stdout.close()
        except Exception:
            pass
        self.proc.wait(timeout=30)


class FrameWriter:
    def __init__(self, ffmpeg, output, fps, width, height, crf=17):
        self.proc = subprocess.Popen(
            [
                ffmpeg, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{width}x{height}', '-r', str(fps), '-i', '-',
                '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
                '-c:v', 'libx264', '-preset', 'medium', '-crf', str(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
            ],
            stdin=subprocess.PIPE,
        )

    def write(self, frame):
        self.proc.stdin.write(frame.tobytes())

    def close(self):
        self.proc.stdin.close()
        code = self.proc.wait(timeout=600)
        if code != 0:
            raise RuntimeError(f'ffmpeg encoder exited with {code}')
