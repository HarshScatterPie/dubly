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
