import ffmpeg from 'fluent-ffmpeg';
import { detectSpeechRegionsVad, isVadAvailable } from './vad';

/**
 * Timestamp correction via real speech-region detection.
 *
 * Gemini's STT doesn't give trustworthy timing (verified empirically against a clip with
 * known ground truth): it *estimates* timestamps and the error compounds over the clip
 * (~0.2s early at the start, ~1.6s early by 14s in). The transcript *text* is accurate;
 * only the timing is not.
 *
 * So rather than trusting it, we measure where speech physically is in the audio
 * (ffmpeg `silencedetect`) and snap the transcript onto those regions. That makes segment
 * boundaries land on actual speech instead of drifting into silence, which is what keeps
 * captions and the dubbed audio locked to the picture.
 */
export interface SpeechRegion {
  start: number;
  end: number;
}

const NOISE_FLOOR_DB = -35;
// Pauses shorter than this are within-sentence breathing, not a real segment boundary —
// merging them keeps one spoken sentence as one region instead of shattering it.
const MIN_SILENCE_SECONDS = 0.35;
// silencedetect reports the moment audio crosses the noise floor, which lands slightly
// *after* a word actually begins (speech onsets ramp up rather than starting at full
// volume) and slightly before it fully decays. Measured against a known-ground-truth clip
// this bias was a consistent ~0.23s late on every region, so compensate for it directly.
const SPEECH_LEAD_IN_SECONDS = 0.22;
const SPEECH_TAIL_SECONDS = 0.1;

/**
 * Finds where speech actually occurs. Prefers the Silero VAD model, which distinguishes
 * human speech from applause/music/noise; falls back to amplitude-based silence detection
 * only if the model file is missing (that fallback cannot tell a clapping audience from a
 * talking person, so it is strictly a degraded mode).
 */
export async function detectSpeechRegions(audioPath: string, totalDuration: number): Promise<SpeechRegion[]> {
  if (isVadAvailable()) {
    try {
      const regions = await detectSpeechRegionsVad(audioPath, totalDuration);
      if (regions.length > 0) return regions;
    } catch (err) {
      console.error('[forcedAlign] VAD failed, falling back to silence detection', err);
    }
  }
  return detectSpeechRegionsByAmplitude(audioPath, totalDuration);
}

function detectSpeechRegionsByAmplitude(audioPath: string, totalDuration: number): Promise<SpeechRegion[]> {
  return new Promise((resolve, reject) => {
    const silenceStarts: number[] = [];
    const silenceEnds: number[] = [];

    const cmd = ffmpeg(audioPath)
      .audioFilters(`silencedetect=noise=${NOISE_FLOOR_DB}dB:d=${MIN_SILENCE_SECONDS}`)
      .format('null')
      .output('-');

    cmd.on('stderr', (line: string) => {
      const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
      if (s) silenceStarts.push(parseFloat(s[1]));
      const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
      if (e) silenceEnds.push(parseFloat(e[1]));
    });
    cmd.on('error', reject);
    cmd.on('end', () => {
      // Speech is the inverse of the detected silences.
      const regions: SpeechRegion[] = [];
      let cursor = 0;
      for (let i = 0; i < silenceStarts.length; i++) {
        const sStart = Math.max(0, silenceStarts[i]);
        if (sStart > cursor + 0.05) regions.push({ start: cursor, end: sStart });
        cursor = silenceEnds[i] !== undefined ? silenceEnds[i] : sStart;
      }
      if (cursor < totalDuration - 0.05) regions.push({ start: cursor, end: totalDuration });

      const kept = regions.filter((r) => r.end - r.start > 0.12);
      // Widen each region to recover the soft onset/decay, without letting neighbours
      // overlap or running past the clip's bounds.
      resolve(
        kept.map((r, i) => {
          const prevEnd = i > 0 ? kept[i - 1].end : 0;
          const nextStart = i < kept.length - 1 ? kept[i + 1].start : totalDuration;
          return {
            start: Math.max(prevEnd, Math.max(0, r.start - SPEECH_LEAD_IN_SECONDS)),
            end: Math.min(nextStart, Math.min(totalDuration, r.end + SPEECH_TAIL_SECONDS)),
          };
        })
      );
    });
    cmd.run();
  });
}

export interface AlignableSegment {
  startTime: number;
  endTime: number;
  text: string;
}

/**
 * Largest sequence on either side of an alignment that the exact solver will run on. The
 * solver is O(groups * n^2); past this the proportional fallback takes over, which is
 * cheaper and only degrades placement quality, never ordering or coverage.
 */
const MAX_ALIGN_ITEMS = 600;
/**
 * How much the solver cares about cutting on the *big* pauses versus giving every line a
 * duration proportional to its text. Both terms are normalized to roughly 0..1 across the
 * whole clip, so this reads as a direct ratio: text length leads, pause structure breaks
 * the ties it leaves.
 */
const PAUSE_WEIGHT = 0.35;

/**
 * Splits an ordered sequence into `groups` contiguous, non-empty runs, cutting wherever
 * the summed cost is lowest. Classic O(groups * count^2) partition DP, so `costOf` has to
 * be O(1) — callers precompute prefix sums for that.
 */
function partitionContiguous(
  count: number,
  groups: number,
  costOf: (groupIndex: number, from: number, to: number) => number
): [number, number][] | null {
  if (groups <= 0 || count < groups) return null;

  const INF = Number.POSITIVE_INFINITY;
  // best[g][i]: cheapest way to cover the first i items using exactly g runs.
  const best: number[][] = Array.from({ length: groups + 1 }, () => new Array<number>(count + 1).fill(INF));
  const cutAt: number[][] = Array.from({ length: groups + 1 }, () => new Array<number>(count + 1).fill(0));
  best[0][0] = 0;

  for (let g = 1; g <= groups; g++) {
    // Every run holds at least one item, so run g can only end late enough to have filled
    // the runs before it and early enough to leave one item for each run after it.
    for (let i = g; i <= count - (groups - g); i++) {
      for (let j = g - 1; j < i; j++) {
        const prefix = best[g - 1][j];
        if (prefix === INF) continue;
        const total = prefix + costOf(g - 1, j, i);
        if (total < best[g][i]) {
          best[g][i] = total;
          cutAt[g][i] = j;
        }
      }
    }
  }
  if (best[groups][count] === INF) return null;

  const runs: [number, number][] = [];
  let end = count;
  for (let g = groups; g >= 1; g--) {
    const from = cutAt[g][end];
    runs.unshift([from, end]);
    end = from;
  }
  return runs;
}

/** Running totals, so a run's speech time, the silence swallowed inside it, and its text length are each an O(1) lookup. */
function buildPrefixSums(regions: SpeechRegion[], lengths: number[]) {
  const speech = [0];
  const gaps = [0];
  for (let i = 0; i < regions.length; i++) {
    speech.push(speech[i] + (regions[i].end - regions[i].start));
    // Silence between this region and the one before it — the pause a listener hears.
    gaps.push(gaps[i] + (i === 0 ? 0 : Math.max(0, regions[i].start - regions[i - 1].end)));
  }
  const chars = [0];
  for (let i = 0; i < lengths.length; i++) chars.push(chars[i] + lengths[i]);
  return { speech, gaps, chars };
}

/**
 * Re-times segments onto measured speech regions, preserving their order and text.
 *
 * The two sequences rarely line up one-to-one: the VAD splits on every breath, while an
 * STT segment is usually a whole sentence spanning several of those. So the counts differ
 * in one direction or the other, and the real job is deciding *which* speech belongs to
 * which line.
 *
 * That decision used to be made by mapping each segment's cumulative share of the
 * transcript's characters onto the same share of the concatenated speech timeline. It
 * assumes a single constant speaking rate for the whole clip and nothing else, so one long
 * pause, one laugh, or one hallucinated segment shifted every line after it — which is how
 * lines ended up landing seconds away from the words they belong to.
 *
 * It is solved as a partition instead: find the cut points that both give each line a
 * duration proportional to its text *and* land on the clip's real pauses, since that is
 * where sentence boundaries actually are. A local mis-sizing then stays local instead of
 * dragging the rest of the timeline along with it.
 */
export function alignSegmentsToSpeech<T extends AlignableSegment>(segments: T[], regions: SpeechRegion[]): T[] {
  if (segments.length === 0 || regions.length === 0) return segments;

  if (regions.length === segments.length) {
    return segments.map((seg, i) => ({ ...seg, startTime: regions[i].start, endTime: regions[i].end }));
  }

  const lengths = segments.map((s) => Math.max(1, s.text.trim().length));
  const totalChars = lengths.reduce((a, b) => a + b, 0);
  const totalSpeech = regions.reduce((sum, r) => sum + (r.end - r.start), 0);
  if (totalSpeech <= 0) return segments;

  if (Math.max(regions.length, segments.length) <= MAX_ALIGN_ITEMS) {
    const solved =
      regions.length > segments.length
        ? groupRegionsPerSegment(segments, regions, lengths, totalChars, totalSpeech)
        : shareRegionsAcrossSegments(segments, regions, lengths, totalChars, totalSpeech);
    if (solved) return solved;
  }
  return distributeProportionally(segments, regions, lengths, totalChars, totalSpeech);
}

/**
 * More speech regions than lines — the usual case, since one spoken sentence is several
 * breath groups. Each line takes a contiguous run of regions, so it spans its own internal
 * breathing pauses while still starting and ending on real speech.
 */
function groupRegionsPerSegment<T extends AlignableSegment>(
  segments: T[],
  regions: SpeechRegion[],
  lengths: number[],
  totalChars: number,
  totalSpeech: number
): T[] | null {
  const { speech, gaps } = buildPrefixSums(regions, lengths);
  const totalGap = gaps[regions.length] || 1;

  const runs = partitionContiguous(regions.length, segments.length, (segIndex, from, to) => {
    const expected = (lengths[segIndex] / totalChars) * totalSpeech;
    const actual = speech[to] - speech[from];
    const durationCost = Math.abs(actual - expected) / totalSpeech;
    // Silence swallowed *inside* this run: cheap for the breaths within a sentence, dear
    // for the long beat between two sentences — which is what pulls the cuts onto the
    // boundaries a listener would pick.
    const swallowedPause = (gaps[to] - gaps[from + 1]) / totalGap;
    return durationCost + PAUSE_WEIGHT * swallowedPause;
  });
  if (!runs) return null;

  return segments.map((seg, i) => ({
    ...seg,
    startTime: regions[runs[i][0]].start,
    endTime: regions[runs[i][1] - 1].end,
  }));
}

/**
 * Fewer speech regions than lines — several lines share one region, because the STT split
 * a single uninterrupted burst into sentences. Lines are partitioned across the regions
 * first, then subdivided inside the one region they landed in, so a mis-sized line can
 * only disturb its own region.
 */
function shareRegionsAcrossSegments<T extends AlignableSegment>(
  segments: T[],
  regions: SpeechRegion[],
  lengths: number[],
  totalChars: number,
  totalSpeech: number
): T[] | null {
  const { chars } = buildPrefixSums(regions, lengths);

  const runs = partitionContiguous(segments.length, regions.length, (regionIndex, from, to) => {
    const region = regions[regionIndex];
    const expected = ((chars[to] - chars[from]) / totalChars) * totalSpeech;
    return Math.abs(region.end - region.start - expected) / totalSpeech;
  });
  if (!runs) return null;

  const out = segments.slice();
  runs.forEach(([from, to], regionIndex) => {
    const region = regions[regionIndex];
    const span = region.end - region.start;
    let runChars = 0;
    for (let i = from; i < to; i++) runChars += lengths[i];

    let cursor = region.start;
    for (let i = from; i < to; i++) {
      const startTime = cursor;
      const endTime = Math.min(region.end, cursor + (lengths[i] / runChars) * span);
      cursor = endTime;
      out[i] = { ...segments[i], startTime, endTime: Math.max(startTime + 0.2, endTime) };
    }
  });
  return out;
}

/**
 * Fallback for clips too long to solve exactly: bucket each segment into the region its
 * character-share midpoint falls in, then subdivide within that region. Weaker than the
 * partition above — a single bad segment can still pull its neighbours — but it keeps the
 * two guarantees that matter: order is preserved, and no line is ever placed in silence.
 */
function distributeProportionally<T extends AlignableSegment>(
  segments: T[],
  regions: SpeechRegion[],
  lengths: number[],
  totalChars: number,
  totalSpeech: number
): T[] {
  const regionCumulativeFraction: number[] = [];
  let accum = 0;
  for (const r of regions) {
    accum += (r.end - r.start) / totalSpeech;
    regionCumulativeFraction.push(accum);
  }

  const buckets: number[][] = regions.map(() => []);
  let charsBefore = 0;
  segments.forEach((_, i) => {
    const midpointFraction = (charsBefore + lengths[i] / 2) / totalChars;
    charsBefore += lengths[i];
    let target = regionCumulativeFraction.findIndex((c) => midpointFraction <= c);
    if (target === -1) target = regions.length - 1;
    buckets[target].push(i);
  });

  const out = segments.slice();
  buckets.forEach((indices, j) => {
    if (indices.length === 0) return;
    const region = regions[j];
    const span = region.end - region.start;
    const bucketChars = indices.reduce((sum, i) => sum + lengths[i], 0);
    let cursor = region.start;
    indices.forEach((i) => {
      const startTime = cursor;
      const endTime = Math.min(region.end, cursor + (lengths[i] / bucketChars) * span);
      cursor = endTime;
      out[i] = { ...segments[i], startTime, endTime: Math.max(startTime + 0.2, endTime) };
    });
  });
  return out;
}

/** Redistributes a segment's per-word timings evenly across its (corrected) span, so caption highlighting follows the fixed timing rather than the provider's original drifted values. */
export function retimeWords<T extends AlignableSegment & { words?: { text: string; start: number; end: number }[] }>(
  segment: T
): T {
  if (!segment.words || segment.words.length === 0) return segment;
  const span = Math.max(0.2, segment.endTime - segment.startTime);
  const lengths = segment.words.map((w) => Math.max(1, w.text.length));
  const total = lengths.reduce((a, b) => a + b, 0);
  let cursor = segment.startTime;
  const words = segment.words.map((w, i) => {
    const share = (lengths[i] / total) * span;
    const start = cursor;
    const end = Math.min(segment.endTime, cursor + share);
    cursor = end;
    return { text: w.text, start, end };
  });
  return { ...segment, words };
}
