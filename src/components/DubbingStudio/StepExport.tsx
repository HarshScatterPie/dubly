/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import confetti from 'canvas-confetti';
import {
  Download,
  FileText,
  Volume2,
  Share2,
  Sparkles,
  ArrowRight,
  CheckCircle2,
  Music,
  Video,
  Languages,
  Plus,
  Copy,
  ExternalLink,
} from 'lucide-react';
import { DubbingProject, Language } from '../../types';
import { LANGUAGES, VOICES } from '../../data/mockData';
import { VideoPlayer } from '../VideoPlayer';
import { renderService } from '../../services/renderService';
import { projectService } from '../../services/projectService';
import { DownloadMenu } from '../DownloadMenu';
import { ShareDialog } from '../ShareDialog';

interface StepExportProps {
  project: DubbingProject;
  onDubAnotherLanguage: (targetLangCode: string) => void;
  onRestartProject: () => void;
  onOpenWorkspace: () => void;
  onShowToast: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
}

export const StepExport: React.FC<StepExportProps> = ({
  project,
  onDubAnotherLanguage,
  onRestartProject,
  onOpenWorkspace,
  onShowToast,
}) => {
  const [activeTrack, setActiveTrack] = useState<'dubbed' | 'original'>('dubbed');
  const [burnCaptions, setBurnCaptions] = useState<boolean>(false);
  const [showShare, setShowShare] = useState<boolean>(false);
  // Which language's render the player and the download buttons are pointed at. A project
  // can hold several, so every export action below is scoped to this one.
  const [viewLanguage, setViewLanguage] = useState<string>(project.targetLanguage);

  const sourceLang = LANGUAGES.find((l) => l.code === project.sourceLanguage) || LANGUAGES[10];
  const voice = VOICES.find((v) => v.id === project.selectedVoiceId) || VOICES[0];

  /**
   * Every language this project rendered into, with the bits the export panel needs.
   *
   * The primary language's render sits in the project's top-level fields while the rest
   * live in `languageOutputs`, so both are flattened into one list here rather than making
   * every button below care which of the two shapes it is looking at.
   */
  const dubbedLanguages = (project.targetLanguages?.length ? project.targetLanguages : [project.targetLanguage])
    .map((code) => {
      const output = project.languageOutputs?.[code];
      const isPrimary = code === project.targetLanguage;
      return {
        code,
        language: LANGUAGES.find((l) => l.code === code),
        status: isPrimary ? 'completed' : output?.status || 'draft',
        videoUrl: isPrimary ? project.finalDubbedVideoUrl : output?.finalDubbedVideoUrl,
        audioUrl: isPrimary ? project.dubbedAudioUrl : output?.dubbedAudioUrl,
        segments: isPrimary ? project.localizedSegments : output?.localizedSegments || [],
        message: isPrimary ? undefined : output?.message,
      };
    })
    .filter((entry) => Boolean(entry.language));

  const active = dubbedLanguages.find((l) => l.code === viewLanguage) || dubbedLanguages[0];
  const targetLang = active?.language || LANGUAGES[0];
  const activeSegments = active?.segments || [];

  useEffect(() => {
    // Fire festive celebration confetti
    try {
      confetti({
        particleCount: 80,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#F05637', '#D94B2E', '#818CF8', '#C084FC', '#38BDF8'],
      });
    } catch {
      // ignore
    }
  }, []);

  // Saves one language's render to disk, honouring the captions toggle; throws so callers can report per-language failures.
  const downloadLanguageVideo = async (languageCode: string) => {
    const entry = dubbedLanguages.find((l) => l.code === languageCode);
    const languageName = entry?.language?.name || languageCode;
    if (!entry?.videoUrl) throw new Error(`The ${languageName} dub has not finished rendering.`);
    let url = entry.videoUrl;
    if (burnCaptions) {
      if (entry.segments.length === 0) throw new Error(`There are no ${languageName} segments to burn in.`);
      const result = await projectService.exportVideo(project.id, true, languageCode);
      url = result.url;
    }
    const suffix = burnCaptions ? 'Dub_CC' : 'Dub';
    await renderService.downloadMedia(`${project.title.replace(/\s+/g, '_')}_${languageName}_${suffix}.mp4`, url);
  };

  const handleDownloadAudio = async () => {
    if (!active?.audioUrl) {
      onShowToast('Audio Not Ready', 'The dubbed audio track is still rendering.', 'error');
      return;
    }
    try {
      await renderService.downloadMedia(
        `${project.title.replace(/\s+/g, '_')}_${targetLang.name}_${voice.name}_Voice.wav`,
        active.audioUrl
      );
      onShowToast('Audio Export Ready', `Dubbed ${targetLang.name} WAV audio file downloaded.`, 'success');
    } catch (err) {
      onShowToast('Download Failed', (err as Error).message, 'error');
    }
  };

  const handleDownloadSRT = () => {
    const srtContent = renderService.generateSRT(activeSegments);
    renderService.downloadTextFile(`${project.title.replace(/\s+/g, '_')}_${targetLang.name}.srt`, srtContent, 'text/plain');
    onShowToast('Subtitles Exported', 'SRT subtitle file downloaded successfully.', 'success');
  };

  const handleDownloadVTT = () => {
    const vttContent = renderService.generateVTT(activeSegments);
    renderService.downloadTextFile(`${project.title.replace(/\s+/g, '_')}_${targetLang.name}.vtt`, vttContent, 'text/vtt');
    onShowToast('Subtitles Exported', 'VTT subtitle file downloaded successfully.', 'success');
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Every language not yet in this project, so another can be added without re-uploading.
  const moreLanguages = LANGUAGES.filter((l) => !dubbedLanguages.some((d) => d.code === l.code) && l.code !== project.sourceLanguage);
  const readyCount = dubbedLanguages.filter((l) => l.videoUrl).length;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Success banner */}
      <div className="relative overflow-hidden rounded-3xl glass-panel p-6 sm:p-7">
        <div aria-hidden className="pointer-events-none absolute -top-24 -left-16 w-72 h-72 rounded-full bg-[#F05637]/10 blur-3xl" />
        <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-5">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500 text-white flex items-center justify-center shadow-[0_8px_24px_rgba(16,185,129,0.35)]">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-xl sm:text-2xl font-bold text-[#0F172A] tracking-tight">Your dub is ready</h3>
              <p className="text-xs text-[#64748B] mt-0.5">
                {dubbedLanguages.length > 1
                  ? `${readyCount} of ${dubbedLanguages.length} languages rendered from one upload · ${formatDuration(project.videoDuration)}`
                  : `${sourceLang.name} → ${targetLang.name} · voiced by ${voice.name.replace(/\s*\(.*\)$/, '')} · ${formatDuration(project.videoDuration)}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowShare(true)}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white hover:bg-[#F8FAFC] text-[#0F172A] text-xs font-semibold border border-[#E2E8F0] transition-colors"
            >
              <Share2 className="w-3.5 h-3.5 text-[#D94B2E]" />
              <span>Share</span>
            </button>
            <button
              type="button"
              onClick={onOpenWorkspace}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#0F172A] hover:bg-[#1E293B] text-white text-xs font-semibold transition-colors"
            >
              <span>Open in Timeline</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Player */}
        <div className="lg:col-span-7 space-y-3">
          {dubbedLanguages.length > 1 && (
            <div className="flex items-center gap-1.5 overflow-x-auto custom-scrollbar pb-1">
              {dubbedLanguages.map((entry) => {
                const isActive = entry.code === viewLanguage;
                const isReady = Boolean(entry.videoUrl);
                return (
                  <button
                    key={entry.code}
                    type="button"
                    onClick={() => isReady && setViewLanguage(entry.code)}
                    disabled={!isReady}
                    title={isReady ? `Preview the ${entry.language!.name} dub` : entry.message || 'Did not render'}
                    className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                      isActive
                        ? 'bg-[#F05637] border-[#F05637] text-white shadow-[0_0_15px_rgba(240,86,55,0.3)]'
                        : 'bg-white border-[#E2E8F0] text-[#64748B] hover:text-[#0F172A] hover:border-[#CBD5E1]'
                    }`}
                  >
                    <span>{entry.language!.name}</span>
                    {!isReady && <span className="text-[10px] font-normal">· failed</span>}
                  </button>
                );
              })}
            </div>
          )}

          <div className="relative rounded-2xl overflow-hidden border border-[#E2E8F0] shadow-[0_24px_60px_rgba(15,23,42,0.12)] bg-[#0F172A]">
            <VideoPlayer
              src={active?.videoUrl || project.videoUrl}
              originalSrc={project.videoUrl}
              localizedSegments={activeSegments}
              activeLanguageName={targetLang.name}
              showAudioTrackSwitch={true}
              activeAudioTrack={activeTrack}
              onToggleAudioTrack={setActiveTrack}
              className="w-full aspect-video"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Language', value: `${sourceLang.name} → ${targetLang.name}` },
              { label: 'Voice', value: voice.name.replace(/\s*\(.*\)$/, '') },
              { label: 'Duration', value: formatDuration(project.videoDuration) },
            ].map((item) => (
              <div key={item.label} className="p-3 rounded-2xl glass-panel">
                <span className="text-[10px] uppercase tracking-wider text-[#94A3B8] block">{item.label}</span>
                <span className="text-xs font-bold text-[#0F172A] mt-0.5 block truncate">{item.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Exports */}
        <div className="lg:col-span-5 space-y-4">
          {/* Raised so the language dropdown opens over the cards below instead of under them. */}
          <div className="relative z-20 rounded-3xl glass-panel p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-bold text-[#0F172A]">Download</h4>
              <span className="text-[11px] text-[#94A3B8]">MP4 · 1080p</span>
            </div>

            <DownloadMenu
              languages={dubbedLanguages.map((entry) => ({
                code: entry.code,
                name: entry.language!.name,
                nativeName: entry.language!.nativeName,
                ready: Boolean(entry.videoUrl),
                statusLabel: entry.status === 'failed' ? entry.message || 'Dubbing failed' : 'Still rendering',
              }))}
              onDownload={downloadLanguageVideo}
              onShowToast={onShowToast}
              sublabel={`Synced dub${burnCaptions ? ' + captions' : ''}`}
            />

            <button
              type="button"
              role="switch"
              aria-checked={burnCaptions}
              onClick={() => setBurnCaptions((v) => !v)}
              className="w-full flex items-center justify-between gap-3 px-1"
            >
              <span className="flex items-center gap-2 text-xs text-[#0F172A]">
                <FileText className="w-3.5 h-3.5 text-[#F05637]" />
                <span>Burn captions into the video</span>
              </span>
              <span className={`relative w-9 h-5 rounded-full transition-colors ${burnCaptions ? 'bg-[#F05637]' : 'bg-[#CBD5E1]'}`}>
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                    burnCaptions ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </span>
            </button>

            <div className="pt-4 border-t border-[#E2E8F0]">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#94A3B8] block mb-2">
                Other formats{dubbedLanguages.length > 1 ? ` · ${targetLang.name}` : ''}
              </span>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'SRT', hint: 'Subtitles', icon: FileText, onClick: handleDownloadSRT, disabled: false },
                  { label: 'VTT', hint: 'Web subtitles', icon: FileText, onClick: handleDownloadVTT, disabled: false },
                  { label: 'WAV', hint: 'Voice track', icon: Volume2, onClick: handleDownloadAudio, disabled: !active?.audioUrl },
                ].map(({ label, hint, icon: Icon, onClick, disabled }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={onClick}
                    disabled={disabled}
                    className="flex flex-col items-center gap-1 py-3 rounded-xl bg-[#F8FAFC] hover:bg-[#FFF4F1] border border-[#E2E8F0] hover:border-[#F05637]/40 transition-colors disabled:opacity-50"
                  >
                    <Icon className="w-4 h-4 text-[#D94B2E]" />
                    <span className="text-xs font-bold text-[#0F172A]">{label}</span>
                    <span className="text-[10px] text-[#94A3B8]">{hint}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowShare(true)}
            className="w-full flex items-center justify-between gap-3 p-5 rounded-3xl glass-panel hover:border-[#F05637]/40 text-left transition-colors group"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-[#FFF4F1] text-[#D94B2E] flex items-center justify-center">
                <Share2 className="w-5 h-5" />
              </div>
              <div>
                <span className="text-sm font-bold text-[#0F172A] block">Share a watch link</span>
                <span className="text-xs text-[#64748B]">Anyone can watch it — expires in 24 hours</span>
              </div>
            </div>
            <ArrowRight className="w-4 h-4 text-[#94A3B8] group-hover:text-[#D94B2E] group-hover:translate-x-0.5 transition-all" />
          </button>

          {moreLanguages.length > 0 && (
            <div className="rounded-3xl glass-panel p-5 space-y-3">
              <div>
                <h4 className="text-sm font-bold text-[#0F172A] flex items-center gap-2">
                  <Languages className="w-4 h-4 text-[#F05637]" />
                  <span>Dub into another language</span>
                </h4>
                <p className="text-xs text-[#64748B] mt-0.5">Same video, no re-upload.</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {moreLanguages.map((lang) => (
                  <button
                    key={lang.code}
                    type="button"
                    onClick={() => onDubAnotherLanguage(lang.code)}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-[#F8FAFC] hover:bg-[#FFF4F1] border border-[#E2E8F0] hover:border-[#F05637]/50 text-xs font-medium text-[#0F172A] transition-colors"
                  >
                    <Plus className="w-3 h-3 text-[#D94B2E]" />
                    <span>{lang.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {showShare && (
        <ShareDialog
          projectId={project.id}
          projectTitle={project.title}
          languages={dubbedLanguages.map((entry) => ({ code: entry.code, name: entry.language!.name, ready: Boolean(entry.videoUrl) }))}
          initialLanguage={viewLanguage}
          onClose={() => setShowShare(false)}
          onShowToast={onShowToast}
        />
      )}
    </div>
  );
};
