import type { LocalizedSegment } from '../../src/types';

// Mirrors the client-side karaoke chunking in VideoPlayer.tsx so a burned-in caption
// visually matches what was shown in the live preview.
const WORDS_PER_CARD = 9;

function toAssTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${c.toString().padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

/**
 * Per-word timing within a segment, estimated proportionally to character length across
 * the segment's real [start,end] window — the same approximation used client-side for
 * the live karaoke preview (translated text has no per-word STT timestamps of its own).
 */
function estimateWordTimings(text: string, start: number, end: number) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const totalChars = words.reduce((sum, w) => sum + w.length, 0) || words.length;
  const duration = Math.max(0.1, end - start);
  let cursor = start;
  return words.map((w) => {
    const share = (Math.max(1, w.length) / totalChars) * duration;
    const wordStart = cursor;
    const wordEnd = Math.min(end, cursor + share);
    cursor = wordEnd;
    return { text: w, start: wordStart, end: wordEnd };
  });
}

function buildCardEvents(seg: LocalizedSegment): string[] {
  const timed = estimateWordTimings(seg.translatedText, seg.startTime, seg.endTime);
  if (timed.length === 0) return [];

  const events: string[] = [];
  for (let i = 0; i < timed.length; i += WORDS_PER_CARD) {
    const card = timed.slice(i, i + WORDS_PER_CARD);
    const cardStart = card[0].start;
    const cardEnd = card[card.length - 1].end;
    const kTags = card
      .map((w) => `{\\k${Math.max(1, Math.round((w.end - w.start) * 100))}}${escapeAssText(w.text)}`)
      .join(' ');
    events.push(`Dialogue: 0,${toAssTime(cardStart)},${toAssTime(cardEnd)},Karaoke,,0,0,0,,${kTags}`);
  }
  return events;
}

/**
 * Builds an ASS subtitle file with native \k karaoke tags (word progressively switches
 * from the "not yet spoken" to the "spoken" color as playback passes it) — burned into
 * the export via ffmpeg's libass-backed `subtitles` filter, so the downloaded video's
 * captions look like the live preview's word-highlight instead of a plain static line.
 */
export function buildKaraokeAss(segments: LocalizedSegment[]): string {
  const events = segments.flatMap(buildCardEvents).join('\n');
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Karaoke,Arial,44,&H003756F0,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,0,0,1,2.5,1.5,2,60,60,70,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}
