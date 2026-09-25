/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type NavigationTab =
  | 'dashboard'
  | 'dubbing'
  | 'text-to-voice'
  | 'my-voices'
  | 'history'
  | 'workspace'
  | 'team'
  | 'glossary'
  | 'usage'
  | 'settings';

export type DubbingStep = 'upload' | 'understand' | 'localize' | 'voice' | 'export';

export type TranslationStyle = 'natural' | 'literal' | 'professional' | 'casual' | 'marketing';

export type VoiceEmotion = 'neutral' | 'friendly' | 'energetic' | 'professional' | 'empathetic';

export type VoiceCategory = 'indian' | 'professional' | 'conversational' | 'narration' | 'expressive';

export type ProjectStatus = 'draft' | 'processing' | 'completed' | 'failed';

export interface Language {
  code: string;
  name: string;
  nativeName: string;
  flag: string;
  category: 'indian' | 'global' | 'asian';
  isPopular?: boolean;
  bcp47: string; // for speech synthesis
}

export interface Voice {
  id: string;
  name: string;
  gender: 'male' | 'female' | 'non-binary';
  languageCode: string;
  languageName: string;
  accent: string;
  category: VoiceCategory;
  description: string;
  avatarUrl: string;
  sampleQuote: string;
  tags: string[];
  pitch: number;
  speed: number;
  /** Dedicated provider powering this voice. `clone` means it is the user's own voice, synthesized locally from their recording. */
  provider: 'vertex' | 'clone';
  providerVoice: {
    vertex?: string;
    /** The cloned voice's own id — the reference recording is looked up from it at synthesis time. */
    clone?: string;
  };
}

/**
 * A voice the user created by uploading a recording of themselves, cloned zero-shot at
 * synthesis time rather than trained. Lives per-user, alongside the shared catalog.
 */
export interface CustomVoice {
  id: string;
  name: string;
  gender: 'male' | 'female' | 'non-binary';
  /** The language the sample was recorded in — clones speak other languages too, this is just what it was captured in. */
  languageCode: string;
  /** What the sample says. Transcribed on upload, because one of the engines needs it to align the reference. */
  sampleTranscript: string;
  sampleAudioUrl?: string;
  createdAt: string;
}

export interface TranscriptWord {
  text: string;
  start: number; // in seconds
  end: number; // in seconds
}

export interface TranscriptSegment {
  id: string;
  startTime: number; // in seconds
  endTime: number; // in seconds
  text: string;
  speaker: string;
  wordsCount: number;
  confidence: number;
  /** Per-word timing within this segment — proportionally estimated from Gemini's segment-level timestamps (Vertex has no native word-level ASR). Refined further by forced alignment when available. Drives karaoke-style caption highlighting. */
  words?: TranscriptWord[];
  /** How the line is spoken in the original (e.g. "excited and fast"), heard by the transcription model; steers the dubbed voice's delivery. */
  delivery?: string;
  /** The same words with the laughs and sighs heard in the original marked inline (e.g. "[laughing] No way!"), so the dub performs them too. */
  performance?: string;
}

/** Who a detected speaker is, heard by transcription; drives voice casting and gendered grammar in translation. */
export interface SpeakerProfile {
  gender: 'male' | 'female' | 'unknown';
  age?: 'child' | 'young' | 'adult' | 'senior';
}

/** Why a line deserves a reviewer's look: text flags are recomputed on every save, render flags come from the line's last dub. */
export type QaFlag = 'untranslated' | 'wrong_script' | 'glossary' | 'condensed' | 'rushed' | 'overflow' | 'director';

export interface LocalizedSegment {
  id: string;
  segmentId: string;
  startTime: number;
  endTime: number;
  speaker: string;
  sourceText: string;
  translatedText: string;
  isEdited?: boolean;
  /** Delivery direction for the dubbed voice; starts as the original line's delivery and can be edited. */
  delivery?: string;
  qaFlags?: QaFlag[];
  /** What the AI review heard wrong in this line's last render (mispronounced word, flat delivery...); set with the `director` flag. */
  directorNote?: string;
  /** Server-owned fingerprint of what the last render spoke for this line; clients cannot set it. */
  renderKey?: string;
}

/** Lines of a rendered language that changed since its last render, and what re-rendering just those costs. */
export interface RetakeInfo {
  changedLineIds: string[];
  seconds: number;
  minutes: number;
}

/** A user's own defaults, saved to their account so they follow them to every device. */
export interface UserPreferences {
  /** Languages a new dub starts with already selected; empty means pick them each time. */
  defaultTargetLanguages: string[];
  defaultVoiceId: string;
  translationStyle: TranslationStyle;
  adaptExpressions: boolean;
  voiceEmotion: VoiceEmotion;
  voiceSpeed: number;
  /** Voice lines with emotion and delivery (Gemini-TTS); off uses the steadier standard voices. */
  expressiveVoices: boolean;
  separateBackground: boolean;
  autoLipSync: boolean;
  /** Whether video downloads start with captions burned in. */
  burnCaptions: boolean;
  /** Paid extra, off by default: an AI reviewer listens to every rendered line against the original and re-records the ones that came out wrong. */
  aiReview: boolean;
  /** Paid extra, off by default: lines are voiced by the premium Gemini-TTS model (performs sighs, richer delivery; about twice the voice cost). */
  premiumVoices: boolean;
  /** Paid extra, off by default: a line that does not fit its slot is voiced again at a better pace before any time-stretching. */
  paceRetakes: boolean;
}

/** A workspace glossary term: `keep` terms (brand names) are never translated, `translate` terms use the given per-language rendering. */
export interface GlossaryEntry {
  id: string;
  term: string;
  mode: 'keep' | 'translate';
  /** Language code -> required translation, for `translate` terms. */
  translations?: Record<string, string>;
  /** How the voice should say the term (a phonetic respelling), in every language. */
  spokenAs?: string;
  note?: string;
}

/**
 * One target language's slice of a project: its own translation, its own render, its own
 * progress. A project holds one of these per language it is being dubbed into.
 *
 * The transcript, the uploaded video, the voice and the separated background bed are all
 * shared across them — those are the expensive parts, and doing them once is the whole
 * point of dubbing several languages together rather than as separate projects.
 */
export interface LanguageOutput {
  languageCode: string;
  localizedSegments: LocalizedSegment[];
  /** Per-language, because one language can fail (no voice for it, provider outage) while the rest render fine. */
  status: ProjectStatus;
  progressPercent: number;
  message?: string;
  wordsCount?: number;
  dubbedAudioUrl?: string;
  finalDubbedVideoUrl?: string;
}

export interface DubbingProject {
  id: string;
  title: string;
  videoUrl: string;
  videoThumbnailUrl: string;
  videoFileName: string;
  videoDuration: number; // in seconds
  videoResolution: string;
  videoFileSize: string;
  sourceLanguage: string;
  /**
   * The project's primary language. Always the first entry of `targetLanguages`, and the
   * one the top-level `localizedSegments` / `finalDubbedVideoUrl` / caption export refer
   * to — so everything written before multi-language dubbing keeps working unchanged.
   */
  targetLanguage: string;
  /** Every language this project dubs into, primary first. Absent on projects created before multi-language support; treat as `[targetLanguage]`. */
  targetLanguages?: string[];
  /** Per-language translation and render state, keyed by language code. */
  languageOutputs?: Record<string, LanguageOutput>;
  selectedVoiceId: string;
  translationStyle: TranslationStyle;
  adaptExpressions: boolean;
  autoLipSync: boolean;
  /** Run vocal/background separation so music and ambience keep playing *under* the dubbed voice, not just between lines. Slow (CPU), so opt-in. */
  separateBackground?: boolean;
  voiceSpeed: number;
  voicePitch: number;
  voiceEmotion: VoiceEmotion;
  transcriptSegments: TranscriptSegment[];
  localizedSegments: LocalizedSegment[];
  dubbedAudioUrl?: string;
  finalDubbedVideoUrl?: string;
  status: ProjectStatus;
  currentStep: DubbingStep;
  progressPercent: number;
  currentProcessingMessage?: string;
  createdAt: string;
  updatedAt: string;
  wordsCount: number;
  speakersCount: number;
  /** Speaker label -> who that speaker is (gender, age), as heard during analysis. Absent on projects analyzed before profiles existed. */
  speakerProfiles?: Record<string, SpeakerProfile>;
  /** Speaker label (e.g. "Speaker 1") -> voice id, for videos with more than one detected speaker. Falls back to selectedVoiceId when a speaker has no override. */
  speakerVoiceMap?: Record<string, string>;
  /**
   * Language code -> voice id: the main voice for that language, so a project can be
   * dubbed with (say) a male Hindi voice and a female Spanish one. Falls back to
   * `selectedVoiceId` for any language with no entry.
   */
  languageVoiceMap?: Record<string, string>;
  /**
   * Language code -> speaker label -> voice id. The most specific choice there is: which
   * voice a given speaker gets *in a given language*. Falls back through
   * `languageVoiceMap`, then `speakerVoiceMap`, then `selectedVoiceId`.
   */
  languageSpeakerVoiceMap?: Record<string, Record<string, string>>;
  /** The job (dub or analysis) currently running on this project, if any. */
  activeJobId?: string | null;
  /** Language code -> edits waiting to be rendered, for languages whose last render recorded line fingerprints. Computed by the server. */
  retakeInfo?: Record<string, RetakeInfo>;
}

export interface TextToVoiceItem {
  id: string;
  title: string;
  scriptText: string;
  languageCode: string;
  voiceId: string;
  speed: number;
  pitch: number;
  emotion: VoiceEmotion;
  audioUrl?: string;
  duration: number;
  characterCount: number;
  wordCount: number;
  createdAt: string;
}

export interface SampleVideoPreset {
  id: string;
  title: string;
  description: string;
  duration: number; // in seconds
  durationFormatted: string;
  resolution: string;
  fileSize: string;
  detectedLanguage: string;
  speakerCount: number;
  videoUrl: string;
  thumbnailUrl: string;
}

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  type: 'success' | 'error' | 'info' | 'warning';
  timestamp: number;
}

export interface UserUsageStats {
  /** Minutes dubbed this calendar month; resets on the 1st. */
  minutesDubbed: number;
  minutesLimit: number;
  /** When this month's minutes refresh (ISO); set by the server. */
  resetsAt?: string;
  totalProjects: number;
  storageUsedMb: number;
  storageLimitMb: number;
  languagesUsed: number;
  wordsTranslated: number;
  activePlan: 'Starter' | 'Pro Studio' | 'Enterprise';
}
