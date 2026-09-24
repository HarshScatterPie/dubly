import { createHash } from 'node:crypto';
import type { DubbingProject, LocalizedSegment, RetakeInfo } from '../../src/types';
import { resolveVoiceId, type VoiceSelection } from './voiceResolution';
import { projectLanguages, segmentsForLanguage, type StoredProject } from './projectRepo';

// A retake still re-stitches and re-muxes the whole language, so even a one-word fix costs at least this much.
export const RETAKE_MIN_SECONDS = 6;
// Usage is kept in tenths of a minute (projectRepo.roundMinutes), so a retake is priced in whole tenths and the quote is what gets charged.
const BILLING_STEP_SECONDS = 6;

type VoiceSettings = Pick<StoredProject, 'voiceEmotion' | 'voiceSpeed' | 'voicePitch'>;

export function voiceSelectionOf(stored: Pick<StoredProject, 'languageSpeakerVoiceMap' | 'languageVoiceMap' | 'speakerVoiceMap' | 'selectedVoiceId'>): VoiceSelection {
  return {
    languageSpeakerVoiceMap: stored.languageSpeakerVoiceMap,
    languageVoiceMap: stored.languageVoiceMap,
    speakerVoiceMap: stored.speakerVoiceMap,
    selectedVoiceId: stored.selectedVoiceId,
  };
}

// Everything the user controls that changes how a line sounds; two equal keys mean the rendered audio is still current.
export function lineRenderKey(seg: Pick<LocalizedSegment, 'translatedText' | 'delivery'>, voiceId: string, settings: VoiceSettings): string {
  const parts = [seg.translatedText.trim(), seg.delivery ?? '', voiceId, settings.voiceEmotion ?? '', settings.voiceSpeed ?? 1, settings.voicePitch ?? 1];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}

export function currentLineKey(stored: StoredProject, languageCode: string, seg: LocalizedSegment): string {
  return lineRenderKey(seg, resolveVoiceId(voiceSelectionOf(stored), languageCode, seg.speaker), stored);
}

function renderedVideoPath(stored: StoredProject, languageCode: string): string | undefined {
  return languageCode === stored.targetLanguage ? stored.finalDubbedVideoStoragePath : stored.languageOutputs?.[languageCode]?.finalDubbedVideoStoragePath;
}

// The lines of a rendered language that changed since its render, and their cost; null when there is no fingerprinted render to compare against.
export function retakePlan(stored: StoredProject, languageCode: string): RetakeInfo | null {
  if (!renderedVideoPath(stored, languageCode)) return null;
  const segments = segmentsForLanguage(stored, languageCode);
  // Renders made before fingerprints existed have nothing to compare against; those languages are re-dubbed as a whole.
  if (!segments.some((s) => s.renderKey)) return null;
  const changed = segments.filter((s) => s.renderKey !== currentLineKey(stored, languageCode, s));
  const seconds = changed.reduce((sum, s) => sum + Math.max(0, s.endTime - s.startTime), 0);
  const fullMinutes = stored.videoDuration / 60;
  const billedSeconds = Math.ceil(Math.max(seconds, RETAKE_MIN_SECONDS) / BILLING_STEP_SECONDS) * BILLING_STEP_SECONDS;
  const minutes = changed.length ? Math.min(fullMinutes, billedSeconds / 60) : 0;
  return { changedLineIds: changed.map((s) => s.id), seconds, minutes };
}

// Adds each language's pending edits to a single-project response; the project list skips it, as it hashes every line.
export function withRetakeInfo(client: DubbingProject, stored: StoredProject): DubbingProject {
  const entries = projectLanguages(stored).flatMap((code) => {
    const plan = retakePlan(stored, code);
    return plan && plan.changedLineIds.length ? [[code, plan] as const] : [];
  });
  return entries.length ? { ...client, retakeInfo: Object.fromEntries(entries) } : client;
}
