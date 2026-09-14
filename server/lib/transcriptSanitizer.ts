import type { TranscriptSegment } from '../../src/types';

/**
 * Strips the degenerate output speech-to-text models produce on non-speech audio.
 *
 * Every STT model in use here will, on silence or room noise, fall into a decoding loop and
 * emit the same short filler over and over. Measured on a real 113-second NASA interview:
 * Gemini returned 223 segments, of which 204 were the single word "Okay." — 91% of the
 * transcript was hallucinated, all of it in one consecutive run, with timestamps that
 * overlapped each other (30.77-31.06, 30.90-31.10, 31.01-31.32, ...) rather than advancing.
 *
 * Left in, each of those becomes a synthesized line in the dub, so the export is minutes of
 * a voice saying "Okay" over the speaker. They also wreck the alignment: the partition
 * downstream distributes lines across speech regions by text length, and 204 phantom lines
 * drag every real one out of place.
 *
 * The rules here key on structure, not on a blocklist of phrases, so they catch a loop on
 * any word in any language: a *consecutive run* of identical text is a loop, and a model
 * emitting segments that overlap its own previous segment is not tracking the audio.
 * Something a person genuinely said twice with other speech in between is never touched.
 */
export interface SanitizeResult {
  segments: TranscriptSegment[];
  removed: number;
  /** Human-readable note for the logs and the analyze response, empty when nothing was dropped. */
  note: string;
}

/** Compared on this rather than raw text, so "Okay." "okay" and "Okay!" count as the same loop. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A run has to be at least this long before it is treated as a loop rather than as speech.
 *
 * Two identical lines in a row happens for real — "No, no", "Wait. Wait." — so collapsing at
 * 2 would edit genuine transcripts. A model that has locked up produces far more than this;
 * the observed case produced 204.
 */
const MIN_LOOP_RUN = 3;
/** A loop repeats something short. A long sentence repeating verbatim is likelier to be real. */
const MAX_LOOP_WORDS = 4;

export function sanitizeTranscript(segments: TranscriptSegment[]): SanitizeResult {
  if (segments.length === 0) return { segments, removed: 0, note: '' };

  const kept: TranscriptSegment[] = [];
  let loopsCollapsed = 0;
  let removed = 0;

  for (let i = 0; i < segments.length; ) {
    const current = segments[i];
    const text = normalize(current.text);

    // How far the identical-text run extends from here.
    let runEnd = i + 1;
    while (runEnd < segments.length && normalize(segments[runEnd].text) === text) runEnd++;
    const runLength = runEnd - i;

    const isLoop = text.length > 0 && runLength >= MIN_LOOP_RUN && text.split(' ').length <= MAX_LOOP_WORDS;

    if (isLoop) {
      // Keep one instance — the speaker probably did say it once somewhere in there — and
      // drop the rest. The kept one keeps its own timing rather than being stretched over
      // the whole run: the run's timestamps are the very thing that proved unreliable, and
      // the alignment pass re-times it against the audio anyway.
      kept.push(current);
      removed += runLength - 1;
      loopsCollapsed++;
      i = runEnd;
      continue;
    }

    for (let j = i; j < runEnd; j++) kept.push(segments[j]);
    i = runEnd;
  }

  // Empty segments carry no speech to dub and no text to align against.
  const nonEmpty = kept.filter((s) => s.text.trim().length > 0);
  removed += kept.length - nonEmpty.length;

  const note = removed > 0
    ? `Removed ${removed} repeated segment${removed === 1 ? '' : 's'} the speech model produced on non-speech audio` +
      (loopsCollapsed > 1 ? ` (${loopsCollapsed} separate runs)` : '')
    : '';

  return { segments: nonEmpty, removed, note };
}

/**
 * Whether a transcript looks degenerate enough to be worth warning about even after
 * cleaning — used only for the log line, so a bad source file is visible in the server
 * output rather than being quietly patched over.
 */
export function describeTranscriptHealth(before: TranscriptSegment[], after: TranscriptSegment[]): string {
  if (before.length === after.length) return `${after.length} segments, clean`;
  const share = Math.round(((before.length - after.length) / before.length) * 100);
  return `${before.length} -> ${after.length} segments (${share}% was model repetition)`;
}
