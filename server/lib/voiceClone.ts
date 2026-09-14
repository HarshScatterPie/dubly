import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { lipsyncDir, serverRoot, tmpDir } from './paths';

/**
 * Speaks text in a voice taken from one short recording the user supplied.
 *
 * The models run locally in the same Python venv as lip-sync and separation — it already
 * carries torch, so adding a cloning engine costs a pip install rather than a second
 * multi-gigabyte runtime. Both engines are MIT-licensed, which matters here: the
 * best-known alternative (Coqui XTTS-v2) is under CPML and cannot be used commercially.
 *
 * Like lip-sync and separation, this is treated as an optional capability: if the engine
 * isn't installed, callers fall back to a catalog voice rather than failing.
 */
const VENV_PYTHON = path.join(lipsyncDir, 'venv', 'Scripts', 'python.exe');
const WORKER_SCRIPT = path.join(serverRoot, 'scripts', 'voice_clone.py');

const SITE_PACKAGES = path.join(lipsyncDir, 'venv', 'Lib', 'site-packages');
/** Package directory each engine installs under, used for the cheap availability check. */
const ENGINE_PACKAGES = { chatterbox: 'chatterbox', indicf5: 'f5_tts' } as const;

export interface CloneEngines {
  chatterbox: boolean;
  indicf5: boolean;
}

/**
 * Which engines are installed, by looking for their package directories.
 *
 * Deliberately a filesystem check rather than running the worker with `--probe`: this is
 * called on every health poll and every dub, and spawning Python (which imports torch)
 * takes seconds. The worker still does the authoritative check before synthesizing.
 */
export function installedCloneEngines(): CloneEngines {
  if (!existsSync(VENV_PYTHON) || !existsSync(WORKER_SCRIPT)) {
    return { chatterbox: false, indicf5: false };
  }
  return {
    chatterbox: existsSync(path.join(SITE_PACKAGES, ENGINE_PACKAGES.chatterbox)),
    indicf5: existsSync(path.join(SITE_PACKAGES, ENGINE_PACKAGES.indicf5)),
  };
}

export function isVoiceCloneAvailable(): boolean {
  const engines = installedCloneEngines();
  return engines.chatterbox || engines.indicf5;
}

/** Languages IndicF5 was trained on — the ones Chatterbox's roster does not reach. */
const INDIC_LANGUAGES = new Set(['as', 'bn', 'gu', 'hi', 'kn', 'ml', 'mr', 'or', 'pa', 'ta', 'te']);
const CHATTERBOX_LANGUAGES = new Set([
  'ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja',
  'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh',
]);

/**
 * Whether a cloned voice can actually be rendered in this language, so the UI can say so
 * up front instead of letting a user pick a voice that will quietly fall back mid-render.
 */
export function canCloneInLanguage(languageCode: string): boolean {
  const engines = installedCloneEngines();
  // `hinglish` is written in Latin script but spoken as Hindi, and both engines are fed
  // the spoken language rather than the script.
  const code = languageCode === 'hinglish' ? 'hi' : languageCode;
  if (engines.indicf5 && INDIC_LANGUAGES.has(code)) return true;
  if (engines.chatterbox && CHATTERBOX_LANGUAGES.has(code)) return true;
  return false;
}

/** How long one clip may take before we give up. Cloning on CPU is slow but not this slow; past this something has hung. */
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

export interface CloneRequest {
  text: string;
  /** Local path to the user's reference recording. */
  referenceAudioPath: string;
  /** What the reference recording says — IndicF5 requires it, Chatterbox ignores it. */
  referenceText?: string;
  languageCode: string;
}

/**
 * Synthesizes one clip and returns it as a WAV buffer.
 *
 * Throws on failure so the caller can decide what to do — the dub pipeline treats it as a
 * per-line failure and the router falls through to a catalog voice.
 */
export async function synthesizeClonedSpeech(request: CloneRequest): Promise<Buffer> {
  if (!isVoiceCloneAvailable()) {
    throw new Error('Voice cloning is not set up on this server (no engine installed in the venv)');
  }

  const jobDir = path.join(tmpDir, 'clone', randomUUID());
  await mkdir(jobDir, { recursive: true });
  const textPath = path.join(jobDir, 'text.txt');
  const outPath = path.join(jobDir, 'out.wav');
  // Written to a file rather than passed on the command line: Devanagari and Tamil
  // through a Windows argv is a reliable way to produce mojibake.
  await writeFile(textPath, request.text, 'utf8');

  try {
    const result = await runWorker([
      '--text-file', textPath,
      '--ref-audio', request.referenceAudioPath,
      '--ref-text', request.referenceText || '',
      '--language', request.languageCode === 'hinglish' ? 'hi' : request.languageCode,
      '--out', outPath,
    ]);
    if (!result.ok) throw new Error(result.error || 'Voice cloning failed');
    if (!existsSync(outPath)) throw new Error('Voice cloning produced no audio');
    return await readFile(outPath);
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface WorkerResult {
  ok: boolean;
  error?: string;
  engine?: string;
}

function runWorker(args: string[]): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(VENV_PYTHON, ['-W', 'ignore', WORKER_SCRIPT, ...args], {
      cwd: serverRoot,
      // The engines shell out to ffmpeg for decoding the reference clip.
      env: {
        ...process.env,
        PATH: `${path.dirname(ffmpegInstaller.path)}${path.delimiter}${process.env.PATH || ''}`,
        PYTHONIOENCODING: 'utf-8',
      },
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
      reject(new Error('Voice cloning timed out'));
    }, CLONE_TIMEOUT_MS);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.trim()) as WorkerResult);
      } catch {
        // The worker only ever prints JSON, so unparseable output means it died before
        // reaching its own error handling — surface the Python stderr instead.
        reject(new Error(`Voice cloning worker failed: ${stderrTail || stdout || 'no output'}`));
      }
    });
  });
}
