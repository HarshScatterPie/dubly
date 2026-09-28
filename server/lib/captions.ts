import { buildCaptionCards, CARD_LINGER_SECONDS, type CaptionLine } from '../../src/lib/captionCues';
import { captionFontFamily } from './fonts';

// The same cards the live player shows (src/lib/captionCues.ts), so a burned-in caption matches the preview word for word.

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

export interface CaptionCanvas {
  /** The video's displayed size; captions are laid out in its own pixels so they scale with it, landscape or vertical. */
  width: number;
  height: number;
}

/**
 * An ASS subtitle file with `\kf` karaoke sweeps: each word fills from the waiting colour to
 * the spoken colour as the dubbed voice says it. Burned in with ffmpeg's libass-backed
 * `subtitles` filter.
 */
export function buildKaraokeAss(segments: CaptionLine[], canvas: CaptionCanvas = { width: 1280, height: 720 }): string {
  const width = Math.max(160, Math.round(canvas.width));
  const height = Math.max(120, Math.round(canvas.height));
  const cards = buildCaptionCards(segments);
  const events = cards
    .map((card, index) => {
      // Lingers briefly into the pause, but never onto the screen with the next card.
      const next = cards[index + 1];
      const end = Math.max(card.end, Math.min(card.end + CARD_LINGER_SECONDS, next ? next.start - 0.01 : Infinity));
      let cursor = card.start;
      const body = card.words
        .map((word, i) => {
          // Durations are taken from the running cursor so rounding never lets the sweep drift from the card.
          const cs = Math.max(1, Math.round((word.end - cursor) * 100));
          cursor += cs / 100;
          return `{\\kf${cs}}${escapeAssText(word.text)}${word.space && i < card.words.length - 1 ? ' ' : ''}`;
        })
        .join('');
      return `Dialogue: 0,${toAssTime(card.start)},${toAssTime(end)},Caption,,0,0,0,,${body}`;
    })
    .join('\n');

  const allText = segments.map((s) => s.translatedText).join(' ');
  const font = captionFontFamily(allText);
  const short = Math.min(width, height);
  const fontSize = Math.round(short * (width >= height ? 0.058 : 0.052));
  const outline = Math.max(2, Math.round(fontSize * 0.08));
  const shadow = Math.max(1, Math.round(fontSize * 0.035));
  const marginSide = Math.round(width * 0.07);
  const marginBottom = Math.round(height * (width >= height ? 0.07 : 0.12));

  // Colours are &HAABBGGRR. Spoken words turn white; the words still to come wait in a soft grey.
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${font},${fontSize},&H00FFFFFF,&H00C8C8C8,&H00141414,&H78000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},2,${marginSide},${marginSide},${marginBottom},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}
