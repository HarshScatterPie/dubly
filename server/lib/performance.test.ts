import { describe, expect, it } from 'vitest';
import { acceptHeardPerformance, performanceTagsIn, sanitizePerformanceTags, stripPerformanceTags } from './performance';
import { normalizeTextForSpeech } from './modelRouter';
import { buildTranslationPrompt, describeSpeakers } from './translatePrompt';

describe('performance tags', () => {
  it('strips performance tags for captions but leaves other brackets alone', () => {
    expect(stripPerformanceTags('[laughing] No way! [sigh]')).toBe('No way!');
    expect(stripPerformanceTags('अरे वाह, [laughing] कमाल!')).toBe('अरे वाह, कमाल!');
    expect(stripPerformanceTags('Chapter [3] begins')).toBe('Chapter [3] begins');
  });

  it('lists tags in canonical spelling', () => {
    expect(performanceTagsIn('[Laughing] hi [SHORT  pause] there [music]')).toEqual(['laughing', 'short pause']);
  });

  it('keeps only the tags the source line had, so a translation cannot invent a laugh', () => {
    expect(sanitizePerformanceTags('[laughing] क्या बात है [sigh]', '[laughing] What a thing')).toBe('[laughing] क्या बात है');
    expect(sanitizePerformanceTags('[laughing] a [laughing] b', '[laughing] x')).toBe('[laughing] a b');
    expect(sanitizePerformanceTags('[Whispering] psst')).toBe('[whispering] psst');
  });

  it('accepts a heard performance only when it is the same words plus laughs or sighs', () => {
    expect(acceptHeardPerformance('That was brilliant!', '[laughing] That was brilliant!')).toBe('[laughing] That was brilliant!');
    expect(acceptHeardPerformance('That was brilliant!', '[laughing] That was great!')).toBeUndefined();
    expect(acceptHeardPerformance('That was brilliant!', 'That was brilliant!')).toBeUndefined();
    // Only laughs and sighs are heard; anything else the model adds is dropped.
    expect(acceptHeardPerformance('Hello there', '[whispering] Hello [sigh] there')).toBe('Hello [sigh] there');
    expect(acceptHeardPerformance('Hello there', 42)).toBeUndefined();
  });

  it('keeps performance tags for the voice while still dropping stage directions', () => {
    expect(normalizeTextForSpeech('[laughing] Great news [music] everyone')).toBe('[laughing] Great news everyone.');
    expect(normalizeTextForSpeech('[applause] Thank you')).toBe('Thank you.');
  });
});

describe('speaker-aware translation prompt', () => {
  const lines = [
    { id: 'seg-1', text: 'I went to the market.', speaker: 'Speaker 1', durationSeconds: 2 },
    { id: 'seg-2', text: '[laughing] Did you?', speaker: 'Speaker 2', durationSeconds: 1.5 },
  ];

  it('describes each speaker so gendered grammar agrees with who is talking', () => {
    const prompt = buildTranslationPrompt(lines, 'Hindi', 'natural', true, '', '', {
      speakers: { 'Speaker 1': { gender: 'female', age: 'adult' }, 'Speaker 2': { gender: 'male' } },
    });
    expect(prompt).toContain('- Speaker 1: female, adult');
    expect(prompt).toContain('- Speaker 2: male');
    expect(prompt).toContain('"speaker": "Speaker 1"');
    expect(prompt).toContain('PERFORMANCE TAGS');
  });

  it('leaves speakers out for a lone speaker nobody could place, and tags out when there are none', () => {
    const prompt = buildTranslationPrompt([{ id: 'seg-1', text: 'Hello', speaker: 'Speaker 1' }], 'Hindi', 'natural', true);
    expect(prompt).not.toContain('SPEAKERS');
    expect(prompt).not.toContain('"speaker"');
    expect(prompt).not.toContain('PERFORMANCE TAGS');
  });

  it('still names a lone speaker whose gender was heard', () => {
    expect(describeSpeakers([{ id: 'a', text: 'x', speaker: 'Speaker 1' }], { 'Speaker 1': { gender: 'female' } })).toBe('- Speaker 1: female');
  });
});
