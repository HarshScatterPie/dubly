import { describe, expect, it } from 'vitest';
import type { DubbingProject } from '../../src/types';
import { projectProgress, targetsSummary } from '../../src/lib/projectProgress';

// A project as the server stores it right after upload: the voice and languages are placeholders nobody chose.
const fresh = (overrides: Partial<DubbingProject> = {}): DubbingProject =>
  ({
    id: 'p',
    title: 'Demo',
    videoUrl: 'https://storage/source.mp4',
    sourceLanguage: 'en',
    targetLanguage: 'hi',
    targetLanguages: ['hi'],
    languageOutputs: {},
    selectedVoiceId: 'riya',
    transcriptSegments: [],
    localizedSegments: [],
    status: 'draft',
    ...overrides,
  }) as DubbingProject;

const line = { id: 'loc-hi-seg-1', segmentId: 'seg-1', startTime: 0, endTime: 2, speaker: 'Speaker 1', sourceText: 'hi', translatedText: 'नमस्ते' };
const transcript = [{ id: 'seg-1', startTime: 0, endTime: 2, text: 'hi', speaker: 'Speaker 1', wordsCount: 1, confidence: 0.9 }];

describe('project progress', () => {
  it('shows none of the placeholder choices on a project left right after upload', () => {
    const progress = projectProgress(fresh());
    expect(progress).toMatchObject({ stage: 'uploaded', complete: false, badge: 'Task incomplete', nextStep: 'Analyze the video' });
    expect(progress.sourceLanguageName).toBeNull();
    expect(progress.targetLanguageNames).toEqual([]);
    expect(progress.voiceName).toBeNull();
  });

  it('reveals each choice only once the step that makes it has happened', () => {
    const analyzed = projectProgress(fresh({ transcriptSegments: transcript }));
    expect(analyzed).toMatchObject({ stage: 'analyzed', sourceLanguageName: 'English (US)', voiceName: null, nextStep: 'Choose languages' });

    const translated = projectProgress(fresh({ transcriptSegments: transcript, localizedSegments: [line] }));
    expect(translated).toMatchObject({ stage: 'translated', targetLanguageNames: ['Hindi'], voiceName: null, badge: 'Task incomplete' });

    const dubbing = projectProgress(
      fresh({ transcriptSegments: transcript, localizedSegments: [line], status: 'processing', activeJobId: 'j', selectedVoiceId: 'google-hi-aoede' })
    );
    expect(dubbing).toMatchObject({ stage: 'dubbing', running: true, voiceName: 'Ritu (Google Chirp3-HD)' });
  });

  it('tells an analysis in progress apart from a dub in progress', () => {
    expect(projectProgress(fresh({ activeJobId: 'j' })).stage).toBe('analyzing');
  });

  it('marks a project done only when a dub was rendered', () => {
    const done = projectProgress(fresh({ transcriptSegments: transcript, localizedSegments: [line], status: 'completed', finalDubbedVideoUrl: 'https://storage/dubbed_hi.mp4' }));
    expect(done).toMatchObject({ stage: 'done', complete: true, badge: 'Ready' });
    expect(projectProgress(fresh({ transcriptSegments: transcript, localizedSegments: [line], status: 'failed' })).stage).toBe('failed');
    expect(projectProgress(fresh({ videoUrl: '' })).stage).toBe('no_video');
  });

  it('summarizes several languages for tight spaces', () => {
    const progress = projectProgress(
      fresh({
        targetLanguages: ['hi', 'ta', 'te'],
        localizedSegments: [line],
        languageOutputs: {
          ta: { languageCode: 'ta', localizedSegments: [line], status: 'draft', progressPercent: 0 },
          te: { languageCode: 'te', localizedSegments: [], status: 'draft', progressPercent: 0 },
        },
      })
    );
    expect(targetsSummary(progress)).toBe('Hindi +1');
  });
});
