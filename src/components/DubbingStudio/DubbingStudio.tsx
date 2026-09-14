/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
} from 'lucide-react';
import {
  DubbingProject,
  DubbingStep,
  LanguageOutput,
  LocalizedSegment,
  SampleVideoPreset,
  TranscriptSegment,
  TranslationStyle,
  Voice,
  VoiceEmotion,
} from '../../types';
import { SAMPLE_VIDEOS, LANGUAGES, VOICES } from '../../data/mockData';
import { StepUpload } from './StepUpload';
import { StepUnderstand } from './StepUnderstand';
import { StepLocalize } from './StepLocalize';
import { StepVoice } from './StepVoice';
import { StepProcessing } from './StepProcessing';
import { StepExport } from './StepExport';
import { speechToTextService } from '../../services/speechToTextService';
import { translationService } from '../../services/translationService';
import { videoService } from '../../services/videoService';
import { projectService } from '../../services/projectService';
import { voiceCloneService } from '../../services/voiceCloneService';
import { loadDubbingPreferences } from '../SettingsModal';
import { apiGet } from '../../lib/apiClient';

const savedPrefs = loadDubbingPreferences();
const STEP_ORDER: DubbingStep[] = ['upload', 'understand', 'localize', 'voice', 'export'];
const SWIPE_THRESHOLD_PX = 60;
/** Mirrors the server's own ceiling — every language is a full TTS + render pass. */
const MAX_TARGET_LANGUAGES = 10;

interface DubbingStudioProps {
  initialSampleId?: string | null;
  onSaveProject: (project: DubbingProject) => void;
  onOpenWorkspace: (project: DubbingProject) => void;
  onShowToast: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
}

export const DubbingStudio: React.FC<DubbingStudioProps> = ({
  initialSampleId,
  onSaveProject,
  onOpenWorkspace,
  onShowToast,
}) => {
  // Check if we start with an initial sample
  const initialPreset = initialSampleId
    ? SAMPLE_VIDEOS.find((s) => s.id === initialSampleId) || SAMPLE_VIDEOS[0]
    : null;

  const [currentStep, setCurrentStep] = useState<DubbingStep>('upload');

  // Real backend project id — created as soon as a video is picked, reused through
  // every subsequent step so the server always has the source of truth.
  const [projectId, setProjectId] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  // Tracks the furthest step index actually reached (via the step's own action button,
  // e.g. Analyze/Generate) — swipe/arrow/pip navigation can move freely within
  // [0, maxReachedIndex], but can never skip ahead of work that hasn't happened yet.
  const maxReachedIndexRef = useRef(0);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  React.useEffect(() => {
    // Guards against setState after unmount for the long-running upload/analyze/dub
    // requests below. React StrictMode mounts -> unmounts -> remounts once in dev, so
    // the flag must be reset to true here (not just via useRef's one-time initializer)
    // or it stays permanently false after that simulated unmount.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Video State
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(
    initialPreset ? initialPreset.videoUrl : null
  );
  const [fileName, setFileName] = useState<string>(
    initialPreset ? `${initialPreset.title}.mp4` : ''
  );
  const [fileSizeFormatted, setFileSizeFormatted] = useState<string>(
    initialPreset ? initialPreset.fileSize : ''
  );
  const [durationFormatted, setDurationFormatted] = useState<string>(
    initialPreset ? initialPreset.durationFormatted : '00:38'
  );
  const [videoDuration, setVideoDuration] = useState<number>(
    initialPreset ? initialPreset.duration : 38
  );
  const [resolution, setResolution] = useState<string>(
    initialPreset ? initialPreset.resolution : '1920 × 1080 (Full HD)'
  );
  const [detectedAudio, setDetectedAudio] = useState<string>('Not yet analyzed');
  const [detectedLanguage, setDetectedLanguage] = useState<string>('Pending analysis');
  const [sourceLanguageCode, setSourceLanguageCode] = useState<string>('en');
  const [activePresetId, setActivePresetId] = useState<string | undefined>(
    initialPreset ? initialPreset.id : undefined
  );
  const [isUploading, setIsUploading] = useState<boolean>(false);

  // Analysis State
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStage, setAnalysisStage] = useState(0);
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [speakersCount, setSpeakersCount] = useState<number>(1);
  const [speakerVoiceMap, setSpeakerVoiceMap] = useState<Record<string, string>>({});

  // Localization State
  // Several languages can be dubbed from one upload. The first entry is the primary one:
  // it drives the voice preview, the processing screen and the top-level project fields.
  const [targetLanguageCodes, setTargetLanguageCodes] = useState<string[]>([
    savedPrefs?.defaultTargetLang || 'hi',
  ]);
  // Which language the localize table shows and edits — the rest are still queued.
  const [activeLanguageCode, setActiveLanguageCode] = useState<string>(savedPrefs?.defaultTargetLang || 'hi');
  const [languageOutputs, setLanguageOutputs] = useState<Record<string, LanguageOutput>>({});
  const targetLanguageCode = targetLanguageCodes[0] || 'hi';
  const [translationStyle, setTranslationStyle] = useState<TranslationStyle>(
    (savedPrefs?.defaultStyle as TranslationStyle) || 'natural'
  );
  const [adaptExpressions, setAdaptExpressions] = useState<boolean>(savedPrefs?.adaptExpressions ?? true);
  const [isTranslating, setIsTranslating] = useState<boolean>(false);
  const [hasGeneratedTranslation, setHasGeneratedTranslation] = useState<boolean>(false);
  const [localizedSegments, setLocalizedSegments] = useState<DubbingProject['localizedSegments']>([]);

  // Voice State
  // `selectedVoiceId` / `speakerVoiceMap` are the project-wide defaults; the two maps
  // below override them per target language, so one dub can be a male Hindi voice and a
  // female Spanish one. `voiceLanguageCode` is just which language the picker is on.
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>(savedPrefs?.defaultVoice || 'riya');
  const [languageVoiceMap, setLanguageVoiceMap] = useState<Record<string, string>>({});
  const [languageSpeakerVoiceMap, setLanguageSpeakerVoiceMap] = useState<Record<string, Record<string, string>>>({});
  const [voiceLanguageCode, setVoiceLanguageCode] = useState<string>(savedPrefs?.defaultTargetLang || 'hi');
  const [customVoices, setCustomVoices] = useState<Voice[]>([]);
  const [voiceSpeed, setVoiceSpeed] = useState<number>(1.0);
  const [voicePitch, setVoicePitch] = useState<number>(1.0);
  const [voiceEmotion, setVoiceEmotion] = useState<VoiceEmotion>('friendly');
  const [autoLipSync, setAutoLipSync] = useState<boolean>(false);
  const [lipSyncAvailable, setLipSyncAvailable] = useState<boolean>(false);
  const [separateBackground, setSeparateBackground] = useState<boolean>(false);
  const [separationAvailable, setSeparationAvailable] = useState<boolean>(false);

  React.useEffect(() => {
    // The user's cloned voices are offered right alongside the catalog in StepVoice.
    voiceCloneService
      .list()
      .then((res) => setCustomVoices(res.voices.map((v) => voiceCloneService.toVoice(v))))
      .catch(() => setCustomVoices([]));
  }, []);

  React.useEffect(() => {
    apiGet<{ lipSyncAvailable: boolean; separationAvailable: boolean }>('/api/health')
      .then((res) => {
        setLipSyncAvailable(res.lipSyncAvailable);
        setSeparationAvailable(res.separationAvailable);
      })
      .catch(() => {
        setLipSyncAvailable(false);
        setSeparationAvailable(false);
      });
  }, []);

  // Processing & Export State
  const [isGeneratingDub, setIsGeneratingDub] = useState<boolean>(false);
  const [dubProgress, setDubProgress] = useState<number>(0);
  const [processingMessage, setProcessingMessage] = useState<string>('');

  // Completed Project Holder
  const [completedProject, setCompletedProject] = useState<DubbingProject | null>(null);

  // If we started from a sample preset, import it into a real backend project on mount.
  React.useEffect(() => {
    if (initialPreset) {
      void handleSelectSample(initialPreset);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stepsList: { id: DubbingStep; label: string; num: string }[] = [
    { id: 'upload', label: 'Upload', num: '01' },
    { id: 'understand', label: 'Understand', num: '02' },
    { id: 'localize', label: 'Localize', num: '03' },
    { id: 'voice', label: 'Voice', num: '04' },
    { id: 'export', label: 'Export', num: '05' },
  ];

  // Handle user selecting custom video file
  const handleFileSelected = async (file: File) => {
    setSelectedFile(file);
    setActivePresetId(undefined);
    setIsUploading(true);

    // Instant client-side preview while the real upload runs.
    const meta = await videoService.parseVideoFile(file);
    setVideoPreviewUrl(meta.previewUrl);
    setFileName(meta.fileName);
    setFileSizeFormatted(meta.fileSizeFormatted);
    setDurationFormatted(meta.durationFormatted);
    setVideoDuration(meta.durationSeconds);
    setResolution(meta.resolution);
    setDetectedAudio(meta.detectedAudio);
    setDetectedLanguage(meta.detectedLanguage);

    try {
      const draft = await projectService.createDraft(
        file.name.replace(/\.[^/.]+$/, ''),
        'en',
        targetLanguageCode
      );
      setProjectId(draft.id);
      const uploaded = await projectService.uploadVideo(draft.id, file);
      setDurationFormatted(videoService.formatDuration(uploaded.videoDuration));
      setVideoDuration(uploaded.videoDuration);
      setResolution(uploaded.videoResolution);
      setFileSizeFormatted(uploaded.videoFileSize);
      onShowToast('Video Uploaded', `${file.name} ready for AI analysis.`, 'success');
    } catch (err) {
      onShowToast('Upload Failed', (err as Error).message, 'error');
    } finally {
      if (isMountedRef.current) setIsUploading(false);
    }
  };

  // Handle user selecting sample preset — imports the real file server-side and runs
  // the exact same pipeline as an upload (no canned transcript/translation shortcuts).
  const handleSelectSample = async (sample: SampleVideoPreset) => {
    setSelectedFile(null);
    setActivePresetId(sample.id);
    setVideoPreviewUrl(sample.videoUrl);
    setFileName(`${sample.title}.mp4`);
    setFileSizeFormatted(sample.fileSize);
    setDurationFormatted(sample.durationFormatted);
    setVideoDuration(sample.duration);
    setResolution(sample.resolution);
    setDetectedAudio('Speech detected · 1 speaker');
    setDetectedLanguage(sample.detectedLanguage);
    setTranscriptSegments([]);
    setIsUploading(true);

    try {
      const draft = await projectService.createDraft(sample.title, 'en', targetLanguageCode);
      setProjectId(draft.id);
      const imported = await projectService.importSample(draft.id, sample.videoUrl, `${sample.title}.mp4`);
      setDurationFormatted(videoService.formatDuration(imported.videoDuration));
      setVideoDuration(imported.videoDuration);
      setResolution(imported.videoResolution);
      setFileSizeFormatted(imported.videoFileSize);
      onShowToast('Sample Loaded', `${sample.title} ready for dubbing.`, 'info');
    } catch (err) {
      onShowToast('Sample Import Failed', (err as Error).message, 'error');
    } finally {
      if (isMountedRef.current) setIsUploading(false);
    }
  };

  /** Adds or removes a target language, never leaving the selection empty. */
  const handleToggleTargetLanguage = (code: string) => {
    setTargetLanguageCodes((prev) => {
      if (prev.includes(code)) {
        // Keeping at least one selected means the Generate button never becomes a no-op.
        if (prev.length === 1) return prev;
        const next = prev.filter((c) => c !== code);
        setActiveLanguageCode((active) => (active === code ? next[0] : active));
        return next;
      }
      if (prev.length >= MAX_TARGET_LANGUAGES) {
        onShowToast(
          'Language Limit Reached',
          `You can dub into ${MAX_TARGET_LANGUAGES} languages at a time.`,
          'info'
        );
        return prev;
      }
      return [...prev, code];
    });
    setHasGeneratedTranslation(false);
  };

  /** Pulls one language's translated lines out of the project the server returned. */
  const segmentsForLanguage = (project: DubbingProject, code: string): LocalizedSegment[] =>
    project.languageOutputs?.[code]?.localizedSegments ||
    (project.targetLanguage === code ? project.localizedSegments : []) ||
    [];

  const handleResetVideo = () => {
    setSelectedFile(null);
    setVideoPreviewUrl(null);
    setActivePresetId(undefined);
    setProjectId(null);
    setTranscriptSegments([]);
    setLocalizedSegments([]);
    setHasGeneratedTranslation(false);
    setCurrentStep('upload');
  };

  // STEP 1 -> STEP 2: Analyze Video (real STT)
  const handleAnalyzeVideo = async () => {
    if (!videoPreviewUrl || !projectId) return;
    setIsAnalyzing(true);
    setCurrentStep('understand');
    setAnalysisStage(1);

    setTimeout(() => setAnalysisStage(2), 500);
    setTimeout(() => setAnalysisStage(3), 1000);
    setTimeout(() => setAnalysisStage(4), 1500);

    try {
      const res = await speechToTextService.transcribe(projectId);
      setAnalysisStage(5);
      setTranscriptSegments(res.segments);
      setDetectedLanguage(res.language);
      setSourceLanguageCode(res.languageCode);
      setSpeakersCount(res.speakersCount);
      setSpeakerVoiceMap(res.speakerVoiceMap);
      setDetectedAudio(
        res.segments.length > 0
          ? `Speech detected · ${res.wordsCount} words transcribed · ${res.speakersCount} speaker${res.speakersCount > 1 ? 's' : ''}`
          : 'No speech detected'
      );
      onShowToast(
        'Analysis Complete',
        `Detected ${res.wordsCount} words${res.speakersCount > 1 ? ` from ${res.speakersCount} speakers` : ''}.`,
        'success'
      );
      // Said out loud rather than silently showing fewer lines than the model returned —
      // otherwise a transcript that lost 200 phantom lines just looks unexplained.
      if (res.removedSegments > 0) {
        onShowToast(
          'Cleaned Up Transcript',
          `${res.sanitizeNote}. This is normal on videos with music or long pauses.`,
          'info'
        );
      }
    } catch (err) {
      onShowToast('Analysis Failed', (err as Error).message, 'error');
      setCurrentStep('upload');
    } finally {
      if (isMountedRef.current) setIsAnalyzing(false);
    }
  };

  // STEP 2 -> STEP 3: Continue to Localization
  const handleContinueToLocalization = () => {
    // Don't auto-translate here — targetLanguageCode is still whatever the default
    // (or last) selection was, not necessarily what the user wants for this project.
    // Let them pick a language on this screen and hit "Generate Translation" themselves.
    setCurrentStep('localize');
  };

  // STEP 3: Generate Translation — every selected language in one call.
  const handleGenerateTranslation = async () => {
    if (!projectId) return;
    setIsTranslating(true);
    try {
      const project = await translationService.translateSegments(
        projectId,
        targetLanguageCodes,
        translationStyle,
        adaptExpressions,
        // Only the explicit "Regenerate" press re-buys translations that already exist;
        // a first pass (or an added language) reuses whatever is already there.
        hasGeneratedTranslation
      );
      const active = targetLanguageCodes.includes(activeLanguageCode) ? activeLanguageCode : targetLanguageCodes[0];
      setActiveLanguageCode(active);
      setLanguageOutputs(project.languageOutputs || {});
      setLocalizedSegments(segmentsForLanguage(project, active));
      setHasGeneratedTranslation(true);
      const names = targetLanguageCodes
        .map((code) => LANGUAGES.find((l) => l.code === code)?.name || code)
        .join(', ');
      onShowToast(
        'Translation Ready',
        `Localized into ${names} with ${translationStyle} style.`,
        'success'
      );
    } catch (err) {
      onShowToast('Translation Failed', (err as Error).message, 'error');
    } finally {
      if (isMountedRef.current) setIsTranslating(false);
    }
  };

  /** Switches which language the localize table is showing. */
  const handleSelectActiveLanguage = (code: string) => {
    setActiveLanguageCode(code);
    setLocalizedSegments(languageOutputs[code]?.localizedSegments || []);
  };

  // STEP 3 -> STEP 4: Continue to Voice
  const handleContinueToVoice = () => {
    // Seed each language that has no voice yet with one native to it, so a fresh
    // multi-language project starts out sounding right rather than all one voice.
    setLanguageVoiceMap((prev) => {
      const next = { ...prev };
      for (const code of targetLanguageCodes) {
        if (next[code]) continue;
        const nativeVoice = VOICES.find((v) => v.languageCode === code);
        if (nativeVoice) next[code] = nativeVoice.id;
      }
      return next;
    });
    const matchingVoice = VOICES.find((v) => v.languageCode === targetLanguageCode);
    if (matchingVoice) setSelectedVoiceId(matchingVoice.id);
    setVoiceLanguageCode((current) => (targetLanguageCodes.includes(current) ? current : targetLanguageCode));
    setCurrentStep('voice');
  };

  /** The voice a language currently uses, falling back to the project-wide pick. */
  const voiceForLanguage = (code: string) => languageVoiceMap[code] || selectedVoiceId;

  /** The speaker->voice overrides in force for a language. */
  const speakerVoicesForLanguage = (code: string) => languageSpeakerVoiceMap[code] || speakerVoiceMap;

  const handleSelectVoice = (voiceId: string) => {
    setLanguageVoiceMap((prev) => ({ ...prev, [voiceLanguageCode]: voiceId }));
    // The primary language also writes the project-wide field, so a single-language
    // project (and anything reading a project the old way) still sees the right voice.
    if (voiceLanguageCode === targetLanguageCode) setSelectedVoiceId(voiceId);
  };

  const handleSelectVoiceForSpeaker = (speaker: string, voiceId: string) => {
    setLanguageSpeakerVoiceMap((prev) => ({
      ...prev,
      // Seeded from the auto-assigned map the transcribe step produced, so overriding one
      // speaker in one language doesn't discard the distinct voices given to the others.
      [voiceLanguageCode]: { ...(prev[voiceLanguageCode] || speakerVoiceMap), [speaker]: voiceId },
    }));
    if (voiceLanguageCode === targetLanguageCode) {
      setSpeakerVoiceMap((prev) => ({ ...prev, [speaker]: voiceId }));
    }
  };

  // STEP 4 -> STEP 5: Generate Dub (real TTS + ffmpeg render, polled from Firestore)
  const handleGenerateDub = async () => {
    if (!projectId) return;
    setIsGeneratingDub(true);
    setCurrentStep('export');
    setDubProgress(5);
    setProcessingMessage('Starting dubbing pipeline...');

    try {
      await projectService.startDub(projectId, {
        voiceId: selectedVoiceId,
        voiceSpeed,
        voicePitch,
        voiceEmotion,
        speakerVoiceMap,
        // Sent filled in for every selected language rather than only the ones the user
        // touched, so the render never has to guess what an unvisited tab meant.
        languageVoiceMap: Object.fromEntries(
          targetLanguageCodes.map((code) => [code, voiceForLanguage(code)])
        ),
        languageSpeakerVoiceMap: Object.fromEntries(
          targetLanguageCodes.map((code) => [code, speakerVoicesForLanguage(code)])
        ),
        autoLipSync,
        separateBackground,
      });
    } catch (err) {
      setIsGeneratingDub(false);
      onShowToast('Dubbing Failed to Start', (err as Error).message, 'error');
      setCurrentStep('voice');
      return;
    }

    const poll = async () => {
      if (!isMountedRef.current) return;
      try {
        const proj = await projectService.get(projectId);
        if (!isMountedRef.current) return;
        setDubProgress(proj.progressPercent);
        setProcessingMessage(proj.currentProcessingMessage || '');

        if (proj.status === 'completed') {
          setIsGeneratingDub(false);
          setCompletedProject(proj);
          onSaveProject(proj);
          onShowToast('Dubbing Finished!', 'Your localized video is ready for export.', 'success');
          return;
        }
        if (proj.status === 'failed') {
          setIsGeneratingDub(false);
          onShowToast('Dubbing Failed', proj.currentProcessingMessage || 'Something went wrong.', 'error');
          setCurrentStep('voice');
          return;
        }
        setTimeout(poll, 1500);
      } catch (err) {
        if (!isMountedRef.current) return;
        setIsGeneratingDub(false);
        onShowToast('Dubbing Failed', (err as Error).message, 'error');
        setCurrentStep('voice');
      }
    };
    void poll();
  };

  // Add another language to a finished project, without re-uploading. Languages that are
  // already translated are reused server-side, so this only pays for the new one.
  const handleDubAnotherLanguage = async (newLangCode: string) => {
    if (!projectId) return;
    if (targetLanguageCodes.length >= MAX_TARGET_LANGUAGES && !targetLanguageCodes.includes(newLangCode)) {
      onShowToast('Language Limit Reached', `You can dub into ${MAX_TARGET_LANGUAGES} languages at a time.`, 'info');
      return;
    }
    const nextCodes = targetLanguageCodes.includes(newLangCode)
      ? targetLanguageCodes
      : [...targetLanguageCodes, newLangCode];
    setTargetLanguageCodes(nextCodes);
    setActiveLanguageCode(newLangCode);
    setCurrentStep('localize');
    setIsTranslating(true);
    try {
      const project = await translationService.translateSegments(
        projectId,
        nextCodes,
        translationStyle,
        adaptExpressions,
        false
      );
      setLanguageOutputs(project.languageOutputs || {});
      setLocalizedSegments(segmentsForLanguage(project, newLangCode));
      setHasGeneratedTranslation(true);

      const langObj = LANGUAGES.find((l) => l.code === newLangCode);
      onShowToast('Language Added', `Ready to dub into ${langObj?.name}.`, 'info');
    } catch (err) {
      onShowToast('Translation Failed', (err as Error).message, 'error');
    } finally {
      if (isMountedRef.current) setIsTranslating(false);
    }
  };

  // Transcript editing handlers — persisted immediately so the server-side dub
  // pipeline (which reads the stored project, not local state) picks up edits.
  const handleUpdateSegment = async (segmentId: string, newText: string) => {
    const updated = transcriptSegments.map((s) =>
      s.id === segmentId ? { ...s, text: newText, wordsCount: newText.split(/\s+/).filter(Boolean).length } : s
    );
    setTranscriptSegments(updated);
    if (projectId) {
      try {
        await projectService.patch(projectId, { transcriptSegments: updated });
      } catch {
        // best-effort — local state is already updated for display
      }
    }
    onShowToast('Transcript Updated', 'Segment saved.', 'info');
  };

  const handleAddSegment = async () => {
    const lastSeg = transcriptSegments[transcriptSegments.length - 1];
    const newStart = lastSeg ? lastSeg.endTime + 0.5 : 0;
    const newSeg: TranscriptSegment = {
      id: `seg-${Date.now()}`,
      startTime: newStart,
      endTime: newStart + 4.0,
      text: 'New dialogue segment to be localized.',
      speaker: 'Speaker 1',
      wordsCount: 6,
      confidence: 0.99,
    };
    const updated = [...transcriptSegments, newSeg];
    setTranscriptSegments(updated);
    if (projectId) {
      try {
        await projectService.patch(projectId, { transcriptSegments: updated });
      } catch {
        // best-effort
      }
    }
  };

  const handleDeleteSegment = async (segmentId: string) => {
    const updated = transcriptSegments.filter((s) => s.id !== segmentId);
    setTranscriptSegments(updated);
    if (projectId) {
      try {
        await projectService.patch(projectId, { transcriptSegments: updated });
      } catch {
        // best-effort
      }
    }
  };

  const handleUpdateLocalizedSegment = async (id: string, text: string) => {
    const updated = localizedSegments.map((s) => (s.id === id ? { ...s, translatedText: text, isEdited: true } : s));
    setLocalizedSegments(updated);
    setLanguageOutputs((prev) => ({
      ...prev,
      [activeLanguageCode]: {
        ...(prev[activeLanguageCode] || { languageCode: activeLanguageCode, status: 'draft', progressPercent: 0 }),
        localizedSegments: updated,
      },
    }));
    if (projectId) {
      try {
        // Saved against the language being edited, not the project as a whole — otherwise
        // an edit to one language would land on whichever one happens to be primary.
        await projectService.updateLanguageSegments(projectId, activeLanguageCode, updated);
      } catch {
        // best-effort — local state is already updated for display
      }
    }
    onShowToast('Translation Updated', 'Segment saved.', 'info');
  };

  const targetLang = LANGUAGES.find((l) => l.code === targetLanguageCode) || LANGUAGES[0];
  const selectedVoice =
    [...customVoices, ...VOICES].find((v) => v.id === voiceForLanguage(voiceLanguageCode)) || VOICES[0];
  const wordsCount = transcriptSegments.reduce((sum, s) => sum + s.wordsCount, 0);
  const secondsRemaining = Math.max(0, Math.round((100 - dubProgress) * 0.7));

  const currentStepIndex = STEP_ORDER.indexOf(currentStep);
  maxReachedIndexRef.current = Math.max(maxReachedIndexRef.current, currentStepIndex);
  const canGoToIndex = (idx: number) => idx >= 0 && idx <= maxReachedIndexRef.current;
  const goToIndex = (idx: number) => {
    if (canGoToIndex(idx)) setCurrentStep(STEP_ORDER[idx]);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    // Only treat it as a step-swipe when the gesture is clearly more horizontal than
    // vertical (so scrolling a tall step's content, e.g. the transcript list, is
    // unaffected) and past a minimum distance.
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0) goToIndex(currentStepIndex + 1);
    else goToIndex(currentStepIndex - 1);
  };

  // Plain render helper (not a component) so re-renders never remount step content —
  // a nested component function would get a fresh identity every render and React
  // would tear down/rebuild each step's DOM (losing focus/scroll/local state) on every
  // parent state update, which happens constantly here (polling, typing, etc).
  const renderStepContent = (step: DubbingStep) => (
    <>
      {step === 'upload' && (
        <StepUpload
          selectedFile={selectedFile}
          videoPreviewUrl={videoPreviewUrl}
          fileName={fileName}
          fileSizeFormatted={fileSizeFormatted}
          durationFormatted={durationFormatted}
          resolution={resolution}
          detectedAudio={detectedAudio}
          detectedLanguage={detectedLanguage}
          isAnalyzing={isAnalyzing}
          isUploading={isUploading}
          onFileSelected={handleFileSelected}
          onSelectSample={handleSelectSample}
          onAnalyzeVideo={handleAnalyzeVideo}
          onResetVideo={handleResetVideo}
        />
      )}

      {step === 'understand' && (
        <StepUnderstand
          isAnalyzing={isAnalyzing}
          analysisStage={analysisStage}
          videoPreviewUrl={videoPreviewUrl || ''}
          transcriptSegments={transcriptSegments}
          wordsCount={wordsCount}
          speakersCount={speakersCount}
          detectedLanguage={detectedLanguage}
          onUpdateSegment={handleUpdateSegment}
          onAddSegment={handleAddSegment}
          onDeleteSegment={handleDeleteSegment}
          onContinue={handleContinueToLocalization}
        />
      )}

      {step === 'localize' && (
        <StepLocalize
          sourceLanguageCode={sourceLanguageCode}
          targetLanguageCodes={targetLanguageCodes}
          activeLanguageCode={activeLanguageCode}
          translationStyle={translationStyle}
          adaptExpressions={adaptExpressions}
          transcriptSegments={transcriptSegments}
          localizedSegments={localizedSegments}
          isTranslating={isTranslating}
          hasGeneratedTranslation={hasGeneratedTranslation}
          translatedLanguageCodes={Object.keys(languageOutputs).filter(
            (code) => (languageOutputs[code]?.localizedSegments?.length || 0) > 0
          )}
          onToggleTargetLanguage={handleToggleTargetLanguage}
          onSelectActiveLanguage={handleSelectActiveLanguage}
          onChangeStyle={(style) => {
            setTranslationStyle(style);
            setHasGeneratedTranslation(false);
          }}
          onToggleAdaptExpressions={() => setAdaptExpressions(!adaptExpressions)}
          onGenerateTranslation={handleGenerateTranslation}
          onUpdateLocalizedSegment={handleUpdateLocalizedSegment}
          onContinueToVoice={handleContinueToVoice}
          onShowToast={onShowToast}
        />
      )}

      {step === 'voice' && (
        <StepVoice
          selectedVoiceId={voiceForLanguage(voiceLanguageCode)}
          targetLanguageCode={targetLanguageCode}
          targetLanguageCodes={targetLanguageCodes}
          customVoices={customVoices}
          voiceLanguageCode={voiceLanguageCode}
          onSelectVoiceLanguage={setVoiceLanguageCode}
          voiceForLanguage={voiceForLanguage}
          voiceSpeed={voiceSpeed}
          voicePitch={voicePitch}
          voiceEmotion={voiceEmotion}
          speakersCount={speakersCount}
          speakerVoiceMap={speakerVoicesForLanguage(voiceLanguageCode)}
          transcriptSegments={transcriptSegments}
          autoLipSync={autoLipSync}
          lipSyncAvailable={lipSyncAvailable}
          separateBackground={separateBackground}
          separationAvailable={separationAvailable}
          onToggleSeparateBackground={setSeparateBackground}
          onSelectVoice={handleSelectVoice}
          onSelectVoiceForSpeaker={handleSelectVoiceForSpeaker}
          onChangeSpeed={setVoiceSpeed}
          onChangePitch={setVoicePitch}
          onChangeEmotion={setVoiceEmotion}
          onToggleLipSync={setAutoLipSync}
          onGenerateDub={handleGenerateDub}
          onShowToast={onShowToast}
        />
      )}

      {step === 'export' && (
        isGeneratingDub ? (
          <StepProcessing
            targetLanguageName={
              targetLanguageCodes.length > 1
                ? `${targetLanguageCodes.length} languages`
                : targetLang.name
            }
            voiceName={selectedVoice.name}
            videoPreviewUrl={videoPreviewUrl || ''}
            progressPercent={dubProgress}
            secondsRemaining={secondsRemaining}
            statusMessage={processingMessage}
          />
        ) : (
          completedProject && (
            <StepExport
              project={completedProject}
              onDubAnotherLanguage={handleDubAnotherLanguage}
              onRestartProject={handleResetVideo}
              onOpenWorkspace={() => onOpenWorkspace(completedProject)}
              onShowToast={onShowToast}
            />
          )
        )
      )}
    </>
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Studio Header & Stepper */}
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">
              Video Dubbing
            </h2>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Upload a video and we'll translate its existing speech into another language.
            </p>
          </div>

          {currentStep !== 'upload' && !isGeneratingDub && (
            <button
              type="button"
              onClick={() => {
                const prevIdx = Math.max(0, STEP_ORDER.indexOf(currentStep) - 1);
                setCurrentStep(STEP_ORDER[prevIdx]);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#F8FAFC] hover:bg-slate-100 text-slate-600 text-xs font-semibold border border-[#E2E8F0] self-start sm:self-auto transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back Step</span>
            </button>
          )}
        </div>

        {/* Step Indicator with Professional Polish step lines & badges */}
        <div className="glass-panel p-4 rounded-2xl overflow-x-auto custom-scrollbar">
          <div className="flex items-center justify-between min-w-[620px] px-4">
            {stepsList.map((st, idx) => {
              const isPast = idx < currentStepIndex;
              const isCurrent = currentStep === st.id;
              const isReachable = canGoToIndex(idx);

              return (
                <React.Fragment key={st.id}>
                  <button
                    type="button"
                    onClick={() => goToIndex(idx)}
                    disabled={!isReachable}
                    className={`flex items-center gap-2.5 transition-all text-left group ${
                      !isReachable ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                    }`}
                  >
                    <div
                      className={`w-6 h-6 rounded-full text-[10px] flex items-center justify-center font-bold transition-all ${
                        isCurrent
                          ? 'bg-[#F05637] text-white shadow-[0_0_15px_rgba(240,86,55,0.4)]'
                          : isPast
                          ? 'bg-emerald-600 text-white'
                          : 'border border-[#E2E8F0] text-[#64748B] bg-[#FFFFFF]'
                      }`}
                    >
                      {isPast ? <CheckCircle2 className="w-3.5 h-3.5 text-white" /> : st.num}
                    </div>
                    <span
                      className={`text-xs font-medium transition-colors ${
                        isCurrent
                          ? 'text-[#0F172A] font-semibold'
                          : isPast
                          ? 'text-emerald-600'
                          : 'text-[#64748B] group-hover:text-slate-600'
                      }`}
                    >
                      {st.label}
                    </span>
                  </button>

                  {idx < stepsList.length - 1 && (
                    <div
                      className={`step-line ${
                        idx < currentStepIndex ? 'active-step-line' : ''
                      }`}
                    />
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* Swipeable step viewport — each step is its own full-height, independently
          scrolling pane; swipe (touch) or the arrow buttons move between panes instead
          of scrolling down one long page. */}
      <div className="relative">
        <button
          type="button"
          onClick={() => goToIndex(currentStepIndex - 1)}
          disabled={!canGoToIndex(currentStepIndex - 1)}
          aria-label="Previous step"
          className="hidden lg:flex absolute -left-14 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full items-center justify-center bg-[#F8FAFC] border border-[#E2E8F0] text-[#64748B] hover:text-[#D94B2E] hover:border-[#CBD5E1] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <button
          type="button"
          onClick={() => goToIndex(currentStepIndex + 1)}
          disabled={!canGoToIndex(currentStepIndex + 1)}
          aria-label="Next step"
          className="hidden lg:flex absolute -right-14 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full items-center justify-center bg-[#F8FAFC] border border-[#E2E8F0] text-[#64748B] hover:text-[#D94B2E] hover:border-[#CBD5E1] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronRight className="w-5 h-5" />
        </button>

        <div
          className="overflow-hidden"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <div
            className="flex transition-transform duration-300 ease-out"
            style={{ transform: `translateX(-${currentStepIndex * 100}%)` }}
          >
            {STEP_ORDER.map((step) => (
              <div
                key={step}
                className="w-full shrink-0 max-h-[75vh] min-h-[360px] overflow-y-auto custom-scrollbar px-0.5"
              >
                {step === currentStep && renderStepContent(step)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
