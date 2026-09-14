import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { lipsyncDir, serverRoot } from './paths';
import { env } from './env';
import type { TranscriptSegment } from '../../src/types';

/**
 * Word-accurate timings from a CTC forced alignment, the same approach WhisperX uses.
 *
 * This is the precision layer on top of the VAD pass in `forcedAlign.ts`. The VAD decides
 * *which* stretch of audio a line belongs to; this decides where each word inside it starts
 * and ends, by solving for the frame-by-frame path through the audio that produces exactly
 * the text we already know was said.
 *
 * Optional like lip-sync and separation: without the model, the VAD-derived timings stand.
 */
const VENV_PYTHON = path.join(lipsyncDir, 'venv', 'Scripts', 'python.exe');
const WORKER_SCRIPT = path.join(serverRoot, 'scripts', 'forced_align.py');
const SITE_PACKAGES = path.join(lipsyncDir, 'venv', 'Lib', 'site-packages');

/**
 * Languages with a mapped alignment model, mirroring the worker's own table. Kept in sync
 * by hand rather than probed, because probing means spawning Python and importing torch —
 * seconds of work to answer a question asked on every transcribe.
 */
const ALIGNABLE_LANGUAGES = new Set([
  'en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'ru', 'pl', 'ar', 'ja', 'zh', 'ko', 'tr',
  'el', 'fa', 'fi', 'he', 'id', 'sv', 'ur',
  'hi', 'hinglish', 'ta', 'te', 'bn', 'gu', 'mr', 'or', 'ml', 'kn', 'pa',
]);

export function isCtcAlignAvailable(languageCode?: string): boolean {
  if (!existsSync(VENV_PYTHON) || !existsSync(WORKER_SCRIPT)) return false;
  if (!existsSync(path.join(SITE_PACKAGES, 'transformers'))) return false;
  return languageCode === undefined || ALIGNABLE_LANGUAGES.has(languageCode);
}

/** First run downloads the model; after that it is cached by huggingface_hub. */
const ALIGN_TIMEOUT_MS = 15 * 60 * 1000;

interface AlignedSegment {
  id: string;
  aligned: boolean;
  start?: number;
  end?: number;
  words?: { text: string; start: number; end: number }[];
  score?: number;
}

/**
 * Refines segment and word timings in place against the audio.
 *
 * Segments the aligner could not place (no model for the language, text with no alignable
 * characters, a window too short for its text) keep the timings they came in with, so the
 * result is never worse than the input.
 */
export async function refineTimingsWithCtc(
  audioPath: string,
  languageCode: string,
  segments: TranscriptSegment[]
): Promise<TranscriptSegment[]> {
  if (segments.length === 0 || !isCtcAlignAvailable(languageCode)) return segments;

  const result = await runWorker({
    audioPath,
    language: languageCode === 'hinglish' ? 'hi' : languageCode,
    segments: segments.map((s) => ({ id: s.id, text: s.text, start: s.startTime, end: s.endTime })),
  });
  if (!result.ok) throw new Error(result.error || 'Forced alignment failed');

  const byId = new Map((result.segments || []).map((s) => [s.id, s]));
  let refined = 0;
  const out = segments.map((segment) => {
    const match = byId.get(segment.id);
    if (!match?.aligned || match.start === undefined || match.end === undefined) return segment;
    refined++;
    return {
      ...segment,
      startTime: match.start,
      // A one-word segment can align to a near-zero span; keep a floor so downstream
      // duration maths (the TTS time-fit) never divides by something meaningless.
      endTime: Math.max(match.start + 0.2, match.end),
      words: match.words?.length ? match.words : segment.words,
    };
  });

  console.log(`[ctcAlign] ${refined}/${segments.length} segments refined via ${result.model}`);
  return out;
}

interface WorkerResponse {
  ok: boolean;
  error?: string;
  model?: string;
  ready?: boolean;
  segments?: AlignedSegment[];
}

function runWorker(request: unknown): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const proc = spawn(VENV_PYTHON, ['-W', 'ignore', WORKER_SCRIPT], {
      cwd: serverRoot,
      // HF_TOKEN is passed through so the gated AI4Bharat models can be used once their
      // terms have been accepted; without it the worker falls back to ungated models.
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_TOKEN: env.hfToken || '' },
    });

    let stdout = '';
    let stderrTail = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Forced alignment timed out'));
    }, ALIGN_TIMEOUT_MS);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.trim()) as WorkerResponse);
      } catch {
        reject(new Error(`Forced alignment worker failed: ${stderrTail || stdout || 'no output'}`));
      }
    });

    // The transcript goes over stdin as JSON, never through argv — a Windows command line
    // mangles Devanagari and Tamil.
    proc.stdin.write(JSON.stringify(request));
    proc.stdin.end();
  });
}
