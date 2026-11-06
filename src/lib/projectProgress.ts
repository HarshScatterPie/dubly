import type { DubbingProject } from '../types';
import { LANGUAGES, VOICES } from '../data/mockData';

export type ProjectStage = 'no_video' | 'uploaded' | 'analyzing' | 'analyzed' | 'translated' | 'dubbing' | 'failed' | 'done';

// What a project has really been through. A new project is stored with placeholder choices (voice, languages) before the
// user makes any, so screens read those only once the step that sets them for real has happened.
export interface ProjectProgress {
  stage: ProjectStage;
  complete: boolean;
  /** A job is running on the server. */
  running: boolean;
  /** Short status for a badge. */
  badge: string;
  /** What the user does next, for an unfinished project. */
  nextStep: string;
  /** Known once analysis has detected it. */
  sourceLanguageName: string | null;
  /** Languages actually translated or dubbed, primary first. */
  targetLanguageNames: string[];
  /** Known once a dub has been started with it. */
  voiceName: string | null;
}

const languageName = (code: string) => LANGUAGES.find((l) => l.code === code)?.name || code;

function hasRender(p: DubbingProject): boolean {
  return Boolean(p.finalDubbedVideoUrl) || Object.values(p.languageOutputs ?? {}).some((o) => Boolean(o.finalDubbedVideoUrl));
}

// Lines of the transcript, from the lines themselves or, for a listed project (which leaves them out), from the server's count.
// A file named by a phone or a chat app (WhatsApp saves a bare id) makes a title nobody can read.
const BARE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What to call a project on screen. */
export function projectTitle(p: Pick<DubbingProject, 'title'>): string {
  const title = (p.title ?? '').trim();
  return !title || BARE_ID.test(title) ? 'Untitled video' : title;
}

export function transcriptLineCount(p: DubbingProject): number {
  return p.transcriptSegments?.length || p.segmentCounts?.transcript || 0;
}

// Translated lines of one language, the same way.
export function languageLineCount(p: DubbingProject, code: string): number {
  return (
    p.languageOutputs?.[code]?.localizedSegments?.length ||
    (code === p.targetLanguage ? p.localizedSegments?.length : 0) ||
    p.segmentCounts?.languages?.[code] ||
    0
  );
}

export function projectProgress(p: DubbingProject): ProjectProgress {
  const languages = p.targetLanguages?.length ? p.targetLanguages : [p.targetLanguage];
  const translated = languages.filter(
    (code) =>
      languageLineCount(p, code) > 0 ||
      Boolean(p.languageOutputs?.[code]?.finalDubbedVideoUrl) ||
      (code === p.targetLanguage && Boolean(p.finalDubbedVideoUrl))
  );
  const analyzed = transcriptLineCount(p) > 0;
  // Only a dub run saves the voice choice; transcription never marks a project processing or failed.
  const dubStarted = hasRender(p) || p.status === 'processing' || p.status === 'failed' || p.status === 'completed';

  let stage: ProjectStage;
  if (!p.videoUrl) stage = 'no_video';
  else if (p.status === 'processing') stage = 'dubbing';
  else if (p.activeJobId) stage = 'analyzing';
  else if (hasRender(p)) stage = 'done';
  else if (p.status === 'failed') stage = 'failed';
  else if (translated.length) stage = 'translated';
  else if (analyzed) stage = 'analyzed';
  else stage = 'uploaded';

  const copy: Record<ProjectStage, { badge: string; nextStep: string }> = {
    no_video: { badge: 'Task incomplete', nextStep: 'Upload a video' },
    uploaded: { badge: 'Task incomplete', nextStep: 'Analyze the video' },
    analyzing: { badge: 'Analyzing', nextStep: 'Analysis in progress' },
    analyzed: { badge: 'Task incomplete', nextStep: 'Choose languages' },
    translated: { badge: 'Task incomplete', nextStep: 'Choose voices and dub' },
    dubbing: { badge: 'Dubbing', nextStep: 'Dub in progress' },
    failed: { badge: 'Failed', nextStep: 'Try the dub again' },
    done: { badge: 'Ready', nextStep: '' },
  };

  const voice = VOICES.find((v) => v.id === p.selectedVoiceId);
  return {
    stage,
    complete: stage === 'done',
    running: stage === 'analyzing' || stage === 'dubbing',
    ...copy[stage],
    sourceLanguageName: analyzed ? languageName(p.sourceLanguage) : null,
    targetLanguageNames: translated.map(languageName),
    voiceName: dubStarted ? voice?.name || 'Unknown voice' : null,
  };
}

// "Hindi", "Hindi +2" or null, for places with room for one language.
export function targetsSummary(progress: ProjectProgress): string | null {
  const [first, ...rest] = progress.targetLanguageNames;
  if (!first) return null;
  return rest.length ? `${first} +${rest.length}` : first;
}
