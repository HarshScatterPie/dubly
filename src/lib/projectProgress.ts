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

export function projectProgress(p: DubbingProject): ProjectProgress {
  const languages = p.targetLanguages?.length ? p.targetLanguages : [p.targetLanguage];
  const translated = languages.filter(
    (code) =>
      Boolean(p.languageOutputs?.[code]?.localizedSegments?.length) ||
      Boolean(p.languageOutputs?.[code]?.finalDubbedVideoUrl) ||
      (code === p.targetLanguage && (p.localizedSegments?.length > 0 || Boolean(p.finalDubbedVideoUrl)))
  );
  const analyzed = (p.transcriptSegments?.length ?? 0) > 0;
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
    voiceName: dubStarted ? voice?.name || (p.selectedVoiceId?.startsWith('cloned:') ? 'My voice' : 'Unknown voice') : null,
  };
}

// "Hindi", "Hindi +2" or null, for places with room for one language.
export function targetsSummary(progress: ProjectProgress): string | null {
  const [first, ...rest] = progress.targetLanguageNames;
  if (!first) return null;
  return rest.length ? `${first} +${rest.length}` : first;
}
