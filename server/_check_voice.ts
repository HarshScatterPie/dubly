import { db } from './lib/firebaseAdmin';
import { toVoice, type StoredCustomVoice } from './lib/customVoices';
import { canSpaceCloneLanguage, isSpaceCloneConfigured } from './lib/spaceClone';
import { probeMedia } from './lib/ffmpeg';
import { bucket } from './lib/firebaseAdmin';
import { tmpDir } from './lib/paths';
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

async function main() {
  const users = await db.collection('users').listDocuments();
  for (const user of users) {
    const snap = await user.collection('voices').orderBy('createdAt', 'desc').get();
    if (snap.empty) continue;

    console.log(`user ${user.id}: ${snap.size} saved voice(s)\n`);
    for (const doc of snap.docs) {
      const v = doc.data() as StoredCustomVoice;
      console.log(`  id           : ${v.id}`);
      console.log(`  name         : ${v.name}`);
      console.log(`  gender       : ${v.gender}`);
      console.log(`  recorded in  : ${v.languageCode}`);
      console.log(`  transcript   : ${v.sampleTranscript ? JSON.stringify(v.sampleTranscript.slice(0, 90)) : '(EMPTY — STT did not run)'}`);
      console.log(`  created      : ${v.createdAt}`);

      // Is the sample actually in storage, and is it a usable reference clip?
      const [exists] = await bucket.file(v.sampleStoragePath).exists();
      console.log(`  sample file  : ${exists ? 'present' : 'MISSING'} at ${v.sampleStoragePath}`);
      if (exists) {
        const dir = path.join(tmpDir, 'voice-check');
        await mkdir(dir, { recursive: true });
        const local = path.join(dir, 'sample.wav');
        await bucket.file(v.sampleStoragePath).download({ destination: local });
        const probe = await probeMedia(local);
        console.log(`  duration     : ${probe.durationSeconds.toFixed(2)}s`);
        await rm(dir, { recursive: true, force: true });
      }

      const asVoice = toVoice(v);
      console.log(`  as a Voice   : provider=${asVoice.provider}, clone id=${asVoice.providerVoice.clone}`);
      console.log(`  Space set up : ${isSpaceCloneConfigured()}`);
      console.log(`  can speak hi : ${canSpaceCloneLanguage('hi')}   en: ${canSpaceCloneLanguage('en')}`);
      console.log('');
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
