import { stripPerformanceTags } from './performanceTags';

/**
 * Caption timing shared by the live player, the SRT/VTT downloads and the burned-in export,
 * so what a user previews is exactly what they download.
 *
 * Captions follow the dubbed voice, not the original speaker: a render records where each
 * line is actually spoken (`dubStartTime`/`dubEndTime`), and a translated line is rarely
 * the same length as the original. Lines rendered before that existed fall back to the
 * original slot.
 */
export interface CaptionLine {
  startTime: number;
  endTime: number;
  translatedText: string;
  dubStartTime?: number;
  dubEndTime?: number;
}

export interface CaptionWord {
  text: string;
  /** Whether a space follows this word (false inside CJK/Thai runs, which are written without spaces). */
  space: boolean;
  start: number;
  end: number;
}

export interface CaptionCard {
  start: number;
  end: number;
  words: CaptionWord[];
}

// A card holds about a line and a half: long enough to read as a phrase, short enough to never cover the picture.
const MAX_CARD_CHARS = 64;
// Past this a card is broken at the next clause boundary rather than mid-phrase.
const SOFT_BREAK_CHARS = 36;
// How long a finished card may linger into the silence after it, so a fast line can still be read.
export const CARD_LINGER_SECONDS = 0.35;
const CLAUSE_END = /[.,!?;:…।॥。！？、，]$/;

export function spokenSpan(line: CaptionLine): { start: number; end: number } {
  const start = Number.isFinite(line.dubStartTime) ? line.dubStartTime! : line.startTime;
  const end = Number.isFinite(line.dubEndTime) ? line.dubEndTime! : line.endTime;
  return { start, end: Math.max(start + 0.2, end) };
}

type Segmenter = { segment: (text: string) => Iterable<{ segment: string; isWordLike?: boolean }> };

function wordSegmenter(): Segmenter | null {
  const Ctor = (Intl as unknown as { Segmenter?: new (locale?: string, opts?: { granularity: string }) => Segmenter }).Segmenter;
  if (!Ctor) return null;
  try {
    return new Ctor(undefined, { granularity: 'word' });
  } catch {
    return null;
  }
}

let cachedSegmenter: Segmenter | null | undefined;

/** Words of a caption, keeping punctuation attached and CJK/Thai split into readable units. */
export function tokenizeCaption(text: string): { text: string; space: boolean }[] {
  const clean = stripPerformanceTags(text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (cachedSegmenter === undefined) cachedSegmenter = wordSegmenter();
  const tokens: { text: string; space: boolean }[] = [];
  if (cachedSegmenter) {
    for (const part of cachedSegmenter.segment(clean)) {
      if (/^\s+$/.test(part.segment)) {
        if (tokens.length) tokens[tokens.length - 1].space = true;
        continue;
      }
      const last = tokens[tokens.length - 1];
      // Punctuation belongs to the word it follows, so a card never starts with a comma.
      if (last && !last.space && part.isWordLike === false) last.text += part.segment;
      else tokens.push({ text: part.segment, space: false });
    }
    return tokens;
  }
  return clean.split(' ').map((word) => ({ text: word, space: true }));
}

const visibleLength = (text: string) => [...text].length;

/** Each word's share of the spoken span, proportional to its length (translations carry no per-word timestamps of their own). */
export function timedWords(line: CaptionLine): CaptionWord[] {
  const tokens = tokenizeCaption(line.translatedText);
  if (!tokens.length) return [];
  const { start, end } = spokenSpan(line);
  const weights = tokens.map((t) => Math.max(1, visibleLength(t.text)) + (t.space ? 0.6 : 0));
  const total = weights.reduce((sum, w) => sum + w, 0);
  let cursor = start;
  return tokens.map((token, i) => {
    const wordStart = cursor;
    const wordEnd = i === tokens.length - 1 ? end : Math.min(end, cursor + (weights[i] / total) * (end - start));
    cursor = wordEnd;
    return { ...token, start: wordStart, end: wordEnd };
  });
}

export function cardText(words: CaptionWord[]): string {
  return words.map((w, i) => w.text + (w.space && i < words.length - 1 ? ' ' : '')).join('');
}

/**
 * One line's words grouped into on-screen cards of even length (no one-word scrap left over
 * at the end), each broken at a clause boundary when one falls near where the card would end.
 */
export function cardsForLine(line: CaptionLine): CaptionCard[] {
  const words = timedWords(line);
  if (!words.length) return [];
  const lengths = words.map((w) => visibleLength(w.text) + (w.space ? 1 : 0));
  const total = lengths.reduce((sum, n) => sum + n, 0);
  const count = Math.max(1, Math.ceil(total / MAX_CARD_CHARS));
  const target = total / count;
  const cards: CaptionCard[] = [];
  let current: CaptionWord[] = [];
  let chars = 0;
  let consumed = 0;
  const flush = () => {
    if (!current.length) return;
    cards.push({ start: current[0].start, end: current[current.length - 1].end, words: current });
    current = [];
    chars = 0;
  };
  words.forEach((word, i) => {
    current.push(word);
    chars += lengths[i];
    consumed += lengths[i];
    const cardsLeft = count - cards.length;
    if (cardsLeft <= 1 || i === words.length - 1) return;
    const nextLength = lengths[i + 1];
    // A clause ending near the target is the natural place to break; otherwise break before the card would overshoot it.
    const atClause = CLAUSE_END.test(word.text) && chars >= target * 0.7;
    const overshoot = chars + nextLength / 2 > target;
    if ((atClause || overshoot) && total - consumed >= Math.min(SOFT_BREAK_CHARS, target * 0.5)) flush();
  });
  flush();
  return cards;
}

/** Every card of a language in play order, trimmed so two cards never share the screen. */
export function buildCaptionCards(lines: CaptionLine[]): CaptionCard[] {
  // Each line's words stay inside its own span: a line that ran long must end before the next
  // begins, or the two lines' cards interleave and flash past each other unread.
  const spans = lines
    .filter((line) => stripPerformanceTags(line.translatedText).trim())
    .map((line) => ({ line, span: spokenSpan(line) }))
    .sort((a, b) => a.span.start - b.span.start);
  spans.forEach((entry, i) => {
    const next = spans[i + 1];
    if (next && entry.span.end > next.span.start - 0.02) entry.span.end = Math.max(entry.span.start + 0.3, next.span.start - 0.02);
  });
  const cards = spans
    .flatMap(({ line, span }) => cardsForLine({ ...line, dubStartTime: span.start, dubEndTime: span.end }))
    .filter((card) => card.end > card.start)
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < cards.length - 1; i++) {
    if (cards[i].end > cards[i + 1].start) cards[i] = { ...cards[i], end: Math.max(cards[i].start + 0.05, cards[i + 1].start - 0.01) };
  }
  return cards;
}

/** The card on screen at `time`: the one being spoken, or the last one while it lingers into the pause after it. */
export function activeCaptionCard(cards: CaptionCard[], time: number): CaptionCard | null {
  let lo = 0;
  let hi = cards.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cards[mid].start <= time) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  const card = cards[found];
  const next = cards[found + 1];
  const lingerUntil = Math.min(card.end + CARD_LINGER_SECONDS, next ? next.start : Infinity);
  return time <= lingerUntil ? card : null;
}

// Two balanced lines at most, the way broadcast subtitles are set.
function wrapTwoLines(text: string, maxLine = 42): string {
  if (visibleLength(text) <= maxLine || !text.includes(' ')) return text;
  const words = text.split(' ');
  let best = text;
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const score = Math.abs(visibleLength(a) - visibleLength(b)) + (visibleLength(a) > maxLine || visibleLength(b) > maxLine ? 100 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = `${a}\n${b}`;
    }
  }
  return best;
}

function timestamp(seconds: number, separator: ',' | '.'): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${separator}${String(rest).padStart(3, '0')}`;
}

// Subtitle files get a little more time on screen than karaoke cards: there is no highlight to follow.
function subtitleCues(lines: CaptionLine[]) {
  const cards = buildCaptionCards(lines);
  return cards.map((card, i) => {
    const next = cards[i + 1];
    const wanted = Math.max(card.end, card.start + 0.5) + CARD_LINGER_SECONDS;
    const end = Math.max(card.start + 0.05, Math.min(wanted, next ? next.start - 0.01 : Infinity));
    return { start: card.start, end, text: wrapTwoLines(cardText(card.words)) };
  });
}

export function toSrt(lines: CaptionLine[]): string {
  return subtitleCues(lines)
    .map((cue, i) => `${i + 1}\n${timestamp(cue.start, ',')} --> ${timestamp(cue.end, ',')}\n${cue.text}\n`)
    .join('\n');
}

export function toVtt(lines: CaptionLine[], title = 'Dubly'): string {
  const body = subtitleCues(lines)
    .map((cue) => `${timestamp(cue.start, '.')} --> ${timestamp(cue.end, '.')}\n${cue.text}\n`)
    .join('\n');
  return `WEBVTT - ${title}\n\n${body}`;
}
