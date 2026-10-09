import { describe, expect, it, vi } from 'vitest';
import { buildReviewPrompt, describeVerdict, parseReviewResponse, retakeStyle, reviewDubbedLines } from './dubDirector';
import { vertexGenerateJson } from './vertexClient';
import { paceRequest } from './speechStyle';
import { lineGainsDb, MAX_LINE_GAIN_DB } from './levelMatch';

// The reviewer is the only network call these tests could make; each test sets what it answers.
vi.mock('./vertexClient', () => ({ vertexGenerateJson: vi.fn() }));

describe('AI review', () => {
  it('reads verdicts for the lines it asked about and nothing else', () => {
    const raw = JSON.stringify({
      lines: [
        { id: 'a', ok: true },
        { id: 'b', ok: false, problem: 'mispronounced', note: "says 'ScatterPie' wrong", direction: 'say ScatterPie as scatter pie' },
        { id: 'c', ok: false, problem: 'vibes' },
        { id: 'zzz', ok: false, problem: 'garbled' },
      ],
    });
    const verdicts = parseReviewResponse(raw, ['a', 'b', 'c']);
    expect(verdicts.get('a')).toEqual({ ok: true });
    expect(verdicts.get('b')).toEqual({ ok: false, problem: 'mispronounced', note: "says 'ScatterPie' wrong", direction: 'say ScatterPie as scatter pie' });
    // An unrecognised problem is too vague to act on.
    expect(verdicts.get('c')).toEqual({ ok: true });
    expect(verdicts.has('zzz')).toBe(false);
  });

  it('treats an unreadable answer as no verdicts rather than bad lines', () => {
    expect(parseReviewResponse('not json', ['a']).size).toBe(0);
    expect(parseReviewResponse('{"lines": "no"}', ['a']).size).toBe(0);
  });

  it('bounds notes and strips control characters', () => {
    const verdicts = parseReviewResponse(JSON.stringify({ lines: [{ id: 'a', ok: false, problem: 'garbled', note: `x\u0000${'y'.repeat(500)}` }] }), ['a']);
    expect(verdicts.get('a')!.note!.length).toBeLessThanOrEqual(120);
    expect(verdicts.get('a')!.note).not.toContain('\u0000');
  });

  it('turns a verdict into direction for the retake and a note for the editor', () => {
    expect(retakeStyle('Speak warmly.', { ok: false, problem: 'wrong_emotion', direction: 'angrier, clipped' })).toBe(
      "Speak warmly. Director's note for this take: angrier, clipped."
    );
    expect(retakeStyle('', { ok: false, problem: 'garbled' })).toBe('Say every word of the line clearly and completely, at a natural pace.');
    expect(describeVerdict({ ok: false, problem: 'missing_words' })).toBe('words missing from the take');
    expect(describeVerdict({ ok: false, problem: 'garbled', note: 'cut off at the end' })).toBe('cut off at the end');
  });

  it('tells the reviewer that tags are performed, not spoken', () => {
    expect(buildReviewPrompt('Hindi')).toContain('[laughing]');
  });
});

describe('pace direction', () => {
  it('asks a line that overruns its room to speed up, and keeps only a shorter take', () => {
    const request = paceRequest(5, 3, 3.5)!;
    expect(request.direction).toContain('3.5 seconds');
    expect(request.accept(4, 5)).toBe(true);
    expect(request.accept(5.2, 5)).toBe(false);
  });

  it('asks a line far shorter than the original to take its time, without overrunning', () => {
    const request = paceRequest(1.5, 4, 5)!;
    expect(request.direction).toContain('4.0 seconds');
    expect(request.accept(3.2, 1.5)).toBe(true);
    expect(request.accept(5.5, 1.5)).toBe(false);
  });

  it('leaves a line that fits alone, and aims in the voice’s own seconds', () => {
    expect(paceRequest(3, 3, 3.2)).toBeNull();
    expect(paceRequest(0.8, 1, 1)).toBeNull();
    expect(paceRequest(5, 3, 3.5, 1.2)!.direction).toContain('4.2 seconds');
  });
});

describe('line levels', () => {
  it('keeps the original’s dynamics relative to the median line, within bounds', () => {
    const gains = lineGainsDb([
      { id: 'normal', sourceDb: -20, dubDb: -18 },
      { id: 'normal2', sourceDb: -20, dubDb: -18 },
      { id: 'whisper', sourceDb: -30, dubDb: -18 },
      { id: 'shout', sourceDb: -17, dubDb: -18 },
      { id: 'unmeasured', sourceDb: null, dubDb: -18 },
    ]);
    expect(gains.has('normal')).toBe(false);
    expect(gains.get('whisper')).toBe(-MAX_LINE_GAIN_DB);
    expect(gains.get('shout')).toBe(3);
    expect(gains.has('unmeasured')).toBe(false);
  });

  it('does nothing with too few lines to know what normal is', () => {
    expect(lineGainsDb([{ id: 'a', sourceDb: -30, dubDb: -10 }]).size).toBe(0);
  });
});

describe('AI review progress', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `l${i}`, script: `line ${i}`, dubbed: Buffer.alloc(44) }));

  it('reports every finished batch, including one that failed, so the bar can keep moving', async () => {
    let call = 0;
    vi.mocked(vertexGenerateJson).mockImplementation(async () => {
      if (++call === 2) throw new Error('quota');
      return '{}';
    });
    const seen: [number, number][] = [];
    // 20 lines go out in three requests of at most eight lines.
    const verdicts = await reviewDubbedLines(lines(20), 'Hindi', (done, total) => seen.push([done, total]));
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    // Nothing was judged bad: a failed or unreadable batch just has no verdicts.
    expect(verdicts.size).toBe(0);
  });

  it('works without a progress callback', async () => {
    vi.mocked(vertexGenerateJson).mockResolvedValue('{}');
    await expect(reviewDubbedLines(lines(3), 'Hindi')).resolves.toBeInstanceOf(Map);
  });
});
