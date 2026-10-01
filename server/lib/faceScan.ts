import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import type { FaceScan } from '../../src/types';
import { SAFE_INPUT_OPTIONS } from './ffmpeg';
import { ffmpegPath } from './mediaTools';
import { serverRoot } from './paths';

/**
 * Looks at a dozen or so frames of an uploaded video to tell whether someone's face is on
 * screen — the case where each dubbed line has to fit the speaker's mouth. Runs the SCRFD
 * face detector (ONNX, CPU, ~3MB) in-process, the same way Silero VAD runs, so it needs no
 * Python and takes a second or two.
 */
export const FACE_DETECTOR = path.join(serverRoot, 'models', 'scrfd_2.5g_bnkps.onnx');

// The detector's square input: a frame is scaled to fit and padded on the right and bottom.
const INPUT_SIZE = 640;
const SCORE_THRESHOLD = 0.5;
const NMS_THRESHOLD = 0.4;
// SCRFD-2.5G with keypoints: a score, box and 5-point output per stride, two anchors per grid cell.
const STRIDES = [8, 16, 32];
const ANCHORS_PER_CELL = 2;

export function isFaceScanAvailable(): boolean {
  return existsSync(FACE_DETECTOR);
}

// A face in at least this share of samples, covering at least this much of the frame (~110 px tall at 1080p).
const MIN_FACE_SHARE = 0.3;
const MIN_FACE_AREA = 0.005;

export function faceScanVerdict(scan: Omit<FaceScan, 'hasFaces' | 'scannedAt'>): boolean {
  if (!scan.sampledFrames) return false;
  return scan.framesWithFace / scan.sampledFrames >= MIN_FACE_SHARE && scan.medianFaceArea >= MIN_FACE_AREA;
}

type Box = [number, number, number, number];
type Point = [number, number];

export interface FaceDetection {
  /** x1, y1, x2, y2 in frame pixels. */
  box: Box;
  score: number;
  /** Left eye, right eye, nose, left and right mouth corners. */
  kps: Point[];
}

interface Frame {
  width: number;
  height: number;
  rgb: Uint8Array;
}

// Overlap as SCRFD's reference NMS measures it (pixel-inclusive widths).
function overlap(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]) + 1);
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]) + 1);
  const inter = w * h;
  const area = (box: Box) => (box[2] - box[0] + 1) * (box[3] - box[1] + 1);
  return inter / (area(a) + area(b) - inter);
}

/** Greedy non-maximum suppression; the survivors come back best score first. */
export function nms(detections: FaceDetection[], threshold = NMS_THRESHOLD): FaceDetection[] {
  const keep: FaceDetection[] = [];
  for (const d of [...detections].sort((a, b) => b.score - a.score)) {
    if (keep.every((k) => overlap(k.box, d.box) <= threshold)) keep.push(d);
  }
  return keep;
}

/**
 * Turns the detector's raw outputs (scores, then box distances, then keypoint offsets, one
 * tensor per stride) into faces in frame pixels; `scale` is input pixels per frame pixel.
 */
export function decodeScrfd(outputs: ArrayLike<number>[], scale: number, threshold = SCORE_THRESHOLD): FaceDetection[] {
  const found: FaceDetection[] = [];
  STRIDES.forEach((stride, idx) => {
    const scores = outputs[idx];
    const distances = outputs[idx + STRIDES.length];
    const offsets = outputs[idx + STRIDES.length * 2];
    const cols = Math.floor(INPUT_SIZE / stride);
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] < threshold) continue;
      const cell = Math.floor(i / ANCHORS_PER_CELL);
      const cx = (cell % cols) * stride;
      const cy = Math.floor(cell / cols) * stride;
      const d = i * 4;
      const box: Box = [
        (cx - distances[d] * stride) / scale,
        (cy - distances[d + 1] * stride) / scale,
        (cx + distances[d + 2] * stride) / scale,
        (cy + distances[d + 3] * stride) / scale,
      ];
      const kps: Point[] = [];
      for (let j = 0; j < 5; j++) {
        kps.push([(cx + offsets[i * 10 + j * 2] * stride) / scale, (cy + offsets[i * 10 + j * 2 + 1] * stride) / scale]);
      }
      found.push({ box, score: scores[i], kps });
    }
  });
  return nms(found);
}

/** Nose roughly between the eyes: the face is turned towards the camera. */
export function isFrontal(kps: Point[]): boolean {
  const [leftEye, rightEye, nose] = kps;
  const eyeDistance = Math.max(1, Math.hypot(rightEye[0] - leftEye[0], rightEye[1] - leftEye[1]));
  return Math.abs(nose[0] - (leftEye[0] + rightEye[0]) / 2) / eyeDistance < 0.38;
}

// Scales the frame to fit the input (bilinear, as OpenCV's resize does), pads with black, and normalises to the model's range.
function toInput(frame: Frame): { tensor: ort.Tensor; scale: number } {
  const { width, height, rgb } = frame;
  let newW: number;
  let newH: number;
  if (height / width > 1) {
    newH = INPUT_SIZE;
    newW = Math.trunc(newH / (height / width));
  } else {
    newW = INPUT_SIZE;
    newH = Math.trunc(newW * (height / width));
  }
  const plane = INPUT_SIZE * INPUT_SIZE;
  const data = new Float32Array(3 * plane).fill(-127.5 / 128);
  const sx = width / newW;
  const sy = height / newH;
  for (let y = 0; y < newH; y++) {
    const fy = Math.min(height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < newW; x++) {
      const fx = Math.min(width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const top = rgb[(y0 * width + x0) * 3 + c] * (1 - wx) + rgb[(y0 * width + x1) * 3 + c] * wx;
        const bottom = rgb[(y1 * width + x0) * 3 + c] * (1 - wx) + rgb[(y1 * width + x1) * 3 + c] * wx;
        data[c * plane + y * INPUT_SIZE + x] = (Math.round(top * (1 - wy) + bottom * wy) - 127.5) / 128;
      }
    }
  }
  return { tensor: new ort.Tensor('float32', data, [1, 3, INPUT_SIZE, INPUT_SIZE]), scale: newH / height };
}

// A stored video is read over HTTPS by its signed URL (ffmpeg seeks, so only the frames it needs are fetched); anything else must be a local file.
function inputProtocols(video: string): string {
  if (video.startsWith('https://')) return 'https,tls,tcp';
  if (video.startsWith('http://')) return 'http,tcp';
  return SAFE_INPUT_OPTIONS[1];
}

// One frame at `seconds`, rotation applied, as RGB; null when there is no frame there.
function grabFrame(video: string, seconds: number): Promise<Frame | null> {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath,
      ['-v', 'error', '-nostdin', '-protocol_whitelist', inputProtocols(video), '-ss', seconds.toFixed(3), '-i', video, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'ppm', '-'],
      { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 60_000, windowsHide: true },
      (err, stdout) => resolve(err ? null : parsePpm(stdout))
    );
  });
}

function parsePpm(buf: Buffer): Frame | null {
  const header = buf.subarray(0, 64).toString('latin1').match(/^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/);
  if (!header) return null;
  const width = Number(header[1]);
  const height = Number(header[2]);
  const start = header[0].length;
  if (Number(header[3]) !== 255 || buf.length < start + width * height * 3) return null;
  return { width, height, rgb: buf.subarray(start, start + width * height * 3) };
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;
function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(FACE_DETECTOR).catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

async function detectFaces(session: ort.InferenceSession, frame: Frame): Promise<FaceDetection[]> {
  const { tensor, scale } = toInput(frame);
  const results = await session.run({ [session.inputNames[0]]: tensor });
  const outputs = session.outputNames.map((name) => results[name].data as Float32Array);
  if (outputs.length !== STRIDES.length * 3) throw new Error(`unexpected face detector outputs (${outputs.length})`);
  return decodeScrfd(outputs, scale);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

async function sampleFaces(video: string, durationSeconds: number, deadline: number): Promise<Omit<FaceScan, 'hasFaces' | 'scannedAt'> | null> {
  const session = await getSession();
  const count = durationSeconds > 600 ? 16 : 12;
  const duration = Math.max(0.5, durationSeconds);
  let sampled = 0;
  let withFace = 0;
  let frontal = 0;
  let maxFaces = 0;
  const areas: number[] = [];
  let best: { rank: number; time: number; box: Box } | null = null;

  for (let i = 0; i < count; i++) {
    if (Date.now() > deadline) return null;
    // Evenly spread, skipping the very start and end where fades and title cards live.
    const time = duration * (0.04 + (0.92 * (i + 0.5)) / count);
    const frame = await grabFrame(video, time);
    if (!frame) continue;
    sampled++;
    const { width: w, height: h } = frame;
    // Tiny background faces are not what a viewer watches.
    const big = (await detectFaces(session, frame)).filter((d) => d.box[3] - d.box[1] >= Math.max(40, 0.05 * h));
    maxFaces = Math.max(maxFaces, big.length);
    if (!big.length) continue;
    withFace++;
    const size = (d: FaceDetection) => (d.box[2] - d.box[0]) * (d.box[3] - d.box[1]);
    const main = big.reduce((a, b) => (size(b) > size(a) ? b : a));
    const [x1, y1, x2, y2] = main.box;
    const area = Math.max(0, size(main)) / (w * h);
    areas.push(area);
    const looksAhead = isFrontal(main.kps);
    if (looksAhead) frontal++;
    const rank = area * main.score * (looksAhead ? 1.5 : 1);
    if (!best || rank > best.rank) best = { rank, time, box: [Math.max(0, x1 / w), Math.max(0, y1 / h), Math.min(1, x2 / w), Math.min(1, y2 / h)] };
  }

  return {
    sampledFrames: sampled,
    framesWithFace: withFace,
    maxFaces,
    medianFaceArea: areas.length ? median(areas) : 0,
    frontalRatio: withFace ? frontal / withFace : 0,
    ...(best && { best: { time: Math.round(best.time * 100) / 100, box: best.box.map((v) => Math.round(v * 10000) / 10000) as Box } }),
  };
}

/** The scan of a local file or signed URL, or null when it cannot run or fails; a missing scan never blocks anything. */
export async function scanFaces(video: string, durationSeconds: number, timeoutMs = 90_000): Promise<FaceScan | null> {
  if (!isFaceScanAvailable() || !(durationSeconds > 0)) return null;
  try {
    const raw = await sampleFaces(video, durationSeconds, Date.now() + timeoutMs);
    return raw && { ...raw, hasFaces: faceScanVerdict(raw), scannedAt: new Date().toISOString() };
  } catch (err) {
    console.error('[faceScan] failed', err);
    return null;
  }
}
