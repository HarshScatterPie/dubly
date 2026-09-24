/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Video,
  FileText,
  Languages,
  Mic,
  Download,
  Share2,
  Sparkles,
  Check,
  Edit3,
  Volume2,
  Trash2,
  ExternalLink,
  Play,
  Pause,
  Loader2,
  Wand2,
} from 'lucide-react';
import { DubbingProject, LocalizedSegment, TranscriptSegment, Voice } from '../types';
import { LANGUAGES, VOICES } from '../data/mockData';
import { voiceCloneService } from '../services/voiceCloneService';
import { projectService } from '../services/projectService';
import { VideoPlayer } from './VideoPlayer';
import { textToSpeechService } from '../services/textToSpeechService';
import { renderService } from '../services/renderService';
import { DownloadMenu } from './DownloadMenu';

interface ProjectWorkspaceProps {
  project: DubbingProject;
  onBack: () => void;
  onUpdateProject: (updated: DubbingProject) => void;
  onShowToast: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
}

export const ProjectWorkspace: React.FC<ProjectWorkspaceProps> = ({
  project,
  onBack,
  onUpdateProject,
  onShowToast,
}) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'transcript' | 'translation' | 'voice' | 'export'>('overview');
  const [editingSegId, setEditingSegId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  // Which language's translation the Translation tab is showing — a project can hold
  // several, but only ever displayed the primary one regardless of what the tab's own
  // label ("Translation (Tamil +1)") implied was there to look at.
  const [translationLanguage, setTranslationLanguage] = useState<string>(project.targetLanguage);
  const [videoSeekTime, setVideoSeekTime] = useState<number | undefined>(undefined);
  const [activeTrack, setActiveTrack] = useState<'dubbed' | 'original'>('dubbed');

  // Which language the Voice tab is editing, and the voice picked for it. Held locally
  // until the user re-dubs, because picking a voice changes nothing on its own — the audio
  // only changes when it is rendered again.
  const [voiceLanguage, setVoiceLanguage] = useState<string>(project.targetLanguage);
  const [pendingVoiceId, setPendingVoiceId] = useState<string | null>(null);
  const [isRedubbing, setIsRedubbing] = useState<boolean>(false);
  const [redubProgress, setRedubProgress] = useState<number>(0);
  const [redubMessage, setRedubMessage] = useState<string>('');
  const [customVoices, setCustomVoices] = useState<Voice[]>([]);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);

  useEffect(() => {
    voiceCloneService
      .list()
      .then((res) => setCustomVoices(res.voices.map((v) => voiceCloneService.toVoice(v))))
      .catch(() => setCustomVoices([]));
  }, []);

  const sourceLang = LANGUAGES.find((l) => l.code === project.sourceLanguage) || LANGUAGES[10];
  const targetLang = LANGUAGES.find((l) => l.code === project.targetLanguage) || LANGUAGES[0];
  /** The user's cloned voices first, then the shared catalog — same order as the studio. */
  const availableVoices = [...customVoices, ...VOICES];
  const selectedVoice = availableVoices.find((v) => v.id === project.selectedVoiceId) || VOICES[0];

  /** Every language this project targets, tolerating projects saved before multi-language. */
  const projectLanguages = project.targetLanguages?.length
    ? project.targetLanguages
    : [project.targetLanguage];

  // Every language's finished render, for the download menus (the primary language's lives at the top level).
  const downloadableLanguages = projectLanguages.map((code) => {
    const output = project.languageOutputs?.[code];
    const lang = LANGUAGES.find((l) => l.code === code);
    const videoUrl = code === project.targetLanguage ? project.finalDubbedVideoUrl : output?.finalDubbedVideoUrl;
    return {
      code,
      name: lang?.name || code,
      nativeName: lang?.nativeName,
      ready: Boolean(videoUrl),
      statusLabel: output?.status === 'failed' ? output.message || 'Dubbing failed' : 'Not dubbed yet',
      videoUrl,
    };
  });
  const downloadLanguageVideo = async (code: string) => {
    const entry = downloadableLanguages.find((l) => l.code === code);
    if (!entry?.videoUrl) throw new Error('This language has not been dubbed yet.');
    await renderService.downloadMedia(`${project.title.replace(/\s+/g, '_')}_${entry.name}.mp4`, entry.videoUrl);
  };

  /** The voice currently assigned to a language, before any unsaved pick. */
  const savedVoiceForLanguage = (code: string) =>
    project.languageVoiceMap?.[code] || project.selectedVoiceId;

  /**
   * The primary language's segments live at the top level (`project.localizedSegments`,
   * kept there for projects saved before multi-language dubbing existed); every other
   * language's live under `languageOutputs`. Segment ids are namespaced per language
   * (`loc-<lang>-...`), so there's no risk of the two ever colliding.
   */
  const translationSegments: LocalizedSegment[] =
    translationLanguage === project.targetLanguage
      ? project.localizedSegments
      : project.languageOutputs?.[translationLanguage]?.localizedSegments || [];
  const translationLang = LANGUAGES.find((l) => l.code === translationLanguage) || targetLang;
  const translationVoice =
    availableVoices.find((v) => v.id === savedVoiceForLanguage(translationLanguage)) || selectedVoice;

  const activeVoiceId = pendingVoiceId ?? savedVoiceForLanguage(voiceLanguage);
  const hasVoiceChange = pendingVoiceId !== null && pendingVoiceId !== savedVoiceForLanguage(voiceLanguage);

  const handleUpdateTranscriptSegment = (segmentId: string, newText: string) => {
    const updatedSegments = project.transcriptSegments.map((s) =>
      s.id === segmentId ? { ...s, text: newText } : s
    );
    onUpdateProject({ ...project, transcriptSegments: updatedSegments });
    setEditingSegId(null);
    onShowToast('Transcript Updated', 'Segment text saved.', 'success');
  };

  const handleUpdateLocalizedSegment = async (locId: string, newText: string) => {
    const updatedLoc = translationSegments.map((s) =>
      s.id === locId ? { ...s, translatedText: newText, isEdited: true } : s
    );
    try {
      // The dedicated per-language endpoint, not the generic project patch: the generic
      // one only ever writes the top-level (primary-language) `localizedSegments` field,
      // so an edit made while viewing a secondary language would silently vanish — its
      // segment ids (`loc-<lang>-...`) don't even appear in that array.
      const saved = await projectService.updateLanguageSegments(project.id, translationLanguage, updatedLoc);
      onUpdateProject(saved);
      setEditingSegId(null);
      onShowToast('Translation Updated', 'Segment translation saved.', 'success');
    } catch (err) {
      onShowToast('Save Failed', (err as Error).message, 'error');
    }
  };

  /**
   * Re-renders one language with the newly picked voice.
   *
   * Picking a voice used to save the id and claim the track had switched, which was simply
   * untrue — the rendered audio is a file, and nothing had re-rendered it. The voice only
   * takes effect when the dub is run again, so that is what this does, and only for the one
   * language being edited rather than every language in the project.
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

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 animate-fade-in">
      {/* Workspace Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-[#E2E8F0]">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onBack}
            className="p-2 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] text-[#0F172A] border border-[#E2E8F0] transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl sm:text-2xl font-bold text-[#0F172A] tracking-tight">
                {project.title}
              </h2>
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50/80 text-emerald-600 border border-emerald-200/60">
                Completed
              </span>
            </div>
            <p className="text-xs text-[#64748B] mt-0.5">
              {sourceLang.name} → {targetLang.name} · Voice: {selectedVoice.name} · {project.videoFileSize}
            </p>
          </div>
        </div>

        {/* Quick Export Actions */}
        <div className="flex items-center gap-2">
          <DownloadMenu
            size="compact"
            label="Download"
            languages={downloadableLanguages}
            onDownload={downloadLanguageVideo}
            onShowToast={onShowToast}
          />
        </div>
      </div>

      {/* Horizontal Tab Navigation */}
      <div className="flex items-center gap-2 p-1.5 glass-panel rounded-2xl overflow-x-auto custom-scrollbar">
        <button
          type="button"
          onClick={() => setActiveTab('overview')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
            activeTab === 'overview'
              ? 'bg-[#F05637] text-white shadow-sm shadow-[0_0_12px_rgba(240,86,55,0.4)]'
              : 'text-[#64748B] hover:text-[#0F172A]'
          }`}
        >
          <Video className="w-3.5 h-3.5" />
          <span>Overview</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('transcript')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
            activeTab === 'transcript'
              ? 'bg-[#F05637] text-white shadow-sm shadow-[0_0_12px_rgba(240,86,55,0.4)]'
              : 'text-[#64748B] hover:text-[#0F172A]'
          }`}
        >
          <FileText className="w-3.5 h-3.5" />
          <span>Transcript ({project.transcriptSegments.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('translation')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
            activeTab === 'translation'
              ? 'bg-[#F05637] text-white shadow-sm shadow-[0_0_12px_rgba(240,86,55,0.4)]'
              : 'text-[#64748B] hover:text-[#0F172A]'
          }`}
        >
          <Languages className="w-3.5 h-3.5" />
          <span>
            Translation (
            {projectLanguages.length > 1
              ? `${targetLang.name} +${projectLanguages.length - 1}`
              : targetLang.name}
            )
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('voice')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
            activeTab === 'voice'
              ? 'bg-[#F05637] text-white shadow-sm shadow-[0_0_12px_rgba(240,86,55,0.4)]'
              : 'text-[#64748B] hover:text-[#0F172A]'
          }`}
        >
          <Mic className="w-3.5 h-3.5" />
          <span>
            Voice Track (
            {projectLanguages.length > 1
              ? `${projectLanguages.length} languages`
              : selectedVoice.name}
            )
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('export')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
            activeTab === 'export'
              ? 'bg-[#F05637] text-white shadow-sm shadow-[0_0_12px_rgba(240,86,55,0.4)]'
              : 'text-[#64748B] hover:text-[#0F172A]'
          }`}
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export Center</span>
        </button>
      </div>

      {/* Tab Content Render */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          <div className="lg:col-span-7 space-y-4">
            <div className="relative rounded-2xl overflow-hidden border border-[#E2E8F0] shadow-2xl bg-[#FFFFFF]">
              <VideoPlayer
                src={project.finalDubbedVideoUrl || project.videoUrl}
                originalSrc={project.videoUrl}
                currentTime={videoSeekTime}
                localizedSegments={project.localizedSegments}
                activeLanguageName={targetLang.name}
                showAudioTrackSwitch={true}
                activeAudioTrack={activeTrack}
                onToggleAudioTrack={setActiveTrack}
                className="w-full aspect-video"
              />
            </div>
          </div>

          <div className="lg:col-span-5 space-y-6">
            <div className="rounded-3xl glass-panel p-6 space-y-5">
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">
                Project Parameters
              </h3>

              <div className="space-y-3 text-xs">
                <div className="flex items-center justify-between p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]">
                  <span className="text-[#64748B]">Language Pair</span>
                  <span className="font-semibold text-[#0F172A]">
                    {sourceLang.name} → <strong className="text-[#D94B2E]">{targetLang.name}</strong>
                  </span>
                </div>

                <div className="flex items-center justify-between p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]">
                  <span className="text-[#64748B]">AI Voice</span>
                  <span className="font-semibold text-[#0F172A]">
                    {selectedVoice.name} ({selectedVoice.accent})
                  </span>
                </div>

                <div className="flex items-center justify-between p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]">
                  <span className="text-[#64748B]">Translation Style</span>
                  <span className="font-semibold text-[#0F172A] capitalize">
                    {project.translationStyle} (Adapt Native: {project.adaptExpressions ? 'Yes' : 'No'})
                  </span>
                </div>

                <div className="flex items-center justify-between p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]">
                  <span className="text-[#64748B]">Segments Count</span>
                  <span className="font-mono text-[#0F172A] font-bold">
                    {project.localizedSegments.length} Segments ({project.wordsCount} words)
                  </span>
                </div>

                <div className="flex items-center justify-between p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]">
                  <span className="text-[#64748B]">Resolution & Size</span>
                  <span className="font-mono text-[#0F172A]">
                    {project.videoResolution} · {project.videoFileSize}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setActiveTab('translation')}
                className="w-full py-3 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] border border-[#E2E8F0] text-xs font-semibold text-[#D94B2E] hover:text-[#ff9d83] transition-colors"
              >
                Inspect & Edit Translations →
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'transcript' && (
        <div className="rounded-3xl glass-panel p-6 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-[#E2E8F0]">
            <h3 className="text-sm font-bold text-[#0F172A]">Original Source Transcript</h3>
            <span className="text-xs text-[#64748B] font-mono">{project.transcriptSegments.length} Segments</span>
          </div>

          <div className="space-y-3">
            {project.transcriptSegments.map((seg) => {
              const isEditing = editingSegId === seg.id;
              return (
                <div key={seg.id} className="p-4 rounded-2xl bg-[#F8FAFC] border border-[#E2E8F0] space-y-2">
                  <div className="flex items-center justify-between text-xs text-[#64748B] font-mono">
                    <span>
                      {formatTime(seg.startTime)} — {formatTime(seg.endTime)}
                    </span>
                    {!isEditing && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingSegId(seg.id);
                          setEditText(seg.text);
                        }}
                        className="text-[#D94B2E] hover:text-[#ff9d83] text-xs font-semibold"
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
                        <button
                          type="button"
                          onClick={() => setEditingSegId(null)}
                          className="px-3 py-1 text-xs text-[#64748B]"
                        >
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
                    <p className="text-xs text-[#0F172A]">"{seg.text}"</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'translation' && (
        <div className="rounded-3xl glass-panel p-6 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-[#E2E8F0]">
            <h3 className="text-sm font-bold text-[#0F172A]">
              Dubbed Localization ({translationLang.name})
            </h3>
            <span className="text-xs text-[#D94B2E] font-mono">{translationSegments.length} Segments</span>
          </div>

          {/* Which language is showing — a project can hold several, and this is the only
              place in the tab that lets you pick. */}
          {projectLanguages.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 pb-1">
              <span className="text-[11px] text-[#64748B]">Language:</span>
              {projectLanguages.map((code) => {
                const lang = LANGUAGES.find((l) => l.code === code);
                if (!lang) return null;
                const isActive = code === translationLanguage;
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => {
                      setTranslationLanguage(code);
                      setEditingSegId(null);
                    }}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
                      isActive
                        ? 'bg-[#F05637] text-white border-[#F05637]'
                        : 'bg-[#F8FAFC] text-[#64748B] border-[#E2E8F0] hover:text-[#0F172A]'
                    }`}
                  >
                    {lang.flag} {lang.name}
                  </button>
                );
              })}
            </div>
          )}

          <div className="space-y-3">
            {translationSegments.length === 0 && (
              <p className="text-xs text-[#94A3B8] text-center py-8">
                No translation yet for {translationLang.name}.
              </p>
            )}
            {translationSegments.map((loc) => {
              const isEditing = editingSegId === loc.id;
              return (
                <div key={loc.id} className="p-4 rounded-2xl bg-[#F8FAFC] border border-[#E2E8F0] space-y-2">
                  <div className="flex items-center justify-between text-xs text-[#64748B] font-mono">
                    <span>
                      {formatTime(loc.startTime)} — {formatTime(loc.endTime)}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          textToSpeechService.speakText(loc.translatedText, translationVoice, translationLanguage, {
                            onError: (err) => onShowToast('Playback Failed', err.message, 'error'),
                          })
                        }
                        className="text-[#64748B] hover:text-[#D94B2E]"
                        title="Listen"
                      >
                        <Volume2 className="w-3.5 h-3.5" />
                      </button>
                      {!isEditing && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingSegId(loc.id);
                            setEditText(loc.translatedText);
                          }}
                          className="text-[#D94B2E] hover:text-[#ff9d83] text-xs font-semibold"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  </div>

                  <p className="text-[11px] text-[#94A3B8] italic">Original: "{loc.sourceText}"</p>

                  {isEditing ? (
                    <div className="space-y-2 pt-1">
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={2}
                        className="w-full p-2.5 rounded-xl bg-[#FFFFFF] border border-[#F05637] text-[#0F172A] text-xs focus:outline-none focus:ring-1 focus:ring-[#F05637]"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingSegId(null)}
                          className="px-3 py-1 text-xs text-[#64748B]"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleUpdateLocalizedSegment(loc.id, editText)}
                          className="px-3 py-1 bg-[#F05637] text-white text-xs font-semibold rounded-lg shadow-[0_0_10px_rgba(240,86,55,0.3)]"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-[#0F172A] font-medium">"{loc.translatedText}"</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'voice' && (
        <div className="rounded-3xl glass-panel p-6 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-[#0F172A]">Switch or Re-assign Voice Model</h3>
              <p className="text-[11px] text-[#64748B] mt-0.5">
                Preview a voice, then re-dub to actually apply it — the audio is a rendered file, so
                picking a voice alone does not change it.
              </p>
            </div>
          </div>

          {/* Which language's voice is being set. A project can hold several. */}
          {projectLanguages.length > 1 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-[#64748B]">Voice for:</span>
              {projectLanguages.map((code) => {
                const lang = LANGUAGES.find((l) => l.code === code);
                if (!lang) return null;
                const isActive = code === voiceLanguage;
                return (
                  <button
                    key={code}
                    type="button"
                    disabled={isRedubbing}
                    onClick={() => {
                      setVoiceLanguage(code);
                      setPendingVoiceId(null);
                    }}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all disabled:opacity-50 ${
                      isActive
                        ? 'bg-[#F05637] text-white border-[#F05637]'
                        : 'bg-[#F8FAFC] text-[#64748B] border-[#E2E8F0] hover:text-[#0F172A]'
                    }`}
                  >
                    {lang.flag} {lang.name}
                  </button>
                );
              })}
            </div>
          )}

          {/* Action bar: the only thing here that actually changes the audio. */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-2xl bg-[#F8FAFC] border border-[#E2E8F0]">
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
                {isRedubbing
                  ? `Re-dubbing... ${redubProgress}%`
                  : `Re-dub ${LANGUAGES.find((l) => l.code === voiceLanguage)?.name || ''} with this voice`}
              </span>
            </button>
          </div>

          {isRedubbing && (
            <div className="h-1.5 rounded-full bg-[#E2E8F0] overflow-hidden">
              <div
                className="h-full bg-[#F05637] transition-all duration-500"
                style={{ width: `${Math.max(3, redubProgress)}%` }}
              />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {availableVoices.map((v) => {
              const isSelected = activeVoiceId === v.id;
              const isRendered = savedVoiceForLanguage(voiceLanguage) === v.id;
              const isPreviewing = previewingVoiceId === v.id;
              return (
                <div
                  key={v.id}
                  onClick={() => !isRedubbing && setPendingVoiceId(v.id)}
                  className={`p-4 rounded-2xl border transition-all ${
                    isRedubbing ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
                  } ${
                    isSelected
                      ? 'bg-[#FFF4F1] border-[#F05637] ring-1 ring-[#F05637] shadow-[0_0_15px_rgba(240,86,55,0.3)]'
                      : 'bg-[#F8FAFC] border-[#E2E8F0] hover:bg-[#E2E8F0]'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {v.avatarUrl ? (
                      <img src={v.avatarUrl} alt={v.name} className="w-12 h-12 rounded-xl object-cover shrink-0" />
                    ) : (
                      <span className="w-12 h-12 rounded-xl bg-[#F05637]/15 text-[#D94B2E] flex items-center justify-center shrink-0">
                        <Mic className="w-5 h-5" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <h4 className="text-xs font-bold text-[#0F172A] truncate">{v.name}</h4>
                      <span className="text-[11px] text-[#D94B2E] block truncate">{v.accent}</span>
                      <p className="text-[10px] text-[#94A3B8] line-clamp-1 mt-1">{v.description}</p>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => handlePreviewVoice(e, v)}
                      title={`Preview ${v.name}`}
                      className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center transition-colors ${
                        isPreviewing
                          ? 'bg-[#F05637] text-white'
                          : 'bg-white text-[#64748B] border border-[#E2E8F0] hover:text-[#D94B2E]'
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="relative z-20 p-6 rounded-3xl glass-panel space-y-4">
            <h4 className="text-sm font-bold text-[#0F172A]">Video Master</h4>
            <p className="text-xs text-[#64748B]">
              Download 1080p MP4 with multiplexed audio and soft subtitles.
            </p>
            <DownloadMenu
              align="left"
              label="Download MP4"
              sublabel="Dubbed master"
              languages={downloadableLanguages}
              onDownload={downloadLanguageVideo}
              onShowToast={onShowToast}
            />
          </div>

          <div className="p-6 rounded-3xl glass-panel space-y-4">
            <h4 className="text-sm font-bold text-[#0F172A]">Audio Track Only</h4>
            <p className="text-xs text-[#64748B]">
              Export the dubbed voiceover track as lossless WAV.
            </p>
            <button
              type="button"
              onClick={async () => {
                try {
                  await renderService.downloadMedia(`${project.title}_Audio.wav`, project.dubbedAudioUrl || '');
                  onShowToast('Audio Exported', 'Downloaded WAV audio.', 'success');
                } catch (err) {
                  onShowToast('Download Failed', (err as Error).message, 'error');
                }
              }}
              disabled={!project.dubbedAudioUrl}
              className="w-full py-2.5 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] text-[#0F172A] text-xs font-semibold border border-[#E2E8F0] disabled:opacity-50"
            >
              Download WAV
            </button>
          </div>

          <div className="p-6 rounded-3xl glass-panel space-y-4">
            <h4 className="text-sm font-bold text-[#0F172A]">Subtitles (.SRT / .VTT)</h4>
            <p className="text-xs text-[#64748B]">
              Download standard subtitle files for YouTube, Vimeo, or Premiere.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  const srt = renderService.generateSRT(project.localizedSegments);
                  renderService.downloadTextFile(`${project.title}.srt`, srt);
                  onShowToast('Subtitles Exported', 'Downloaded SRT subtitle file.', 'success');
                }}
                className="py-2.5 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] text-[#0F172A] text-xs font-semibold border border-[#E2E8F0]"
              >
                Download SRT
              </button>
              <button
                type="button"
                onClick={() => {
                  const vtt = renderService.generateVTT(project.localizedSegments);
                  renderService.downloadTextFile(`${project.title}.vtt`, vtt, 'text/vtt');
                  onShowToast('Subtitles Exported', 'Downloaded VTT subtitle file.', 'success');
                }}
                className="py-2.5 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] text-[#0F172A] text-xs font-semibold border border-[#E2E8F0]"
              >
                Download VTT
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
