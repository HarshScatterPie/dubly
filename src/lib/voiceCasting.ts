import type { SpeakerProfile, TranscriptSegment, Voice } from '../types';
import { VOICES } from '../data/mockData';

// The gender of whoever talks most, by speaking time; undefined when analysis could not tell.
export function mainSpeakerGender(segments: TranscriptSegment[], profiles: Record<string, SpeakerProfile> | undefined): 'male' | 'female' | undefined {
  if (!profiles) return undefined;
  const seconds = new Map<string, number>();
  for (const s of segments) {
    if (!s.text.trim()) continue;
    const speaker = s.speaker || 'Speaker 1';
    seconds.set(speaker, (seconds.get(speaker) ?? 0) + Math.max(0, s.endTime - s.startTime));
  }
  const main = [...seconds].sort((a, b) => b[1] - a[1])[0]?.[0];
  const gender = main ? profiles[main]?.gender : undefined;
  return gender === 'male' || gender === 'female' ? gender : undefined;
}

// A starting voice for a language: native to it and, when known, of the main speaker's gender (every persona speaks every language).
export function defaultVoiceFor(languageCode: string, gender?: 'male' | 'female', catalog: Voice[] = VOICES): Voice | undefined {
  const native = catalog.filter((v) => v.provider !== 'clone' && v.languageCode === languageCode);
  if (!gender) return native[0];
  return native.find((v) => v.gender === gender) ?? catalog.find((v) => v.provider !== 'clone' && v.gender === gender) ?? native[0];
}
