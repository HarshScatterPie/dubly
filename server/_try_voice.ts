/**
 * Speaks with the user's actual saved voice, through the same router the dub pipeline
 * uses — reference loader, provider routing, TTS cache and all. If this works, the
 * "Try it" button and a real render both work.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { db } from './lib/firebaseAdmin';
import { createReferenceLoader, toVoice, type StoredCustomVoice } from './lib/customVoices';
import { routeSynthesizeSpeech } from './lib/modelRouter';
import { getWavDurationSeconds } from './lib/audioUtils';
import { tmpDir } from './lib/paths';

async function main() {
  const users = await db.collection('users').listDocuments();
  let stored: StoredCustomVoice | null = null;
  let uid = '';
  for (const user of users) {
    const snap = await user.collection('voices').orderBy('createdAt', 'desc').limit(1).get();
    if (!snap.empty) {
      stored = snap.docs[0].data() as StoredCustomVoice;
      uid = user.id;
      break;
    }
  }
  if (!stored) throw new Error('no saved voice found');

  console.log(`voice: ${stored.name} (${stored.id})\n`);
  const voice = toVoice(stored);
  const workDir = path.join(tmpDir, 'try-voice');
  await mkdir(workDir, { recursive: true });
  const loadReference = createReferenceLoader(uid, workDir);

  try {
    const reference = await loadReference(stored.id);
    console.log(`reference downloaded -> ${path.basename(reference.audioPath)}`);
    console.log(`reference transcript : ${reference.transcript ? 'present' : 'none'}\n`);

    for (const [language, text] of [
      ['en', 'Hello, this is my own cloned voice speaking English.'],
      ['hi', 'नमस्ते, यह मेरी अपनी आवाज़ हिंदी बोल रही है।'],
    ] as const) {
      process.stdout.write(`${language}: `);
      const started = Date.now();
      try {
        const { audio, provider, fromCache } = await routeSynthesizeSpeech(
          text,
          voice,
          language,
          'auto',
          reference
        );
        const out = path.join(tmpDir, `try_${language}.wav`);
        writeFileSync(out, audio);
        console.log(
          `OK via ${provider}${fromCache ? ' (cached)' : ''} — ` +
            `${getWavDurationSeconds(audio).toFixed(2)}s of audio in ${((Date.now() - started) / 1000).toFixed(1)}s`
        );
        console.log(`     saved to ${out}`);
      } catch (err) {
        console.log(`FAILED\n     ${(err as Error).message.slice(0, 300)}`);
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
