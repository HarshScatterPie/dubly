import { describe, expect, it } from 'vitest';
import { VOICES } from '../../src/data/mockData';
import { castVoices, cleanSpeakerProfile, mergeSpeakerProfiles, profilesForSpeakers } from './speakerProfiles';
import { defaultVoiceFor, mainSpeakerGender } from '../../src/lib/voiceCasting';
import type { TranscriptSegment } from '../../src/types';

const genderOf = (id: string) => VOICES.find((v) => v.id === id)?.gender;

describe('speaker profiles', () => {
  it('keeps only understood genders and ages', () => {
    expect(cleanSpeakerProfile({ gender: 'Female', age: 'young adult' })).toEqual({ gender: 'female', age: 'young' });
    expect(cleanSpeakerProfile({ gender: 'robot', age: 'ancient' })).toEqual({ gender: 'unknown' });
    expect(cleanSpeakerProfile('nope')).toBeUndefined();
  });

  it('never lets a later chunk overwrite a gender an earlier chunk heard', () => {
    const profiles = mergeSpeakerProfiles({}, [{ label: 'Speaker 1', gender: 'unknown' }, { label: 'Speaker 2', gender: 'male' }]);
    mergeSpeakerProfiles(profiles, [{ label: 'Speaker 1', gender: 'female', age: 'adult' }, { label: 'Speaker 2', gender: 'female' }]);
    expect(profiles).toEqual({ 'Speaker 1': { gender: 'female', age: 'adult' }, 'Speaker 2': { gender: 'male' } });
  });

  it('keeps only speakers still in the transcript', () => {
    expect(profilesForSpeakers({ 'Speaker 1': { gender: 'male' }, 'Speaker 9': { gender: 'female' } }, ['Speaker 1'])).toEqual({ 'Speaker 1': { gender: 'male' } });
  });
});

describe('voice casting', () => {
  it('gives two women two different female voices', () => {
    const map = castVoices(['Speaker 1', 'Speaker 2'], { 'Speaker 1': { gender: 'female' }, 'Speaker 2': { gender: 'female' } }, VOICES);
    expect(genderOf(map['Speaker 1'])).toBe('female');
    expect(genderOf(map['Speaker 2'])).toBe('female');
    expect(map['Speaker 1']).not.toBe(map['Speaker 2']);
  });

  it('hands the default voice to the first speaker it suits', () => {
    const map = castVoices(['Speaker 1', 'Speaker 2'], { 'Speaker 1': { gender: 'female' }, 'Speaker 2': { gender: 'male' } }, VOICES, 'google-hi-charon');
    expect(map['Speaker 2']).toBe('google-hi-charon');
    expect(genderOf(map['Speaker 1'])).toBe('female');
  });

  it('alternates genders for speakers nobody could place, as before profiles existed', () => {
    const map = castVoices(['Speaker 1', 'Speaker 2'], {}, VOICES);
    expect(genderOf(map['Speaker 1'])).toBe('male');
    expect(genderOf(map['Speaker 2'])).toBe('female');
  });

  it('starts a single-speaker project on a native voice of the speaker’s gender', () => {
    const segments = [
      { id: 's1', startTime: 0, endTime: 10, text: 'long line', speaker: 'Speaker 1' },
      { id: 's2', startTime: 10, endTime: 11, text: 'short', speaker: 'Speaker 2' },
    ] as TranscriptSegment[];
    const gender = mainSpeakerGender(segments, { 'Speaker 1': { gender: 'female' }, 'Speaker 2': { gender: 'male' } });
    expect(gender).toBe('female');
    const hindi = defaultVoiceFor('hi', gender);
    expect(hindi?.languageCode).toBe('hi');
    expect(hindi?.gender).toBe('female');
    // No native female voice: a female persona still beats a male native one.
    expect(defaultVoiceFor('ta', 'female')?.gender).toBe('female');
    expect(defaultVoiceFor('hi')?.id).toBe(VOICES.find((v) => v.languageCode === 'hi')?.id);
  });
});
