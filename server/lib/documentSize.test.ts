import { describe, expect, it } from 'vitest';
import { withTransaction } from './mongo';
import { documentBytes, insertPlan, loadProject, MONGO_MAX_DOCUMENT_BYTES, planProjectWrite, deleteProjectDocuments } from './projectStorage';
import type { StoredProject } from './projectRepo';

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

// A dubbed project as stored: 150 words/min in 12-word lines with word timings, Indic translations, primary language stored twice.
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

const WORKSPACE = 'ws-00000000-0000-0000-0000-000000000000';
const PROJECT = 'proj-00000000-0000-0000-0000-000000000000';

describe("project document size against MongoDB's 16 MiB limit", () => {
  const rows: string[] = [];
  const scenarios = [30, 60].flatMap((minutes) => [1, 3, 5, 10].map((languages) => ({ minutes, languages })));

  it.each(scenarios)('$minutes-minute video, $languages language(s), split layout', ({ minutes, languages }) => {
    const data = realisticProject(minutes, languages) as unknown as StoredProject;
    const plan = planProjectWrite(WORKSPACE, PROJECT, undefined, data);
    const sizes = [documentBytes(plan.project), ...plan.parts.map((part) => documentBytes(part as unknown as Record<string, unknown>))];
    const largest = Math.max(...sizes);
    const allInOne = documentBytes(data as unknown as Record<string, unknown>);
    rows.push(
      `${String(minutes).padStart(2)} min | ${String(languages).padStart(2)} lang | all-in-one ${(allInOne / 1024).toFixed(0).padStart(5)} KiB | largest split doc ${(largest / 1024).toFixed(0).padStart(4)} KiB (${((largest / MONGO_MAX_DOCUMENT_BYTES) * 100).toFixed(1)}%)`
    );
    // Every document of the largest allowed project stays far under the limit.
    expect(largest).toBeLessThan(MONGO_MAX_DOCUMENT_BYTES * 0.1);
  });

  it('prints the table', () => {
    console.log(['', 'Project documents vs the 16 MiB MongoDB limit', ...rows, ''].join(String.fromCharCode(10)));
  });

  it('writes and reads back the largest allowed project (60 min, 10 languages) unchanged', async () => {
    const data = realisticProject(60, 10) as unknown as StoredProject;
    await withTransaction(async (session) => {
      await deleteProjectDocuments(WORKSPACE, PROJECT, session);
      await insertPlan(WORKSPACE, PROJECT, planProjectWrite(WORKSPACE, PROJECT, undefined, data), session);
    });
    const loaded = await loadProject(WORKSPACE, PROJECT);
    expect(loaded?.transcriptSegments).toEqual(data.transcriptSegments);
    expect(loaded?.languageOutputs?.ta.localizedSegments).toEqual(data.languageOutputs?.ta.localizedSegments);
    await withTransaction((session) => deleteProjectDocuments(WORKSPACE, PROJECT, session));
  });
});
