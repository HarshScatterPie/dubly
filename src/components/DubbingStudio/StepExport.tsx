/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import { CheckCircle2, Clock, ExternalLink, Languages, Mic, Monitor, Plus, RefreshCw, Share2 } from 'lucide-react';
import { DubbingProject, VoiceEngine } from '../../types';
import { LANGUAGES, VOICES } from '../../data/mockData';
import { languageVoiced, VOICE_ENGINES } from '../../lib/voiceEngines';
import { VideoPlayer } from '../VideoPlayer';
import { ShareDialog } from '../ShareDialog';
import { loadDevicePrefs } from '../../lib/devicePrefs';
import { dubbedLanguagesOf, formatClock, LanguageTabs, QualityPanel, StatTile, SyncedScript } from '../DubResult';
import { ExportPanel } from '../ExportPanel';

interface StepExportProps {
  project: DubbingProject;
  onDubAnotherLanguage: (targetLangCode: string) => void;
  onRestartProject: () => void;
  onOpenWorkspace: () => void;
  onShowToast: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
  /** Whether downloads start with captions burned in (the user's saved default). */
  defaultBurnCaptions?: boolean;
  /** The voice engines the workspace's plan includes; languages none of them speaks are not offered. */
  voiceEngines?: VoiceEngine[];
}

export const StepExport: React.FC<StepExportProps> = ({
  project,
  onDubAnotherLanguage,
  onRestartProject,
  onOpenWorkspace,
  onShowToast,
  defaultBurnCaptions = false,
  voiceEngines = VOICE_ENGINES,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeTrack, setActiveTrack] = useState<'dubbed' | 'original'>('dubbed');
  const [showShare, setShowShare] = useState(false);
  const [showMoreLanguages, setShowMoreLanguages] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [seekTo, setSeekTo] = useState<number | undefined>(undefined);

  const languages = useMemo(() => dubbedLanguagesOf(project), [project]);
  const firstReady = languages.find((l) => l.videoUrl)?.code || project.targetLanguage;
  const [viewLanguage, setViewLanguage] = useState<string>(languages.some((l) => l.code === project.targetLanguage && l.videoUrl) ? project.targetLanguage : firstReady);
  const active = languages.find((l) => l.code === viewLanguage) || languages[0];

  const sourceLang = LANGUAGES.find((l) => l.code === project.sourceLanguage);
  const voiceId = (active && project.languageVoiceMap?.[active.code]) || project.selectedVoiceId;
  const voiceName = VOICES.find((v) => v.id === voiceId)?.name.replace(/\s*\(.*\)$/, '') || 'AI voice';
  const readyCount = languages.filter((l) => l.videoUrl).length;
  const moreLanguages = LANGUAGES.filter((l) => !languages.some((d) => d.code === l.code) && l.code !== project.sourceLanguage && languageVoiced(l.code, voiceEngines));

  useEffect(() => {
    // Only on screen and only if the user wants it: the studio also finishes, or is restored, while hidden behind another screen.
    if (!loadDevicePrefs().celebrate || rootRef.current?.offsetParent === null) return;
    try {
      confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 }, colors: ['#F05637', '#D94B2E', '#818CF8', '#C084FC', '#38BDF8'] });
    } catch {
      // ignore
    }
  }, []);

  // The same number twice would not move the player, so each jump is nudged by a hair.
  const jumpTo = (time: number) => setSeekTo(time + Math.random() * 1e-4);

  return (
    <div ref={rootRef} className="space-y-6 animate-fade-in">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-3xl bg-[#0F172A] text-white p-6 sm:p-7 shadow-[0_24px_60px_rgba(15,23,42,0.25)]">
        <div aria-hidden className="pointer-events-none absolute -top-24 -right-10 w-80 h-80 rounded-full bg-[#F05637]/30 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-28 left-10 w-72 h-72 rounded-full bg-teal-400/15 blur-3xl" />
        <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-5">
          <div className="flex items-start gap-4 min-w-0">
            <div className="w-12 h-12 shrink-0 rounded-2xl bg-emerald-500 flex items-center justify-center shadow-[0_8px_24px_rgba(16,185,129,0.4)]">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/55">Dub ready</p>
              <h3 className="text-xl sm:text-2xl font-extrabold tracking-tight truncate">{project.title}</h3>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="px-2 py-1 rounded-full bg-white/10 border border-white/10">
                  {sourceLang?.name || 'Original'} → {languages.length > 1 ? `${readyCount} of ${languages.length} languages` : active?.language.name}
                </span>
                <span className="px-2 py-1 rounded-full bg-white/10 border border-white/10 inline-flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {formatClock(project.videoDuration)}
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowShare(true)}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs font-semibold transition-colors"
            >
              <Share2 className="w-3.5 h-3.5" />
              Share
            </button>
            <button
              type="button"
              onClick={onOpenWorkspace}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white text-[#0F172A] hover:bg-white/90 text-xs font-bold transition-colors"
            >
              Edit lines &amp; voices
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onRestartProject}
              className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-white/70 hover:text-white text-xs font-semibold transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              New video
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Watch */}
        <div className="lg:col-span-8 space-y-3 min-w-0">
          <LanguageTabs languages={languages} active={viewLanguage} onSelect={setViewLanguage} />
          <VideoPlayer
            key={active?.code}
            src={active?.videoUrl || project.videoUrl}
            originalSrc={project.videoUrl}
            poster={project.videoThumbnailUrl || undefined}
            localizedSegments={activeTrack === 'dubbed' ? active?.segments || [] : []}
            transcriptSegments={activeTrack === 'original' ? project.transcriptSegments : []}
            activeLanguageName={active?.language.name || 'Dubbed'}
            showAudioTrackSwitch
            activeAudioTrack={activeTrack}
            onToggleAudioTrack={setActiveTrack}
            currentTime={seekTo}
            autoPlayOnSeek
            onTimeUpdate={setPlayhead}
            className="w-full aspect-video shadow-[0_24px_60px_rgba(15,23,42,0.18)]"
          />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatTile icon={Languages} label="Language" value={`${sourceLang?.name.split(' ')[0] || 'Original'} → ${active?.language.name || '—'}`} />
            <StatTile icon={Mic} label="Voice" value={voiceName} />
            <StatTile icon={Clock} label="Duration" value={formatClock(project.videoDuration)} />
            <StatTile icon={Monitor} label="Resolution" value={project.videoResolution?.split(' (')[0] || '—'} />
          </div>
          {active && (
            <SyncedScript
              segments={active.segments}
              currentTime={playhead}
              onSeek={jumpTo}
              languageName={active.language.name}
            />
          )}
        </div>

        {/* Take it away */}
        <div className="lg:col-span-4 space-y-4">
          <ExportPanel
            project={project}
            languages={languages}
            active={active}
            defaultBurnCaptions={defaultBurnCaptions}
            onShare={() => setShowShare(true)}
            onShowToast={onShowToast}
          />
          <QualityPanel report={active?.report} faceDetected={project.faceScan?.hasFaces} onReviewLines={onOpenWorkspace} />

          {moreLanguages.length > 0 && (
            <div className="rounded-3xl glass-panel p-5 space-y-3">
              <button type="button" onClick={() => setShowMoreLanguages((v) => !v)} className="w-full flex items-center justify-between text-left">
                <span>
                  <span className="text-sm font-bold text-[#0F172A] flex items-center gap-2">
                    <Languages className="w-4 h-4 text-[#F05637]" />
                    Dub into another language
                  </span>
                  <span className="text-xs text-[#64748B]">Same video and transcript, no re-upload.</span>
                </span>
                <Plus className={`w-4 h-4 text-[#94A3B8] transition-transform ${showMoreLanguages ? 'rotate-45' : ''}`} />
              </button>
              {showMoreLanguages && (
                <div className="flex flex-wrap gap-1.5 animate-fade-in">
                  {moreLanguages.map((lang) => (
                    <button
                      key={lang.code}
                      type="button"
                      onClick={() => onDubAnotherLanguage(lang.code)}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-white hover:bg-[#FFF4F1] border border-[#E2E8F0] hover:border-[#F05637]/50 text-xs font-medium text-[#0F172A] transition-colors"
                    >
                      <span>{lang.flag}</span>
                      <span>{lang.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showShare && (
        <ShareDialog
          projectId={project.id}
          projectTitle={project.title}
          languages={languages.map((entry) => ({ code: entry.code, name: entry.language.name, ready: Boolean(entry.videoUrl) }))}
          initialLanguage={viewLanguage}
          onClose={() => setShowShare(false)}
          onShowToast={onShowToast}
        />
      )}
    </div>
  );
};
