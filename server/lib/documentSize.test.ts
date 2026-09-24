import { describe, expect, it } from 'vitest';
import { FIRESTORE_MAX_DOCUMENT_BYTES, firestoreDocumentSize, firestoreValueSize } from './documentSize';
import { db } from './firebaseAdmin';
import { applyPlan, loadProject, planProjectWrite } from './projectStorage';
import type { StoredProject } from './projectRepo';

describe('firestoreValueSize follows the documented rules', () => {
  it('sizes primitives, maps and arrays', () => {
    expect(firestoreValueSize('abc')).toBe(4);
    expect(firestoreValueSize('नमस्ते')).toBe(Buffer.byteLength('नमस्ते') + 1);
    expect(firestoreValueSize(3.14)).toBe(8);
    expect(firestoreValueSize(true)).toBe(1);
    expect(firestoreValueSize(null)).toBe(1);
    expect(firestoreValueSize({ a: 1, b: 'x' })).toBe(2 + 8 + 2 + 2);
    expect(firestoreValueSize([1, 2, 'xy'])).toBe(8 + 8 + 3);
    expect(firestoreValueSize({ a: undefined })).toBe(0);
  });
});

// Deterministic pseudo-random text so the measurement is repeatable.
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const EN = 'the and you that was for are with this have from they will would there their what about which when make can like time just know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most'.split(' ');
const DEVANAGARI = 'कखगघचछजझटठडढणतथदधनपफबभमयरलवशषसह';
const MATRAS = 'ािीुूेैोौं';

function englishLine(rand: () => number, words: number): string {
  return Array.from({ length: words }, () => EN[Math.floor(rand() * EN.length)]).join(' ');
}
function hindiLine(rand: () => number, words: number): string {
  return Array.from({ length: words }, () =>
    Array.from({ length: 2 + Math.floor(rand() * 3) }, () => DEVANAGARI[Math.floor(rand() * DEVANAGARI.length)] + (rand() < 0.6 ? MATRAS[Math.floor(rand() * MATRAS.length)] : '')).join('')
  ).join(' ');
}

/**
 * A project as the pipeline stores it after dubbing: 150 spoken words a minute in ~12-word lines with per-word timings, and
 * every target language translated into an Indic script (3 bytes a character, the heaviest case Dubly serves). The primary
 * language's segments are stored twice, at the top level and in languageOutputs, exactly as projects.ts/dub.ts do.
 */
export function realisticProject(minutes: number, languageCount: number): Record<string, unknown> {
  const rand = rng(minutes * 100 + languageCount);
  const totalWords = minutes * 150;
  const segmentCount = Math.ceil(totalWords / 12);
  const segLen = (minutes * 60) / segmentCount;
  const transcriptSegments = Array.from({ length: segmentCount }, (_, i) => {
    const text = englishLine(rand, 12);
    const startTime = i * segLen;
    const words = text.split(' ').map((w, k) => ({ text: w, start: startTime + k * (segLen / 12), end: startTime + (k + 1) * (segLen / 12) }));
    return { id: `seg-${i + 1}`, startTime, endTime: startTime + segLen, text, speaker: `Speaker ${1 + (i % 2)}`, wordsCount: 12, confidence: 0.93, words };
  });
  const languages = ['hi', 'ta', 'bn', 'mr', 'te', 'gu', 'kn', 'ml', 'pa', 'or'].slice(0, languageCount);
  const localized = (code: string) =>
    transcriptSegments.map((s) => ({
      id: `loc-${code}-${s.id}`,
      segmentId: s.id,
      startTime: s.startTime,
      endTime: s.endTime,
      speaker: s.speaker,
      sourceText: s.text,
      translatedText: hindiLine(rand, 12),
      isEdited: false,
    }));
  const languageOutputs = Object.fromEntries(
    languages.map((code) => [
      code,
      {
        languageCode: code,
        localizedSegments: localized(code),
        status: 'completed',
        progressPercent: 100,
        wordsCount: totalWords,
        dubbedAudioStoragePath: `workspaces/ws-00000000-0000-0000-0000-000000000000/projects/proj-00000000-0000-0000-0000-000000000000/dubbed_audio_${code}.wav`,
        finalDubbedVideoStoragePath: `workspaces/ws-00000000-0000-0000-0000-000000000000/projects/proj-00000000-0000-0000-0000-000000000000/dubbed_${code}.mp4`,
      },
    ])
  );
  return {
    id: 'proj-00000000-0000-0000-0000-000000000000',
    ownerUid: 'u'.repeat(28),
    title: 'Quarterly all-hands recording',
    transcriptSegments,
    localizedSegments: (languageOutputs[languages[0]] as { localizedSegments: unknown[] }).localizedSegments,
    languageOutputs,
    targetLanguages: languages,
    targetLanguage: languages[0],
    status: 'completed',
  };
}

const PATH = 'workspaces/ws-00000000-0000-0000-0000-000000000000/projects/proj-00000000-0000-0000-0000-000000000000';

describe('project document size (P1-7 measurement)', () => {
  const rows: string[] = [];
  const scenarios = [30, 60].flatMap((minutes) => [1, 3, 5, 10].map((languages) => ({ minutes, languages })));

  it.each(scenarios)('$minutes-minute video, $languages language(s)', async ({ minutes, languages }) => {
    const data = realisticProject(minutes, languages);
    const bytes = firestoreDocumentSize(PATH, data);
    // Written to the emulator too, which enforces the same 1 MiB ceiling as production (far-over documents are not sent).
    const written =
      bytes > FIRESTORE_MAX_DOCUMENT_BYTES * 1.2
        ? 'not sent (far over)'
        : await db.doc(`measure/${minutes}m-${languages}l`).set(data).then(
            () => 'written',
            (err: Error) => `REJECTED (${err.message.split('\n')[0].slice(0, 60)})`
          );
    const pct = ((bytes / FIRESTORE_MAX_DOCUMENT_BYTES) * 100).toFixed(0);
    rows.push(`${String(minutes).padStart(2)} min | ${String(languages).padStart(2)} lang | ${(bytes / 1024).toFixed(0).padStart(5)} KiB | ${pct.padStart(3)}% of limit | emulator: ${written}`);
    expect(bytes).toBeGreaterThan(0);
    if (bytes < FIRESTORE_MAX_DOCUMENT_BYTES * 0.98) expect(written).toBe('written');
  });

  it('prints the table', () => {
    console.log(`\nProject document size vs the 1 MiB Firestore limit (all-in-one layout)\n${rows.join('\n')}\n`);
  });

  it('keeps every document of the split layout under the limit at the largest allowed size (60 min, 10 languages)', async () => {
    const data = realisticProject(60, 10) as unknown as StoredProject;
    const ref = db.doc(PATH);
    const plan = planProjectWrite(ref, undefined, data);
    const sizes = [
      { path: ref.path, bytes: firestoreDocumentSize(ref.path, plan.project) },
      ...plan.parts.map((p) => ({ path: p.ref.path, bytes: firestoreDocumentSize(p.ref.path, p.data) })),
    ];
    const largest = sizes.reduce((a, b) => (b.bytes > a.bytes ? b : a));
    console.log(
      `\nSplit layout, 60 min x 10 languages: ${sizes.length} documents, largest ${largest.path.split('/').slice(-2).join('/')} = ${(largest.bytes / 1024).toFixed(0)} KiB (${((largest.bytes / FIRESTORE_MAX_DOCUMENT_BYTES) * 100).toFixed(0)}% of limit)\n`
    );
    expect(largest.bytes).toBeLessThan(FIRESTORE_MAX_DOCUMENT_BYTES * 0.6);
    await db.runTransaction(async (tx) => applyPlan(tx, ref, plan));
    const loaded = await loadProject(ref);
    expect(loaded?.transcriptSegments).toEqual(data.transcriptSegments);
    expect(loaded?.languageOutputs?.ta.localizedSegments).toEqual(data.languageOutputs?.ta.localizedSegments);
  });
});
