import { describe, expect, it } from 'vitest';
import type { GlossaryEntry, LocalizedSegment } from '../../src/types';
import { reconcileSavedSegments, renderQaFlags, textQaFlags } from './lineReview';
import { buildStylePrompt, cleanDelivery } from './speechStyle';

const brand: GlossaryEntry = { id: 'g1', term: 'ScatterPie', mode: 'keep' };
const hi = { languageCode: 'hi', sourceLanguageCode: 'en', glossary: [brand] };

const line = (overrides: Partial<LocalizedSegment> = {}): LocalizedSegment => ({
  id: 'loc-hi-seg-1',
  segmentId: 'seg-1',
  startTime: 10,
  endTime: 14,
  speaker: 'Speaker 1',
  sourceText: 'Welcome to ScatterPie',
  translatedText: 'ScatterPie में आपका स्वागत है',
  ...overrides,
});

describe('text review flags', () => {
  it('passes a correct line', () => {
    expect(textQaFlags(line(), hi)).toEqual([]);
  });

  it('flags a line that came back untranslated, in the wrong script, or off-glossary', () => {
    expect(textQaFlags(line({ translatedText: 'Welcome to ScatterPie' }), hi)).toEqual(['untranslated']);
    expect(textQaFlags(line({ translatedText: 'ScatterPie mein aapka swagat hai' }), hi)).toEqual(['wrong_script']);
    expect(textQaFlags(line({ translatedText: 'स्कैटरपाई में आपका स्वागत है' }), hi)).toEqual(['glossary']);
  });

  it('ignores silent lines', () => {
    expect(textQaFlags(line({ sourceText: '', translatedText: '' }), hi)).toEqual([]);
  });
});

describe('render review flags', () => {
  it('separates a comfortable fit, an audibly rushed one and one that runs over', () => {
    expect(renderQaFlags({ condensed: false, spokenSeconds: 4, availableSeconds: 4, maxCompression: 1.35 })).toEqual([]);
    expect(renderQaFlags({ condensed: false, spokenSeconds: 5, availableSeconds: 4, maxCompression: 1.35 })).toEqual(['rushed']);
    expect(renderQaFlags({ condensed: true, spokenSeconds: 6, availableSeconds: 4, maxCompression: 1.35 })).toEqual(['condensed', 'overflow']);
  });
});

describe('saving edited lines', () => {
  const stored = [line({ renderKey: 'server-key', qaFlags: ['rushed'] })];

  it('keeps the server fingerprint whatever the client sends', () => {
    const [saved] = reconcileSavedSegments([line({ renderKey: 'forged' })], stored, hi);
    expect(saved.renderKey).toBe('server-key');
    const [fresh] = reconcileSavedSegments([line({ id: 'new-line', renderKey: 'forged' })], stored, hi);
    expect(fresh.renderKey).toBeUndefined();
  });

  it('pins timing and origin to the analysed values, so a retake cannot be made cheaper by shrinking slots', () => {
    const [saved] = reconcileSavedSegments([line({ startTime: 10, endTime: 10.01, speaker: 'Speaker 9', sourceText: 'x' })], stored, hi);
    expect([saved.startTime, saved.endTime, saved.speaker, saved.sourceText]).toEqual([10, 14, 'Speaker 1', 'Welcome to ScatterPie']);
  });

  it('keeps render flags for unchanged text, drops them after an edit, and recomputes text flags', () => {
    expect(reconcileSavedSegments([line({ qaFlags: [] })], stored, hi)[0].qaFlags).toEqual(['rushed']);
    const [edited] = reconcileSavedSegments([line({ translatedText: 'स्कैटरपाई में स्वागत', qaFlags: [] })], stored, hi);
    expect(edited.qaFlags).toEqual(['glossary']);
  });

  it('cleans the delivery note and drops an empty one', () => {
    expect(reconcileSavedSegments([line({ delivery: '  calm\n and   warm ' })], stored, hi)[0].delivery).toBe('calm and warm');
    expect('delivery' in reconcileSavedSegments([line({ delivery: '   ' })], stored, hi)[0]).toBe(false);
  });
});

describe('voice direction', () => {
  it('combines the project emotion with the line delivery', () => {
    const prompt = buildStylePrompt('friendly', 'excited and fast');
    expect(prompt).toContain('warm, friendly and conversational');
    expect(prompt).toContain('delivered as: excited and fast');
    expect(buildStylePrompt(undefined, undefined)).toBe('');
  });

  it('bounds and flattens delivery notes before they reach a prompt', () => {
    expect(cleanDelivery('a'.repeat(200))?.length).toBe(80);
    expect(cleanDelivery(42)).toBeUndefined();
  });
});
