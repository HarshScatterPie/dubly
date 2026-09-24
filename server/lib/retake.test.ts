import { describe, expect, it } from 'vitest';
import type { LocalizedSegment } from '../../src/types';
import type { StoredProject } from './projectRepo';
import { currentLineKey, lineRenderKey, RETAKE_MIN_SECONDS, retakePlan } from './retake';

const seg = (n: number, text: string): LocalizedSegment => ({
  id: `loc-hi-seg-${n}`,
  segmentId: `seg-${n}`,
  startTime: n * 10,
  endTime: n * 10 + 4,
  speaker: 'Speaker 1',
  sourceText: `line ${n}`,
  translatedText: text,
});

// A two-minute project whose Hindi render fingerprinted every line as it is now.
function renderedProject(): StoredProject {
  const project = {
    id: 'p',
    targetLanguage: 'hi',
    targetLanguages: ['hi'],
    videoDuration: 120,
    finalDubbedVideoStoragePath: 'workspaces/w/projects/p/dubbed_hi.mp4',
    selectedVoiceId: 'riya',
    voiceEmotion: 'friendly',
    voiceSpeed: 1,
    voicePitch: 1,
    localizedSegments: [seg(1, 'पहली पंक्ति'), seg(2, 'दूसरी पंक्ति'), seg(3, 'तीसरी पंक्ति')],
  } as unknown as StoredProject;
  project.localizedSegments = project.localizedSegments.map((s) => ({ ...s, renderKey: currentLineKey(project, 'hi', s) }));
  return project;
}

describe('line fingerprints', () => {
  const settings = { voiceEmotion: 'friendly' as const, voiceSpeed: 1, voicePitch: 1 };
  const base = lineRenderKey({ translatedText: 'नमस्ते', delivery: 'calm' }, 'riya', settings);

  it('are stable for the same line and settings', () => {
    expect(lineRenderKey({ translatedText: ' नमस्ते ', delivery: 'calm' }, 'riya', settings)).toBe(base);
  });

  it('change with anything that changes how the line sounds', () => {
    expect(lineRenderKey({ translatedText: 'नमस्कार', delivery: 'calm' }, 'riya', settings)).not.toBe(base);
    expect(lineRenderKey({ translatedText: 'नमस्ते', delivery: 'excited' }, 'riya', settings)).not.toBe(base);
    expect(lineRenderKey({ translatedText: 'नमस्ते', delivery: 'calm' }, 'arjun', settings)).not.toBe(base);
    expect(lineRenderKey({ translatedText: 'नमस्ते', delivery: 'calm' }, 'riya', { ...settings, voiceEmotion: 'energetic' })).not.toBe(base);
    expect(lineRenderKey({ translatedText: 'नमस्ते', delivery: 'calm' }, 'riya', { ...settings, voiceSpeed: 1.1 })).not.toBe(base);
  });
});

describe('retake plan', () => {
  it('has nothing to offer for a language that was never rendered, or rendered before fingerprints', () => {
    const project = renderedProject();
    expect(retakePlan({ ...project, finalDubbedVideoStoragePath: undefined }, 'hi')).toBeNull();
    const legacy = { ...project, localizedSegments: project.localizedSegments.map(({ renderKey: _k, ...s }) => s) };
    expect(retakePlan(legacy, 'hi')).toBeNull();
  });

  it('finds no changes right after a render', () => {
    expect(retakePlan(renderedProject(), 'hi')).toEqual({ changedLineIds: [], seconds: 0, minutes: 0 });
  });

  it('charges only the edited lines, with a floor for the re-stitch', () => {
    const project = renderedProject();
    project.localizedSegments[1] = { ...project.localizedSegments[1], translatedText: 'बदली हुई पंक्ति' };
    const plan = retakePlan(project, 'hi')!;
    expect(plan.changedLineIds).toEqual(['loc-hi-seg-2']);
    expect(plan.seconds).toBe(4);
    // Four seconds of edits bill the six-second minimum: a tenth of a minute.
    expect(plan.minutes).toBeCloseTo(RETAKE_MIN_SECONDS / 60);
    expect(plan.minutes).toBeCloseTo(0.1);

    project.localizedSegments[2] = { ...project.localizedSegments[2], delivery: 'whispering' };
    // Eight seconds round up to the next tenth of a minute, the step usage is kept in.
    expect(retakePlan(project, 'hi')!.minutes).toBeCloseTo(0.2);
  });

  it('treats a new voice as every line changed, never charging more than a full re-dub', () => {
    const plan = retakePlan({ ...renderedProject(), selectedVoiceId: 'arjun', videoDuration: 6 }, 'hi')!;
    expect(plan.changedLineIds).toHaveLength(3);
    expect(plan.minutes).toBeCloseTo(6 / 60);
  });
});
