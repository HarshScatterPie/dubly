// Release gate (npm run test:perf): one whole journey through the API with real ffmpeg, voice-activity and face detection,
// job machinery and a throwaway MongoDB; only Google's models are replaced, by instant fakes that count every call and
// play the ~10 requests/minute Gemini 2.5 TTS quota. It fails when a step re-buys model work it already paid for, or when
// processing time, main-thread stalls, API latency during a dub or memory exceed their budgets.
//
// PERF_VIDEO: a video with real speech (CI makes one with server/perf/make-video.sh).
// PERF_BUDGET_SCALE: multiplies every time budget (e.g. 2 on a slow machine); call budgets never scale.
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const state = {
    phase: 'setup',
    calls: [] as { phase: string; kind: string }[],
    geminiTtsAt: [] as number[],
    stages: [] as { at: number; message: string }[],
  };
  const WORDS = ['this', 'video', 'will', 'show', 'you', 'how', 'the', 'curry', 'cooks', 'step', 'by', 'step', 'and', 'why', 'it', 'tastes', 'great'];
  const DEVANAGARI = ['आज', 'हम', 'घर', 'पर', 'एक', 'आसान', 'सब्ज़ी', 'बनाना', 'सीखेंगे', 'सबसे', 'पहले', 'धोकर', 'टुकड़ों', 'में', 'काट', 'लीजिए'];
  const HINGLISH = ['aaj', 'hum', 'ghar', 'par', 'ek', 'easy', 'sabzi', 'banana', 'seekhenge', 'sabse', 'pehle', 'dhokar', 'chhote', 'pieces', 'mein'];
  const words = (dict: string[], chars: number, seed: number) => {
    const out: string[] = [];
    for (let i = seed, len = 0; len < chars; i++) {
      out.push(dict[i % dict.length]);
      len += dict[i % dict.length].length + 1;
    }
    return out.join(' ') + (dict === DEVANAGARI ? '।' : '.');
  };
  const usage = (input: number, output: number) => ({ promptTokenCount: Math.round(input), candidatesTokenCount: output, thoughtsTokenCount: 0 });
  const count = (kind: string) => state.calls.push({ phase: state.phase, kind });

  // Where the speech is in a 16 kHz mono WAV, by frame energy: the fake hears the test video's real speech.
  function speechIn(wav: Buffer) {
    let data = wav.subarray(44);
    for (let offset = 12; offset + 8 <= wav.length; ) {
      const size = wav.readUInt32LE(offset + 4);
      if (wav.toString('ascii', offset, offset + 4) === 'data') {
        data = wav.subarray(offset + 8, Math.min(wav.length, offset + 8 + size));
        break;
      }
      offset += 8 + size + (size % 2);
    }
    const voiced: boolean[] = [];
    for (let i = 0; i + 640 <= data.length; i += 640) {
      let sum = 0;
      for (let j = 0; j < 320; j++) sum += Math.abs(data.readInt16LE(i + j * 2));
      voiced.push(sum / 320 > 900);
    }
    const segments: { start: number; end: number }[] = [];
    let start = -1;
    let quiet = 0;
    voiced.forEach((v, k) => {
      if (v) {
        if (start < 0) start = k;
        quiet = 0;
      } else if (start >= 0 && ++quiet > 25) {
        segments.push({ start: start * 0.02, end: (k - quiet) * 0.02 });
        start = -1;
        quiet = 0;
      }
    });
    if (start >= 0) segments.push({ start: start * 0.02, end: voiced.length * 0.02 });
    return { seconds: data.length / 32000, segments: segments.filter((s) => s.end - s.start > 0.4) };
  }

  async function generateContent(request: { contents: unknown }) {
    const contents = request.contents as any;
    if (Array.isArray(contents)) {
      const parts = contents[0].parts as any[];
      if (String(parts[0]?.text ?? '').includes('dubbing director')) {
        count('gemini:review');
        const ids = parts.map((p) => /^Line "([^"]+)"/.exec(p.text ?? '')?.[1]).filter(Boolean);
        return { text: JSON.stringify({ lines: ids.map((id) => ({ id, ok: true })) }), usageMetadata: usage(2000, 20 * ids.length) };
      }
      count('gemini:transcribe');
      const { seconds, segments } = speechIn(Buffer.from(parts.filter((p) => p.inlineData).pop().inlineData.data, 'base64'));
      const body = {
        language: 'English',
        speakers: [
          { label: 'Speaker 1', gender: 'male', age: 'adult' },
          { label: 'Speaker 2', gender: 'female', age: 'adult' },
        ],
        segments: segments.map((s, k) => ({
          start: +s.start.toFixed(2),
          end: +s.end.toFixed(2),
          text: words(WORDS, Math.round((s.end - s.start) * 14), k * 3),
          speaker: k % 2 ? 'Speaker 2' : 'Speaker 1',
          delivery: 'calm and warm',
        })),
      };
      return { text: JSON.stringify(body), usageMetadata: usage(seconds * 32 + 600, segments.length * 45) };
    }
    const prompt = String(contents);
    if (prompt.startsWith('Convert each romanized Hinglish line')) {
      count('gemini:hinglish-script');
      const lines = JSON.parse(prompt.slice(prompt.indexOf('Lines:\n') + 7)) as { id: string; text: string }[];
      // Like the model, the answer for a line depends on the request it came in, so a line asked about twice can differ.
      return { text: JSON.stringify({ translations: lines.map((l, k) => ({ id: l.id, translatedText: words(DEVANAGARI, l.text.length, k) })) }), usageMetadata: usage(prompt.length / 3, lines.length * 25) };
    }
    if (prompt.includes('Return ONLY {"text"')) {
      count('gemini:condense');
      const line = JSON.parse(/Line: ("(?:[^"\\]|\\.)*")\s*$/.exec(prompt)![1]) as string;
      // Answers vary between attempts (temperature 0.2), as the real model's do.
      const dict = /[ऀ-ॿ]/.test(line) ? DEVANAGARI : HINGLISH;
      return { text: JSON.stringify({ text: words(dict, Math.floor(line.length * 0.7), Math.floor(Math.random() * 1000)) }), usageMetadata: usage(300, 25) };
    }
    if (prompt.includes('"translations"')) {
      count('gemini:translate');
      const target = /into (.+?)\.\n/.exec(prompt)?.[1] ?? '';
      const items = [...prompt.matchAll(/\{"id": ("(?:[^"\\]|\\.)*")[^\n]*?"text": ("(?:[^"\\]|\\.)*")\}/g)].map((m) => ({ id: JSON.parse(m[1]) as string, text: JSON.parse(m[2]) as string }));
      const dict = target.startsWith('Hinglish') ? HINGLISH : DEVANAGARI;
      return {
        text: JSON.stringify({ translations: items.map((it, k) => ({ id: it.id, translatedText: words(dict, Math.round(it.text.length * 0.9), k) })) }),
        usageMetadata: usage(prompt.length / 3, items.length * 30),
      };
    }
    count('gemini:other');
    return { text: '{}', usageMetadata: usage(100, 5) };
  }

  function tone(seconds: number, rate = 24000) {
    const frames = Math.round(seconds * rate);
    const pad = Math.round(0.05 * rate);
    const pcm = Buffer.alloc((frames + 2 * pad) * 2);
    for (let i = 0; i < frames; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 180 * i) / rate) * 6000 * (0.6 + 0.4 * Math.sin(i / 900))), (pad + i) * 2);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
  }

  // Cloud TTS: Gemini voices allow 10 requests a minute (as on the production project), Chirp 3 HD is unlimited.
  async function synthesizeSpeech(request: any) {
    const text = String(request.input?.text ?? '');
    if (request.voice?.modelName) {
      const now = Date.now();
      state.geminiTtsAt = state.geminiTtsAt.filter((t) => now - t < 60_000);
      if (state.geminiTtsAt.length >= 10) throw Object.assign(new Error('8 RESOURCE_EXHAUSTED: Quota exceeded for gemini-2.5-flash-tts'), { code: 8 });
      state.geminiTtsAt.push(now);
      count('tts:gemini');
      return [{ audioContent: tone(Math.max(0.6, text.length * 0.1)) }];
    }
    count('tts:chirp');
    return [{ audioContent: tone(Math.max(0.6, text.length * 0.07)) }];
  }

  const PERSONAS: [string, string][] = [['Charon', 'MALE'], ['Kore', 'FEMALE'], ['Puck', 'MALE'], ['Aoede', 'FEMALE'], ['Fenrir', 'MALE'], ['Leda', 'FEMALE'], ['Orus', 'MALE'], ['Zephyr', 'FEMALE']];
  const listVoices = async () => [{ voices: ['hi-IN', 'en-US', 'en-IN'].flatMap((lang) => PERSONAS.map(([n, g]) => ({ name: `${lang}-Chirp3-HD-${n}`, languageCodes: [lang], ssmlGender: g }))) }];
  return { state, generateContent, synthesizeSpeech, listVoices };
});

vi.mock('../lib/env', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/env')>();
  return { env: { ...original.env, ttsEngine: 'cloud', vertexProjectId: 'demo-perf' } };
});
vi.mock('../lib/credentials', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/credentials')>()), hasGoogleCredentials: () => true }));
// The voice and text caches start empty, so the first render pays for everything and the rest must not.
vi.mock('../lib/paths', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/paths')>();
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const scratch = path.join(tmpdir(), `dubly-perf-${process.pid}`);
  return { ...original, cacheDir: path.join(scratch, 'cache'), tmpDir: path.join(scratch, 'tmp') };
});
// Every progress message is timed where it is written, which is what a stage's duration is measured from.
vi.mock('../lib/jobs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/jobs')>();
  return {
    ...original,
    writeProjectForJob: (job: Parameters<typeof original.writeProjectForJob>[0], patch: Parameters<typeof original.writeProjectForJob>[1], jobPatch?: Parameters<typeof original.writeProjectForJob>[2]) => {
      if (patch?.currentProcessingMessage) fake.state.stages.push({ at: Date.now(), message: patch.currentProcessingMessage });
      return original.writeProjectForJob(job, patch, jobPatch);
    },
  };
});
vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/genai')>()),
  GoogleGenAI: class {
    models = { generateContent: fake.generateContent };
  },
}));
vi.mock('@google-cloud/text-to-speech', () => ({
  default: {
    TextToSpeechClient: class {
      synthesizeSpeech = fake.synthesizeSpeech;
      listVoices = fake.listVoices;
    },
  },
}));

import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createUser, resetEmulators, startApi, type TestApi, type TestUser } from '../test/helpers';
import { resetGeminiTtsStateForTests } from '../lib/googleTtsClient';
import { probeMedia } from '../lib/ffmpeg';
import { cacheDir } from '../lib/paths';

const scale = Number(process.env.PERF_BUDGET_SCALE) || 1;

interface PhaseResult {
  phase: string;
  seconds: number;
  calls: Record<string, number>;
  loopLagMs: { p99: number; max: number };
  api?: { requests: number; errors: number; failedStatuses?: number[]; p95Ms: number; maxMs: number };
  stages: { message: string; seconds: number }[];
}

let api: TestApi;
let user: TestUser;
const results: PhaseResult[] = [];
let peakRssMb = 0;
const rssSampler = setInterval(() => (peakRssMb = Math.max(peakRssMb, process.memoryUsage().rss / 2 ** 20)), 250);

beforeAll(async () => {
  api = await startApi();
  await resetEmulators();
  user = await createUser('perf@gate.test');
});
afterAll(async () => {
  clearInterval(rssSampler);
  await api.close();
  await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
});

// Light requests a person makes while their dub renders (polling, the project list, usage) at about the pace of three open
// tabs, well inside the per-user rate limit: what the rest of the app feels like meanwhile.
async function lightRequestsDuring<T>(work: Promise<T>, projectId: string) {
  const timings: number[] = [];
  const failures: number[] = [];
  let done = false;
  const finished = work.finally(() => (done = true));
  const paths = [`/api/projects/${projectId}/progress`, '/api/projects', '/api/usage'];
  await Promise.all(
    Array.from({ length: 3 }, async (_, worker) => {
      for (let k = worker; !done; k++) {
        const started = performance.now();
        const res = await api.call('GET', paths[k % paths.length], { token: user.token });
        timings.push(performance.now() - started);
        if (res.status >= 400) failures.push(res.status);
        await new Promise((r) => setTimeout(r, 1000));
      }
    })
  );
  const sorted = timings.sort((a, b) => a - b);
  return {
    result: await finished,
    api: {
      requests: sorted.length,
      errors: failures.length,
      ...(failures.length ? { failedStatuses: [...new Set(failures)] } : {}),
      p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
    },
  };
}

async function phase(name: string, run: () => Promise<PhaseResult['api'] | void>): Promise<PhaseResult> {
  fake.state.phase = name;
  fake.state.stages = [];
  // Each step starts in a fresh quota minute, as it would minutes apart in real use; leftover pauses would hide re-bought voices.
  fake.state.geminiTtsAt = [];
  resetGeminiTtsStateForTests();
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const started = Date.now();
  const apiResult = await run();
  const ended = Date.now();
  lag.disable();
  const fold = (m: string) => m.replace(/\(\d+\/\d+\)|\d+%|part \d+ of \d+|\d+ re-recorded|\d+ lines?/g, '#');
  const stages: PhaseResult['stages'] = [];
  fake.state.stages.forEach((s, k) => {
    const seconds = ((fake.state.stages[k + 1]?.at ?? ended) - s.at) / 1000;
    const last = stages[stages.length - 1];
    if (last && last.message === fold(s.message)) last.seconds += seconds;
    else stages.push({ message: fold(s.message), seconds });
  });
  const calls: Record<string, number> = {};
  for (const c of fake.state.calls) if (c.phase === name) calls[c.kind] = (calls[c.kind] ?? 0) + 1;
  const result: PhaseResult = {
    phase: name,
    seconds: (ended - started) / 1000,
    calls,
    loopLagMs: { p99: Math.round(lag.percentile(99) / 1e6), max: Math.round(lag.max / 1e6) },
    ...(apiResult ? { api: apiResult } : {}),
    stages,
  };
  results.push(result);
  return result;
}

it('dubs a video within its budgets and never pays twice for the same model work', { timeout: 60 * 60_000 }, async () => {
  const video = process.env.PERF_VIDEO;
  if (!video) throw new Error('Set PERF_VIDEO to a video with speech (server/perf/make-video.sh makes one).');
  const videoMinutes = (await probeMedia(video)).durationSeconds / 60;
  const id = (await api.call('POST', '/api/projects', { token: user.token, body: { title: 'Perf', sourceLanguage: 'en', targetLanguage: 'hi' } })).body.id as string;

  const followJob = async (jobId: string) => {
    for (;;) {
      const job = (await api.call('GET', `/api/projects/${id}/jobs/${jobId}`, { token: user.token })).body;
      if (job?.settled || ['completed', 'failed', 'partially_completed', 'cancelled'].includes(job?.status)) return job;
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  const dub = async (body: Record<string, unknown>) => {
    const res = await api.call('POST', `/api/projects/${id}/dub`, { token: user.token, body });
    expect(res.status).toBe(202);
    const { result, api: light } = await lightRequestsDuring(followJob(res.body.jobId), id);
    expect(result.status).toBe('completed');
    return light;
  };
  const project = async () => {
    const res = await api.call('GET', `/api/projects/${id}`, { token: user.token });
    if (res.status !== 200) throw new Error(`GET project answered ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
    return res.body;
  };
  const spokenLines = async (code: string) =>
    ((await project()).languageOutputs[code].localizedSegments as { translatedText: string }[]).filter((l) => l.translatedText.trim());

  const upload = await phase('upload', async () => {
    const form = new FormData();
    form.append('file', new Blob([await readFile(video)], { type: 'video/mp4' }), 'perf.mp4');
    const res = await fetch(`${api.baseUrl}/api/projects/${id}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
    expect(res.status).toBe(200);
  });
  const transcribe = await phase('transcribe', async () => {
    const res = await api.call('POST', `/api/projects/${id}/transcribe`, { token: user.token, headers: { Prefer: 'respond-async' } });
    expect(res.status).toBe(202);
    const { result, api: light } = await lightRequestsDuring(followJob(res.body.jobId), id);
    expect(result.status).toBe('completed');
    return light;
  });
  const translate = await phase('translate Hindi', async () => {
    expect((await api.call('POST', `/api/projects/${id}/translate`, { token: user.token, body: { targetLanguageCodes: ['hi'] } })).status).toBe(200);
  });
  const firstDub = await phase('dub Hindi', () => dub({ languages: ['hi'] }));
  const redub = await phase('re-dub Hindi, nothing changed', () => dub({ languages: ['hi'] }));
  // What the studio sends when one more language is ticked: the languages already translated are kept.
  const addLanguage = await phase('add Hinglish', async () => {
    expect((await api.call('POST', `/api/projects/${id}/translate`, { token: user.token, body: { targetLanguageCodes: ['hi', 'hinglish'], regenerate: false } })).status).toBe(200);
  });
  const hinglishDub = await phase('dub Hinglish', () => dub({ languages: ['hinglish'] }));
  const hinglishLines = await spokenLines('hinglish');
  const retake = await phase('retake one edited Hinglish line', async () => {
    const lines = (await project()).languageOutputs.hinglish.localizedSegments as { translatedText: string; isEdited?: boolean }[];
    const edited = lines.find((l) => l.translatedText.trim())!;
    edited.translatedText = `${edited.translatedText} theek hai`;
    edited.isEdited = true;
    expect((await api.call('PATCH', `/api/projects/${id}/languages/hinglish/segments`, { token: user.token, body: { localizedSegments: lines } })).status).toBe(200);
    const res = await api.call('POST', `/api/projects/${id}/languages/hinglish/retake`, { token: user.token });
    expect(res.status).toBe(202);
    const { result, api: light } = await lightRequestsDuring(followJob(res.body.jobId), id);
    expect(result.status).toBe('completed');
    return light;
  });

  const calls = (p: PhaseResult, prefix = '') => Object.entries(p.calls).filter(([k]) => k.startsWith(prefix)).reduce((sum, [, n]) => sum + n, 0);
  const violations: string[] = [];
  const atMost = (label: string, value: number, budget: number, unit = '') => {
    if (value > budget) violations.push(`${label}: ${+value.toFixed(2)}${unit} > budget ${+budget.toFixed(2)}${unit}`);
  };

  // Model work: exact budgets, the same on every machine.
  atMost('transcription requests', calls(transcribe, 'gemini:transcribe'), Math.ceil((videoMinutes * 60) / 28) + 1);
  atMost('translation requests for one language', calls(translate, 'gemini:'), 1);
  atMost('model requests re-dubbing with nothing changed', calls(redub), 0);
  atMost('translation requests adding one language', calls(addLanguage, 'gemini:'), 1);
  atMost('Hinglish script requests', calls(hinglishDub, 'gemini:hinglish-script'), Math.ceil(hinglishLines.length / 150) + calls(hinglishDub, 'gemini:condense'));
  atMost('voice requests retaking one line', calls(retake, 'tts:'), 3);
  atMost('text-model requests retaking one line', calls(retake, 'gemini:'), 4);
  atMost('voices for the first dub', calls(firstDub, 'tts:'), 2 * (await spokenLines('hi')).length);

  // Time and responsiveness: per minute of video, scaled by PERF_BUDGET_SCALE.
  atMost('upload', upload.seconds / videoMinutes, 10 * scale, ' s per video minute');
  atMost('transcription', transcribe.seconds / videoMinutes, 12 * scale, ' s per video minute');
  for (const p of [firstDub, redub, hinglishDub, retake]) atMost(`${p.phase}`, p.seconds / videoMinutes, 45 * scale, ' s per video minute');
  for (const p of results) {
    atMost(`${p.phase}: longest main-thread stall`, p.loopLagMs.max, 1500 * scale, ' ms');
    // The upload step also includes this test reading and posting the whole video from the same process.
    atMost(`${p.phase}: main-thread stall p99`, p.loopLagMs.p99, 400 * scale, ' ms');
    if (p.api) {
      atMost(`${p.phase}: failed light requests${p.api.failedStatuses ? ` (HTTP ${p.api.failedStatuses.join(', ')})` : ''}`, p.api.errors, 0);
      atMost(`${p.phase}: light request p95`, p.api.p95Ms, 1000 * scale, ' ms');
    }
  }
  atMost('peak memory', peakRssMb, 2048, ' MB');

  const summary = { videoMinutes: +videoMinutes.toFixed(2), peakRssMb: Math.round(peakRssMb), budgetScale: scale, violations, phases: results };
  if (process.env.PERF_RESULT) await writeFile(process.env.PERF_RESULT, JSON.stringify(summary, null, 1));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown(summary));
  console.log(markdown(summary));
  expect(violations).toEqual([]);
});

function markdown(s: { videoMinutes: number; peakRssMb: number; violations: string[]; phases: PhaseResult[] }): string {
  const rows = s.phases.map((p) => {
    const calls = Object.entries(p.calls).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    const light = p.api ? `${p.api.p95Ms} / ${p.api.maxMs} ms (${p.api.requests} req, ${p.api.errors} failed)` : '';
    return `| ${p.phase} | ${p.seconds.toFixed(1)} s | ${calls} | ${p.loopLagMs.p99} / ${p.loopLagMs.max} ms | ${light} |`;
  });
  const slowest = s.phases
    .flatMap((p) => p.stages.map((st) => ({ ...st, phase: p.phase })))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 8)
    .map((st) => `| ${st.phase} | ${st.message.replace(/\|/g, '/')} | ${st.seconds.toFixed(1)} s |`);
  return [
    `## Release gate: pipeline performance (${s.videoMinutes} min video, peak memory ${s.peakRssMb} MB)`,
    s.violations.length ? `**Over budget:**\n${s.violations.map((v) => `- ${v}`).join('\n')}` : '**All budgets met.**',
    '',
    '| Step | Time | Model calls | Main-thread stall p99 / max | Light requests p95 / max during it |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '| Step | Slowest stages | Time |',
    '|---|---|---|',
    ...slowest,
    '',
  ].join('\n');
}
