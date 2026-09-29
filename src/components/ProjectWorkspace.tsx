/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Clock,
  Download,
  FileText,
  Languages,
  Loader2,
  Mic,
  Monitor,
  Pause,
  Play,
  PlayCircle,
  Plus,
  RotateCcw,
  Share2,
  Users,
  Video,
  Volume2,
  Wand2,
} from 'lucide-react';
import { DubbingProject, LocalizedSegment, Voice, VoiceEngine } from '../types';
import { LANGUAGES, VOICES } from '../data/mockData';
import { enginesLabel, listedEngines, VOICE_ENGINE_INFO, VOICE_ENGINES, voiceAllowed } from '../lib/voiceEngines';
import { VoiceEngineBadge } from './VoiceEngineBadge';
import { projectService } from '../services/projectService';
import { VideoPlayer } from './VideoPlayer';
import { textToSpeechService } from '../services/textToSpeechService';
import { resolveVoice } from '../lib/voiceResolution';
import { DeliveryInput, DeliveryTag, insertTagAtCursor, needsReview, PerformanceTagPicker, QaFlagBadges, ReviewFilterToggle } from './LineReview';
import { notifyWorkDone } from '../lib/devicePrefs';
import { projectProgress } from '../lib/projectProgress';
import { ProjectStatusBadge } from './ProjectStatusBadge';
import { ShareDialog } from './ShareDialog';
import { dubbedLanguagesOf, formatClock, QualityPanel, StatTile, SyncedScript } from './DubResult';
import { ExportPanel } from './ExportPanel';

interface ProjectWorkspaceProps {
  project: DubbingProject;
  onBack: () => void;
  onUpdateProject: (updated: DubbingProject) => void;
  /** Shows a project the server just returned, without saving it back. */
  onProjectRefreshed: (fresh: DubbingProject) => void;
  onShowToast: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
  /** Allowance used per dubbed minute with the user's paid extras (1 with none), so estimates match what is charged. */
  allowanceRate?: number;
  /** The voice engines the workspace's plan includes; the other voices are shown locked. */
  voiceEngines?: VoiceEngine[];
  /** Opens the studio on this project to add languages, without re-uploading. */
  onDubMoreLanguages?: (project: DubbingProject) => void;
  /** The user's saved default for captioned downloads. */
  defaultBurnCaptions?: boolean;
}

type Tab = 'overview' | 'translation' | 'transcript' | 'voice' | 'export';

export const ProjectWorkspace: React.FC<ProjectWorkspaceProps> = ({
  allowanceRate = 1,
  voiceEngines = VOICE_ENGINES,
  project,
  onBack,
  onUpdateProject,
  onProjectRefreshed,
  onShowToast,
  onDubMoreLanguages,
  defaultBurnCaptions = false,
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [editingSegId, setEditingSegId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const translationEditorRef = React.useRef<HTMLTextAreaElement>(null);
  // One language drives the whole workspace: what plays, which script shows, what the export tab downloads.
  const [viewLanguage, setViewLanguage] = useState<string>(project.targetLanguage);
  const [seekTo, setSeekTo] = useState<number | undefined>(undefined);
  const [playhead, setPlayhead] = useState(0);
  const [activeTrack, setActiveTrack] = useState<'dubbed' | 'original'>('dubbed');
  const [showShare, setShowShare] = useState(false);

  // Which language the Voice tab is editing, and the voice picked for it. Held locally
  // until the user re-dubs, because picking a voice changes nothing on its own — the audio
  // only changes when it is rendered again.
  const [voiceLanguage, setVoiceLanguage] = useState<string>(project.targetLanguage);
  const [pendingVoiceId, setPendingVoiceId] = useState<string | null>(null);
  const [isRedubbing, setIsRedubbing] = useState<boolean>(false);
  const [redubProgress, setRedubProgress] = useState<number>(0);
  const [redubMessage, setRedubMessage] = useState<string>('');
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const [editDelivery, setEditDelivery] = useState('');
  const [reviewOnly, setReviewOnly] = useState(false);
  // The language whose edited lines are being re-rendered, with the run's progress.
  const [retake, setRetake] = useState<{ language: string; progress: number; message: string } | null>(null);

  // The project list leaves out which edited lines are waiting for a render, so the full project is loaded on open.
  useEffect(() => {
    projectService
      .get(project.id)
      .then(onProjectRefreshed)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const languages = useMemo(() => dubbedLanguagesOf(project), [project]);
  const active = languages.find((l) => l.code === viewLanguage) || languages[0];
  const sourceLang = LANGUAGES.find((l) => l.code === project.sourceLanguage) || LANGUAGES.find((l) => l.code === 'en')!;
  const availableVoices = VOICES;
  // Voices the plan can use first; the others are listed after them, locked.
  const pickerVoices = useMemo(() => {
    const shownEngines = listedEngines(voiceEngines);
    return VOICES.filter((v) => shownEngines.includes(v.engine)).sort((a, b) => Number(!voiceAllowed(a, voiceEngines)) - Number(!voiceAllowed(b, voiceEngines)));
  }, [voiceEngines]);
  const projectLanguages = languages.map((l) => l.code);
  const readyCount = languages.filter((l) => l.videoUrl).length;

  /** The voice currently assigned to a language, before any unsaved pick. */
  const savedVoiceForLanguage = (code: string) => project.languageVoiceMap?.[code] || project.selectedVoiceId;
  const activeVoiceName = availableVoices.find((v) => v.id === savedVoiceForLanguage(active?.code || project.targetLanguage))?.name.replace(/\s*\(.*\)$/, '') || 'AI voice';

  const translationSegments: LocalizedSegment[] = active?.segments || [];
  const translationLang = active?.language || LANGUAGES[0];

  const activeVoiceId = pendingVoiceId ?? savedVoiceForLanguage(voiceLanguage);
  const hasVoiceChange = pendingVoiceId !== null && pendingVoiceId !== savedVoiceForLanguage(voiceLanguage);

  // A jump belongs to the moment it was made: coming back to Watch later must not replay it.
  useEffect(() => {
    if (activeTab !== 'overview') setSeekTo(undefined);
  }, [activeTab]);

  // The same number twice would not move the player, so each jump is nudged by a hair.
  const jumpTo = (time: number) => {
    setSeekTo(time + Math.random() * 1e-4);
    setActiveTab('overview');
  };

  const handleUpdateTranscriptSegment = (segmentId: string, newText: string) => {
    const updatedSegments = project.transcriptSegments.map((s) => (s.id === segmentId ? { ...s, text: newText } : s));
    onUpdateProject({ ...project, transcriptSegments: updatedSegments });
    setEditingSegId(null);
    onShowToast('Transcript Updated', 'Segment text saved.', 'success');
  };

  const handleUpdateLocalizedSegment = async (locId: string, newText: string, delivery: string) => {
    const updatedLoc = translationSegments.map((s) =>
      s.id === locId ? { ...s, translatedText: newText, delivery: delivery.trim() || undefined, isEdited: true } : s
    );
    try {
      // The dedicated per-language endpoint, not the generic project patch: the generic one
      // only ever writes the primary language's lines.
      const saved = await projectService.updateLanguageSegments(project.id, translationLang.code, updatedLoc);
      onProjectRefreshed(saved);
      setEditingSegId(null);
      onShowToast('Translation Updated', 'Saved. Update the dub to hear it.', 'success');
    } catch (err) {
      onShowToast('Save Failed', (err as Error).message, 'error');
    }
  };

  /**
   * Re-renders one language with the newly picked voice. Picking a voice alone changes
   * nothing — the audio is a rendered file — so this re-dubs just that language.
   */
  const handleRedubWithVoice = async () => {
    if (!pendingVoiceId) return;
    const voice = availableVoices.find((v) => v.id === pendingVoiceId);
    const langName = LANGUAGES.find((l) => l.code === voiceLanguage)?.name || voiceLanguage;

    setIsRedubbing(true);
    setRedubProgress(5);
    setRedubMessage(`Starting ${langName} re-dub...`);

    try {
      await projectService.startDub(project.id, {
        voiceId: voiceLanguage === project.targetLanguage ? pendingVoiceId : project.selectedVoiceId,
        voiceSpeed: project.voiceSpeed,
        voicePitch: project.voicePitch,
        voiceEmotion: project.voiceEmotion,
        speakerVoiceMap: project.speakerVoiceMap,
        languageVoiceMap: { ...project.languageVoiceMap, [voiceLanguage]: pendingVoiceId },
        languageSpeakerVoiceMap: project.languageSpeakerVoiceMap,
        autoLipSync: project.autoLipSync,
        separateBackground: project.separateBackground,
        // Only this language re-renders; the others keep the files they already have.
        languages: [voiceLanguage],
      });
    } catch (err) {
      setIsRedubbing(false);
      onShowToast('Re-dub Failed to Start', (err as Error).message, 'error');
      return;
    }

    const poll = async () => {
      try {
        const fresh = await projectService.get(project.id);
        setRedubProgress(fresh.progressPercent);
        setRedubMessage(fresh.currentProcessingMessage || '');

        if (fresh.status === 'completed') {
          setIsRedubbing(false);
          setPendingVoiceId(null);
          onUpdateProject(fresh);
          onShowToast('Re-dub Complete', `${langName} now uses ${voice?.name}.`, 'success');
          notifyWorkDone('Re-dub complete', `${project.title}: ${langName} now uses ${voice?.name}.`);
          return;
        }
        if (fresh.status === 'failed') {
          setIsRedubbing(false);
          onShowToast('Re-dub Failed', fresh.currentProcessingMessage || 'Something went wrong.', 'error');
          return;
        }
        setTimeout(poll, 1500);
      } catch (err) {
        setIsRedubbing(false);
        onShowToast('Re-dub Failed', (err as Error).message, 'error');
      }
    };
    void poll();
  };

  const pendingRetake = project.retakeInfo?.[translationLang.code];
  const changedLineIds = new Set(pendingRetake?.changedLineIds ?? []);
  const flaggedCount = translationSegments.filter(needsReview).length;
  const shownTranslationSegments = reviewOnly ? translationSegments.filter(needsReview) : translationSegments;

  // Plays a line in the voice its speaker gets in this language, directed the way the dub directs it.
  const handlePreviewLine = (loc: LocalizedSegment) => {
    const voice = resolveVoice(project, translationLang.code, loc.speaker, availableVoices);
    textToSpeechService.speakText(loc.translatedText, voice, translationLang.code, {
      onError: (err) => onShowToast('Playback Failed', err.message, 'error'),
      emotion: project.voiceEmotion,
      delivery: loc.delivery,
    });
  };

  // Re-renders the edited lines of one language; only the changed lines are charged.
  const handleRetake = async () => {
    const language = translationLang.code;
    const langName = translationLang.name;
    setRetake({ language, progress: 3, message: `Starting ${langName} update...` });
    try {
      await projectService.retakeLines(project.id, language);
    } catch (err) {
      setRetake(null);
      onShowToast('Update Failed to Start', (err as Error).message, 'error');
      return;
    }
    const poll = async () => {
      try {
        const fresh = await projectService.get(project.id);
        if (fresh.status === 'completed' || fresh.status === 'failed') {
          setRetake(null);
          onProjectRefreshed(fresh);
          if (fresh.status === 'completed') {
            onShowToast('Dub Updated', `${langName} now has your edited lines.`, 'success');
            notifyWorkDone('Dub updated', `${project.title}: ${langName} now has your edited lines.`);
          } else onShowToast('Update Failed', fresh.currentProcessingMessage || 'Something went wrong.', 'error');
          return;
        }
        setRetake({ language, progress: fresh.progressPercent, message: fresh.currentProcessingMessage || 'Rendering...' });
        setTimeout(poll, 1500);
      } catch (err) {
        setRetake(null);
        onShowToast('Update Failed', (err as Error).message, 'error');
      }
    };
    void poll();
  };

  /** Speaks a voice's sample line in the language being configured, so it can be judged before committing to a render. */
  const handlePreviewVoice = async (e: React.MouseEvent, voice: Voice) => {
    e.stopPropagation();
    if (previewingVoiceId === voice.id) {
      textToSpeechService.stopPlayback();
      setPreviewingVoiceId(null);
      return;
    }
    setPreviewingVoiceId(voice.id);
    await textToSpeechService.speakText(voice.sampleQuote, voice, voiceLanguage, {
      onEnd: () => setPreviewingVoiceId((cur) => (cur === voice.id ? null : cur)),
      onError: (err) => {
        setPreviewingVoiceId(null);
        onShowToast('Preview Failed', err.message, 'error');
      },
    });
  };

  const tabs: { id: Tab; label: string; icon: React.ElementType; count?: number }[] = [
    { id: 'overview', label: 'Watch', icon: PlayCircle },
    { id: 'translation', label: 'Translation', icon: Languages, count: flaggedCount || undefined },
    { id: 'transcript', label: 'Original script', icon: FileText },
    { id: 'voice', label: 'Voices', icon: Mic },
    { id: 'export', label: 'Export', icon: Download },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="rounded-3xl glass-panel p-4 sm:p-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              className="p-2 rounded-xl bg-white hover:bg-[#F1F5F9] text-[#0F172A] border border-[#E2E8F0] transition-colors shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="relative w-24 h-14 rounded-xl overflow-hidden bg-[#0F172A] shrink-0 hidden sm:block">
              {project.videoThumbnailUrl ? (
                <img src={project.videoThumbnailUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Video className="w-5 h-5 text-slate-500" />
                </div>
              )}
              <span className="absolute bottom-1 right-1 px-1 rounded bg-black/75 text-[9px] font-mono text-white">{formatClock(project.videoDuration)}</span>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-lg sm:text-xl font-extrabold text-[#0F172A] tracking-tight truncate">{project.title}</h2>
                {/* The project's real state: this screen also shows projects whose re-dub is running or failed. */}
                <ProjectStatusBadge progress={projectProgress(project)} />
              </div>
              <p className="text-xs text-[#64748B] mt-0.5 truncate">
                {sourceLang.name} → {languages.length > 1 ? `${readyCount} of ${languages.length} languages dubbed` : active?.language.name}
                {' · '}
                {project.videoResolution?.split(' (')[0]} · {project.videoFileSize}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onDubMoreLanguages && project.transcriptSegments?.length > 0 && (
              <button
                type="button"
                onClick={() => onDubMoreLanguages(project)}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white hover:bg-[#F8FAFC] border border-[#E2E8F0] text-xs font-semibold text-[#0F172A] transition-colors"
              >
                <Plus className="w-3.5 h-3.5 text-[#D94B2E]" />
                More languages
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowShare(true)}
              disabled={readyCount === 0}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white hover:bg-[#F8FAFC] border border-[#E2E8F0] text-xs font-semibold text-[#0F172A] transition-colors disabled:opacity-50"
            >
              <Share2 className="w-3.5 h-3.5 text-[#D94B2E]" />
              Share
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('export')}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold shadow-[0_0_15px_rgba(240,86,55,0.3)] transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </button>
          </div>
        </div>

        {/* One language picker for the whole workspace */}
        {languages.length > 1 && (
          <div className="mt-4 pt-4 border-t border-[#E2E8F0] flex items-center gap-2 overflow-x-auto custom-scrollbar">
            <span className="text-[11px] font-semibold text-[#94A3B8] shrink-0">Language</span>
            {languages.map((entry) => {
              const isActive = entry.code === active?.code;
              return (
                <button
                  key={entry.code}
                  type="button"
                  onClick={() => {
                    setViewLanguage(entry.code);
                    setEditingSegId(null);
                  }}
                  className={`shrink-0 inline-flex items-center gap-1.5 pl-2 pr-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
                    isActive ? 'bg-[#0F172A] border-[#0F172A] text-white' : 'bg-white border-[#E2E8F0] text-[#475569] hover:text-[#0F172A]'
                  }`}
                >
                  <span>{entry.language.flag}</span>
                  {entry.language.name}
                  {!entry.videoUrl && <span className={`text-[10px] ${isActive ? 'text-white/60' : 'text-[#94A3B8]'}`}>· not dubbed</span>}
                  {project.retakeInfo?.[entry.code] && <span className="w-1.5 h-1.5 rounded-full bg-sky-500" title="Has edits waiting for a render" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 rounded-2xl bg-[#F1F5F9] overflow-x-auto custom-scrollbar">
        {tabs.map(({ id, label, icon: Icon, count }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={`shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
              activeTab === id ? 'bg-white text-[#0F172A] shadow-sm' : 'text-[#64748B] hover:text-[#0F172A]'
            }`}
          >
            <Icon className={`w-3.5 h-3.5 ${activeTab === id ? 'text-[#F05637]' : ''}`} />
            {label}
            {count ? <span className="px-1.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold">{count}</span> : null}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-8 space-y-3 min-w-0">
            <VideoPlayer
              key={active?.code}
              src={active?.videoUrl || project.videoUrl}
              originalSrc={project.videoUrl}
              poster={project.videoThumbnailUrl || undefined}
              currentTime={seekTo}
              autoPlayOnSeek
              onTimeUpdate={setPlayhead}
              localizedSegments={activeTrack === 'dubbed' && active?.videoUrl ? translationSegments : []}
              transcriptSegments={activeTrack === 'original' || !active?.videoUrl ? project.transcriptSegments : []}
              activeLanguageName={active?.language.name || 'Dubbed'}
              showAudioTrackSwitch={Boolean(active?.videoUrl)}
              activeAudioTrack={activeTrack}
              onToggleAudioTrack={setActiveTrack}
              className="w-full aspect-video shadow-[0_24px_60px_rgba(15,23,42,0.16)]"
            />
            {!active?.videoUrl && (
              <p className="text-xs text-[#64748B] px-1">
                {active?.language.name} has not been dubbed yet — you are watching the original.
              </p>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StatTile icon={Mic} label="Voice" value={activeVoiceName} />
              <StatTile icon={Users} label="Speakers" value={String(project.speakersCount || 1)} />
              <StatTile icon={Clock} label="Duration" value={formatClock(project.videoDuration)} />
              <StatTile icon={Monitor} label="Lines" value={`${translationSegments.length} · ${project.wordsCount} words`} />
            </div>
          </div>
          <div className="lg:col-span-4 space-y-4">
            <QualityPanel report={active?.report} faceDetected={project.faceScan?.hasFaces} onReviewLines={() => { setReviewOnly(true); setActiveTab('translation'); }} />
            {active && (
              <SyncedScript segments={translationSegments} currentTime={playhead} onSeek={(t) => setSeekTo(t + Math.random() * 1e-4)} languageName={active.language.name} maxHeightClass="max-h-[340px]" />
            )}
          </div>
        </div>
      )}

      {activeTab === 'transcript' && (
        <div className="rounded-3xl glass-panel p-6 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-[#E2E8F0]">
            <div>
              <h3 className="text-sm font-bold text-[#0F172A]">Original script · {sourceLang.name}</h3>
              <p className="text-[11px] text-[#64748B]">What was said in the video, line by line. Click a time to watch it.</p>
            </div>
            <span className="text-xs text-[#64748B] font-mono">{project.transcriptSegments.length} lines</span>
          </div>

          <div className="space-y-2">
            {project.transcriptSegments.map((seg) => {
              const isEditing = editingSegId === seg.id;
              return (
                <div key={seg.id} className="p-4 rounded-2xl bg-white border border-[#E2E8F0] space-y-2">
                  <div className="flex items-center justify-between text-xs text-[#64748B] font-mono">
                    <button type="button" onClick={() => jumpTo(seg.startTime)} className="hover:text-[#D94B2E]" title="Watch this line">
                      {formatClock(seg.startTime)} — {formatClock(seg.endTime)}
                      {seg.speaker && <span className="ml-2 font-sans text-[10px] text-[#94A3B8]">{seg.speaker}</span>}
                    </button>
                    {!isEditing && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingSegId(seg.id);
                          setEditText(seg.text);
                        }}
                        className="text-[#D94B2E] hover:text-[#ff9d83] text-xs font-semibold font-sans"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  {isEditing ? (
                    <div className="space-y-2">
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={2}
                        className="w-full p-2.5 rounded-xl bg-[#FFFFFF] border border-[#F05637] text-[#0F172A] text-xs focus:outline-none focus:ring-1 focus:ring-[#F05637]"
                      />
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => setEditingSegId(null)} className="px-3 py-1 text-xs text-[#64748B]">
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleUpdateTranscriptSegment(seg.id, editText)}
                          className="px-3 py-1 bg-[#F05637] text-white text-xs font-semibold rounded-lg shadow-[0_0_10px_rgba(240,86,55,0.3)]"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[13px] text-[#0F172A] leading-relaxed">{seg.text}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'translation' && (
        <div className="rounded-3xl glass-panel p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#E2E8F0]">
            <div>
              <h3 className="text-sm font-bold text-[#0F172A]">
                {translationLang.flag} {translationLang.name} translation
              </h3>
              <p className="text-[11px] text-[#64748B]">Edit a line, then update the dub — only the changed lines are re-voiced.</p>
            </div>
            <ReviewFilterToggle count={flaggedCount} active={reviewOnly} onToggle={() => setReviewOnly(!reviewOnly)} />
          </div>

          {(pendingRetake || retake?.language === translationLang.code) && (
            <div className="p-4 rounded-2xl bg-[#F05637]/5 border border-[#F05637]/30 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-bold text-[#0F172A]">
                    {retake?.language === translationLang.code
                      ? retake.message
                      : `${pendingRetake!.changedLineIds.length} edited line${pendingRetake!.changedLineIds.length === 1 ? '' : 's'} not in the ${translationLang.name} dub yet`}
                  </p>
                  {!retake && pendingRetake && (
                    <p className="text-[11px] text-[#64748B] mt-0.5">
                      Only the changed lines are charged: about {Math.max(0.1, pendingRetake.minutes * allowanceRate).toFixed(1)} min of your allowance
                      {allowanceRate > 1 ? ` (paid extras on: ${allowanceRate}× per minute)` : ''}.
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleRetake}
                  disabled={Boolean(retake) || isRedubbing}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {retake ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                  {retake ? `Updating... ${retake.progress}%` : 'Update the dub'}
                </button>
              </div>
              {retake?.language === translationLang.code && (
                <div className="h-1.5 rounded-full bg-[#E2E8F0] overflow-hidden">
                  <div className="h-full bg-[#F05637] transition-all" style={{ width: `${Math.max(3, retake.progress)}%` }} />
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            {translationSegments.length === 0 && <p className="text-xs text-[#94A3B8] text-center py-8">No translation yet for {translationLang.name}.</p>}
            {shownTranslationSegments.map((loc) => {
              const isEditing = editingSegId === loc.id;
              return (
                <div key={loc.id} className={`p-4 rounded-2xl bg-white border space-y-2 ${needsReview(loc) ? 'border-amber-200' : 'border-[#E2E8F0]'}`}>
                  <div className="flex items-center justify-between gap-2 text-xs text-[#64748B] font-mono">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <button type="button" onClick={() => jumpTo(loc.dubStartTime ?? loc.startTime)} className="hover:text-[#D94B2E]" title="Watch this line">
                        {formatClock(loc.startTime)} — {formatClock(loc.endTime)}
                      </button>
                      {changedLineIds.has(loc.id) && (
                        <span
                          title="Edited since the last render. Update the dub to hear it."
                          className="px-1.5 py-0.5 rounded-md bg-sky-50 border border-sky-200 text-sky-700 text-[10px] font-semibold font-sans"
                        >
                          Not in the dub yet
                        </span>
                      )}
                      <DeliveryTag delivery={loc.delivery} />
                      <QaFlagBadges flags={loc.qaFlags} directorNote={loc.directorNote} />
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <button type="button" onClick={() => handlePreviewLine(loc)} className="text-[#64748B] hover:text-[#D94B2E]" title="Listen">
                        <Volume2 className="w-3.5 h-3.5" />
                      </button>
                      {!isEditing && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingSegId(loc.id);
                            setEditText(loc.translatedText);
                            setEditDelivery(loc.delivery || '');
                          }}
                          className="text-[#D94B2E] hover:text-[#ff9d83] text-xs font-semibold font-sans"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  </div>

                  <p className="text-[11px] text-[#94A3B8] italic">{loc.sourceText}</p>

                  {isEditing ? (
                    <div className="space-y-2 pt-1">
                      <textarea
                        ref={translationEditorRef}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={2}
                        className="w-full p-2.5 rounded-xl bg-[#FFFFFF] border border-[#F05637] text-[#0F172A] text-xs focus:outline-none focus:ring-1 focus:ring-[#F05637]"
                      />
                      <PerformanceTagPicker onInsert={(tag) => setEditText((text) => insertTagAtCursor(text, tag, translationEditorRef.current))} />
                      <DeliveryInput value={editDelivery} onChange={setEditDelivery} />
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => setEditingSegId(null)} className="px-3 py-1 text-xs text-[#64748B]">
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleUpdateLocalizedSegment(loc.id, editText, editDelivery)}
                          className="px-3 py-1 bg-[#F05637] text-white text-xs font-semibold rounded-lg shadow-[0_0_10px_rgba(240,86,55,0.3)]"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[13px] text-[#0F172A] font-medium leading-relaxed">{loc.translatedText}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'voice' && (
        <div className="rounded-3xl glass-panel p-6 space-y-5">
          <div>
            <h3 className="text-sm font-bold text-[#0F172A]">Change a language's voice</h3>
            <p className="text-[11px] text-[#64748B] mt-0.5">
              Preview a voice, then re-dub to apply it — the audio is a rendered file, so picking a voice alone does not change it.
            </p>
          </div>

          {/* Which language's voice is being set. A project can hold several. */}
          {projectLanguages.length > 1 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-[#64748B]">Voice for:</span>
              {languages.map((entry) => {
                const isActive = entry.code === voiceLanguage;
                return (
                  <button
                    key={entry.code}
                    type="button"
                    disabled={isRedubbing}
                    onClick={() => {
                      setVoiceLanguage(entry.code);
                      setPendingVoiceId(null);
                    }}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all disabled:opacity-50 ${
                      isActive ? 'bg-[#0F172A] text-white border-[#0F172A]' : 'bg-white text-[#64748B] border-[#E2E8F0] hover:text-[#0F172A]'
                    }`}
                  >
                    {entry.language.flag} {entry.language.name}
                  </button>
                );
              })}
            </div>
          )}

          {/* Action bar: the only thing here that actually changes the audio. */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-2xl bg-white border border-[#E2E8F0]">
            <div className="min-w-0">
              <span className="text-xs font-bold text-[#0F172A] block truncate">
                {availableVoices.find((v) => v.id === activeVoiceId)?.name || 'No voice selected'}
              </span>
              <span className="text-[11px] text-[#64748B]">
                {isRedubbing
                  ? redubMessage || 'Rendering...'
                  : hasVoiceChange
                  ? 'Not applied yet — re-dub to hear it'
                  : `Currently rendered in ${LANGUAGES.find((l) => l.code === voiceLanguage)?.name || voiceLanguage}`}
              </span>
            </div>
            <button
              type="button"
              onClick={handleRedubWithVoice}
              disabled={!hasVoiceChange || isRedubbing}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-bold shadow-[0_0_20px_rgba(240,86,55,0.3)] transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
            >
              {isRedubbing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
              <span>
                {isRedubbing ? `Re-dubbing... ${redubProgress}%` : `Re-dub ${LANGUAGES.find((l) => l.code === voiceLanguage)?.name || ''} with this voice`}
              </span>
            </button>
          </div>

          {isRedubbing && (
            <div className="h-1.5 rounded-full bg-[#E2E8F0] overflow-hidden">
              <div className="h-full bg-[#F05637] transition-all duration-500" style={{ width: `${Math.max(3, redubProgress)}%` }} />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {pickerVoices.map((v) => {
              const isSelected = activeVoiceId === v.id;
              const isRendered = savedVoiceForLanguage(voiceLanguage) === v.id;
              const isPreviewing = previewingVoiceId === v.id;
              const locked = !voiceAllowed(v, voiceEngines);
              return (
                <div
                  key={v.id}
                  onClick={() => {
                    if (isRedubbing) return;
                    if (locked) {
                      onShowToast(`${VOICE_ENGINE_INFO[v.engine].label} is an Enterprise voice`, `Your plan includes ${enginesLabel(voiceEngines)} voices. Upgrade to Enterprise to use this one.`, 'info');
                      return;
                    }
                    setPendingVoiceId(v.id);
                  }}
                  aria-disabled={locked}
                  className={`p-4 rounded-2xl border transition-all ${isRedubbing || locked ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'} ${
                    isSelected ? 'bg-[#FFF4F1] border-[#F05637] ring-1 ring-[#F05637]' : locked ? 'bg-white border-dashed border-[#CBD5E1]' : 'bg-white border-[#E2E8F0] hover:border-[#CBD5E1]'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {v.avatarUrl ? (
                      <img src={v.avatarUrl} alt={v.name} className="w-11 h-11 rounded-xl object-cover shrink-0" />
                    ) : (
                      <span className="w-11 h-11 rounded-xl bg-[#F05637]/15 text-[#D94B2E] flex items-center justify-center shrink-0">
                        <Mic className="w-5 h-5" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <h4 className="text-xs font-bold text-[#0F172A] truncate">{v.name.replace(/\s*\(.*\)$/, '')}</h4>
                      <span className="text-[11px] text-[#D94B2E] block truncate">{v.accent}</span>
                      <span className="mt-1 inline-block">
                        <VoiceEngineBadge engine={v.engine} locked={locked} compact />
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={(e) => handlePreviewVoice(e, v)}
                      title={`Preview ${v.name}`}
                      className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center transition-colors ${
                        isPreviewing ? 'bg-[#F05637] text-white' : 'bg-white text-[#64748B] border border-[#E2E8F0] hover:text-[#D94B2E]'
                      }`}
                    >
                      {isPreviewing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  {isRendered && (
                    <span className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
                      <Check className="w-3 h-3" />
                      Currently rendered
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'export' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5">
            <ExportPanel
              project={project}
              languages={languages}
              active={active}
              defaultBurnCaptions={defaultBurnCaptions}
              onShare={() => setShowShare(true)}
              onShowToast={onShowToast}
            />
          </div>
          <div className="lg:col-span-7 space-y-4">
            <QualityPanel report={active?.report} faceDetected={project.faceScan?.hasFaces} onReviewLines={() => { setReviewOnly(true); setActiveTab('translation'); }} />
            <div className="rounded-3xl glass-panel p-5 space-y-3">
              <h4 className="text-sm font-bold text-[#0F172A]">Every language</h4>
              <div className="divide-y divide-[#E2E8F0]">
                {languages.map((entry) => (
                  <div key={entry.code} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-base">{entry.language.flag}</span>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-[#0F172A] truncate">{entry.language.name}</p>
                        <p className="text-[11px] text-[#94A3B8] truncate">
                          {entry.videoUrl
                            ? entry.report
                              ? `${Math.round((entry.report.inSync / Math.max(1, entry.report.lines)) * 100)}% timing match${entry.report.lipSync === 'applied' ? ' · lip-synced' : ''}`
                              : 'Rendered'
                            : entry.message || 'Not dubbed yet'}
                        </p>
                      </div>
                    </div>
                    {entry.videoUrl ? (
                      <button
                        type="button"
                        onClick={() => {
                          setViewLanguage(entry.code);
                          setActiveTab('overview');
                        }}
                        className="text-[11px] font-semibold text-[#D94B2E] hover:underline shrink-0"
                      >
                        Watch
                      </button>
                    ) : (
                      <span className="text-[10px] font-semibold text-[#94A3B8] shrink-0">—</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {showShare && (
        <ShareDialog
          projectId={project.id}
          projectTitle={project.title}
          languages={languages.map((entry) => ({ code: entry.code, name: entry.language.name, ready: Boolean(entry.videoUrl) }))}
          initialLanguage={active?.code || project.targetLanguage}
          onClose={() => setShowShare(false)}
          onShowToast={onShowToast}
        />
      )}
    </div>
  );
};
