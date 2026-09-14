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
  const [selectedQuickLang, setSelectedQuickLang] = useState<string>('ta');
  const [burnCaptions, setBurnCaptions] = useState<boolean>(false);
  const [isPreparingDownload, setIsPreparingDownload] = useState<boolean>(false);
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

  /** Downloads one language's render — defaults to whichever is on screen. */
  const handleDownloadVideo = async (languageCode = viewLanguage) => {
    const entry = dubbedLanguages.find((l) => l.code === languageCode);
    const languageName = entry?.language?.name || languageCode;
    if (!entry?.videoUrl) {
      onShowToast('Not Ready', `The ${languageName} dub has not finished rendering.`, 'error');
      return;
    }
    setIsPreparingDownload(true);
    try {
      const suffix = burnCaptions ? 'Dub_CC' : 'Dub';
      let url = entry.videoUrl;
      if (burnCaptions) {
        if (entry.segments.length === 0) {
          onShowToast('No Captions Available', `There are no ${languageName} segments to burn in.`, 'error');
          return;
        }
        onShowToast('Preparing Captions', 'Burning captions into the video — this can take a moment on first download.', 'info');
        const result = await projectService.exportVideo(project.id, true, languageCode);
        url = result.url;
      }
      await renderService.downloadMedia(`${project.title.replace(/\s+/g, '_')}_${languageName}_${suffix}.mp4`, url);
      onShowToast('Video Download Started', `${languageName} dubbed master download queued.`, 'success');
    } catch (err) {
      onShowToast('Download Failed', (err as Error).message, 'error');
    } finally {
      setIsPreparingDownload(false);
    }
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

  const handleCopyShareLink = () => {
    navigator.clipboard.writeText(window.location.href);
    onShowToast('Link Copied', 'Shareable studio link copied to clipboard.', 'info');
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const quickLanguages = [
    { code: 'hi', name: 'Hindi', flag: '🇮🇳' },
    { code: 'ta', name: 'Tamil', flag: '🇮🇳' },
    { code: 'te', name: 'Telugu', flag: '🇮🇳' },
    { code: 'bn', name: 'Bengali', flag: '🇮🇳' },
    { code: 'mr', name: 'Marathi', flag: '🇮🇳' },
    { code: 'es', name: 'Spanish', flag: '🇪🇸' },
    { code: 'fr', name: 'French', flag: '🇫🇷' },
    { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
  ].filter((l) => !dubbedLanguages.some((d) => d.code === l.code));

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Title & Success Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6 rounded-3xl bg-gradient-to-r from-[#F05637]/20 via-[#FFFFFF] to-[#FFFFFF] border border-[#F05637]/40 glass-panel">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-emerald-50/90 text-emerald-600 border border-emerald-200/60 flex items-center justify-center shadow-lg">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-xl sm:text-2xl font-bold text-[#0F172A] tracking-tight">
              Your dub is ready.
            </h3>
            <p className="text-xs text-[#64748B] mt-0.5">
              {dubbedLanguages.length > 1
                ? `High-definition video rendered in ${dubbedLanguages.length} languages from one upload`
                : `High-definition video rendered with synchronized ${targetLang.name} voiceover`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopyShareLink}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] text-[#0F172A] text-xs font-semibold border border-[#E2E8F0] transition-colors"
          >
            <Share2 className="w-3.5 h-3.5" />
            <span>Share</span>
          </button>
          <button
            type="button"
            onClick={onOpenWorkspace}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold shadow-md shadow-[0_0_15px_rgba(240,86,55,0.3)] transition-all"
          >
            <span>Open in Timeline</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Grid: Video Player + Export Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left: Video Player */}
        <div className="lg:col-span-7 space-y-4">
          {/* One row per rendered language: switches the player and every export action
              below onto that language, and downloads it directly. */}
          {dubbedLanguages.length > 1 && (
            <div className="p-2 rounded-2xl glass-panel space-y-1.5">
              {dubbedLanguages.map((entry) => {
                const isActive = entry.code === viewLanguage;
                const isReady = entry.status === 'completed' && Boolean(entry.videoUrl);
                return (
                  <div
                    key={entry.code}
                    className={`flex items-center gap-2 p-2 rounded-xl transition-colors ${
                      isActive ? 'bg-[#F05637]/10 ring-1 ring-[#F05637]' : 'hover:bg-[#F8FAFC]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => isReady && setViewLanguage(entry.code)}
                      disabled={!isReady}
                      className="flex items-center gap-2.5 flex-1 min-w-0 text-left disabled:cursor-not-allowed"
                    >
                      <span className="text-lg shrink-0">{entry.language!.flag}</span>
                      <span className="min-w-0">
                        <span className="text-xs font-bold text-[#0F172A] block truncate">
                          {entry.language!.name}
                        </span>
                        <span className="text-[10px] text-[#64748B] block truncate">
                          {isReady
                            ? isActive
                              ? 'Now previewing'
                              : 'Ready to preview'
                            : entry.message || 'Did not render'}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDownloadVideo(entry.code)}
                      disabled={!isReady || isPreparingDownload}
                      title={`Download the ${entry.language!.name} dub`}
                      className="flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg bg-[#F8FAFC] hover:bg-[#E2E8F0] border border-[#E2E8F0] text-[11px] font-semibold text-[#0F172A] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Download className="w-3 h-3 text-[#D94B2E]" />
                      <span>MP4</span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="relative rounded-2xl overflow-hidden border border-[#E2E8F0] shadow-2xl bg-[#FFFFFF]">
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

          {/* Video Metadata Breakdown */}
          <div className="p-4 rounded-2xl glass-panel grid grid-cols-3 gap-3 text-xs">
            <div>
              <span className="text-[#94A3B8] block text-[10px]">Translation</span>
              <span className="font-bold text-[#0F172A] mt-0.5 flex items-center gap-1.5">
                <span>{sourceLang.name}</span>
                <span className="text-[#D94B2E]">↓</span>
                <span className="text-[#D94B2E]">{targetLang.name}</span>
              </span>
            </div>

            <div>
              <span className="text-[#94A3B8] block text-[10px]">Audio Voice</span>
              <span className="font-bold text-[#0F172A] mt-0.5 block truncate">
                {voice.name} · {voice.accent.split(' ')[0]}
              </span>
            </div>

            <div>
              <span className="text-[#94A3B8] block text-[10px]">Duration</span>
              <span className="font-mono font-bold text-[#0F172A] mt-0.5 block">
                {formatDuration(project.videoDuration)}
              </span>
            </div>
          </div>
        </div>

        {/* Right: Export Downloads & Multilingual Version Creator */}
        <div className="lg:col-span-5 space-y-6">
          {/* Main Download Options */}
          <div className="rounded-3xl glass-panel p-6 space-y-5">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">
              Export Outputs
            </h4>

            {/* Burn-in Captions Toggle */}
            <button
              type="button"
              onClick={() => setBurnCaptions((v) => !v)}
              className="w-full flex items-center justify-between p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] transition-colors"
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-[#0F172A]">
                <FileText className="w-3.5 h-3.5 text-[#F05637]" />
                <span>Burn in captions (CC)</span>
              </div>
              <span
                className={`relative w-9 h-5 rounded-full transition-colors ${burnCaptions ? 'bg-[#F05637]' : 'bg-[#CBD5E1]'}`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                    burnCaptions ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </span>
            </button>

            {/* Download Video Button */}
            <button
              type="button"
              // Wrapped, not passed directly: React would hand the click event in as the
              // languageCode argument, and the default only applies to `undefined`.
              onClick={() => handleDownloadVideo()}
              disabled={isPreparingDownload || !active?.videoUrl}
              className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-[#F05637] hover:bg-[#D94B2E] active:bg-[#B3391F] text-white shadow-[0_0_25px_rgba(240,86,55,0.3)] transition-all group disabled:opacity-60"
            >
              <div className="flex items-center gap-3 text-left">
                <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
                  <Video className="w-5 h-5" />
                </div>
                <div>
                  <span className="text-sm font-bold block">
                    {isPreparingDownload ? 'Preparing...' : 'Download Video'}
                  </span>
                  <span className="text-[11px] text-coral-700 block font-mono">
                    1080p MP4 · Synced Dub{burnCaptions ? ' + Captions' : ''}
                  </span>
                </div>
              </div>
              <Download className="w-5 h-5 group-hover:translate-y-0.5 transition-transform" />
            </button>

            {/* Subtitle Downloads (SRT / VTT) */}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={handleDownloadSRT}
                className="flex items-center justify-center gap-2 p-3 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] border border-[#E2E8F0] text-[#0F172A] text-xs font-semibold transition-colors"
              >
                <FileText className="w-4 h-4 text-[#D94B2E]" />
                <span>Download SRT</span>
              </button>

              <button
                type="button"
                onClick={handleDownloadVTT}
                className="flex items-center justify-center gap-2 p-3 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] border border-[#E2E8F0] text-[#0F172A] text-xs font-semibold transition-colors"
              >
                <FileText className="w-4 h-4 text-teal-600" />
                <span>Download VTT</span>
              </button>
            </div>

            {/* Audio-Only Mode Card */}
            <div className="pt-4 border-t border-[#E2E8F0] space-y-3">
              <span className="text-xs font-bold text-[#0F172A] flex items-center gap-1.5">
                <Music className="w-3.5 h-3.5 text-[#F05637]" />
                <span>Audio-Only Mode</span>
              </span>

              <button
                type="button"
                onClick={handleDownloadAudio}
                disabled={!active?.audioUrl}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] border border-[#E2E8F0] text-[#0F172A] text-xs font-semibold transition-colors disabled:opacity-50"
              >
                <Volume2 className="w-3.5 h-3.5 text-[#D94B2E]" />
                <span>Export WAV Audio</span>
              </button>
            </div>
          </div>

          {/* Create Another Language Strip (Without Re-uploading!) */}
          <div className="rounded-3xl glass-panel border-[#F05637]/30 p-6 space-y-4">
            <div>
              <h4 className="text-sm font-bold text-[#0F172A] flex items-center gap-2">
                <Languages className="w-4 h-4 text-[#F05637]" />
                <span>Create another language</span>
              </h4>
              <p className="text-xs text-[#64748B] mt-0.5">
                Localize this exact video into more languages without uploading again.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {quickLanguages.map((qlang) => (
                <button
                  key={qlang.code}
                  type="button"
                  onClick={() => onDubAnotherLanguage(qlang.code)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#F8FAFC] hover:bg-[#F05637]/20 border border-[#E2E8F0] hover:border-[#F05637]/60 text-xs font-medium text-[#0F172A] transition-all"
                >
                  <span>{qlang.flag}</span>
                  <span>{qlang.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
