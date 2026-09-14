import { readFile } from 'node:fs/promises';
import { env } from './env';

/**
 * Voice cloning through a Hugging Face ZeroGPU Space.
 *
 * Same model as the local path (Chatterbox), the difference is where it runs. On this
 * project's dev machine — a 15W laptop CPU with no CUDA — cloning renders at roughly
 * realtime, which makes a multi-language dub unusable. A ZeroGPU Space runs it on a
 * Blackwell GPU for free, with no allow-list and no per-character bill.
 *
 * Deliberately spoken to over its plain HTTP API rather than through a Gradio client:
 * the Space exposes a base64-in/base64-out function, so this is two fetches and no new
 * dependency, no multipart upload dance, and nothing to keep in sync with Gradio's
 * client releases.
 */
const SPACE_TIMEOUT_MS = 4 * 60 * 1000;

export function isSpaceCloneConfigured(): boolean {
  return Boolean(env.hfSpaceUrl);
}

/**
 * Languages the Space's Chatterbox model can speak. Mirrors the SUPPORTED set in
 * `hf-space/app.py` — kept here too so the router can decide without paying for a
 * round trip to find out.
 */
const SUPPORTED = new Set([
  'ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja',
  'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh',
]);

export function canSpaceCloneLanguage(languageCode: string): boolean {
  return SUPPORTED.has(languageCode === 'hinglish' ? 'hi' : languageCode);
}

export interface SpaceCloneRequest {
  text: string;
  referenceAudioPath: string;
  languageCode: string;
}

/**
 * Synthesizes one line and returns it as a WAV buffer.
 *
 * Gradio's HTTP API is a two-step: POST the arguments to get an event id, then GET that
 * event as a server-sent stream. It is done by hand here because the payload is small
 * and the alternative is a dependency that exists to hide exactly these two calls.
 */
export async function synthesizeViaSpace(request: SpaceCloneRequest): Promise<Buffer> {
  const base = env.hfSpaceUrl?.replace(/\/+$/, '');
  if (!base) throw new Error('No Hugging Face Space is configured (set HF_SPACE_URL)');

  const language = request.languageCode === 'hinglish' ? 'hi' : request.languageCode;
  if (!SUPPORTED.has(language)) {
    throw new Error(`The cloning Space cannot speak '${language}'`);
  }

  const reference = (await readFile(request.referenceAudioPath)).toString('base64');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Without a token the call lands in the stricter anonymous pool; with one it draws on
  // this account's own daily quota and gets better queue priority. Private Spaces
  // require it outright.
  if (env.hfToken) headers.Authorization = `Bearer ${env.hfToken}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPACE_TIMEOUT_MS);

  try {
    // Gradio 5 moved the HTTP API under /gradio_api; 4 served it at the root. Both are
    // tried so the Space can be upgraded without this needing to know.
    const prefixes = ['/gradio_api/call/clone', '/call/clone'];
    let eventId: string | undefined;
    let prefix = prefixes[0];
    let lastError = '';

    for (const candidate of prefixes) {
      const started = await fetch(`${base}${candidate}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ data: [request.text, reference, language] }),
        signal: controller.signal,
      });
      if (started.ok) {
        ({ event_id: eventId } = (await started.json()) as { event_id?: string });
        prefix = candidate;
        break;
      }
      lastError = `${started.status}: ${(await started.text()).slice(0, 200)}`;
      // Only a missing route is worth retrying at the other path; anything else is a real
      // failure (asleep Space, bad token, out of quota) and retrying just hides it.
      if (started.status !== 404) break;
    }

    if (!eventId) throw new Error(`Space rejected the request (${lastError || 'no event id'})`);

    const stream = await fetch(`${base}${prefix}/${eventId}`, {
      headers,
      signal: controller.signal,
    });
    if (!stream.ok) {
      throw new Error(`Space stream failed (${stream.status}): ${(await stream.text()).slice(0, 200)}`);
    }

    const payload = parseGradioEventStream(await stream.text());
    // The Space reports failures as a string rather than throwing, so a real reason
    // reaches the user instead of an opaque 500.
    if (payload.startsWith('ERROR: ')) throw new Error(payload.slice(7));
    if (!payload) throw new Error('Space returned no audio');
    return Buffer.from(payload, 'base64');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pulls the result out of Gradio's SSE response.
 *
 * The stream carries progress events too, so this takes the payload of the last `complete`
 * event and unwraps Gradio's one-element array.
 */
function parseGradioEventStream(body: string): string {
  let complete: string | null = null;
  let currentEvent = '';

  for (const rawLine of body.split(/\r?\n/)) {
    if (rawLine.startsWith('event:')) {
      currentEvent = rawLine.slice(6).trim();
      continue;
    }
    if (!rawLine.startsWith('data:')) continue;
    const data = rawLine.slice(5).trim();

    if (currentEvent === 'error') {
      throw new Error(`Space errored: ${data.slice(0, 300)}`);
    }
    if (currentEvent === 'complete') complete = data;
  }

  if (complete === null) throw new Error('Space stream ended without a result');
  try {
    const parsed = JSON.parse(complete);
    return Array.isArray(parsed) ? String(parsed[0] ?? '') : String(parsed ?? '');
  } catch {
    return complete;
  }
}
