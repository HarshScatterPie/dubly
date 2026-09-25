import { describe, expect, it } from 'vitest';
import { buildReviewPrompt, describeVerdict, parseReviewResponse, retakeStyle } from './dubDirector';
import { paceRequest } from './speechStyle';
import { lineGainsDb, MAX_LINE_GAIN_DB } from './levelMatch';

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
