import type { VoiceEmotion } from '../../src/types';

const EMOTION_DIRECTION: Record<VoiceEmotion, string> = {
  neutral: 'clear, even and neutral',
  friendly: 'warm, friendly and conversational',
  energetic: 'energetic and enthusiastic',
  professional: 'confident, polished and professional',
  empathetic: 'gentle, caring and empathetic',
};

export const MAX_DELIVERY_LENGTH = 80;

// Delivery notes come from the transcription model or a user, so they are flattened and bounded before reaching a prompt.
export function cleanDelivery(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_DELIVERY_LENGTH).trim();
  return text || undefined;
}

// The style prompt for one line: the project's overall voice, then the original line's own delivery, which wins where they differ.
export function buildStylePrompt(emotion: VoiceEmotion | undefined, delivery: string | undefined): string {
  const parts: string[] = [];
  const direction = emotion ? EMOTION_DIRECTION[emotion] : undefined;
  if (direction) parts.push(`Speak in a ${direction} voice.`);
  const note = cleanDelivery(delivery);
  if (note) parts.push(`This line is a dub of an original delivered as: ${note}. Match that delivery.`);
  if (parts.length === 0) return '';
  // Leading or trailing silence would eat into the line's slot on the timeline.
  parts.push('Do not add pauses before or after the line.');
  return parts.join(' ');
}

// A line this much longer than its room is sped up audibly by the stitcher (lineReview.RUSHED_RATIO).
const PACE_UP_RATIO = 1.15;
// A line this much shorter than the original leaves the speaker's mouth moving in silence.
const PACE_DOWN_RATIO = 0.6;
const PACE_DOWN_MIN_SLOT_SECONDS = 1.5;

export interface PaceRequest {
  // Appended to the line's style prompt for a second take.
  direction: string;
  // Whether the new take (seconds as it will play) is better than the first.
  accept: (newSeconds: number, firstSeconds: number) => boolean;
}

// A pace note for a take that does not fit its slot, since a voice that speeds up sounds natural and stretched audio does not; `rawPerPlayed` maps played seconds back to the voice's own.
export function paceRequest(playedSeconds: number, slotSeconds: number, availableSeconds: number, rawPerPlayed = 1): PaceRequest | null {
  if (playedSeconds <= 0) return null;
  if (playedSeconds > availableSeconds * PACE_UP_RATIO) {
    const target = availableSeconds * rawPerPlayed;
    return {
      direction: `Speak briskly, without sounding rushed, so the whole line takes about ${target.toFixed(1)} seconds.`,
      accept: (next, first) => next < first,
    };
  }
  if (slotSeconds >= PACE_DOWN_MIN_SLOT_SECONDS && playedSeconds < slotSeconds * PACE_DOWN_RATIO) {
    const target = slotSeconds * rawPerPlayed;
    return {
      direction: `Take your time: speak at a relaxed, measured pace so the line takes about ${target.toFixed(1)} seconds.`,
      accept: (next, first) => next > first && next <= availableSeconds,
    };
  }
  return null;
}
