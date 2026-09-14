import type { Voice } from '../../src/types';
import { VOICES } from '../../src/data/mockData';

/** The four places a voice choice can come from, in the order they are consulted. */
export interface VoiceSelection {
  /** language -> speaker -> voice id */
  languageSpeakerVoiceMap?: Record<string, Record<string, string>>;
  /** language -> voice id */
  languageVoiceMap?: Record<string, string>;
  /** speaker -> voice id, applied whatever the language */
  speakerVoiceMap?: Record<string, string>;
  /** the project's single fallback voice */
  selectedVoiceId: string;
}

/**
 * Picks the voice for one line: the language it is being dubbed into, and who is speaking.
 *
 * Resolved most-specific-first, so a choice the user made about *this speaker in this
 * language* always beats a broader one. Each layer is optional and older projects only
 * have the last two, which is exactly what they had before per-language voices existed —
 * so they keep resolving to the same voice they always did.
 *
 * Note that a voice id is a *persona*, not a provider voice: the TTS clients resolve
 * "Charon" to a real Hindi or Spanish voice at synthesis time. Per-language selection is
 * therefore about deliberately choosing a *different* persona for a language, not about
 * making one work there.
 */
export function resolveVoiceId(selection: VoiceSelection, languageCode: string, speaker: string): string {
  return (
    selection.languageSpeakerVoiceMap?.[languageCode]?.[speaker] ||
    selection.languageVoiceMap?.[languageCode] ||
    selection.speakerVoiceMap?.[speaker] ||
    selection.selectedVoiceId
  );
}

/**
 * Same resolution, returning the voice itself. Falls back to the project's default voice
 * if an id no longer exists in the catalog (a stale saved project), so one removed voice
 * cannot fail a whole render.
 */
export function resolveVoice(
  selection: VoiceSelection,
  languageCode: string,
  speaker: string,
  /** Defaults to the built-in catalog; pass the user's catalog so their cloned voices resolve too. */
  catalog: Voice[] = VOICES
): Voice {
  const id = resolveVoiceId(selection, languageCode, speaker);
  return (
    catalog.find((v) => v.id === id) ||
    catalog.find((v) => v.id === selection.selectedVoiceId) ||
    catalog[0] ||
    VOICES[0]
  );
}
